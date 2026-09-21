/**
 * Contract shared between the backend and queue-consumer's Action Operator for dispatching/cancelling Actions.
 * Placement/admission is Kueue's job
 */
export const ACTION_DISPATCH_QUEUE_NAME = 'action-dispatch-queue';

export enum ActionQueueJob {
    SUBMIT = 'submit-action',
    CANCEL = 'cancel-action',
}

export interface ActionQueueJobData {
    uuid: string;
}
