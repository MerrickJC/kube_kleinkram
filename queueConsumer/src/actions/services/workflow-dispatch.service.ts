import { AccessControlService } from '@kleinkram/backend-common';
import { ActionTemplateEntity } from '@kleinkram/backend-common/entities/action/action-template.entity';
import { ActionEntity } from '@kleinkram/backend-common/entities/action/action.entity';
import { ApiKeyEntity } from '@kleinkram/backend-common/entities/auth/api-key.entity';
import environment from '@kleinkram/backend-common/environment';
import {
    ACTION_DISPATCH_QUEUE_NAME,
    ActionQueueJob,
    ActionQueueJobData,
} from '@kleinkram/backend-common/modules/action-dispatcher/action-queue.constants';
import {
    AccessGroupRights,
    ActionDispatchKind,
    ActionState,
    KeyTypes,
    UserRole,
} from '@kleinkram/shared';
import { OnQueueFailed, Process, Processor } from '@nestjs/bull';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bull';
import { Repository } from 'typeorm';
import logger from '../../logger';
import { DispatchStoreService } from '../dispatcher/dispatch-store.service';
import { dispatcherEnabled, outputVolumeSizeLimit } from '../dispatcher/dispatcher.config';
import type { SubmittedWorkflow } from '../dispatcher/locality-dispatcher.service';
import { publishDispatchWake } from '../dispatcher/wake-channel';
import { DisposableAPIKey } from '../helper/disposable-api-key';
import {
    ACTION_MANAGED_BY_LABEL_KEY,
    ACTION_MANAGED_BY_LABEL_VALUE,
    ACTION_UUID_LABEL,
    actionExecutorServiceAccount,
    actionPodServiceAccount,
    actionsNamespace,
    apiKeySecretNameForAction,
    ARGO_GROUP,
    ARGO_VERSION,
    getCoreV1Api,
    getCustomObjectsApi,
    gpuTaintKey,
    WORKFLOW_PLURAL,
    workflowNameForAction,
} from '../helper/kube-client';
import { ImageResolutionService } from './image-resolution.service';

const ARTIFACT_REPOSITORY_CONFIGMAP =
    process.env.ARGO_ARTIFACT_REPOSITORY_CONFIGMAP ??
    'kleinkram-artifact-repository';
// Actions aren't trusted to create their own output directory (they may run
// as a non-root user that can't mkdir at the image's filesystem root), so
// /out is backed by an emptyDir volume instead. The size limit is fixed for
// now since ActionTemplateEntity has no per-template disk quota field.
const OUTPUT_VOLUME_NAME = 'out';
const OUTPUT_VOLUME_SIZE_LIMIT = outputVolumeSizeLimit();

const KLEINKRAM_LOCAL_LABEL_PREFIX = 'kleinkram.local';

/**
 * Consumes `submit-action` jobs from the dispatch queue. Also the
 * dispatcher's real WorkflowSubmitter (see submitForDispatcher below and
 * dispatcher.module.ts's WORKFLOW_SUBMITTER provider) - once
 * ACTION_DISPATCHER_ENABLED is true, `submit()` no longer builds a Workflow
 * itself; it only hands the job to the dispatcher, which calls back into
 * submitForDispatcher once it has decided on a node.
 */
@Processor(ACTION_DISPATCH_QUEUE_NAME)
@Injectable()
export class WorkflowDispatchService {
    constructor(
        @InjectRepository(ActionEntity)
        private actionRepository: Repository<ActionEntity>,
        @InjectRepository(ApiKeyEntity)
        private apikeyRepository: Repository<ApiKeyEntity>,
        private accessControlService: AccessControlService,
        private readonly imageResolutionService: ImageResolutionService,
        private readonly dispatchStore: DispatchStoreService,
    ) {}

