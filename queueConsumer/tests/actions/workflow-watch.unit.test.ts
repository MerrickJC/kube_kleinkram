import { ActionEntity } from '@kleinkram/backend-common/entities/action/action.entity';
import { ApiKeyEntity } from '@kleinkram/backend-common/entities/auth/api-key.entity';
import { ActionState } from '@kleinkram/shared';
import { Repository } from 'typeorm';
import { ActionErrorHintService } from '../../src/actions/services/action-error-hint.service';
import { ArtifactStatusService } from '../../src/actions/services/artifact-status.service';
import { ResourceUsageService } from '../../src/actions/services/resource-usage.service';
import { WorkflowWatchService } from '../../src/actions/services/workflow-watch.service';

jest.mock('../../src/logger', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockDeleteNamespacedSecret = jest.fn();
const mockGetNamespacedCustomObject = jest.fn();

jest.mock('../../src/actions/helper/kube-client', () => {
    const actual = jest.requireActual('../../src/actions/helper/kube-client');
    return {
        ...actual,
        getCoreV1Api: () => ({
            deleteNamespacedSecret: mockDeleteNamespacedSecret,
        }),
        getCustomObjectsApi: () => ({
            getNamespacedCustomObject: mockGetNamespacedCustomObject,
        }),
    };
});

interface PrivateWorkflowWatch {
    handleEvent(workflow: unknown): Promise<void>;
    deriveFailureCause(workflow: unknown, phase: string): string;
}

const asPrivate = (service: WorkflowWatchService): PrivateWorkflowWatch =>
    service as unknown as PrivateWorkflowWatch;

describe('WorkflowWatchService', () => {
    let service: WorkflowWatchService;
    let actionRepo: Repository<ActionEntity>;
    let apikeyRepo: Repository<ApiKeyEntity>;
    let artifactStatusService: ArtifactStatusService;
    let resourceUsageService: ResourceUsageService;
    let actionErrorHintService: ActionErrorHintService;

    const actionUuid = 'action-uuid';

    beforeEach(() => {
        jest.clearAllMocks();

        actionRepo = {
            findOne: jest.fn(),
            update: jest.fn().mockResolvedValue({}),
            find: jest.fn().mockResolvedValue([]),
        } as unknown as Repository<ActionEntity>;

        apikeyRepo = {
            findOne: jest.fn().mockResolvedValue(null),
            save: jest.fn().mockResolvedValue({}),
        } as unknown as Repository<ApiKeyEntity>;

        artifactStatusService = {
            recordFromWorkflowStatus: jest.fn().mockResolvedValue(undefined),
        } as unknown as ArtifactStatusService;

        resourceUsageService = {
            recordUsage: jest.fn().mockResolvedValue(undefined),
        } as unknown as ResourceUsageService;

        actionErrorHintService = {
            assess: jest.fn().mockResolvedValue(undefined),
        } as unknown as ActionErrorHintService;

        service = new WorkflowWatchService(
            actionRepo,
            apikeyRepo,
            artifactStatusService,
            resourceUsageService,
            actionErrorHintService,
        );

        mockDeleteNamespacedSecret.mockResolvedValue({});
    });

    const workflowLabels = (uuid: string) => ({
        'kleinkram.local/action-uuid': uuid,
    });

    describe('handleEvent phase mapping', () => {
        test('Running moves a non-PROCESSING action to PROCESSING', async () => {
            (actionRepo.findOne as jest.Mock).mockResolvedValue({
                uuid: actionUuid,
                state: ActionState.STARTING,
            });

            await asPrivate(service).handleEvent({
                metadata: { labels: workflowLabels(actionUuid) },
                status: { phase: 'Running', startedAt: '2026-01-01T00:00:00Z' },
            });

            expect(actionRepo.update).toHaveBeenCalledWith(
                { uuid: actionUuid },
                expect.objectContaining({ state: ActionState.PROCESSING }),
            );
        });

        test('Running is a no-op when the action is already PROCESSING', async () => {
            (actionRepo.findOne as jest.Mock).mockResolvedValue({
                uuid: actionUuid,
                state: ActionState.PROCESSING,
            });

            await asPrivate(service).handleEvent({
                metadata: { labels: workflowLabels(actionUuid) },
                status: { phase: 'Running' },
            });

            expect(actionRepo.update).not.toHaveBeenCalled();
        });

        test('Succeeded marks the action DONE and records artifacts/usage', async () => {
            (actionRepo.findOne as jest.Mock).mockResolvedValue({
                uuid: actionUuid,
                state: ActionState.PROCESSING,
                template: { cpuMemory: 2 },
            });

            await asPrivate(service).handleEvent({
                metadata: { labels: workflowLabels(actionUuid) },
                status: {
                    phase: 'Succeeded',
                    startedAt: '2026-01-01T00:00:00Z',
                    finishedAt: '2026-01-01T00:05:00Z',
                },
            });

            expect(actionRepo.update).toHaveBeenCalledWith(
                { uuid: actionUuid },
                expect.objectContaining({ state: ActionState.DONE }),
            );
            expect(
                artifactStatusService.recordFromWorkflowStatus,
            ).toHaveBeenCalledWith(actionUuid, expect.anything());
            expect(resourceUsageService.recordUsage).toHaveBeenCalled();
            expect(actionErrorHintService.assess).not.toHaveBeenCalled();
            expect(mockDeleteNamespacedSecret).toHaveBeenCalled();
        });

        test('Failed marks the action FAILED and asks for an error hint', async () => {
            (actionRepo.findOne as jest.Mock).mockResolvedValue({
                uuid: actionUuid,
                state: ActionState.PROCESSING,
                template: { cpuMemory: 2 },
            });

            await asPrivate(service).handleEvent({
                metadata: { labels: workflowLabels(actionUuid) },
                status: {
                    phase: 'Failed',
                    message: 'OOMKilled',
                    finishedAt: '2026-01-01T00:05:00Z',
                },
            });

            expect(actionRepo.update).toHaveBeenCalledWith(
                { uuid: actionUuid },
                expect.objectContaining({ state: ActionState.FAILED }),
            );
            expect(actionErrorHintService.assess).toHaveBeenCalledWith(
                actionUuid,
            );
        });

        test('a terminal phase on an already-CANCELLED action only triggers cleanup', async () => {
            (actionRepo.findOne as jest.Mock).mockResolvedValue({
                uuid: actionUuid,
                state: ActionState.CANCELLED,
            });

            await asPrivate(service).handleEvent({
                metadata: { labels: workflowLabels(actionUuid) },
                status: { phase: 'Failed' },
            });

            expect(actionRepo.update).not.toHaveBeenCalled();
            expect(mockDeleteNamespacedSecret).toHaveBeenCalled();
        });

        test('Pending is a no-op', async () => {
            (actionRepo.findOne as jest.Mock).mockResolvedValue({
                uuid: actionUuid,
                state: ActionState.STARTING,
            });

            await asPrivate(service).handleEvent({
                metadata: { labels: workflowLabels(actionUuid) },
                status: { phase: 'Pending' },
            });

            expect(actionRepo.update).not.toHaveBeenCalled();
        });
    });

    describe('deriveFailureCause', () => {
        test('recognizes an OOMKilled message', () => {
            const cause = asPrivate(service).deriveFailureCause(
                { status: { message: 'container OOMKilled' } },
                'Failed',
            );
            expect(cause).toContain('OOMKilled');
        });

        test('recognizes a deadline-exceeded message', () => {
            const cause = asPrivate(service).deriveFailureCause(
                { status: { message: 'pod active deadline exceeded' } },
                'Failed',
            );
            expect(cause).toBe('Action exceeded its maximum runtime.');
        });

        test('falls back to a generic message when Argo gives no detail', () => {
            const cause = asPrivate(service).deriveFailureCause(
                { status: {} },
                'Error',
            );
            expect(cause).toContain('no further detail');
        });
    });

    describe('reconcileStuckActions', () => {
        test('marks an action FAILED when its backing Workflow is gone (404)', async () => {
            (actionRepo.find as jest.Mock).mockResolvedValue([
                {
                    uuid: actionUuid,
                    state: ActionState.PROCESSING,
                    workflowName: 'action-action-uuid',
                },
            ]);
            mockGetNamespacedCustomObject.mockRejectedValue({ code: 404 });

            await service.reconcileStuckActions();

            expect(actionRepo.update).toHaveBeenCalledWith(
                { uuid: actionUuid },
                expect.objectContaining({ state: ActionState.FAILED }),
            );
        });

        test('leaves an action alone when its Workflow still exists', async () => {
            (actionRepo.find as jest.Mock).mockResolvedValue([
                {
                    uuid: actionUuid,
                    state: ActionState.PROCESSING,
                    workflowName: 'action-action-uuid',
                },
            ]);
            mockGetNamespacedCustomObject.mockResolvedValue({});

            await service.reconcileStuckActions();

            expect(actionRepo.update).not.toHaveBeenCalled();
        });

        test('ignores non-404 errors without marking the action FAILED', async () => {
            (actionRepo.find as jest.Mock).mockResolvedValue([
                {
                    uuid: actionUuid,
                    state: ActionState.PROCESSING,
                    workflowName: 'action-action-uuid',
                },
            ]);
            mockGetNamespacedCustomObject.mockRejectedValue({ code: 500 });

            await service.reconcileStuckActions();

            expect(actionRepo.update).not.toHaveBeenCalled();
        });
    });
});
