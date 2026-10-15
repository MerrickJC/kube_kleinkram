import type { PodSnapshot, ResourceVector } from './types';

// Pods in these phases no longer hold their requested resources (spec §7:
// "pods bound to the node ... phase not in {Succeeded, Failed}").
const RELEASED_PHASES = new Set(['Succeeded', 'Failed']);

export function emptyVector(): ResourceVector {
    return { cpuMilli: 0, memBytes: 0, ephemeralBytes: 0, gpu: 0 };
}

export function addVector(a: ResourceVector, b: ResourceVector): ResourceVector {
    return {
        cpuMilli: a.cpuMilli + b.cpuMilli,
        memBytes: a.memBytes + b.memBytes,
        ephemeralBytes: a.ephemeralBytes + b.ephemeralBytes,
        gpu: a.gpu + b.gpu,
    };
}

export function subtractVector(a: ResourceVector, b: ResourceVector): ResourceVector {
    return {
        cpuMilli: a.cpuMilli - b.cpuMilli,
        memBytes: a.memBytes - b.memBytes,
        ephemeralBytes: a.ephemeralBytes - b.ephemeralBytes,
        gpu: a.gpu - b.gpu,
    };
}

/**
 * free(node, r) = allocatable - headroom - Σ non-terminal pod requests on
 * this node - in-flight dispatches, recomputed from scratch every call.
 *
 * Deliberately not incremental: a missed/duplicated informer event then
 * self-heals on the next relist instead of permanently skewing a running
 * counter (see plan's "recompute, never accumulate" cut-line decision).
 */
export function freeCapacity(
    nodeName: string,
    allocatable: ResourceVector,
    headroom: ResourceVector,
    allPods: readonly PodSnapshot[],
    inflight: ResourceVector,
): ResourceVector {
    let used = headroom;
    for (const pod of allPods) {
        if (pod.nodeName !== nodeName) continue;
        if (RELEASED_PHASES.has(pod.phase)) continue;
        used = addVector(used, pod.request);
    }
    used = addVector(used, inflight);
    return subtractVector(allocatable, used);
}

function componentWiseMax(a: ResourceVector, b: ResourceVector): ResourceVector {
    return {
        cpuMilli: Math.max(a.cpuMilli, b.cpuMilli),
        memBytes: Math.max(a.memBytes, b.memBytes),
        ephemeralBytes: Math.max(a.ephemeralBytes, b.ephemeralBytes),
        gpu: Math.max(a.gpu, b.gpu),
    };
}

/**
 * Approximates the kube-scheduler's effective pod request (spec §7):
 * regular containers' requests are summed (they run concurrently), while
 * non-restartable init containers run sequentially so only the largest
 * single one counts - then the larger of the two, plus pod overhead.
 * Argo adds its own init/wait containers, so these must be included by
 * the caller rather than assumed zero.
 */
export function effectivePodRequest(
    containerRequests: readonly ResourceVector[],
    initContainerRequests: readonly ResourceVector[],
    overhead: ResourceVector = emptyVector(),
): ResourceVector {
    let containerSum = emptyVector();
    for (const request of containerRequests) containerSum = addVector(containerSum, request);

    let initMax = emptyVector();
    for (const request of initContainerRequests) initMax = componentWiseMax(initMax, request);

    return addVector(componentWiseMax(containerSum, initMax), overhead);
}

export function fits(request: ResourceVector, free: ResourceVector): boolean {
    return (
        request.cpuMilli <= free.cpuMilli &&
        request.memBytes <= free.memBytes &&
        request.ephemeralBytes <= free.ephemeralBytes &&
        request.gpu <= free.gpu
    );
}
