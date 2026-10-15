import { redis } from '@kleinkram/backend-common/consts';
import { ActionDispatchKind } from '@kleinkram/shared';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { Redis } from 'ioredis';
import type { Counter, Gauge, Histogram } from 'prom-client';
import {
    actionsNamespace,
    ARGO_GROUP,
    ARGO_VERSION,
    getCustomObjectsApi,
    WORKFLOW_PLURAL,
    workflowNameForAction,
} from '../helper/kube-client';
import { addVector, emptyVector, freeCapacity, subtractVector } from './capacity';
import { ClusterStateService } from './cluster-state.service';
import { DispatchStoreService } from './dispatch-store.service';
import {
    avgRuntimeSeconds,
    cycleDebounceMs,
    dispatcherEnabled,
    fallbackDepth,
    headroomVector,
    inflightTtlSeconds,
    maxBlockedNodes,
    maxDispatchAttempts,
    missPenaltySeconds,
    nodeChangeDebounceSeconds,
    pendingTimeoutSeconds,
    reconcileSeconds,
    reserveAfterSeconds,
    resyncSeconds,
} from './dispatcher.config';
import {
    DISPATCH_CYCLE_DURATION_SECONDS_METRIC,
    DISPATCH_DECISION_LATENCY_SECONDS_METRIC,
    DISPATCH_HEAD_BLOCKED_METRIC,
    DISPATCH_INFLIGHT_TIMEOUTS_TOTAL_METRIC,
    DISPATCH_LEADER_METRIC,
    DISPATCH_OLDEST_QUEUED_SECONDS_METRIC,
    DISPATCH_PENDING_TIMEOUTS_TOTAL_METRIC,
    DISPATCH_QUEUE_DEPTH_METRIC,
    DISPATCH_RECONCILE_FIXES_TOTAL_METRIC,
    DISPATCH_TOTAL_METRIC,
} from './dispatcher.metrics';
import { JobQueueStore } from './job-queue';
import { LeaderLockService } from './leader-lock.service';
import { findStealCandidate, forcedBackfill, localFill } from './placement';
import { rankForJob } from './ranking';
import type { JobRecord } from './types';
import { DISPATCH_WAKE_CHANNEL } from './wake-channel';

export interface SubmittedWorkflow {
    workflowName: string;
}

/**
 * Builds and submits the real Argo Workflow for a job pinned to `node`.
 * Implemented by WorkflowDispatchService.submitForDispatcher and wired in
 * by dispatcher.module.ts.
 */
export const WORKFLOW_SUBMITTER = 'WORKFLOW_SUBMITTER';

export interface WorkflowSubmitter {
    submit(actionUuid: string, node: string): Promise<SubmittedWorkflow>;
}

interface InflightEntry {
    node: string;
    request: JobRecord['request'];
    expiresAt: number;
}

/**
 * The locality dispatcher's cycle (spec §8.3) and crash-safe dispatch
 * (§9.1), simplified per the plan's cut-line: see placement.ts/job-queue.ts
 * for what was trimmed. Runs only on the leader (LeaderLockService) and
 * only when ACTION_DISPATCHER_ENABLED=true.
 */
