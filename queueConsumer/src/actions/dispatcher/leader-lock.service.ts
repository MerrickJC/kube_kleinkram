import { redis } from '@kleinkram/backend-common/consts';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Redis } from 'ioredis';
import Redlock, { Lock } from 'redlock';
import { dispatcherEnabled } from './dispatcher.config';

const LOCK_KEY = 'action-dispatcher-leader';
const LOCK_TTL_MS = 30_000;
const EXTEND_INTERVAL_MS = 10_000;
const RETRY_INTERVAL_MS = 2000;

type LeadershipListener = (isLeader: boolean) => void;

/**
 * Single-active-instance guard for the locality dispatcher (spec §11),
 * simplified per the plan's cut-line to Redlock only - no Kubernetes
 * Lease, no Postgres advisory lock. This reuses the same
 * single-active-instance idiom already in this service
 * (AccessGroupExpiryProvider, FileCleanupQueueProcessorProvider), extended
 * from a one-shot `using()` call to a continuously held, self-renewing
 * lock, since dispatching (unlike those cron jobs) has no natural end.
 *
 * The real duplicate-Workflow guard is the deterministic Workflow name
 * (action-<uuid>, already 409-idempotent) - this lock only bounds the
 * window in which two replicas could simultaneously believe they're
 * allowed to dispatch (plan risk #5), and the Deployment this runs in is
 * `replicas: 1` / `strategy: Recreate` anyway (see the Helm phase).
 */
@Injectable()
export class LeaderLockService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(LeaderLockService.name);
    private redlock: Redlock | undefined;
    private lock: Lock | undefined;
    private extendTimer: NodeJS.Timeout | undefined;
    private leader = false;
    private stopped = false;
    private readonly listeners: LeadershipListener[] = [];

    onModuleInit(): void {
        if (!dispatcherEnabled()) return;
        this.redlock = new Redlock([new Redis(redis)], {
            retryCount: 0,
            retryDelay: RETRY_INTERVAL_MS,
        });
        void this.acquireLoop();
    }

    async onModuleDestroy(): Promise<void> {
        this.stopped = true;
        if (this.extendTimer) clearInterval(this.extendTimer);
        if (this.lock) {
            try {
                await this.lock.release();
            } catch (error) {
                this.logger.debug(
                    `Failed to release leader lock on shutdown (it will expire on its own): ${String(error)}`,
                );
            }
        }
    }

    isLeader(): boolean {
        return this.leader;
    }

    /** Fires immediately with the current state whenever leadership is gained or lost */
    onLeadershipChange(listener: LeadershipListener): void {
        this.listeners.push(listener);
    }

    private async acquireLoop(): Promise<void> {
        while (!this.stopped) {
            try {
                if (!this.redlock) return;
                this.lock = await this.redlock.acquire([LOCK_KEY], LOCK_TTL_MS);
                this.setLeader(true);
                this.startExtendLoop();
                return;
            } catch (error) {
                this.logger.debug(`Leader lock held elsewhere, retrying: ${String(error)}`);
                await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS));
            }
        }
    }

    private startExtendLoop(): void {
        this.extendTimer = setInterval(() => {
            void this.extend();
        }, EXTEND_INTERVAL_MS);
    }

    private async extend(): Promise<void> {
        if (!this.lock) return;
        try {
            this.lock = await this.lock.extend(LOCK_TTL_MS);
        } catch (error) {
            // If the extend fails, stop dispatching immediately - don't
            // wait to find out whether it was a transient Redis blip or an
            // actual loss of the lock to another replica.
            this.logger.error(`Lost leader lock, stopping dispatch: ${String(error)}`);
            this.setLeader(false);
            if (this.extendTimer) clearInterval(this.extendTimer);
            this.lock = undefined;
            void this.acquireLoop();
        }
    }

    private setLeader(isLeader: boolean): void {
        if (this.leader === isLeader) return;
        this.leader = isLeader;
        for (const listener of this.listeners) listener(isLeader);
    }
}
