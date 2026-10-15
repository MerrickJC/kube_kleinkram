import { emptyVector } from '../../src/actions/dispatcher/capacity';
import {
    findStealCandidate,
    forcedBackfill,
    localFill,
} from '../../src/actions/dispatcher/placement';
import type { JobRecord, ResourceVector } from '../../src/actions/dispatcher/types';

function vector(partial: Partial<ResourceVector>): ResourceVector {
    return { ...emptyVector(), ...partial };
}

let counter = 0;
function job(partial: Partial<JobRecord> & { cpuMilli?: number; ageSeconds?: number }): JobRecord {
    counter += 1;
    const now = new Date('2026-01-01T00:00:00Z');
    return {
        actionUuid: partial.actionUuid ?? `job-${counter.toString()}`,
        dataKey: partial.dataKey ?? 'mission-1',
        jobClass: partial.jobClass ?? 'cpu',
        request: partial.request ?? vector({ cpuMilli: partial.cpuMilli ?? 1000 }),
        enqueuedAt:
            partial.enqueuedAt ??
            new Date(now.getTime() - (partial.ageSeconds ?? 0) * 1000),
        home: partial.home ?? 'node-a',
        fallbacks: partial.fallbacks ?? [],
    };
}

const NOW = new Date('2026-01-01T00:00:00Z');

describe('Local Fill (Step A)', () => {
    test('should dispatch the head job when it fits', () => {
        const queue = [job({ cpuMilli: 1000 })];
        const result = localFill(queue, vector({ cpuMilli: 2000 }), 300, NOW);
        expect(result.dispatches).toEqual(queue);
        expect(result.blockedOnHead).toBe(false);
    });

    test('should backfill a smaller later job when the head does not fit and has not waited long', () => {
        const big = job({ cpuMilli: 4000, ageSeconds: 10 });
        const small = job({ cpuMilli: 500, ageSeconds: 5 });
        const result = localFill([big, small], vector({ cpuMilli: 1000 }), 300, NOW);
        expect(result.dispatches).toEqual([small]);
        expect(result.blockedOnHead).toBe(false);
    });

    test('should block the whole node once the head has waited past RESERVE_AFTER_S', () => {
        const big = job({ cpuMilli: 4000, ageSeconds: 301 });
        const small = job({ cpuMilli: 500, ageSeconds: 5 });
        const result = localFill([big, small], vector({ cpuMilli: 1000 }), 300, NOW);
        expect(result.dispatches).toEqual([]);
        expect(result.blockedOnHead).toBe(true);
    });

    test('should not block when the head fits even if it has waited a long time', () => {
        const head = job({ cpuMilli: 500, ageSeconds: 9999 });
        const result = localFill([head], vector({ cpuMilli: 1000 }), 300, NOW);
        expect(result.blockedOnHead).toBe(false);
        expect(result.dispatches).toEqual([head]);
    });
});

describe('forcedBackfill (cluster-wide blocked-node cap override)', () => {
    test('should dispatch smaller jobs even when an earlier job in the list does not fit', () => {
        const big = job({ cpuMilli: 4000 });
        const small = job({ cpuMilli: 500 });
        const dispatches = forcedBackfill([big, small], vector({ cpuMilli: 1000 }));
        expect(dispatches).toEqual([small]);
    });
});

describe('Steal Candidate Selection (Step B)', () => {
    test('should not steal when expected wait at home is within the miss penalty', () => {
        const queues = new Map<string, readonly JobRecord[]>([
            ['node-b', [job({ cpuMilli: 500 })]],
        ]);
        const throughput = new Map([['node-b', 1 / 10]]); // 1 job per 10s -> position 1 -> wait 10s
        const candidate = findStealCandidate(
            'node-a',
            vector({ cpuMilli: 1000 }),
            queues,
            throughput,
            60,
        );
        expect(candidate).toBeUndefined();
    });

    test('should steal the first job whose expected wait exceeds the miss penalty', () => {
        const stealable = job({ cpuMilli: 500 });
        const queues = new Map<string, readonly JobRecord[]>([['node-b', [stealable]]]);
        const throughput = new Map([['node-b', 1 / 1000]]); // position 1 -> wait 1000s > 60s penalty
        const candidate = findStealCandidate(
            'node-a',
            vector({ cpuMilli: 1000 }),
            queues,
            throughput,
            60,
        );
        expect(candidate?.job.actionUuid).toBe(stealable.actionUuid);
        expect(candidate?.sourceNode).toBe('node-b');
    });

    test('should skip a stealable job that does not fit the target node', () => {
        const tooBig = job({ cpuMilli: 5000 });
        const queues = new Map<string, readonly JobRecord[]>([['node-b', [tooBig]]]);
        const throughput = new Map([['node-b', 1 / 1000]]);
        const candidate = findStealCandidate(
            'node-a',
            vector({ cpuMilli: 1000 }),
            queues,
            throughput,
            60,
        );
        expect(candidate).toBeUndefined();
    });

    test('should prefer a candidate for which the target node ranks higher in its fallback list', () => {
        // Neither job's home is the target node ('node-a'), so this isolates
        // the fallback-position tie-break rather than the home-node short-circuit.
        const notListed = job({
            cpuMilli: 500,
            home: 'node-x',
            fallbacks: ['node-y', 'node-z'],
            ageSeconds: 100,
        });
        const nearFallback = job({
            cpuMilli: 500,
            home: 'node-x',
            fallbacks: ['node-a'],
            ageSeconds: 50,
        });
        const queues = new Map<string, readonly JobRecord[]>([
            ['node-b', [notListed]],
            ['node-c', [nearFallback]],
        ]);
        const throughput = new Map([
            ['node-b', 1 / 1000],
            ['node-c', 1 / 1000],
        ]);
        const candidate = findStealCandidate(
            'node-a',
            vector({ cpuMilli: 1000 }),
            queues,
            throughput,
            60,
        );
        expect(candidate?.job.actionUuid).toBe(nearFallback.actionUuid);
    });

    test('should never steal onto itself', () => {
        const self = job({ cpuMilli: 500 });
        const queues = new Map<string, readonly JobRecord[]>([['node-a', [self]]]);
        const throughput = new Map([['node-a', 1 / 1000]]);
        const candidate = findStealCandidate(
            'node-a',
            vector({ cpuMilli: 1000 }),
            queues,
            throughput,
            60,
        );
        expect(candidate).toBeUndefined();
    });
});
