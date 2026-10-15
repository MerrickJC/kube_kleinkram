import { redis } from '@kleinkram/backend-common/consts';
import { Redis } from 'ioredis';

// WorkflowDispatchService (queue-consumer deployment) and
// LocalityDispatcherService (action-dispatcher deployment) are different
// processes/pods even when built from the same image, so "a job was
// queued/cancelled" can only cross that boundary via Redis pub/sub, not an
// in-process event emitter.
export const DISPATCH_WAKE_CHANNEL = 'kleinkram:dispatch:wake';

let publisher: Redis | undefined;

/** Fire-and-forget: a missed wake just means the next RESYNC_S tick catches it */
export async function publishDispatchWake(): Promise<void> {
    try {
        publisher ??= new Redis(redis);
        await publisher.publish(DISPATCH_WAKE_CHANNEL, '1');
    } catch {
        // best-effort only, see above
    }
}
