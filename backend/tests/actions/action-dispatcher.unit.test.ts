import {
    ActionEntity,
    ActionTemplateEntity,
    MissionEntity,
    UserEntity,
} from '@kleinkram/backend-common';
import { AccessControlService } from '@kleinkram/backend-common/modules/access-control/access-control.service';
import { ActionDispatcherService } from '@kleinkram/backend-common/modules/action-dispatcher/action-dispatcher.service';
import { ActionQueueJob } from '@kleinkram/backend-common/modules/action-dispatcher/action-queue.constants';
import { ActionState, ActionTriggerSource, UserRole } from '@kleinkram/shared';
import { Repository } from 'typeorm';

interface MockActionQueue {
    add: jest.Mock;
    getJob: jest.Mock;
}

describe('ActionDispatcherService Unit Tests', () => {
    let service: ActionDispatcherService;
    let actionRepo: Repository<ActionEntity>;
    let templateRepo: Repository<ActionTemplateEntity>;
    let accessControlService: AccessControlService;
    let mockQueue: MockActionQueue;

    const mission = { uuid: 'mission-uuid' } as MissionEntity;
    const creator = { uuid: 'user-uuid', role: UserRole.USER } as UserEntity;

    beforeEach(() => {
        actionRepo = {
            create: jest.fn(),
            save: jest.fn(),
            update: jest.fn(),
            findOneOrFail: jest.fn(),
        } as unknown as Repository<ActionEntity>;

        templateRepo = {
            findOneOrFail: jest.fn(),
        } as unknown as Repository<ActionTemplateEntity>;

        accessControlService = {
            canAccessMission: jest.fn(),
        } as unknown as AccessControlService;

        service = new ActionDispatcherService(
            actionRepo,
            templateRepo,
            accessControlService,
        );

        // Bypass onModuleInit (which would open a real Bull/Redis connection)
        // and inject a mock queue directly, matching how the service uses it.
        mockQueue = {
            add: jest.fn().mockResolvedValue(undefined),
            getJob: jest.fn().mockResolvedValue(undefined),
        };
        (service as unknown as { actionQueue: MockActionQueue }).actionQueue =
            mockQueue;
    });

    describe('dispatch', () => {
        test('throws ConflictException and creates no action when access is denied', async () => {
            (templateRepo.findOneOrFail as jest.Mock).mockResolvedValue({
                uuid: 'template-uuid',
                accessRights: 0,
            });
            (
                accessControlService.canAccessMission as jest.Mock
            ).mockResolvedValue(false);

            await expect(
                service.dispatch(
                    'template-uuid',
                    mission,
                    creator,
                    {},
                    ActionTriggerSource.MANUAL,
                ),
            ).rejects.toThrow('Creator no longer has access to this mission');

            expect(actionRepo.create).not.toHaveBeenCalled();
            expect(mockQueue.add).not.toHaveBeenCalled();
        });

        test('creates a PENDING action and enqueues a SUBMIT job on success', async () => {
            (templateRepo.findOneOrFail as jest.Mock).mockResolvedValue({
                uuid: 'template-uuid',
                accessRights: 0,
            });
            (
                accessControlService.canAccessMission as jest.Mock
            ).mockResolvedValue(true);
            (actionRepo.create as jest.Mock).mockImplementation(
                (data) => data as ActionEntity,
            );
            (actionRepo.save as jest.Mock).mockImplementation((data) =>
                Promise.resolve({ ...data, uuid: 'action-uuid' }),
            );

            const result = await service.dispatch(
                'template-uuid',
                mission,
                creator,
                {},
                ActionTriggerSource.MANUAL,
                'trigger-uuid',
            );

            expect(result).toBe('action-uuid');
            expect(actionRepo.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    mission,
                    creator,
                    state: ActionState.PENDING,
                    triggerSource: ActionTriggerSource.MANUAL,
                    triggerUuid: 'trigger-uuid',
                }),
            );
            expect(mockQueue.add).toHaveBeenCalledWith(
                ActionQueueJob.SUBMIT,
                { uuid: 'action-uuid' },
                expect.objectContaining({
                    jobId: `${ActionQueueJob.SUBMIT}-action-uuid`,
                    attempts: 3,
                }),
            );
        });

        test('marks the action UNPROCESSABLE and rethrows when enqueueing fails', async () => {
            (templateRepo.findOneOrFail as jest.Mock).mockResolvedValue({
                uuid: 'template-uuid',
                accessRights: 0,
            });
            (
                accessControlService.canAccessMission as jest.Mock
            ).mockResolvedValue(true);
            (actionRepo.create as jest.Mock).mockImplementation(
                (data) => data as ActionEntity,
            );
            (actionRepo.save as jest.Mock).mockImplementation((data) =>
                Promise.resolve({ ...data, uuid: 'action-uuid' }),
            );
            mockQueue.add.mockRejectedValue(new Error('redis unreachable'));

            await expect(
                service.dispatch(
                    'template-uuid',
                    mission,
                    creator,
                    {},
                    ActionTriggerSource.MANUAL,
                ),
            ).rejects.toThrow('Failed to dispatch action');

            expect(actionRepo.update).toHaveBeenCalledWith('action-uuid', {
                state: ActionState.UNPROCESSABLE,
                // eslint-disable-next-line @typescript-eslint/naming-convention
                state_cause: 'Failed to submit action for dispatch',
            });
        });
    });

    describe('stopAction', () => {
        test('cancels the action, removes the queued submit job, and enqueues a CANCEL job', async () => {
            const action = { uuid: 'action-uuid', state: ActionState.PENDING };
            (actionRepo.findOneOrFail as jest.Mock).mockResolvedValue(action);
            (actionRepo.save as jest.Mock).mockResolvedValue(action);
            const mockJob = { remove: jest.fn().mockResolvedValue(undefined) };
            mockQueue.getJob.mockResolvedValue(mockJob);

            await service.stopAction('action-uuid');

            expect(actionRepo.save).toHaveBeenCalledWith(
                expect.objectContaining({
                    state: ActionState.CANCELLED,
                    // eslint-disable-next-line @typescript-eslint/naming-convention
                    state_cause: 'Action cancelled by user',
                }),
            );
            expect(mockQueue.getJob).toHaveBeenCalledWith(
                `${ActionQueueJob.SUBMIT}-action-uuid`,
            );
            expect(mockJob.remove).toHaveBeenCalled();
            expect(mockQueue.add).toHaveBeenCalledWith(
                ActionQueueJob.CANCEL,
                { uuid: 'action-uuid' },
                expect.objectContaining({
                    jobId: `${ActionQueueJob.CANCEL}-action-uuid`,
                }),
            );
        });

        test('still enqueues a CANCEL job when no queued submit job exists', async () => {
            const action = { uuid: 'action-uuid', state: ActionState.PENDING };
            (actionRepo.findOneOrFail as jest.Mock).mockResolvedValue(action);
            (actionRepo.save as jest.Mock).mockResolvedValue(action);
            mockQueue.getJob.mockResolvedValue(undefined);

            await expect(
                service.stopAction('action-uuid'),
            ).resolves.toBeUndefined();

            expect(mockQueue.add).toHaveBeenCalledWith(
                ActionQueueJob.CANCEL,
                { uuid: 'action-uuid' },
                expect.anything(),
            );
        });

        test('still enqueues a CANCEL job when removing the submit job throws', async () => {
            const action = { uuid: 'action-uuid', state: ActionState.PENDING };
            (actionRepo.findOneOrFail as jest.Mock).mockResolvedValue(action);
            (actionRepo.save as jest.Mock).mockResolvedValue(action);
            const mockJob = {
                remove: jest.fn().mockRejectedValue(new Error('already active')),
            };
            mockQueue.getJob.mockResolvedValue(mockJob);

            await expect(
                service.stopAction('action-uuid'),
            ).resolves.toBeUndefined();

            expect(mockQueue.add).toHaveBeenCalledWith(
                ActionQueueJob.CANCEL,
                { uuid: 'action-uuid' },
                expect.anything(),
            );
        });

        test('propagates the error when the action cannot be found', async () => {
            (actionRepo.findOneOrFail as jest.Mock).mockRejectedValue(
                new Error('not found'),
            );

            await expect(service.stopAction('missing-uuid')).rejects.toThrow(
                'not found',
            );
            expect(mockQueue.add).not.toHaveBeenCalled();
        });
    });
});
