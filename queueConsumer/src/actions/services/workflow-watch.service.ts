import { ActionEntity } from '@kleinkram/backend-common/entities/action/action.entity';
import { ApiKeyEntity } from '@kleinkram/backend-common/entities/auth/api-key.entity';
import { ActionState } from '@kleinkram/shared';
import * as k8s from '@kubernetes/client-node';
import {
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import {
    ACTION_MANAGED_BY_LABEL_SELECTOR,
    ACTION_UUID_LABEL,
    actionsNamespace,
    apiKeySecretNameForAction,
    ARGO_GROUP,
    ARGO_VERSION,
    getCoreV1Api,
    getCustomObjectsApi,
    getKubeConfig,
} from '../helper/kube-client';
import { ActionErrorHintService } from './action-error-hint.service';
import { ArtifactStatusService } from './artifact-status.service';
import { ResourceUsageService } from './resource-usage.service';

interface WorkflowNode {
    type?: string;
    phase?: string;
    startedAt?: string;
    finishedAt?: string;
}

interface WorkflowObject {
    metadata?: { name?: string; labels?: Record<string, string> };
    // `nodes` is deliberately left out of this type literal (rather than
    // typed as Record<string, WorkflowNode>): ArtifactStatusService declares
    // its own unrelated WorkflowNode shape for the same `status` object, and
    // having two structurally-disjoint `nodes` types on this shared object
    // trips TS's weak-type-detection check. Read via findPodNode() instead.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    status?: Record<string, any> & {
        phase?: string;
        message?: string;
        startedAt?: string;
        finishedAt?: string;
    };
}

/**
 * Watches Argo Workflow objects and copies their phase into ActionEntity.state
 *
 * Fixes ActionEntity resources stuck in STARTING/PROCESSING with no backing Workflow
 */
