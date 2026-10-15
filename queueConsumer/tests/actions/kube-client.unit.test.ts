import type { V1Node } from '@kubernetes/client-node';
import { isNodeReadySchedulable } from '../../src/actions/helper/kube-client';

function readyNode(partial: Partial<V1Node> = {}): V1Node {
    return {
        spec: { unschedulable: false, taints: [] },
        status: { conditions: [{ type: 'Ready', status: 'True' }] },
        ...partial,
    } as V1Node;
}

describe('isNodeReadySchedulable', () => {
    test('should accept a Ready, untainted, schedulable node', () => {
        expect(isNodeReadySchedulable(readyNode())).toBe(true);
    });

    test('should reject a cordoned node', () => {
        const node = readyNode({ spec: { unschedulable: true, taints: [] } });
        expect(isNodeReadySchedulable(node)).toBe(false);
    });

    test('should reject a node that is not Ready', () => {
        const node = readyNode({
            status: { conditions: [{ type: 'Ready', status: 'False' }] },
        });
        expect(isNodeReadySchedulable(node)).toBe(false);
    });

    test('should reject a node marked for removal by the cluster autoscaler', () => {
        const node = readyNode({
            spec: {
                unschedulable: false,
                taints: [{ key: 'ToBeDeletedByClusterAutoscaler', effect: 'NoSchedule' }],
            },
        });
        expect(isNodeReadySchedulable(node)).toBe(false);
    });

    test('should reject a node with an untolerated NoSchedule taint', () => {
        const node = readyNode({
            spec: {
                unschedulable: false,
                taints: [{ key: 'dedicated', value: 'other-team', effect: 'NoSchedule' }],
            },
        });
        expect(isNodeReadySchedulable(node)).toBe(false);
    });

    test('should accept a GPU-tainted node since that taint is explicitly tolerated', () => {
        const node = readyNode({
            spec: {
                unschedulable: false,
                taints: [{ key: 'nvidia.com/gpu', effect: 'NoSchedule' }],
            },
        });
        expect(isNodeReadySchedulable(node)).toBe(true);
    });

    test('should ignore a taint with a non-blocking effect such as PreferNoSchedule', () => {
        const node = readyNode({
            spec: {
                unschedulable: false,
                taints: [{ key: 'dedicated', effect: 'PreferNoSchedule' }],
            },
        });
        expect(isNodeReadySchedulable(node)).toBe(true);
    });
});
