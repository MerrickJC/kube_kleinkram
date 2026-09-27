import { redis } from '@backend-common/consts';
import { ActionTemplateEntity } from '@backend-common/entities/action/action-template.entity';
import { ActionEntity } from '@backend-common/entities/action/action.entity';
import { MissionEntity } from '@backend-common/entities/mission/mission.entity';
import { UserEntity } from '@backend-common/entities/user/user.entity';
import { ActionState, ActionTriggerSource, UserRole } from '@kleinkram/shared';
import {
    ConflictException,
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import Queue from 'bull';
import { Repository } from 'typeorm';
import { AccessControlService } from '../access-control/access-control.service';
import {
    ACTION_DISPATCH_QUEUE_NAME,
    ActionQueueJob,
} from './action-queue.constants';

/* Creates ActionEntity rows and hands them to queue-consumer for Argo Workflow creation */
@Injectable()
export class ActionDispatcherService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(ActionDispatcherService.name);
    private actionQueue!: Queue.Queue;

    constructor(
        @InjectRepository(ActionEntity)
        private actionRepository: Repository<ActionEntity>,
        @InjectRepository(ActionTemplateEntity)
        private actionTemplateRepository: Repository<ActionTemplateEntity>,
        private accessControlService: AccessControlService,
    ) {}

    async onModuleInit(): Promise<void> {
        this.actionQueue = new Queue(ACTION_DISPATCH_QUEUE_NAME, { redis });
        await this.actionQueue.isReady();
        this.logger.log('Action dispatch queue initialized');
    }

    async onModuleDestroy(): Promise<void> {
        await this.actionQueue.close();
    }

    /**
     * Core dispatch logic: validates access, creates the ActionEntity, and
     * enqueues a submit job. The Action Operator (queue-consumer) builds and
     * submits the Argo Workflow from there.
     */
    async dispatch(
        templateUuid: string,
        mission: MissionEntity,
        creator: UserEntity,
        // Kept for downstream compatibility (trigger/webhook payload data)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        _parameters: Record<string, any>,
        triggerSource: ActionTriggerSource = ActionTriggerSource.MANUAL,
        triggerUuid?: string,
    ): Promise<string> {
        const template = await this.actionTemplateRepository.findOneOrFail({
            where: { uuid: templateUuid },
        });

        const canAccess = await this.accessControlService.canAccessMission(
            {
                uuid: creator.uuid,
                role: creator.role ?? UserRole.USER,
            },
            mission,
            template.accessRights,
        );

        if (!canAccess) {
            this.logger.error(
                `[Dispatch] Access denied for user ${creator.uuid}`,
            );
            throw new ConflictException(
                'Creator no longer has access to this mission',
            );
        }

        let action = this.actionRepository.create({
            mission,
            creator,
            state: ActionState.PENDING,
            template,
            triggerSource,
            triggerUuid,
        });

        action = await this.actionRepository.save(action);

        try {
            // jobId = action uuid makes submission idempotent for Bull's retry
            await this.actionQueue.add(
                ActionQueueJob.SUBMIT,
                { uuid: action.uuid },
                {
                    jobId: `${ActionQueueJob.SUBMIT}-${action.uuid}`,
                    removeOnComplete: true,
                    removeOnFail: false,
                    attempts: 3,
                    backoff: { delay: 5000, type: 'exponential' },
                },
            );

            this.logger.log(
                `Action ${action.uuid} dispatched for mission ${mission.uuid}`,
            );
            return action.uuid;
        } catch (error) {
            this.logger.error(`Failed to queue action ${action.uuid}`, error);
            await this.actionRepository.update(action.uuid, {
                state: ActionState.UNPROCESSABLE,
                // eslint-disable-next-line @typescript-eslint/naming-convention
                state_cause: 'Failed to submit action for dispatch',
            });
            throw new ConflictException('Failed to dispatch action');
        }
    }

    /**
     * Stops a running or still-queued action
     * Queued jobs: removes the submit job from the queue
     * Running jobs: asks Action Operator to terminate the run
     */
    async stopAction(actionRunId: string): Promise<void> {
        const action = await this.actionRepository.findOneOrFail({
            where: { uuid: actionRunId },
        });

        action.state = ActionState.CANCELLED;
        action.state_cause = 'Action cancelled by user';
        await this.actionRepository.save(action);

        const submitJob = await this.actionQueue.getJob(
            `${ActionQueueJob.SUBMIT}-${actionRunId}`,
        );
        if (submitJob) {
            try {
                await submitJob.remove();
            } catch (error) {
                this.logger.warn(
                    `Could not remove submit job for ${actionRunId} (it may already be processing): ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }

        await this.actionQueue.add(
            ActionQueueJob.CANCEL,
            { uuid: actionRunId },
            {
                jobId: `${ActionQueueJob.CANCEL}-${actionRunId}`,
                removeOnComplete: true,
                removeOnFail: true,
                attempts: 3,
                backoff: { delay: 5000, type: 'exponential' },
            },
        );

        this.logger.log(`Action ${actionRunId} cancellation requested`);
    }
}
