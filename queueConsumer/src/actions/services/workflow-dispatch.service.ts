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
import type { V1Node } from '@kubernetes/client-node';
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
    isNodeReadySchedulable,
    labelSelectorToMatchExpressions,
    listCacheTierNodes,
    localityEnabled,
    localityFallbackRetryLimit,
    localityGpuNodeLabelSelector,
    localityNodeLabelSelector,
    localityTierSizes,
    type NodeSelectorRequirement,
    WORKFLOW_PLURAL,
    workflowNameForAction,
} from '../helper/kube-client';
import { rankNodes } from '../helper/rendezvous-hash';
import { ImageResolutionService } from './image-resolution.service';

// Cluster membership is assumed stable on the order of minutes, so this just
// avoids a Kubernetes API round-trip on every single dispatch.
const NODE_LIST_CACHE_TTL_MS = 30_000;

const KUEUE_LOCAL_QUEUE = process.env.KUEUE_LOCAL_QUEUE ?? 'kleinkram-actions';
const ARTIFACT_REPOSITORY_CONFIGMAP =
    process.env.ARGO_ARTIFACT_REPOSITORY_CONFIGMAP ??
    'kleinkram-artifact-repository';
// Actions aren't trusted to create their own output directory (they may run
// as a non-root user that can't mkdir at the image's filesystem root), so
// /out is backed by an emptyDir volume instead. The size limit is fixed for
// now since ActionTemplateEntity has no per-template disk quota field.
const OUTPUT_VOLUME_NAME = 'out';
const OUTPUT_VOLUME_SIZE_LIMIT =
    process.env.ACTION_OUTPUT_VOLUME_SIZE_LIMIT ?? '10Gi';

interface PreferredAffinityTerm {
    weight: number;
    preference: {
        matchExpressions: { key: string; operator: 'In'; values: string[] }[];
    };
}

/**
 * Consumes `submit-action` jobs from the dispatch queue and turns an
 * ActionEntity into an Argo Workflow
 */
