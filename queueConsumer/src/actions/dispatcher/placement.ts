import { fits, subtractVector } from './capacity';
import type { JobRecord, ResourceVector } from './types';

export interface LocalFillResult {
    /** Jobs to dispatch onto this node, in the order to apply them */
    dispatches: JobRecord[];
    /**
     * True when this node's head job doesn't fit and has waited past
     * RESERVE_AFTER_S: a whole-node reservation (spec §8.4, simplified per
     * the plan's cut-line to guard the whole node rather than threading a
     * reservation vector through every fits() call). While true, no local
     * job - including smaller backfill candidates - is dispatched here,
     * and callers must also refuse steals onto this node, so freed
     * capacity accumulates until the head fits.
     */
    blockedOnHead: boolean;
}

/** The backfill scan shared by localFill and the forced-unblock path below */
export function forcedBackfill(
    queueJobs: readonly JobRecord[],
    freeCapacity: ResourceVector,
): JobRecord[] {
    let free = freeCapacity;
    const dispatches: JobRecord[] = [];
    for (const job of queueJobs) {
        if (fits(job.request, free)) {
            dispatches.push(job);
            free = subtractVector(free, job.request);
        }
    }
    return dispatches;
}

/**
 * Step A (spec §8.3): fills a node's free capacity from its own queue,
 * oldest-first, allowing later (smaller) jobs to backfill ahead of an
 * earlier job that doesn't currently fit - unless that earlier job is the
 * head and has been waiting long enough to trigger the head-of-line guard.
 *
 * The cluster-wide cap on simultaneously blocked nodes (plan risk #8) is
 * enforced by the caller, which re-runs forcedBackfill() for any node this
 * function reports as blocked once the cap is already reached elsewhere.
 */
export function localFill(
    queueJobs: readonly JobRecord[],
    freeCapacity: ResourceVector,
    reserveAfterSeconds: number,
    now: Date,
): LocalFillResult {
    if (queueJobs.length > 0) {
        const head = queueJobs[0];
        if (!fits(head.request, freeCapacity)) {
            const waitedSeconds = (now.getTime() - head.enqueuedAt.getTime()) / 1000;
            if (waitedSeconds > reserveAfterSeconds) {
                return { dispatches: [], blockedOnHead: true };
            }
        }
    }

    return { dispatches: forcedBackfill(queueJobs, freeCapacity), blockedOnHead: false };
}

export interface StealCandidate {
    job: JobRecord;
    sourceNode: string;
}

/**
 * rank of `node` in `job`'s preference list: 0 = home, 1..N = fallback
 * position, else "not listed" (spec §8.3 candidate tie-break #1).
 */
function rankOfNodeForJob(job: JobRecord, node: string): number {
    if (job.home === node) return 0;
    const fallbackIndex = job.fallbacks.indexOf(node);
    return fallbackIndex === -1 ? Number.MAX_SAFE_INTEGER : fallbackIndex + 1;
}

/**
 * Step B (spec §8.3), simplified per the plan's cut-line: no EWMA
 * throughput, scan limits, gang-steal or priority factors - at this
 * deployment's queue depths (tens, not thousands) a linear scan of every
 * other node's queue is microseconds, so the spec's bounded-search
 * machinery buys nothing here.
 *
 * `throughputPerSecond` is a simple proxy supplied by the caller
 * (concurrency on that node / AVG_RUNTIME_S - see dispatcher.config.ts),
 * not an EWMA over completion events.
 *
 * Steal rule: a job J queued on node M is worth moving onto `targetNode`
 * only if J's expected wait at home exceeds the miss penalty of running
 * it elsewhere. Because expected wait grows with queue position, the
 * first stealable job in a queue is also the best one to take from it
 * (spec §8.3: "every job at or after the first qualifying position is
 * also stealable" -> take the first, moving on to the next source queue).
 */
export function findStealCandidate(
    targetNode: string,
    freeCapacity: ResourceVector,
    otherQueues: ReadonlyMap<string, readonly JobRecord[]>,
    throughputPerSecond: ReadonlyMap<string, number>,
    missPenaltySeconds: number,
): StealCandidate | undefined {
    let best: StealCandidate | undefined;
    let bestRank = Infinity;

    for (const [sourceNode, jobs] of otherQueues) {
        if (sourceNode === targetNode) continue;
        const throughput = throughputPerSecond.get(sourceNode) ?? 0;

        for (const [position, job] of jobs.entries()) {
            if (!fits(job.request, freeCapacity)) continue;
            const expectedWaitSeconds =
                throughput > 0 ? (position + 1) / throughput : Infinity;
            if (expectedWaitSeconds <= missPenaltySeconds) continue;

            const rank = rankOfNodeForJob(job, targetNode);
            const better =
                !best ||
                rank < bestRank ||
                (rank === bestRank && job.enqueuedAt.getTime() < best.job.enqueuedAt.getTime());
            if (better) {
                best = { job, sourceNode };
                bestRank = rank;
            }
            break; // best (first qualifying) candidate from this queue
        }
    }
    return best;
}
