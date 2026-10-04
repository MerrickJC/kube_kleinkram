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
    WORKFLOW_PLURAL,
    workflowNameForAction,
} from '../helper/kube-client';
import { ImageResolutionService } from './image-resolution.service';

const KUEUE_LOCAL_QUEUE = process.env.KUEUE_LOCAL_QUEUE ?? 'kleinkram-actions';
const ARTIFACT_REPOSITORY_CONFIGMAP =
    process.env.ARGO_ARTIFACT_REPOSITORY_CONFIGMAP ??
    'kleinkram-artifact-repository';

/**
 * Consumes `submit-action` jobs from the dispatch queue and turns an
 * ActionEntity into an Argo Workflow
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
            state_cause: 'Workflow submitted, waiting for Kueue admission',
            workflowName,
            image,
        });

        logger.info(
            `Submitted Argo Workflow ${workflowName} for action ${action.uuid}`,
        );
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

    private buildWorkflowManifest(
        action: ActionEntity,
        template: ActionTemplateEntity,
        workflowName: string,
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
        };
        if (template.entrypoint) container.command = [template.entrypoint];
        if (template.command) container.args = template.command.split(' ');

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
                },
            },
            spec: {
                entrypoint: 'run-action',
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
                        'kueue.x-k8s.io/queue-name': KUEUE_LOCAL_QUEUE,
                        action_run_uuid: action.uuid,
                        action_template_uuid: template.uuid,
                        mission_uuid: action.mission.uuid,
                        ...(action.triggerUuid
                            ? { action_trigger_uuid: action.triggerUuid }
                            : {}),
                        /* eslint-enable @typescript-eslint/naming-convention */
                    },
                },
                templates: [
                    {
                        name: 'run-action',
                        container,
                        outputs: {
                            artifacts: [{ name: 'results', path: '/out' }],
                        },
                    },
                ],
            },
        };
    }
}