@Processor(ACTION_DISPATCH_QUEUE_NAME)
@Injectable()
export class WorkflowDispatchService {
    private nodeCache: { nodes: V1Node[]; expiresAt: number } | undefined;

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
        const manifest = await this.buildWorkflowManifest(
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

    /**
     * Returns the cache-tier node list (nodes matching
     * `localityNodeLabelSelector()`), refetching only after
     * NODE_LIST_CACHE_TTL_MS has elapsed since the last successful fetch.
     */
    private async getCacheTierNodes(): Promise<V1Node[]> {
        const now = Date.now();
        if (this.nodeCache && this.nodeCache.expiresAt > now) {
            return this.nodeCache.nodes;
        }
        const nodes = await listCacheTierNodes(localityNodeLabelSelector());
        this.nodeCache = { nodes, expiresAt: now + NODE_LIST_CACHE_TTL_MS };
        return nodes;
    }

    /**
     * Computes the ranked, strict locality tiers (top 1, top 2, top 4, ...
     * cache-tier nodes by rendezvous hash on `missionUuid`) plus the final
     * tier's label-selector matchExpressions, so an Action pod widens from
     * a hard requirement on its best-ranked JuiceFS-cache node out to the
     * full cache-tier pool rather than silently landing anywhere once the
     * top-ranked nodes are full. Also computes a shared, weighted preferred
     * ranking (same formula as the old soft-only affinity) that's layered
     * onto every tier's required constraint, so if several of a tier's
     * allowed nodes happen to be free at once, the scheduler still leans
     * toward the best-ranked one rather than picking among them arbitrarily.
     *
     * Returns undefined on any error, disablement, or when no eligible
     * node is found at all (no affinity added, workflow dispatches as a
     * single unconstrained step, same as before this feature existed)
     */
    private async computeLocalityTiers(
        missionUuid: string,
        wantsGpu: boolean,
    ): Promise<
        | {
              strictTiers: string[][];
              finalSelectorExpressions: NodeSelectorRequirement[];
              preferredTerms: PreferredAffinityTerm[];
          }
        | undefined
    > {
        if (!localityEnabled()) return undefined;

        let nodes: V1Node[];
        try {
            nodes = await this.getCacheTierNodes();
        } catch (error) {
            logger.warn(
                `Failed to list cache-tier nodes, skipping locality affinity: ${String(error)}`,
            );
            return undefined;
        }

        const schedulable = nodes.filter((node) =>
            isNodeReadySchedulable(node),
        );
        const eligible = wantsGpu
            ? schedulable.filter((node) => {
                  const selector = localityGpuNodeLabelSelector();
                  const eqIndex = selector.indexOf('=');
                  const gpuLabelKey =
                      eqIndex === -1 ? selector : selector.slice(0, eqIndex);
                  const gpuLabelValue =
                      eqIndex === -1 ? '' : selector.slice(eqIndex + 1);
                  return node.metadata?.labels?.[gpuLabelKey] === gpuLabelValue;
              })
            : schedulable;

        const nodeNames = eligible
            .map(
                (node) =>
                    node.metadata?.labels?.['kubernetes.io/hostname'] ??
                    node.metadata?.name,
            )
            .filter((name): name is string => Boolean(name));

        if (nodeNames.length === 0) return undefined;

        const ranked = rankNodes(missionUuid, nodeNames);

        const strictTiers: string[][] = [];
        let lastSize = 0;
        for (const size of localityTierSizes()) {
            const cappedSize = Math.min(size, ranked.length);
            if (cappedSize <= lastSize) continue;
            strictTiers.push(ranked.slice(0, cappedSize));
            lastSize = cappedSize;
            if (cappedSize === ranked.length) break;
        }

        const finalSelectorExpressions = labelSelectorToMatchExpressions(
            localityNodeLabelSelector(),
        );
        if (wantsGpu) {
            finalSelectorExpressions.push(
                ...labelSelectorToMatchExpressions(
                    localityGpuNodeLabelSelector(),
                ),
            );
        }

        // Weights halve per rank (100, 50, 25, ...) and floor out at 1, so
        // nodes beyond the largest configured tier size are indistinguishable
        // anyway - cap the list there rather than weighting every eligible
        // node for no practical benefit.
        const preferredCap = Math.max(...localityTierSizes());
        const preferredTerms = ranked
            .slice(0, preferredCap)
            .map((nodeName, rank) => ({
                weight: Math.max(1, Math.floor(100 / 2 ** rank)),
                preference: {
                    matchExpressions: [
                        {
                            key: 'kubernetes.io/hostname',
                            operator: 'In' as const,
                            values: [nodeName],
                        },
                    ],
                },
            }));

        return { strictTiers, finalSelectorExpressions, preferredTerms };
    }

    /**
     * Builds a podSpecPatch combining a hard requirement (narrows the
     * feasible node set to this tier) with the shared weighted preference
     * (scores whichever of those nodes are actually free), so a tier never
     * schedules outside its allowed nodes but still favors the best-ranked
     * one among them when several are available at once.
     */
    private affinityPatch(
        requiredNodeSelectorTerms: { matchExpressions: NodeSelectorRequirement[] }[],
        preferredTerms: PreferredAffinityTerm[],
    ): string {
        return JSON.stringify({
            affinity: {
                nodeAffinity: {
                    requiredDuringSchedulingIgnoredDuringExecution: {
                        nodeSelectorTerms: requiredNodeSelectorTerms,
                    },
                    ...(preferredTerms.length > 0
                        ? {
                              preferredDuringSchedulingIgnoredDuringExecution:
                                  preferredTerms,
                          }
                        : {}),
                },
            },
        });
    }

    private async buildWorkflowManifest(
        action: ActionEntity,
        template: ActionTemplateEntity,
        workflowName: string,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ): Promise<Record<string, any>> {
        if (!action.mission) throw new Error('Mission is undefined');

        const activeDeadlineSeconds = Math.max(
            60,
            Math.round(template.maxRuntime * 3600),
        );
        const wantsGpu = template.gpuMemory > 0;
        const tiers = await this.computeLocalityTiers(
            action.mission.uuid,
            wantsGpu,
        );

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
            tiers,
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
                templates,
            },
        };
    }

    /**
     * Builds the Workflow's `entrypoint` and `templates`.
     *
     * With no locality tiers (feature disabled, or no eligible cache-tier
     * node found at all) this is a single unconstrained `run-action`
     * template.
     *
     * With locality tiers, it's a `main` steps template chaining one step
     * per strict ranked tier followed by a final step constrained to the
     * live cache-tier label selector (not a frozen node list, see
     * computeLocalityTiers). Each step's required constraint is layered
     * with the same shared weighted preference, so if several of that
     * step's allowed nodes are free at once, the best-ranked one still
     * wins rather than it being arbitrary. Each step is tolerated via
     * `continueOn` and gated with `when` so a step that doesn't succeed
     * widens to the next tier rather than failing the workflow outright.
     * Action containers should therefore be safe to re-run.
     */
    private buildEntrypointAndTemplates(
        tiers:
            | {
                  strictTiers: string[][];
                  finalSelectorExpressions: NodeSelectorRequirement[];
                  preferredTerms: PreferredAffinityTerm[];
              }
            | undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        container: Record<string, any>,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        volumes: Record<string, any>[],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        outputs: Record<string, any>,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ): { entrypoint: string; templates: Record<string, any>[] } {
        if (!tiers) {
            return {
                entrypoint: 'run-action',
                templates: [
                    { name: 'run-action', container, volumes, outputs },
                ],
            };
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const templates: Record<string, any>[] = [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const steps: Record<string, any>[][] = [];

        for (const [index, tierNodes] of tiers.strictTiers.entries()) {
            const stepName = `tier-${index.toString()}`;
            const templateName = `run-action-${stepName}`;
            templates.push({
                name: templateName,
                podSpecPatch: this.affinityPatch(
                    [
                        {
                            matchExpressions: [
                                {
                                    key: 'kubernetes.io/hostname',
                                    operator: 'In',
                                    values: tierNodes,
                                },
                            ],
                        },
                    ],
                    tiers.preferredTerms,
                ),
                container,
                volumes,
                outputs,
            });
            steps.push([
                {
                    name: stepName,
                    template: templateName,
                    continueOn: { error: true, failed: true },
                    ...(index > 0
                        ? {
                              when: `{{steps.tier-${(index - 1).toString()}.status}} != Succeeded`,
                          }
                        : {}),
                },
            ]);
        }

        templates.push({
            name: 'run-action-tier-cache-any',
            podSpecPatch: this.affinityPatch(
                [{ matchExpressions: tiers.finalSelectorExpressions }],
                tiers.preferredTerms,
            ),
            retryStrategy: {
                limit: localityFallbackRetryLimit(),
                retryPolicy: 'Always',
            },
            container,
            volumes,
            outputs,
        });
        steps.push([
            {
                name: 'tier-cache-any',
                template: 'run-action-tier-cache-any',
                when: `{{steps.tier-${(tiers.strictTiers.length - 1).toString()}.status}} != Succeeded`,
            },
        ]);

        templates.unshift({ name: 'main', steps });

        return { entrypoint: 'main', templates };
    }
}