    @Process({ name: ActionQueueJob.SUBMIT, concurrency: 5 })
    async submit(job: Job<ActionQueueJobData>): Promise<void> {
        const action = await this.actionRepository.findOneOrFail({
            where: { uuid: job.data.uuid },
            relations: {
                template: true,
                mission: { project: true },
                creator: true,
            },
        });

        if (action.state !== ActionState.PENDING) {
            logger.debug(
                `Action ${action.uuid} is not PENDING (state: ${action.state}), skipping submit`,
            );
            return;
        }

        if (!action.mission || !action.template || !action.creator) {
            throw new Error(
                `Action ${action.uuid} is missing required relations`,
            );
        }

        const canAccess = await this.accessControlService.canAccessMission(
            {
                uuid: action.creator.uuid,
                role: action.creator.role ?? UserRole.USER,
            },
            action.mission,
            AccessGroupRights.WRITE,
        );
        if (!canAccess) {
            await this.actionRepository.update(action.uuid, {
                state: ActionState.FAILED,
                // eslint-disable-next-line @typescript-eslint/naming-convention
                state_cause: `User ${action.creator.uuid} lost access to mission ${action.mission.uuid}`,
            });
            return;
        }

        if (dispatcherEnabled()) {
            // LocalityDispatcherService now owns getting this Action a node
            // and calling submitForDispatcher() below - this job is done
            // once the row is marked QUEUED.
            await this.dispatchStore.markQueued(action.uuid, '');
            await publishDispatchWake();
            return;
        }

        const apiKey = await this.mintApiKeySecret(action);
        const image = await this.imageResolutionService.resolveImageDigest(
            action.template.image_name,
        );

        const workflowName = workflowNameForAction(action.uuid);
        const manifest = this.buildWorkflowManifest(
            action,
            action.template,
            workflowName,
        );

        try {
            await getCustomObjectsApi().createNamespacedCustomObject({
                group: ARGO_GROUP,
                version: ARGO_VERSION,
                namespace: actionsNamespace(),
                plural: WORKFLOW_PLURAL,
                body: manifest,
            });
        } catch (error) {
            await apiKey[Symbol.asyncDispose]();
            throw error;
        }

        await this.actionRepository.update(action.uuid, {
            state: ActionState.STARTING,
            // eslint-disable-next-line @typescript-eslint/naming-convention
            state_cause: 'Workflow submitted',
            workflowName,
            image,
        });

        logger.info(
            `Submitted Argo Workflow ${workflowName} for action ${action.uuid}`,
        );
    }

    /**
     * The dispatcher's WorkflowSubmitter (spec §9.1 steps 3-6), called by
     * LocalityDispatcherService once it has claimed this Action for `node`.
     * Access is re-checked here (not just at submit() time), since a queued
     * job may have waited - the spec explicitly calls for this ("Access is
     * checked both at submission time and again just before the workflow
     * starts").
     */
    async submitForDispatcher(actionUuid: string, node: string): Promise<SubmittedWorkflow> {
        const action = await this.actionRepository.findOneOrFail({
            where: { uuid: actionUuid },
            relations: { template: true, mission: { project: true }, creator: true },
        });
        if (!action.mission || !action.template || !action.creator) {
            throw new Error(`Action ${actionUuid} is missing required relations`);
        }

        const canAccess = await this.accessControlService.canAccessMission(
            { uuid: action.creator.uuid, role: action.creator.role ?? UserRole.USER },
            action.mission,
            AccessGroupRights.WRITE,
        );
        if (!canAccess) {
            await this.actionRepository.update(action.uuid, {
                state: ActionState.FAILED,
                // eslint-disable-next-line @typescript-eslint/naming-convention
                state_cause: `User ${action.creator.uuid} lost access to mission ${action.mission.uuid} before dispatch`,
            });
            throw new Error(`Access to mission ${action.mission.uuid} was revoked before dispatch`);
        }

        const apiKey = await this.mintApiKeySecret(action);
        const image = await this.imageResolutionService.resolveImageDigest(action.template.image_name);
        const workflowName = workflowNameForAction(action.uuid);
        const manifest = this.buildWorkflowManifest(action, action.template, workflowName, node);

        try {
            await getCustomObjectsApi().createNamespacedCustomObject({
                group: ARGO_GROUP,
                version: ARGO_VERSION,
                namespace: actionsNamespace(),
                plural: WORKFLOW_PLURAL,
                body: manifest,
            });
        } catch (error) {
            await apiKey[Symbol.asyncDispose]();
            throw error;
        }

        await this.actionRepository.update(action.uuid, {
            state: ActionState.STARTING,
            // eslint-disable-next-line @typescript-eslint/naming-convention
            state_cause: 'Workflow submitted',
            workflowName,
            image,
        });

        logger.info(`Submitted Argo Workflow ${workflowName} for action ${action.uuid} pinned to node ${node}`);
        return { workflowName };
    }

