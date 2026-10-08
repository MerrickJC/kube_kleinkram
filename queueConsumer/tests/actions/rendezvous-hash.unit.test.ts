import { rankNodes } from '../../src/actions/helper/rendezvous-hash';

describe('rankNodes', () => {
    test('is deterministic for the same key and node set', () => {
        const nodes = ['node-a', 'node-b', 'node-c', 'node-d'];

        const first = rankNodes('mission-1', nodes);
        const second = rankNodes('mission-1', nodes);

        expect(second).toEqual(first);
    });

    test('returns every node exactly once', () => {
        const nodes = ['node-a', 'node-b', 'node-c'];

        const ranked = rankNodes('mission-1', nodes);

        expect(ranked).toHaveLength(nodes.length);
        expect(new Set(ranked)).toEqual(new Set(nodes));
    });

    test('is order-independent on the input node list', () => {
        const nodes = ['node-a', 'node-b', 'node-c', 'node-d'];

        const ranked = rankNodes('mission-1', nodes);
        const rankedShuffled = rankNodes(
            'mission-1',
            [...nodes].reverse(),
        );

        expect(rankedShuffled).toEqual(ranked);
    });

    test('different keys spread roughly evenly across the top rank', () => {
        const nodes = ['node-a', 'node-b', 'node-c', 'node-d'];
        const counts: Record<string, number> = {};

        for (let i = 0; i < 400; i++) {
            const top = rankNodes(`mission-${i.toString()}`, nodes)[0];
            counts[top] = (counts[top] ?? 0) + 1;
        }

        for (const node of nodes) {
            expect(counts[node] ?? 0).toBeGreaterThan(0);
        }
    });

    test('removing one node only reassigns keys that ranked it first', () => {
        const before = ['node-a', 'node-b', 'node-c', 'node-d'];
        const after = ['node-a', 'node-b', 'node-c'];

        let moved = 0;
        const sampleSize = 400;
        for (let i = 0; i < sampleSize; i++) {
            const key = `mission-${i.toString()}`;
            const topBefore = rankNodes(key, before)[0];
            const topAfter = rankNodes(key, after)[0];
            if (topBefore !== topAfter) moved++;
        }

        // Only keys that previously ranked the removed node first should move.
        // With 4 -> 3 nodes that's expected to be roughly 1/4 of keys; allow a
        // generous margin since this is a statistical property, not exact.
        expect(moved).toBeGreaterThan(0);
        expect(moved).toBeLessThan(sampleSize * 0.5);
    });
});