@Injectable()
export class LocalityDispatcherService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(LocalityDispatcherService.name);
    private readonly queueStore = new JobQueueStore();
    private readonly inflightByNode = new Map<string, JobRecord['request']>();
    private readonly inflightByJob = new Map<string, InflightEntry>();
    private readonly headBlocked = new Set<string>();

    private wakeSubscriber: Redis | undefined;
    private resyncTimer: NodeJS.Timeout | undefined;
    private reconcileTimer: NodeJS.Timeout | undefined;
    private ttlSweepTimer: NodeJS.Timeout | undefined;
    private cycleDebounceTimer: NodeJS.Timeout | undefined;
    private rerankDebounceTimer: NodeJS.Timeout | undefined;
    private cycleRunning = false;
    private cycleQueued = false;

    constructor(
        private readonly clusterState: ClusterStateService,
        private readonly dispatchStore: DispatchStoreService,
        private readonly leaderLock: LeaderLockService,
        @Optional() @Inject(WORKFLOW_SUBMITTER) private readonly submitter: WorkflowSubmitter | undefined,
        @InjectMetric(DISPATCH_QUEUE_DEPTH_METRIC) private readonly queueDepthMetric: Gauge,
        @InjectMetric(DISPATCH_OLDEST_QUEUED_SECONDS_METRIC)
        private readonly oldestQueuedMetric: Gauge,
        @InjectMetric(DISPATCH_TOTAL_METRIC) private readonly dispatchTotalMetric: Counter,
        @InjectMetric(DISPATCH_CYCLE_DURATION_SECONDS_METRIC)
        private readonly cycleDurationMetric: Histogram,
        @InjectMetric(DISPATCH_DECISION_LATENCY_SECONDS_METRIC)
        private readonly decisionLatencyMetric: Histogram,
        @InjectMetric(DISPATCH_HEAD_BLOCKED_METRIC) private readonly headBlockedMetric: Gauge,
        @InjectMetric(DISPATCH_INFLIGHT_TIMEOUTS_TOTAL_METRIC)
        private readonly inflightTimeoutsMetric: Counter,
        @InjectMetric(DISPATCH_PENDING_TIMEOUTS_TOTAL_METRIC)
        private readonly pendingTimeoutsMetric: Counter,
        @InjectMetric(DISPATCH_RECONCILE_FIXES_TOTAL_METRIC)
        private readonly reconcileFixesMetric: Counter,
        @InjectMetric(DISPATCH_LEADER_METRIC) private readonly leaderMetric: Gauge,
    ) {}

    async onModuleInit(): Promise<void> {
        if (!dispatcherEnabled()) return;

        this.leaderLock.onLeadershipChange((isLeader) => {
            this.leaderMetric.set(isLeader ? 1 : 0);
            if (isLeader) void this.syncFromStoreAndCycle();
        });
        this.clusterState.onChange(() => {
            this.scheduleCycle();
            this.scheduleRerank();
        });

        await this.subscribeToWake();

        this.resyncTimer = setInterval(() => {
            void this.syncFromStoreAndCycle();
        }, resyncSeconds() * 1000);
        this.reconcileTimer = setInterval(() => {
            void this.reconcile();
        }, reconcileSeconds() * 1000);
        this.ttlSweepTimer = setInterval(() => {
            this.sweepInflightTtl();
        }, 10_000);

        await this.waitForClusterSync();
        await this.syncFromStoreAndCycle();
    }

    async onModuleDestroy(): Promise<void> {
        if (this.resyncTimer) clearInterval(this.resyncTimer);
        if (this.reconcileTimer) clearInterval(this.reconcileTimer);
        if (this.ttlSweepTimer) clearInterval(this.ttlSweepTimer);
        if (this.cycleDebounceTimer) clearTimeout(this.cycleDebounceTimer);
        if (this.rerankDebounceTimer) clearTimeout(this.rerankDebounceTimer);
        if (this.wakeSubscriber) await this.wakeSubscriber.quit();
    }

    private async waitForClusterSync(): Promise<void> {
        const deadline = Date.now() + 30_000;
        while (!this.clusterState.isSynced() && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
        if (!this.clusterState.isSynced()) {
            this.logger.warn('Cluster state did not sync within 30s; cycles will no-op until it does');
        }
    }

    private async subscribeToWake(): Promise<void> {
        const subscriber = new Redis(redis);
        await subscriber.subscribe(DISPATCH_WAKE_CHANNEL);
        subscriber.on('message', () => {
            void this.syncFromStoreAndCycle();
        });
        this.wakeSubscriber = subscriber;
    }

    // --- Debounced triggers (spec §8.3 "coalesce triggers with a short debounce") ---

    private scheduleCycle(): void {
        if (this.cycleDebounceTimer) return;
        this.cycleDebounceTimer = setTimeout(() => {
            this.cycleDebounceTimer = undefined;
            this.runCycle();
        }, cycleDebounceMs());
    }

    private scheduleRerank(): void {
        if (this.rerankDebounceTimer) return;
        this.rerankDebounceTimer = setTimeout(() => {
            this.rerankDebounceTimer = undefined;
            this.rerank();
            this.scheduleCycle();
        }, nodeChangeDebounceSeconds() * 1000);
    }

    private rerank(): void {
        this.queueStore.rerank((job) => this.computeRank(job));
    }

    private computeRank(job: JobRecord): { home: string; fallbacks: string[] } {
        const names = this.clusterState
            .eligibleNodes()
            .filter((node) => (job.jobClass === 'gpu' ? node.isGpu : !node.isGpu))
            .map((node) => node.name);
        if (names.length === 0) {
            this.logger.warn(
                `No eligible ${job.jobClass} nodes for action ${job.actionUuid}; parked without a home until one appears`,
            );
            return { home: '', fallbacks: [] };
        }
        return rankForJob(job.dataKey, names, fallbackDepth());
    }

    // --- Keeping the in-memory backlog in sync with the DB (spec §10.4 steps 3,5; §5.3) ---

    private async syncFromStoreAndCycle(): Promise<void> {
        await this.syncFromStore();
        this.scheduleCycle();
    }

    private async syncFromStore(): Promise<void> {
        const freshJobs = await this.dispatchStore.loadQueuedAndDispatching();
        const freshIds = new Set(freshJobs.map((job) => job.actionUuid));

        for (const uuid of this.allQueuedJobIds()) {
            if (!freshIds.has(uuid)) {
                this.queueStore.removeJobEverywhere(uuid);
                this.clearInflight(uuid);
            }
        }

        const existingIds = this.allQueuedJobIds();
        for (const job of freshJobs) {
            if (existingIds.has(job.actionUuid)) continue;
            const { home, fallbacks } = this.computeRank(job);
            job.home = home;
            job.fallbacks = fallbacks;
            this.queueStore.queueFor(home).insert(job);
        }
    }

    private allQueuedJobIds(): Set<string> {
        const ids = new Set<string>();
        for (const jobs of this.queueStore.allEntries().values()) {
            for (const job of jobs) ids.add(job.actionUuid);
        }
        return ids;
    }

    // --- The dispatch cycle itself (spec §8.3) ---

    private runCycle(): void {
        if (this.cycleRunning) {
            this.cycleQueued = true;
            return;
        }
        if (!this.leaderLock.isLeader() || !this.clusterState.isSynced()) return;

        this.cycleRunning = true;
        const stopTimer = this.cycleDurationMetric.startTimer();
        try {
            this.runCycleOnce();
        } catch (error) {
            this.logger.error(`Dispatch cycle failed: ${String(error)}`);
        } finally {
            stopTimer();
            this.cycleRunning = false;
            if (this.cycleQueued) {
                this.cycleQueued = false;
                this.scheduleCycle();
            }
        }
    }

    private runCycleOnce(): void {
        const now = new Date();
        const nodes = this.clusterState.eligibleNodes();
        const nodeByName = new Map(nodes.map((node) => [node.name, node]));
        const pods = this.clusterState.podSnapshots();
        const throughput = this.computeThroughput(nodes);

        // Process nodes with the deepest queue first (spec §8.3), then any
        // remaining eligible node (so idle nodes still get a chance to steal).
        // Array#toSorted isn't available at this project's configured lib
        // target; .sort() is safe here since the array was just freshly
        // spread above, so there's nothing else holding a reference to it.
        const queueNodeNames = [...this.queueStore.nodes()]
            .filter((name) => nodeByName.has(name))
            // eslint-disable-next-line unicorn/no-array-sort
            .sort(
                (a, b) => this.queueStore.queueFor(b).size - this.queueStore.queueFor(a).size,
            );
        const orderedNodeNames = [...queueNodeNames];
        for (const node of nodes) {
            if (!orderedNodeNames.includes(node.name)) orderedNodeNames.push(node.name);
        }

        let blockedCount = 0;
        for (const nodeName of orderedNodeNames) {
            const nodeInfo = nodeByName.get(nodeName);
            if (!nodeInfo) continue;

            const inflightForNode = this.inflightByNode.get(nodeName) ?? emptyVector();
            let free = freeCapacity(nodeName, nodeInfo.allocatable, headroomVector(), pods, inflightForNode);

            const queueJobs = this.queueStore.queueFor(nodeName).peekAll();
            const result = localFill(queueJobs, free, reserveAfterSeconds(), now);

            if (result.blockedOnHead && blockedCount < maxBlockedNodes()) {
                blockedCount += 1;
                this.setHeadBlocked(nodeName, true);
                continue;
            }
            this.setHeadBlocked(nodeName, false);

            const dispatches = result.blockedOnHead
                ? forcedBackfill(queueJobs, free)
                : result.dispatches;

            for (const job of dispatches) {
                free = subtractVector(free, job.request);
                this.applyDispatch(job, nodeName, ActionDispatchKind.LOCAL, now);
            }

            for (;;) {
                const candidate = findStealCandidate(
                    nodeName,
                    free,
                    this.queueStore.allEntries(),
                    throughput,
                    missPenaltySeconds(),
                );
                if (!candidate) break;
                free = subtractVector(free, candidate.job.request);
                this.applyDispatch(candidate.job, nodeName, ActionDispatchKind.STEAL, now);
            }
        }

        this.recordBacklogMetrics();
    }

    private computeThroughput(nodes: { name: string }[]): Map<string, number> {
        const counts = this.clusterState.runningActionCountByNode();
        const throughput = new Map<string, number>();
        for (const node of nodes) {
            throughput.set(node.name, (counts.get(node.name) ?? 0) / avgRuntimeSeconds());
        }
        return throughput;
    }

    private setHeadBlocked(node: string, blocked: boolean): void {
        if (blocked) this.headBlocked.add(node);
        else this.headBlocked.delete(node);
        this.headBlockedMetric.set({ node }, blocked ? 1 : 0);
    }

    private recordBacklogMetrics(): void {
        let oldest = 0;
        const now = Date.now();
        for (const [node, jobs] of this.queueStore.allEntries()) {
            if (!node) continue;
            this.queueDepthMetric.set({ node }, jobs.length);
            for (const job of jobs) {
                oldest = Math.max(oldest, (now - job.enqueuedAt.getTime()) / 1000);
            }
        }
        this.oldestQueuedMetric.set(oldest);
    }

    // --- Applying a decision (spec §9.1) ---

    private applyDispatch(job: JobRecord, node: string, kind: ActionDispatchKind, now: Date): void {
        this.queueStore.removeJobEverywhere(job.actionUuid);
        const latencySeconds = (now.getTime() - job.enqueuedAt.getTime()) / 1000;
        this.decisionLatencyMetric.observe(latencySeconds);
        this.dispatchTotalMetric.inc({ kind });
        void this.dispatchForReal(job, node, kind);
    }

    private async dispatchForReal(job: JobRecord, node: string, kind: ActionDispatchKind): Promise<void> {
        this.addInflight(job, node);

        const claimed = await this.dispatchStore.claimForDispatch(job.actionUuid, node, kind, job.home);
        if (!claimed) {
            // Cancelled, or claimed by a stale leader - either way, not ours anymore.
            this.clearInflight(job.actionUuid);
            return;
        }

        if (!this.submitter) {
            this.logger.error(
                `No workflow submitter wired for action ${job.actionUuid} (DispatcherModule misconfigured); reverting to queued`,
            );
            await this.dispatchStore.revertToQueued(job.actionUuid, 'No workflow submitter configured');
            this.clearInflight(job.actionUuid);
            this.queueStore.queueFor(job.home).insert(job);
            return;
        }

        try {
            const { workflowName } = await this.submitter.submit(job.actionUuid, node);
            await this.dispatchStore.markDispatched(job.actionUuid, workflowName);
            this.clearInflight(job.actionUuid);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`Workflow submit failed for action ${job.actionUuid}: ${message}`);
            await this.dispatchStore.revertToQueued(job.actionUuid, message);
            this.clearInflight(job.actionUuid);
            this.queueStore.queueFor(job.home).insert(job);
        }
    }

    // --- In-flight tracking (spec §7 "in-flight", §9.1 step 1) ---

    private addInflight(job: JobRecord, node: string): void {
        this.inflightByNode.set(node, addVector(this.inflightByNode.get(node) ?? emptyVector(), job.request));
        this.inflightByJob.set(job.actionUuid, {
            node,
            request: job.request,
            expiresAt: Date.now() + inflightTtlSeconds() * 1000,
        });
    }

    private clearInflight(actionUuid: string): void {
        const entry = this.inflightByJob.get(actionUuid);
        if (!entry) return;
        this.inflightByJob.delete(actionUuid);
        const remaining = subtractVector(this.inflightByNode.get(entry.node) ?? emptyVector(), entry.request);
        this.inflightByNode.set(entry.node, remaining);
    }

    private sweepInflightTtl(): void {
        const now = Date.now();
        for (const [actionUuid, entry] of this.inflightByJob) {
            if (entry.expiresAt > now) continue;
            this.logger.warn(
                `In-flight dispatch for action ${actionUuid} on ${entry.node} exceeded INFLIGHT_TTL_S; clearing (reconcile will catch a true orphan)`,
            );
            this.inflightTimeoutsMetric.inc();
            this.clearInflight(actionUuid);
        }
    }

    // --- Reconciliation (spec §10.3) ---

    private async reconcile(): Promise<void> {
        if (!this.leaderLock.isLeader()) return;

        for (const action of await this.dispatchStore.findDispatching()) {
            if (await this.workflowExists(action.uuid)) {
                await this.dispatchStore.markDispatched(action.uuid, workflowNameForAction(action.uuid));
            } else {
                this.logger.warn(`Action ${action.uuid} was DISPATCHING with no backing Workflow; requeuing`);
                await this.dispatchStore.revertToQueued(action.uuid, 'Workflow not found during reconcile');
                this.reconcileFixesMetric.inc({ type: 'dispatching_without_workflow' });
            }
        }

        for (const action of await this.dispatchStore.findDispatchedUnfinished()) {
            if (!(await this.workflowExists(action.uuid))) {
                this.logger.warn(
                    `Action ${action.uuid} was DISPATCHED with no backing Workflow and never finished; marking failed`,
                );
                await this.dispatchStore.markFailed(action.uuid, 'Workflow no longer exists');
                this.reconcileFixesMetric.inc({ type: 'dispatched_without_workflow' });
            }
        }

        const pendingDeadline = new Date(Date.now() - pendingTimeoutSeconds() * 1000);
        for (const action of await this.dispatchStore.findDispatchedCandidatesForPendingTimeout(
            pendingDeadline,
        )) {
            await this.handlePendingTimeout(action.uuid, action.dispatchAttempt);
        }

        await this.syncFromStore();
    }

    private async handlePendingTimeout(actionUuid: string, attempt: number): Promise<void> {
        this.logger.warn(
            `Action ${actionUuid}'s pod has been Pending past PENDING_TIMEOUT_S; the dispatcher's capacity estimate was likely wrong`,
        );
        this.pendingTimeoutsMetric.inc();
        try {
            await getCustomObjectsApi().deleteNamespacedCustomObject({
                group: ARGO_GROUP,
                version: ARGO_VERSION,
                namespace: actionsNamespace(),
                plural: WORKFLOW_PLURAL,
                name: workflowNameForAction(actionUuid),
            });
        } catch (error) {
            this.logger.debug(`Workflow delete during pending-timeout handling failed (may already be gone): ${String(error)}`);
        }

        if (attempt >= maxDispatchAttempts()) {
            await this.dispatchStore.markFailed(
                actionUuid,
                `Pod stayed Pending past the timeout after ${attempt.toString()} attempts`,
            );
            this.reconcileFixesMetric.inc({ type: 'pending_timeout_max_attempts' });
            return;
        }
        await this.dispatchStore.revertToQueued(actionUuid, 'Pod stayed Pending past PENDING_TIMEOUT_S');
        this.reconcileFixesMetric.inc({ type: 'pending_timeout_requeued' });
    }

    private async workflowExists(actionUuid: string): Promise<boolean> {
        try {
            await getCustomObjectsApi().getNamespacedCustomObject({
                group: ARGO_GROUP,
                version: ARGO_VERSION,
                namespace: actionsNamespace(),
                plural: WORKFLOW_PLURAL,
                name: workflowNameForAction(actionUuid),
            });
            return true;
        } catch (error) {
            const httpError = error as { code?: number; statusCode?: number };
            if (httpError.code === 404 || httpError.statusCode === 404) return false;
            this.logger.debug(
                `Workflow existence check failed for action ${actionUuid}, assuming it still exists: ${String(error)}`,
            );
            return true;
        }
    }
}
