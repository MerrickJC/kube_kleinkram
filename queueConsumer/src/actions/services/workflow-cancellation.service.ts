import {
    ACTION_DISPATCH_QUEUE_NAME,
    ActionQueueJob,
    ActionQueueJobData,
} from '@kleinkram/backend-common/modules/action-dispatcher/action-queue.constants';
import { Process, Processor } from '@nestjs/bull';
import { Injectable } from '@nestjs/common';
import { Job } from 'bull';
import logger from '../../logger';
import { DispatchStoreService } from '../dispatcher/dispatch-store.service';
import { dispatcherEnabled } from '../dispatcher/dispatcher.config';
import { publishDispatchWake } from '../dispatcher/wake-channel';
import {
    actionsNamespace,
    ARGO_GROUP,
    ARGO_VERSION,
    getCustomObjectsApi,
    WORKFLOW_PLURAL,
    workflowNameForAction,
} from '../helper/kube-client';

interface HttpError {
    code?: number;
    statusCode?: number;
}

function isNotFound(error: unknown): boolean {
    const httpError = error as HttpError;
    return httpError.code === 404 || httpError.statusCode === 404;
}

/**
 * Consumes `cancel-action` jobs and triggers Argo's own graceful termination
 * by patching spec.shutdown: "Terminate" which triggers Argo's onExit
 * handling to delete the underlying Pod
 */
@Processor(ACTION_DISPATCH_QUEUE_NAME)
@Injectable()
export class WorkflowCancellationService {
    constructor(private readonly dispatchStore: DispatchStoreService) {}

    @Process({ name: ActionQueueJob.CANCEL, concurrency: 5 })
    async cancel(job: Job<ActionQueueJobData>): Promise<void> {
        const workflowName = workflowNameForAction(job.data.uuid);

        try {
            await getCustomObjectsApi().patchNamespacedCustomObject({
                group: ARGO_GROUP,
                version: ARGO_VERSION,
                namespace: actionsNamespace(),
                plural: WORKFLOW_PLURAL,
                name: workflowName,
                body: { spec: { shutdown: 'Terminate' } },
            });
            logger.info(`Requested termination of Workflow ${workflowName}`);
        } catch (error) {
            if (!isNotFound(error)) throw error;
            // No Workflow exists yet - ActionDispatcherService.stopAction()
            // already set state=CANCELLED, which is enough for this row to
            // drop out of the dispatcher's own queries (see
            // DispatchStoreService.loadQueuedAndDispatching), but clear
            // dispatchState too and wake it so an in-memory copy (if any) is
            // removed immediately rather than on the next periodic resync.
            logger.debug(
                `No Workflow ${workflowName} to terminate (already gone, or still queued in the dispatcher)`,
            );
            if (dispatcherEnabled()) {
                await this.dispatchStore.clearDispatchState(job.data.uuid);
                await publishDispatchWake();
            }
        }
    }
}
