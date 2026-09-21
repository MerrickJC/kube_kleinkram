import {
    ACTION_DISPATCH_QUEUE_NAME,
    ActionQueueJob,
    ActionQueueJobData,
} from '@kleinkram/backend-common/modules/action-dispatcher/action-queue.constants';
import { Process, Processor } from '@nestjs/bull';
import { Injectable } from '@nestjs/common';
import { Job } from 'bull';
import logger from '../../logger';
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
                // eslint-disable-next-line @typescript-eslint/naming-convention
                headers: { 'Content-Type': 'application/merge-patch+json' },
            });
            logger.info(`Requested termination of Workflow ${workflowName}`);
        } catch (error) {
            if (isNotFound(error)) {
                logger.debug(
                    `No Workflow ${workflowName} to terminate (already gone or never submitted)`,
                );
                return;
            }
            throw error;
        }
    }
}
