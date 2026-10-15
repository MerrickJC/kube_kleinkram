import { rankForJob } from '../../src/actions/dispatcher/ranking';

describe('rankForJob', () => {
    test('should return a home plus fallbackDepth - 1 fallbacks', () => {
        const { home, fallbacks } = rankForJob(
            'mission-1',
            ['node-a', 'node-b', 'node-c', 'node-d'],
            3,
        );
        expect(['node-a', 'node-b', 'node-c', 'node-d']).toContain(home);
        expect(fallbacks).toHaveLength(2);
        expect(fallbacks).not.toContain(home);
    });

    test('should cap fallbacks at the number of remaining eligible nodes', () => {
        const { fallbacks } = rankForJob('mission-1', ['node-a', 'node-b'], 5);
        expect(fallbacks).toHaveLength(1);
    });

    test('should throw on an empty eligible node set rather than silently picking undefined', () => {
        expect(() => rankForJob('mission-1', [], 3)).toThrow();
    });
});
