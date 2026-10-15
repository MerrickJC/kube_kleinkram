import {
    effectivePodRequest,
    emptyVector,
    fits,
    freeCapacity,
} from '../../src/actions/dispatcher/capacity';
import type { PodSnapshot, ResourceVector } from '../../src/actions/dispatcher/types';

function vector(partial: Partial<ResourceVector>): ResourceVector {
    return { ...emptyVector(), ...partial };
}

function pod(nodeName: string, phase: string, request: Partial<ResourceVector>): PodSnapshot {
    return { nodeName, phase, request: vector(request), labels: {} };
}

describe('Capacity Accounting', () => {
    test('should subtract headroom from allocatable when no pods are present', () => {
        const free = freeCapacity(
            'node-a',
            vector({ cpuMilli: 4000, memBytes: 8 * 2 ** 30 }),
            vector({ cpuMilli: 500 }),
            [],
            emptyVector(),
        );
        expect(free.cpuMilli).toBe(3500);
    });

    test('should subtract requests of non-terminal pods on that node only', () => {
        const pods = [
            pod('node-a', 'Running', { cpuMilli: 1000 }),
            pod('node-b', 'Running', { cpuMilli: 9999 }), // different node, must not count
        ];
        const free = freeCapacity(
            'node-a',
            vector({ cpuMilli: 4000 }),
            emptyVector(),
            pods,
            emptyVector(),
        );
        expect(free.cpuMilli).toBe(3000);
    });

    test('should ignore pods in Succeeded/Failed phase since they no longer hold resources', () => {
        const pods = [
            pod('node-a', 'Succeeded', { cpuMilli: 2000 }),
            pod('node-a', 'Failed', { cpuMilli: 2000 }),
        ];
        const free = freeCapacity(
            'node-a',
            vector({ cpuMilli: 4000 }),
            emptyVector(),
            pods,
            emptyVector(),
        );
        expect(free.cpuMilli).toBe(4000);
    });

    test('should subtract in-flight dispatch requests', () => {
        const free = freeCapacity(
            'node-a',
            vector({ cpuMilli: 4000 }),
            emptyVector(),
            [],
            vector({ cpuMilli: 1500 }),
        );
        expect(free.cpuMilli).toBe(2500);
    });

    test('effectivePodRequest should sum regular containers (main + Argo wait/init sidecars)', () => {
        const effective = effectivePodRequest(
            [vector({ cpuMilli: 1000, memBytes: 100 }), vector({ cpuMilli: 50, memBytes: 10 })],
            [],
        );
        expect(effective).toEqual(vector({ cpuMilli: 1050, memBytes: 110 }));
    });

    test('effectivePodRequest should take the larger of container sum vs. largest init container, not the sum of both', () => {
        const effective = effectivePodRequest(
            [vector({ cpuMilli: 500 })],
            [vector({ cpuMilli: 2000 }), vector({ cpuMilli: 100 })],
        );
        // init containers run sequentially - only the largest (2000m) counts,
        // and it exceeds the container sum (500m), so 2000m wins
        expect(effective.cpuMilli).toBe(2000);
    });

    test('effectivePodRequest should add pod overhead on top of the max', () => {
        const effective = effectivePodRequest([vector({ cpuMilli: 500 })], [], vector({ cpuMilli: 50 }));
        expect(effective.cpuMilli).toBe(550);
    });

    test('fits should require every resource dimension to be within free capacity', () => {
        const free = vector({ cpuMilli: 1000, memBytes: 1000, ephemeralBytes: 1000, gpu: 1 });
        expect(fits(vector({ cpuMilli: 1000, memBytes: 1000, ephemeralBytes: 1000, gpu: 1 }), free)).toBe(
            true,
        );
        expect(fits(vector({ cpuMilli: 1001 }), free)).toBe(false);
        expect(fits(vector({ gpu: 2 }), free)).toBe(false);
    });
});
