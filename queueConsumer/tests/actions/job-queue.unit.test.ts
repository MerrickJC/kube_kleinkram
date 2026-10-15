import { emptyVector } from '../../src/actions/dispatcher/capacity';
import { JobQueueStore, NodeQueue } from '../../src/actions/dispatcher/job-queue';
import type { JobRecord } from '../../src/actions/dispatcher/types';

let counter = 0;
function job(ageSeconds: number, home = 'node-a'): JobRecord {
    counter += 1;
    return {
        actionUuid: `job-${counter.toString()}`,
        dataKey: 'mission-1',
        jobClass: 'cpu',
        request: emptyVector(),
        enqueuedAt: new Date(Date.now() - ageSeconds * 1000),
        home,
        fallbacks: [],
    };
}

describe('NodeQueue', () => {
    test('should keep jobs ordered oldest-first regardless of insertion order', () => {
        const queue = new NodeQueue();
        const newer = job(5);
        const older = job(50);
        queue.insert(newer);
        queue.insert(older);
        expect(queue.peekAll().map((j) => j.actionUuid)).toEqual([
            older.actionUuid,
            newer.actionUuid,
        ]);
    });

    test('should remove a job by id and report its new absence via positionOf', () => {
        const queue = new NodeQueue();
        const target = job(1);
        queue.insert(target);
        expect(queue.remove(target.actionUuid)).toBe(target);
        expect(queue.positionOf(target.actionUuid)).toBe(-1);
        expect(queue.size).toBe(0);
    });
});

describe('JobQueueStore', () => {
    test('should create a queue on first access and reuse it afterward', () => {
        const store = new JobQueueStore();
        const queue = store.queueFor('node-a');
        queue.insert(job(1));
        expect(store.queueFor('node-a').size).toBe(1);
        expect(store.nodes()).toEqual(['node-a']);
    });

    test('should find and remove a job regardless of which node queue holds it', () => {
        const store = new JobQueueStore();
        const target = job(1, 'node-b');
        store.queueFor('node-b').insert(target);
        const removed = store.removeJobEverywhere(target.actionUuid);
        expect(removed).toBe(target);
        expect(store.queueFor('node-b').size).toBe(0);
    });

    test('should move jobs to a new home queue on rerank while preserving enqueuedAt', () => {
        const store = new JobQueueStore();
        const moved = job(42, 'node-a');
        store.queueFor('node-a').insert(moved);

        store.rerank(() => ({ home: 'node-b', fallbacks: ['node-c'] }));

        expect(store.queueFor('node-a').size).toBe(0);
        expect(store.queueFor('node-b').size).toBe(1);
        const [rerankedJob] = store.queueFor('node-b').peekAll();
        expect(rerankedJob?.actionUuid).toBe(moved.actionUuid);
        expect(rerankedJob?.enqueuedAt).toEqual(moved.enqueuedAt);
        expect(rerankedJob?.fallbacks).toEqual(['node-c']);
    });
});
