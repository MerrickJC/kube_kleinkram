import { ActionEntity } from '@kleinkram/backend-common/entities/action/action.entity';
import {
    ActionDispatchKind,
    ActionDispatchState,
    ActionState,
} from '@kleinkram/shared';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, Repository } from 'typeorm';
import { jobClassForTemplate, resourceVectorForTemplate } from './job-request';
import type { JobRecord } from './types';

/**
 * DB-only bookkeeping for the locality dispatcher's backlog (spec §5, §9.1,
 * §10.3), layered directly onto ActionEntity rather than a parallel
 * dispatch_jobs table (see plan's "Job store" decision) - no Kubernetes
 * calls here. The actual Workflow create/delete calls live in
 * LocalityDispatcherService, which uses this store for the DB half of
 * each crash-safe step.
 */
@Injectable()
export class DispatchStoreService {
    private readonly logger = new Logger(DispatchStoreService.name);

    constructor(
        @InjectRepository(ActionEntity)
        private readonly actionRepository: Repository<ActionEntity>,
    ) {}

    /**
     * Startup load (spec §10.4 step 3) and the resync source of truth for
     * the in-memory *placement* queue - deliberately QUEUED/DISPATCHING
     * only, not DISPATCHED (a DISPATCHED job already has a real Workflow
     * running elsewhere and must not re-enter placement; its only concern
     * is reconciliation, via findDispatchedUnfinished()/
     * findDispatchedCandidatesForPendingTimeout() below).
     *
     * QUEUED additionally requires state=PENDING so a cancelled-before-
     * dispatch action (state flips to CANCELLED, but nothing else clears
     * dispatchState - see ActionDispatcherService.stopAction) drops out
     * instead of being dispatched forever.
     */
    async loadQueuedAndDispatching(): Promise<JobRecord[]> {
        const rows = await this.actionRepository.find({
            where: [
                { dispatchState: ActionDispatchState.QUEUED, state: ActionState.PENDING },
                { dispatchState: ActionDispatchState.DISPATCHING },
            ],
            relations: { mission: true, template: true },
            order: { createdAt: 'ASC' },
        });
        const jobs: JobRecord[] = [];
        for (const row of rows) {
            const job = this.toJobRecord(row);
            if (job) jobs.push(job);
        }
        return jobs;
    }

    /** Marks a freshly created ActionEntity (state=PENDING) as queued in the dispatcher */
    async markQueued(actionUuid: string, homeNode: string): Promise<void> {
        await this.actionRepository.update(
            { uuid: actionUuid },
            { dispatchState: ActionDispatchState.QUEUED, homeNode },
        );
    }

    /**
     * Claims a job for dispatch (spec §9.1 step 2). The conditional WHERE
     * means a concurrent cancellation (which clears dispatchState - see
     * clearDispatchState) or a stale/duplicate claim loses the race instead
     * of causing a double dispatch.
     */
    async claimForDispatch(
        actionUuid: string,
        node: string,
        kind: ActionDispatchKind,
        homeNode: string,
    ): Promise<boolean> {
        const result = await this.actionRepository
            .createQueryBuilder()
            .update(ActionEntity)
            .set({
                dispatchState: ActionDispatchState.DISPATCHING,
                dispatchNode: node,
                dispatchKind: kind,
                homeNode,
                dispatchAttempt: () => '"dispatchAttempt" + 1',
            })
            .where('uuid = :uuid', { uuid: actionUuid })
            .andWhere('"dispatchState" = :queued', {
                queued: ActionDispatchState.QUEUED,
            })
            .andWhere('state = :pending', { pending: ActionState.PENDING })
            .execute();
        return (result.affected ?? 0) > 0;
    }

    /** spec §9.1 step 6: the Workflow now exists */
    async markDispatched(actionUuid: string, workflowName: string): Promise<void> {
        await this.actionRepository.update(
            { uuid: actionUuid },
            {
                dispatchState: ActionDispatchState.DISPATCHED,
                workflowName,
                dispatchedAt: new Date(),
                state: ActionState.STARTING,
                // eslint-disable-next-line @typescript-eslint/naming-convention
                state_cause: 'Workflow submitted',
            },
        );
    }

    /** spec §10.3 "pending timeout" rule input: DISPATCHED, still running, dispatched a while ago */
    async findDispatchedCandidatesForPendingTimeout(
        olderThan: Date,
    ): Promise<ActionEntity[]> {
        return this.actionRepository.find({
            where: {
                dispatchState: ActionDispatchState.DISPATCHED,
                executionEndedAt: IsNull(),
                executionStartedAt: IsNull(),
                dispatchedAt: LessThan(olderThan),
            },
        });
    }

    /** spec §9.1 step 5 fallback: Workflow create failed, go back to the queue */
    async revertToQueued(actionUuid: string, error: string): Promise<void> {
        await this.actionRepository.update(
            { uuid: actionUuid },
            {
                dispatchState: ActionDispatchState.QUEUED,
                dispatchNode: undefined,
                lastDispatchError: error,
            },
        );
    }

    /** MAX_ATTEMPTS exceeded, or an unrecoverable submit error */
    async markFailed(actionUuid: string, error: string): Promise<void> {
        await this.actionRepository
            .createQueryBuilder()
            .update(ActionEntity)
            .set({
                dispatchState: () => 'NULL',
                state: ActionState.UNPROCESSABLE,
                // eslint-disable-next-line @typescript-eslint/naming-convention
                state_cause: error,
                lastDispatchError: error,
            })
            .where('uuid = :uuid', { uuid: actionUuid })
            .execute();
    }

    /** Called on cancellation of a job that never reached DISPATCHED (spec §5.3) */
    async clearDispatchState(actionUuid: string): Promise<void> {
        await this.actionRepository
            .createQueryBuilder()
            .update(ActionEntity)
            .set({ dispatchState: () => 'NULL' })
            .where('uuid = :uuid', { uuid: actionUuid })
            .execute();
    }

    /** spec §10.3 rule 1 input: caller checks each for a backing Workflow */
    async findDispatching(): Promise<ActionEntity[]> {
        return this.actionRepository.find({
            where: { dispatchState: ActionDispatchState.DISPATCHING },
        });
    }

    /** spec §10.3 rule 2 input: caller checks each for a backing Workflow */
    async findDispatchedUnfinished(): Promise<ActionEntity[]> {
        return this.actionRepository.find({
            where: {
                dispatchState: ActionDispatchState.DISPATCHED,
                executionEndedAt: IsNull(),
            },
        });
    }

    private toJobRecord(action: ActionEntity): JobRecord | undefined {
        if (!action.mission || !action.template) {
            this.logger.warn(
                `Action ${action.uuid} is queued for dispatch but missing mission/template relations; skipping`,
            );
            return undefined;
        }
        return {
            actionUuid: action.uuid,
            dataKey: action.mission.uuid,
            jobClass: jobClassForTemplate(action.template),
            request: resourceVectorForTemplate(action.template),
            enqueuedAt: action.createdAt,
            // Placeholder until the startup rerank (spec §10.4 step 5)
            // assigns the real home/fallbacks from the current node set.
            home: action.homeNode ?? '',
            fallbacks: [],
        };
    }
}
