import { ActionEntity } from '@kleinkram/backend-common/entities/action/action.entity';
import { ActionTemplateEntity } from '@kleinkram/backend-common/entities/action/action-template.entity';
import { ApiKeyEntity } from '@kleinkram/backend-common/entities/auth/api-key.entity';
import { AccessControlService } from '@kleinkram/backend-common/modules/access-control/access-control.service';
import { ActionQueueJob } from '@kleinkram/backend-common/modules/action-dispatcher/action-queue.constants';
import { ActionState, AccessGroupRights } from '@kleinkram/shared';
import { Job } from 'bull';
import { Repository } from 'typeorm';
import {
    actionPodServiceAccount,
    actionsNamespace,
    apiKeySecretNameForAction,
    workflowNameForAction,
} from '../../src/actions/helper/kube-client';
import { ImageResolutionService } from '../../src/actions/services/image-resolution.service';
import { WorkflowDispatchService } from '../../src/actions/services/workflow-dispatch.service';

jest.mock('../../src/logger', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockCreateNamespacedCustomObject = jest.fn();
const mockCreateNamespacedSecret = jest.fn();

jest.mock('../../src/actions/helper/kube-client', () => {
    const actual = jest.requireActual('../../src/actions/helper/kube-client');
    return {
        ...actual,
        getCoreV1Api: () => ({
            createNamespacedSecret: mockCreateNamespacedSecret,
        }),
        getCustomObjectsApi: () => ({
            createNamespacedCustomObject: mockCreateNamespacedCustomObject,
        }),
    };
});

describe('WorkflowDispatchService', () => {
    let service: WorkflowDispatchService;
    let actionRepo: Repository<ActionEntity>;
    let apikeyRepo: Repository<ApiKeyEntity>;
    let accessControlService: AccessControlService;
    let imageResolutionService: ImageResolutionService;

    const template = {
        uuid: 'template-uuid',
        image_name: 'ghcr.io/example/action:latest',
        cpuCores: 2,
        cpuMemory: 4,
        gpuMemory: 0,
        maxRuntime: 1,
        entrypoint: '',
        command: '',
        accessRights: AccessGroupRights.WRITE,
    } as ActionTemplateEntity;

    const mission = {
        uuid: 'mission-uuid',
        project: { uuid: 'project-uuid' },
    } as ActionEntity['mission'];

    const creator = { uuid: 'creator-uuid', role: undefined } as ActionEntity['creator'];

    const baseAction = {
        uuid: 'action-uuid',
        state: ActionState.PENDING,
        template,
        mission,
        creator,
        triggerUuid: undefined,
    } as ActionEntity;

    beforeEach(() => {
        jest.clearAllMocks();

        actionRepo = {
            findOneOrFail: jest.fn(),
            update: jest.fn().mockResolvedValue({}),
        } as unknown as Repository<ActionEntity>;

        apikeyRepo = {
            create: jest.fn((data) => data as ApiKeyEntity),
            save: jest.fn((data) =>
                Promise.resolve({
                    ...data,
                    uuid: 'apikey-uuid',
                    apikey: 'plaintext-key',
                }),
            ),
            update: jest.fn().mockResolvedValue({}),
        } as unknown as Repository<ApiKeyEntity>;

        accessControlService = {
            canAccessMission: jest.fn().mockResolvedValue(true),
        } as unknown as AccessControlService;

        imageResolutionService = {
            resolveImageDigest: jest.fn().mockResolvedValue({
                sha: 'sha256:abc',
                repoDigests: ['ghcr.io/example/action@sha256:abc'],
            }),
        } as unknown as ImageResolutionService;

        service = new WorkflowDispatchService(
            actionRepo,
            apikeyRepo,
            accessControlService,
            imageResolutionService,
        );

        mockCreateNamespacedCustomObject.mockResolvedValue({});
        mockCreateNamespacedSecret.mockResolvedValue({});
    });

    const job = (uuid: string): Job<{ uuid: string }> =>
        ({ data: { uuid } }) as Job<{ uuid: string }>;

    describe('submit', () => {
        test('skips actions that are not PENDING', async () => {
            (actionRepo.findOneOrFail as jest.Mock).mockResolvedValue({
                ...baseAction,
                state: ActionState.CANCELLED,
            });

            await service.submit(job('action-uuid'));

            expect(mockCreateNamespacedCustomObject).not.toHaveBeenCalled();
            expect(actionRepo.update).not.toHaveBeenCalled();
        });

        test('throws when required relations are missing', async () => {
            (actionRepo.findOneOrFail as jest.Mock).mockResolvedValue({
                ...baseAction,
                mission: undefined,
            });

            await expect(service.submit(job('action-uuid'))).rejects.toThrow(
                'missing required relations',
            );
        });

        test('marks the action FAILED when access has been revoked', async () => {
            (actionRepo.findOneOrFail as jest.Mock).mockResolvedValue(
                baseAction,
            );
            (
                accessControlService.canAccessMission as jest.Mock
            ).mockResolvedValue(false);

            await service.submit(job('action-uuid'));

            expect(actionRepo.update).toHaveBeenCalledWith('action-uuid', {
                state: ActionState.FAILED,
                // eslint-disable-next-line @typescript-eslint/naming-convention
                state_cause: expect.stringContaining('lost access'),
            });
            expect(mockCreateNamespacedCustomObject).not.toHaveBeenCalled();
        });

        test('builds an Argo Workflow manifest with Kueue label and CPU/memory resources', async () => {
            (actionRepo.findOneOrFail as jest.Mock).mockResolvedValue(
                baseAction,
            );

            await service.submit(job('action-uuid'));

            expect(mockCreateNamespacedCustomObject).toHaveBeenCalledTimes(1);
            const [call] = mockCreateNamespacedCustomObject.mock.calls;
            const manifest = call[0].body as {
                metadata: { name: string; namespace: string };
                spec: {
                    serviceAccountName: string;
                    activeDeadlineSeconds: number;
                    podMetadata: { labels: Record<string, string> };
                    templates: {
                        container: {
                            resources: {
                                requests: Record<string, string>;
                                limits: Record<string, string>;
                            };
                        };
                    }[];
                };
            };

            expect(manifest.metadata.name).toBe(
                workflowNameForAction('action-uuid'),
            );
            expect(manifest.metadata.namespace).toBe(actionsNamespace());
            expect(manifest.spec.serviceAccountName).toBe(
                actionPodServiceAccount(),
            );
            expect(manifest.spec.podMetadata.labels['kueue.x-k8s.io/queue-name']).toBeDefined();
            expect(manifest.spec.activeDeadlineSeconds).toBe(
                Math.round(template.maxRuntime * 3600),
            );

            const { resources } = manifest.spec.templates[0].container;
            expect(resources.requests['cpu']).toBe(
                template.cpuCores.toString(),
            );
            expect(resources.requests['memory']).toBe(
                `${template.cpuMemory.toString()}Gi`,
            );
            expect(resources.requests['nvidia.com/gpu']).toBeUndefined();
        });

        test('requests a GPU only when the template declares gpuMemory > 0', async () => {
            (actionRepo.findOneOrFail as jest.Mock).mockResolvedValue({
                ...baseAction,
                template: { ...template, gpuMemory: 8 },
            });

            await service.submit(job('action-uuid'));

            const [call] = mockCreateNamespacedCustomObject.mock.calls;
            const manifest = call[0].body as {
                spec: {
                    templates: {
                        container: {
                            resources: {
                                requests: Record<string, string>;
                                limits: Record<string, string>;
                            };
                        };
                    }[];
                };
            };
            expect(
                manifest.spec.templates[0].container.resources.requests[
                    'nvidia.com/gpu'
                ],
            ).toBe('1');
        });

        test('updates the action to STARTING with the generated workflow name on success', async () => {
            (actionRepo.findOneOrFail as jest.Mock).mockResolvedValue(
                baseAction,
            );

            await service.submit(job('action-uuid'));

            expect(actionRepo.update).toHaveBeenCalledWith(
                'action-uuid',
                expect.objectContaining({
                    state: ActionState.STARTING,
                    workflowName: workflowNameForAction('action-uuid'),
                }),
            );
        });

        test('disposes the minted API key and rethrows when workflow submission fails', async () => {
            (actionRepo.findOneOrFail as jest.Mock).mockResolvedValue(
                baseAction,
            );
            mockCreateNamespacedCustomObject.mockRejectedValue(
                new Error('admission webhook denied'),
            );

            await expect(service.submit(job('action-uuid'))).rejects.toThrow(
                'admission webhook denied',
            );

            expect(apikeyRepo.update).toHaveBeenCalledWith(
                { uuid: 'apikey-uuid' },
                expect.objectContaining({ deletedAt: expect.anything() }),
            );
        });

        test('mints a per-run API key Secret named after the action', async () => {
            (actionRepo.findOneOrFail as jest.Mock).mockResolvedValue(
                baseAction,
            );

            await service.submit(job('action-uuid'));

            expect(mockCreateNamespacedSecret).toHaveBeenCalledWith(
                expect.objectContaining({
                    namespace: actionsNamespace(),
                    body: expect.objectContaining({
                        metadata: expect.objectContaining({
                            name: apiKeySecretNameForAction('action-uuid'),
                        }),
                    }),
                }),
            );
        });
    });

    describe('onJobFailed', () => {
        test('ignores jobs that are not SUBMIT jobs', async () => {
            await service.onJobFailed(
                {
                    name: ActionQueueJob.CANCEL,
                    data: { uuid: 'action-uuid' },
                    attemptsMade: 3,
                    opts: { attempts: 3 },
                } as unknown as Job<{ uuid: string }>,
                new Error('boom'),
            );

            expect(actionRepo.update).not.toHaveBeenCalled();
        });

        test('does nothing while retry attempts remain', async () => {
            await service.onJobFailed(
                {
                    name: ActionQueueJob.SUBMIT,
                    data: { uuid: 'action-uuid' },
                    attemptsMade: 1,
                    opts: { attempts: 3 },
                } as unknown as Job<{ uuid: string }>,
                new Error('boom'),
            );

            expect(actionRepo.update).not.toHaveBeenCalled();
        });

        test('marks the action UNPROCESSABLE once attempts are exhausted', async () => {
            await service.onJobFailed(
                {
                    name: ActionQueueJob.SUBMIT,
                    data: { uuid: 'action-uuid' },
                    attemptsMade: 3,
                    opts: { attempts: 3 },
                } as unknown as Job<{ uuid: string }>,
                new Error('boom'),
            );

            expect(actionRepo.update).toHaveBeenCalledWith('action-uuid', {
                state: ActionState.UNPROCESSABLE,
                // eslint-disable-next-line @typescript-eslint/naming-convention
                state_cause: 'boom',
            });
        });
    });
});
