import type { JobRecord } from './types';

/**
 * A single node's FIFO backlog. Plain array, not a b-tree/skip-list: at this
 * deployment's scale (backlogs in the tens, not the spec's 100k) an O(n)
 * insert-sorted-by-age is microseconds and needs no new dependency.
 *
 * No priority field exists on ActionEntity today, so ordering is purely by
 * enqueuedAt (oldest first) - see the plan's cut-line for §8.5.
 */
export class NodeQueue {
    private jobs: JobRecord[] = [];

    get size(): number {
        return this.jobs.length;
    }

    /** Ordered oldest-first; callers must not mutate the returned array */
    peekAll(): readonly JobRecord[] {
        return this.jobs;
    }

    head(): JobRecord | undefined {
        return this.jobs[0];
    }

    insert(job: JobRecord): void {
        this.jobs.push(job);
        this.jobs.sort((a, b) => a.enqueuedAt.getTime() - b.enqueuedAt.getTime());
    }

    remove(actionUuid: string): JobRecord | undefined {
        const index = this.jobs.findIndex((job) => job.actionUuid === actionUuid);
        if (index === -1) return undefined;
        const [removed] = this.jobs.splice(index, 1);
        return removed;
    }

    positionOf(actionUuid: string): number {
        return this.jobs.findIndex((job) => job.actionUuid === actionUuid);
    }
}

/** Owns every node's NodeQueue, keyed by node name */
export class JobQueueStore {
    private queues = new Map<string, NodeQueue>();

    queueFor(node: string): NodeQueue {
        let queue = this.queues.get(node);
        if (!queue) {
            queue = new NodeQueue();
            this.queues.set(node, queue);
        }
        return queue;
    }

    nodes(): string[] {
        return [...this.queues.keys()];
    }

    allEntries(): ReadonlyMap<string, readonly JobRecord[]> {
        const result = new Map<string, readonly JobRecord[]>();
        for (const [node, queue] of this.queues) {
            result.set(node, queue.peekAll());
        }
        return result;
    }

    removeJobEverywhere(actionUuid: string): JobRecord | undefined {
        for (const queue of this.queues.values()) {
            const removed = queue.remove(actionUuid);
            if (removed) return removed;
        }
        return undefined;
    }

    /**
     * Re-ranks every currently queued job against the (changed) eligible
     * node set (spec §8.1): jobs move to a new home queue but keep their
     * enqueuedAt, so a node add/remove doesn't reset anyone's queue age.
     */
    rerank(rank: (job: JobRecord) => { home: string; fallbacks: string[] }): void {
        const allJobs = [...this.queues.values()].flatMap((queue) => queue.peekAll());
        this.queues.clear();
        for (const job of allJobs) {
            const { home, fallbacks } = rank(job);
            job.home = home;
            job.fallbacks = fallbacks;
            this.queueFor(home).insert(job);
        }
    }
}