    @OnQueueFailed()
    async onJobFailed(
        job: Job<ActionQueueJobData>,
        error: unknown,
    ): Promise<void> {
        if (job.name !== ActionQueueJob.SUBMIT) return;

        const hasAttemptsLeft = job.attemptsMade < (job.opts.attempts ?? 0);
        if (hasAttemptsLeft) return;

        logger.error(
            `Failed to submit workflow for action ${job.data.uuid} after ${job.attemptsMade.toString()} attempts: ${String(error)}`,
        );
        await this.actionRepository.update(job.data.uuid, {
            state: ActionState.UNPROCESSABLE,
            // eslint-disable-next-line @typescript-eslint/naming-convention
            state_cause: error instanceof Error ? error.message : String(error),
        });
    }

    /**
     * Creates a disposable per-run API key and stores it into a Secret so
     * it doesn't appear in the object logs. WorkflowWatchService deletes
     * the Secret once the run reaches a terminal state.
     */
    private async mintApiKeySecret(
        action: ActionEntity,
    ): Promise<DisposableAPIKey> {
        if (!action.mission || !action.template || !action.creator) {
            throw new Error(
                'Action missing relations required to mint API key',
            );
        }

        const apiKey = this.apikeyRepository.create({
            mission: { uuid: action.mission.uuid },
            rights: action.template.accessRights,
            // eslint-disable-next-line @typescript-eslint/naming-convention
            key_type: KeyTypes.ACTION,
            action,
            user: action.creator,
        });
        const saved = await this.apikeyRepository.save(apiKey);

        await getCoreV1Api().createNamespacedSecret({
            namespace: actionsNamespace(),
            body: {
                metadata: {
                    name: apiKeySecretNameForAction(action.uuid),
                    labels: { [ACTION_UUID_LABEL]: action.uuid },
                },
                stringData: { apikey: saved.apikey },
            },
        });

        return new DisposableAPIKey(saved, this.apikeyRepository);
    }

