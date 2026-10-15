// Shared types for the locality dispatcher (see _my_thoughts/data-locality-scheduling.md
// and the implementation plan). Kept dependency-free from @kubernetes/client-node so
// capacity.ts/placement.ts/job-queue.ts stay pure and unit-testable without a cluster.
import type { ActionDispatchKind } from '@kleinkram/shared';

export interface ResourceVector {
    cpuMilli: number;
    memBytes: number;
    ephemeralBytes: number;
    gpu: number;
}

/**
 * A pod's resources, stripped down to what capacity accounting needs
 * (spec §7). `labels` is kept (unlike the rest of the pod spec) because
 * the dispatcher's throughput estimate (placement.ts) needs to tell "our"
 * running Action pods apart from everything else on a node.
 */
export interface PodSnapshot {
    nodeName: string;
    phase: string;
    request: ResourceVector;
    labels: Readonly<Record<string, string>>;
}

export type JobClass = 'cpu' | 'gpu';
export type DispatchKind = ActionDispatchKind;

export interface JobRecord {
    actionUuid: string;
    /** mission.uuid - the datum locality ranking is keyed on (spec §5.2) */
    dataKey: string;
    jobClass: JobClass;
    request: ResourceVector;
    enqueuedAt: Date;
    /** Top-ranked node for dataKey among the eligible set at last (re-)rank */
    home: string;
    /** Next-ranked nodes after home, length = FALLBACK_DEPTH - 1 */
    fallbacks: string[];
}

export interface DispatchDecision {
    job: JobRecord;
    node: string;
    kind: DispatchKind;
}
