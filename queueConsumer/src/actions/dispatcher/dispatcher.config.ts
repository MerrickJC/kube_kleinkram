import type { ResourceVector } from './types';

/**
 * Master switch: when false, WorkflowDispatchService submits Workflows
 * directly and entirely unconstrained (no node pinning, no admission/quota
 * control) and this module's services are no-ops (see dispatcher.module.ts).
 * When true, the dispatcher is the only scheduling path for Actions - there
 * is no shadow/comparison mode.
 */
export function dispatcherEnabled(): boolean {
    return (process.env.ACTION_DISPATCHER_ENABLED ?? 'false') === 'true';
}

export function fallbackDepth(): number {
    const raw = Number.parseInt(process.env.DISPATCHER_FALLBACK_DEPTH ?? '3', 10);
    return Number.isNaN(raw) || raw < 1 ? 3 : raw;
}

export function missPenaltySeconds(): number {
    const raw = Number.parseInt(process.env.DISPATCHER_MISS_PENALTY_S ?? '60', 10);
    return Number.isNaN(raw) ? 60 : raw;
}

/** Fallback throughput estimate before a node has any completion history */
export function avgRuntimeSeconds(): number {
    const raw = Number.parseInt(process.env.DISPATCHER_AVG_RUNTIME_S ?? '600', 10);
    return Number.isNaN(raw) || raw <= 0 ? 600 : raw;
}

/** Head-of-line guard threshold (spec §8.4, simplified to a whole-node block) */
export function reserveAfterSeconds(): number {
    const raw = Number.parseInt(process.env.DISPATCHER_RESERVE_AFTER_S ?? '300', 10);
    return Number.isNaN(raw) ? 300 : raw;
}

export function inflightTtlSeconds(): number {
    const raw = Number.parseInt(process.env.DISPATCHER_INFLIGHT_TTL_S ?? '300', 10);
    return Number.isNaN(raw) ? 300 : raw;
}

export function pendingTimeoutSeconds(): number {
    const raw = Number.parseInt(process.env.DISPATCHER_PENDING_TIMEOUT_S ?? '600', 10);
    return Number.isNaN(raw) ? 600 : raw;
}

export function maxDispatchAttempts(): number {
    const raw = Number.parseInt(process.env.DISPATCHER_MAX_ATTEMPTS ?? '3', 10);
    return Number.isNaN(raw) || raw < 1 ? 3 : raw;
}

export function cycleDebounceMs(): number {
    const raw = Number.parseInt(process.env.DISPATCHER_CYCLE_DEBOUNCE_MS ?? '250', 10);
    return Number.isNaN(raw) ? 250 : raw;
}

export function nodeChangeDebounceSeconds(): number {
    const raw = Number.parseInt(process.env.DISPATCHER_NODE_CHANGE_DEBOUNCE_S ?? '10', 10);
    return Number.isNaN(raw) ? 10 : raw;
}

export function resyncSeconds(): number {
    const raw = Number.parseInt(process.env.DISPATCHER_RESYNC_S ?? '30', 10);
    return Number.isNaN(raw) ? 30 : raw;
}

export function reconcileSeconds(): number {
    const raw = Number.parseInt(process.env.DISPATCHER_RECONCILE_S ?? '300', 10);
    return Number.isNaN(raw) ? 300 : raw;
}

/** Cluster-wide cap on simultaneously head-of-line-blocked nodes (plan risk #8) */
export function maxBlockedNodes(): number {
    const raw = Number.parseInt(process.env.DISPATCHER_MAX_BLOCKED_NODES ?? '1', 10);
    return Number.isNaN(raw) || raw < 0 ? 1 : raw;
}

// Shared with WorkflowDispatchService's manifest building: the dispatcher's
// resource-vector-for-a-job calculation (job-request.ts) must request
// exactly what the pod it later creates will request, or free() drifts.
export function outputVolumeSizeLimit(): string {
    return process.env.ACTION_OUTPUT_VOLUME_SIZE_LIMIT ?? '10Gi';
}

export function headroomVector(): ResourceVector {
    const cpuMilli = Number.parseInt(process.env.DISPATCHER_HEADROOM_CPU_MILLI ?? '500', 10);
    const memBytes = Number.parseInt(
        process.env.DISPATCHER_HEADROOM_MEM_BYTES ?? String(1024 ** 3),
        10,
    );
    return {
        cpuMilli: Number.isNaN(cpuMilli) ? 500 : cpuMilli,
        memBytes: Number.isNaN(memBytes) ? 1024 ** 3 : memBytes,
        ephemeralBytes: 0,
        gpu: 0,
    };
}