    /**
     * Builds the Argo Workflow manifest. When `node` is given (the
     * dispatcher has decided where this Action should run), the pod is
     * hard-pinned there and carries the dispatcher's own labels. When
     * `node` is omitted (the dispatcher is disabled), the pod is submitted
     * entirely unconstrained - no node pinning and no admission/quota
     * control at all (Kueue is no longer used), so this fallback path is
     * only appropriate when the dispatcher isn't running (e.g. local dev).
     */
    private buildWorkflowManifest(
        action: ActionEntity,
        template: ActionTemplateEntity,
        workflowName: string,
        node?: string,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ): Record<string, any> {
        if (!action.mission) throw new Error('Mission is undefined');

        const activeDeadlineSeconds = Math.max(
            60,
            Math.round(template.maxRuntime * 3600),
        );
        const wantsGpu = template.gpuMemory > 0;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const resources: Record<string, Record<string, any>> = {
            requests: {
                cpu: template.cpuCores.toString(),
                memory: `${template.cpuMemory.toString()}Gi`,
            },
            limits: {
                cpu: template.cpuCores.toString(),
                memory: `${template.cpuMemory.toString()}Gi`,
            },
        };
        resources.requests['ephemeral-storage'] = OUTPUT_VOLUME_SIZE_LIMIT;
        resources.limits['ephemeral-storage'] = OUTPUT_VOLUME_SIZE_LIMIT;
        if (wantsGpu) {
            // Kubernetes NVIDIA plugins allocate entire GPU devices
            // so `gpuMemory > 0` maps to "one GPU"
            resources.requests['nvidia.com/gpu'] = '1';
            resources.limits['nvidia.com/gpu'] = '1';
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const container: Record<string, any> = {
            name: 'main',
            image: template.image_name,
            env: [
                {
                    name: 'KLEINKRAM_API_KEY',
                    valueFrom: {
                        secretKeyRef: {
                            name: apiKeySecretNameForAction(action.uuid),
                            key: 'apikey',
                        },
                    },
                },
                {
                    name: 'PROJECT_UUID',
                    value: action.mission.project?.uuid ?? '',
                },
                { name: 'MISSION_UUID', value: action.mission.uuid },
                { name: 'ACTION_UUID', value: action.uuid },
                { name: 'API_ENDPOINT', value: environment.BACKEND_URL },
                { name: 'S3_ENDPOINT', value: environment.S3_ENDPOINT },
            ],
            resources,
            securityContext: {
                capabilities: { drop: ['ALL'] },
                allowPrivilegeEscalation: false,
            },
            volumeMounts: [{ name: OUTPUT_VOLUME_NAME, mountPath: '/out' }],
        };
        if (template.entrypoint) container.command = [template.entrypoint];
        if (template.command) container.args = template.command.split(' ');

        const volumes = [
            {
                name: OUTPUT_VOLUME_NAME,
                emptyDir: { sizeLimit: OUTPUT_VOLUME_SIZE_LIMIT },
            },
        ];
        const outputs = {
            artifacts: [
                {
                    name: 'results',
                    path: '/out',
                    archive: { none: {} },
                    s3: { key: action.uuid },
                },
            ],
        };

        const { entrypoint, templates } = this.buildEntrypointAndTemplates(
            node,
            wantsGpu,
            container,
            volumes,
            outputs,
        );

        return {
            apiVersion: `${ARGO_GROUP}/${ARGO_VERSION}`,
            kind: 'Workflow',
            metadata: {
                name: workflowName,
                namespace: actionsNamespace(),
                labels: {
                    [ACTION_MANAGED_BY_LABEL_KEY]:
                        ACTION_MANAGED_BY_LABEL_VALUE,
                    [ACTION_UUID_LABEL]: action.uuid,
                    ...(node
                        ? {
                              [`${KLEINKRAM_LOCAL_LABEL_PREFIX}/home-node`]:
                                  action.homeNode ?? node,
                              [`${KLEINKRAM_LOCAL_LABEL_PREFIX}/dispatch-node`]: node,
                              [`${KLEINKRAM_LOCAL_LABEL_PREFIX}/dispatch-kind`]:
                                  action.dispatchKind ?? ActionDispatchKind.LOCAL,
                          }
                        : {}),
                },
            },
            spec: {
                entrypoint,
                serviceAccountName: actionPodServiceAccount(),
                executor: {
                    serviceAccountName: actionExecutorServiceAccount(),
                },
                activeDeadlineSeconds,
                podGC: { strategy: 'OnWorkflowCompletion' },
                ttlStrategy: { secondsAfterCompletion: 86_400 },
                artifactRepositoryRef: {
                    configMap: ARTIFACT_REPOSITORY_CONFIGMAP,
                    key: 'artifactRepository',
                },
                podMetadata: {
                    labels: {
                        /* eslint-disable @typescript-eslint/naming-convention */
                        action_run_uuid: action.uuid,
                        action_template_uuid: template.uuid,
                        mission_uuid: action.mission.uuid,
                        ...(action.triggerUuid
                            ? { action_trigger_uuid: action.triggerUuid }
                            : {}),
                        /* eslint-enable @typescript-eslint/naming-convention */
                    },
                },
                templates,
            },
        };
    }

    /**
     * Builds the Workflow's `entrypoint` and single `run-action` template.
     * With `node` given: hard-pinned via `nodeSelector` (spec §9.2), plus
     * the GPU taint's toleration if this template wants a GPU - previously
     * implicit via Kueue's GPU ResourceFlavor (helm/kleinkram/values.yaml),
     * which no longer admits this pod, so this must set it directly or GPU
     * Actions would never schedule. Without `node`: unconstrained, exactly
     * as before locality scheduling existed.
     */
    private buildEntrypointAndTemplates(
        node: string | undefined,
        wantsGpu: boolean,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        container: Record<string, any>,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        volumes: Record<string, any>[],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        outputs: Record<string, any>,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ): { entrypoint: string; templates: Record<string, any>[] } {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const template: Record<string, any> = {
            name: 'run-action',
            container,
            volumes,
            outputs,
        };
        if (node) {
            template.podSpecPatch = JSON.stringify({
                // eslint-disable-next-line @typescript-eslint/naming-convention
                nodeSelector: { 'kubernetes.io/hostname': node },
                ...(wantsGpu
                    ? {
                          tolerations: [
                              { key: gpuTaintKey(), operator: 'Exists', effect: 'NoSchedule' },
                          ],
                      }
                    : {}),
            });
        }
        return { entrypoint: 'run-action', templates: [template] };
    }
}