@Injectable()
export class WorkflowWatchService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(WorkflowWatchService.name);
    private abortController: AbortController | undefined;
    private stopped = false;

    constructor(
        @InjectRepository(ActionEntity)
        private actionRepository: Repository<ActionEntity>,
        @InjectRepository(ApiKeyEntity)
        private apikeyRepository: Repository<ApiKeyEntity>,
        private readonly artifactStatusService: ArtifactStatusService,
        private readonly resourceUsageService: ResourceUsageService,
        private readonly actionErrorHintService: ActionErrorHintService,
    ) {}

    onModuleInit(): void {
        void this.watchLoop();
    }

    onModuleDestroy(): void {
        this.stopped = true;
        this.abortController?.abort();
    }

    private async watchLoop(): Promise<void> {
        while (!this.stopped) {
            try {
                await this.watchOnce();
            } catch (error) {
                this.logger.error(
                    `Workflow watch stream failed, restarting in 5s: ${String(error)}`,
                );
            }
            if (!this.stopped) {
                await new Promise((resolve) => setTimeout(resolve, 5000));
            }
        }
    }

    private async watchOnce(): Promise<void> {
        const path = `/apis/${ARGO_GROUP}/${ARGO_VERSION}/namespaces/${actionsNamespace()}/workflows`;
        this.abortController = new AbortController();

        const watch = new k8s.Watch(getKubeConfig());

        await new Promise<void>((resolve, reject) => {
            watch
                .watch(
                    path,
                    { labelSelector: ACTION_MANAGED_BY_LABEL_SELECTOR },
                    (_phase: string, object: WorkflowObject) => {
                        void this.handleEvent(object).catch(
                            (error: unknown) => {
                                this.logger.error(
                                    `Failed to handle Workflow event: ${String(error)}`,
                                );
                            },
                        );
                    },
                    (error: unknown) => {
                        if (error)
                            reject(
                                error instanceof Error
                                    ? error
                                    : new Error(String(error)),
                            );
                        else resolve();
                    },
                )
                .then((request) => {
                    this.abortController?.signal.addEventListener(
                        'abort',
                        () => {
                            request.abort();
                            resolve();
                        },
                    );
                })
                .catch(reject);
        });
    }

    private async handleEvent(workflow: WorkflowObject): Promise<void> {
        const actionUuid = workflow.metadata?.labels?.[ACTION_UUID_LABEL];
        const phase = workflow.status?.phase;
        if (!actionUuid || !phase) return;

        const action = await this.actionRepository.findOne({
            where: { uuid: actionUuid },
            relations: { template: true },
        });
        if (!action) return;

        if (action.state === ActionState.CANCELLED) {
            if (this.isTerminalPhase(phase)) {
                await this.cleanupRun(actionUuid);
            }
            return;
        }

        switch (phase) {
            case 'Pending': {
                return;
            }
            case 'Running': {
                // The Pod node's phase/startedAt tracks the real Pod
                // lifecycle, so use that to tell "queued" apart from
                // "actually running" wherever node info is available.
                const podNode = this.findPodNode(workflow);
                const stillQueued =
                    podNode !== undefined &&
                    podNode.phase !== 'Running' &&
                    !podNode.startedAt;
                if (stillQueued) return;

                if (action.state !== ActionState.PROCESSING) {
                    const startedAt =
                        this.parseDate(podNode?.startedAt) ??
                        this.parseDate(workflow.status?.startedAt);
                    await this.actionRepository.update(
                        { uuid: actionUuid },
                        {
                            state: ActionState.PROCESSING,
                            // eslint-disable-next-line @typescript-eslint/naming-convention
                            state_cause: 'Action is currently running...',
                            executionStartedAt:
                                action.executionStartedAt ?? startedAt,
                            actionContainerStartedAt:
                                action.actionContainerStartedAt ?? startedAt,
                        },
                    );
                }
                return;
            }
            case 'Succeeded':
            case 'Failed':
            case 'Error': {
                await this.finalize(action, workflow, phase);
                return;
            }
            default: {
                this.logger.debug(
                    `Unhandled Workflow phase '${phase}' for action ${actionUuid}`,
                );
            }
        }
    }

    private async finalize(
        action: ActionEntity,
        workflow: WorkflowObject,
        phase: string,
    ): Promise<void> {
        const finished =
            this.parseDate(workflow.status?.finishedAt) ?? new Date();
        const succeeded = phase === 'Succeeded';
        const stateCause = succeeded
            ? 'Completed Successfully'
            : this.deriveFailureCause(workflow, phase);

        await this.actionRepository.update(
            { uuid: action.uuid },
            {
                state: succeeded ? ActionState.DONE : ActionState.FAILED,
                // eslint-disable-next-line @typescript-eslint/naming-convention
                state_cause: stateCause,
                executionEndedAt: finished,
                actionContainerExitedAt: finished,
            },
        );

        await this.artifactStatusService.recordFromWorkflowStatus(
            action.uuid,
            workflow.status ?? {},
        );

        // Query Prometheus over the Pod's actual run window, not the
        // Workflow's (which starts counting as soon as Argo begins
        // orchestrating, before Kueue admits the Pod) — otherwise the queue
        // wait gets averaged into CPU/memory usage as if it were idle runtime.
        if (action.template && action.actionContainerStartedAt) {
            const memoryLimitBytes =
                action.template.cpuMemory * 1024 * 1024 * 1024;
            await this.resourceUsageService.recordUsage(
                action.uuid,
                memoryLimitBytes,
                action.actionContainerStartedAt,
                finished,
            );
        }

        if (!succeeded) {
            void this.actionErrorHintService.assess(action.uuid);
        }

        await this.cleanupRun(action.uuid);
    }

    private deriveFailureCause(
        workflow: WorkflowObject,
        phase: string,
    ): string {
        const message = workflow.status?.message;
        if (message?.includes('OOMKilled')) {
            return 'Container killed (OOMKilled). Exceeded memory limit.';
        }
        if (message?.toLowerCase().includes('deadline')) {
            return 'Action exceeded its maximum runtime.';
        }
        return message
            ? `Workflow ${phase.toLowerCase()}: ${message}`
            : `Workflow ${phase.toLowerCase()} with no further detail from Argo.`;
    }

    /** Deletes the per-run API key Secret and disposes the ApiKeyEntity */
    private async cleanupRun(actionUuid: string): Promise<void> {
        try {
            await getCoreV1Api().deleteNamespacedSecret({
                name: apiKeySecretNameForAction(actionUuid),
                namespace: actionsNamespace(),
            });
        } catch (error) {
            this.logger.debug(
                `Secret cleanup for action ${actionUuid} skipped: ${String(error)}`,
            );
        }

        const apiKey = await this.apikeyRepository.findOne({
            where: { action: { uuid: actionUuid }, deletedAt: IsNull() },
        });
        if (apiKey) {
            apiKey.deletedAt = new Date();
            await this.apikeyRepository.save(apiKey);
        }
    }

    private findPodNode(workflow: WorkflowObject): WorkflowNode | undefined {
        const nodes = workflow.status?.nodes as
            Record<string, WorkflowNode> | undefined;
        if (!nodes) return undefined;
        return Object.values(nodes).find((node) => node.type === 'Pod');
    }

    private isTerminalPhase(phase: string): boolean {
        return phase === 'Succeeded' || phase === 'Failed' || phase === 'Error';
    }

    private parseDate(value: string | undefined): Date | undefined {
        if (!value) return undefined;
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? undefined : date;
    }

    /**
     * Crash detection: an ActionEntity stuck in STARTING/PROCESSING with no
     * backing Workflow object is reconciled to FAILED
     */
    @Cron(CronExpression.EVERY_5_MINUTES)
    async reconcileStuckActions(): Promise<void> {
        const stuck = await this.actionRepository.find({
            where: {
                state: In([ActionState.STARTING, ActionState.PROCESSING]),
                workflowName: Not(IsNull()),
            },
        });

        for (const action of stuck) {
            if (!action.workflowName) continue;
            try {
                await getCustomObjectsApi().getNamespacedCustomObject({
                    group: ARGO_GROUP,
                    version: ARGO_VERSION,
                    namespace: actionsNamespace(),
                    plural: 'workflows',
                    name: action.workflowName,
                });
            } catch (error) {
                const httpError = error as {
                    code?: number;
                    statusCode?: number;
                };
                if (httpError.code === 404 || httpError.statusCode === 404) {
                    this.logger.warn(
                        `Action ${action.uuid} was ${action.state} with no backing Workflow ${action.workflowName}; marking FAILED`,
                    );
                    await this.actionRepository.update(
                        { uuid: action.uuid },
                        {
                            state: ActionState.FAILED,
                            // eslint-disable-next-line @typescript-eslint/naming-convention
                            state_cause:
                                'Workflow no longer exists (crashed or was deleted out-of-band)',
                            executionEndedAt: new Date(),
                        },
                    );
                    await this.cleanupRun(action.uuid);
                }
            }
        }
    }
}
