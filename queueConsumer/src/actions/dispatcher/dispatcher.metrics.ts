import {
    makeCounterProvider,
    makeGaugeProvider,
    makeHistogramProvider,
} from '@willsoto/nestjs-prometheus';

// `node` is deliberately omitted from every counter/histogram label set
// below (only used on the two low-cardinality gauges where it's essential)
// - the existing kleinkram_action_locality_landed_rank_total metric
// avoided node names for the same reason (unbounded cardinality that
// could outlive this project); see workflow-watch.service.ts.

export const DISPATCH_QUEUE_DEPTH_METRIC = 'kleinkram_dispatch_queue_depth';
export const DISPATCH_OLDEST_QUEUED_SECONDS_METRIC =
    'kleinkram_dispatch_oldest_queued_seconds';
export const DISPATCH_TOTAL_METRIC = 'kleinkram_dispatch_total';
export const DISPATCH_CYCLE_DURATION_SECONDS_METRIC =
    'kleinkram_dispatch_cycle_duration_seconds';
export const DISPATCH_DECISION_LATENCY_SECONDS_METRIC =
    'kleinkram_dispatch_decision_latency_seconds';
export const DISPATCH_IDLE_WHILE_BACKLOGGED_METRIC =
    'kleinkram_dispatch_idle_while_backlogged';
export const DISPATCH_HEAD_BLOCKED_METRIC = 'kleinkram_dispatch_head_blocked';
export const DISPATCH_INFLIGHT_TIMEOUTS_TOTAL_METRIC =
    'kleinkram_dispatch_inflight_timeouts_total';
export const DISPATCH_PENDING_TIMEOUTS_TOTAL_METRIC =
    'kleinkram_dispatch_pending_timeouts_total';
export const DISPATCH_RECONCILE_FIXES_TOTAL_METRIC =
    'kleinkram_dispatch_reconcile_fixes_total';
export const DISPATCH_LEADER_METRIC = 'kleinkram_dispatch_leader';

export const DISPATCHER_METRIC_PROVIDERS = [
    makeGaugeProvider({
        name: DISPATCH_QUEUE_DEPTH_METRIC,
        help: 'Number of jobs currently queued on each node (per-node backlog depth)',
        labelNames: ['node'],
    }),
    makeGaugeProvider({
        name: DISPATCH_OLDEST_QUEUED_SECONDS_METRIC,
        help: 'Age in seconds of the oldest job anywhere in the dispatcher backlog',
    }),
    makeCounterProvider({
        name: DISPATCH_TOTAL_METRIC,
        help: 'Count of dispatch decisions by kind ("local" = home node, "steal" = another node\'s capacity)',
        labelNames: ['kind'],
    }),
    makeHistogramProvider({
        name: DISPATCH_CYCLE_DURATION_SECONDS_METRIC,
        help: 'Duration of one locality-dispatcher cycle',
    }),
    makeHistogramProvider({
        name: DISPATCH_DECISION_LATENCY_SECONDS_METRIC,
        help: 'Time from a job being enqueued to the dispatcher deciding where to place it',
    }),
    makeGaugeProvider({
        name: DISPATCH_IDLE_WHILE_BACKLOGGED_METRIC,
        help: 'Free capacity on a node while its own queue is non-empty (spec §16.1) - nonzero suggests the steal rule left capacity idle that a job could have used',
        labelNames: ['node', 'resource'],
    }),
    makeGaugeProvider({
        name: DISPATCH_HEAD_BLOCKED_METRIC,
        help: 'Whether a node is currently blocked by the head-of-line guard (1) or not (0)',
        labelNames: ['node'],
    }),
    makeCounterProvider({
        name: DISPATCH_INFLIGHT_TIMEOUTS_TOTAL_METRIC,
        help: 'Count of in-flight dispatch entries that expired (INFLIGHT_TTL_S) before their Workflow was observed',
    }),
    makeCounterProvider({
        name: DISPATCH_PENDING_TIMEOUTS_TOTAL_METRIC,
        help: 'Count of dispatched Workflows whose pod stayed Pending past PENDING_TIMEOUT_S and were requeued',
    }),
    makeCounterProvider({
        name: DISPATCH_RECONCILE_FIXES_TOTAL_METRIC,
        help: 'Count of reconciliation fixes applied, by type (spec §10.3)',
        labelNames: ['type'],
    }),
    makeGaugeProvider({
        name: DISPATCH_LEADER_METRIC,
        help: 'Whether this replica currently holds the dispatcher leader lock (1) or not (0)',
    }),
];
