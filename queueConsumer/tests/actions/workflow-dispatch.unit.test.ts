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
const mockListNode = jest.fn();

jest.mock('../../src/actions/helper/kube-client', () => {
    const actual = jest.requireActual('../../src/actions/helper/kube-client');
    return {
        ...actual,
        getCoreV1Api: () => ({
            createNamespacedSecret: mockCreateNamespacedSecret,
            listNode: mockListNode,
        }),
        getCustomObjectsApi: () => ({
            createNamespacedCustomObject: mockCreateNamespacedCustomObject,
        }),
        // listCacheTierNodes calls getCoreV1Api() via its own module-local
        // binding, not through this mock's re-exported property, so it has
        // to be overridden directly rather than relying on the
        // getCoreV1Api override above to reach it.
        listCacheTierNodes: async (labelSelector: string) => {
            const response = await mockListNode({ labelSelector });
            return response.items;
        },
    };
});

const node = (
    name: string,
    labels: Record<string, string> = {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any => ({
    metadata: {
        name,
        labels: { 'kubernetes.io/hostname': name, ...labels },
    },
    spec: { unschedulable: false },
    status: { conditions: [{ type: 'Ready', status: 'True' }] },
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
        mockListNode.mockResolvedValue({ items: [] });
    });

    afterEach(() => {
        delete process.env['LOCALITY_ENABLED'];
        delete process.env['LOCALITY_NODE_LABEL_SELECTOR'];
        delete process.env['LOCALITY_GPU_NODE_LABEL_SELECTOR'];
        delete process.env['LOCALITY_TIER_SIZES'];
        delete process.env['LOCALITY_FALLBACK_RETRY_LIMIT'];
    });

    const job = (uuid: string): Job<{ uuid: string }> =>
        ({ data: { uuid } }) as Job<{ uuid: string }>;

    interface ManifestTemplate {
        name: string;
        podSpecPatch?: string;
        retryStrategy?: { limit: number; retryPolicy: string };
        steps?: {
            name: string;
            template: string;
            when?: string;
            continueOn?: { error: boolean; failed: boolean };
        }[][];
        container?: {
            resources: {
                requests: Record<string, string>;
                limits: Record<string, string>;
            };
        };
    }

    interface Manifest {
        spec: { entrypoint: string; templates: ManifestTemplate[] };
    }

    interface MatchExpression {
        key: string;
        operator: string;
        values: string[];
    }

    const findTemplate = (
        manifest: Manifest,
        name: string,
    ): ManifestTemplate | undefined =>
        manifest.spec.templates.find((t) => t.name === name);

    const patchMatchExpressions = (
        template: ManifestTemplate | undefined,
    ): MatchExpression[] => {
        const patch = JSON.parse(template?.podSpecPatch ?? '{}') as {
            affinity?: {
                nodeAffinity?: {
                    requiredDuringSchedulingIgnoredDuringExecution?: {
                        nodeSelectorTerms: {
                            matchExpressions: MatchExpression[];
                        }[];
                    };
                };
            };
        };
        return (
            patch.affinity?.nodeAffinity
                ?.requiredDuringSchedulingIgnoredDuringExecution
                ?.nodeSelectorTerms[0]?.matchExpressions ?? []
        );
    };

    interface PreferredTerm {
        weight: number;
        preference: { matchExpressions: MatchExpression[] };
    }

    const patchPreferredTerms = (
        template: ManifestTemplate | undefined,
    ): PreferredTerm[] => {
        const patch = JSON.parse(template?.podSpecPatch ?? '{}') as {
            affinity?: {
                nodeAffinity?: {
                    preferredDuringSchedulingIgnoredDuringExecution?: PreferredTerm[];
                };
            };
        };
        return (
            patch.affinity?.nodeAffinity
                ?.preferredDuringSchedulingIgnoredDuringExecution ?? []
        );
    };

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

    describe('locality tiers', () => {
        test('dispatches a single unconstrained template when no cache-tier nodes are found', async () => {
            (actionRepo.findOneOrFail as jest.Mock).mockResolvedValue(
                baseAction,
            );
            mockListNode.mockResolvedValue({ items: [] });

            await service.submit(job('action-uuid'));

            const [call] = mockCreateNamespacedCustomObject.mock.calls;
            const manifest = call[0].body as Manifest;
            expect(manifest.spec.entrypoint).toBe('run-action');
            expect(manifest.spec.templates).toHaveLength(1);
            expect(manifest.spec.templates[0]?.podSpecPatch).toBeUndefined();
        });

        test('builds a single strict tier plus a cache-any fallback when only one node is eligible', async () => {
            (actionRepo.findOneOrFail as jest.Mock).mockResolvedValue(
                baseAction,
            );
            mockListNode.mockResolvedValue({ items: [node('node-a')] });

            await service.submit(job('action-uuid'));

            const [call] = mockCreateNamespacedCustomObject.mock.calls;
            const manifest = call[0].body as Manifest;
            expect(manifest.spec.entrypoint).toBe('main');

            const main = findTemplate(manifest, 'main');
            expect(main?.steps).toHaveLength(2);
            expect(main?.steps?.[0]?.[0]).toMatchObject({
                name: 'tier-0',
                template: 'run-action-tier-0',
                continueOn: { error: true, failed: true },
            });
            expect(main?.steps?.[1]?.[0]).toMatchObject({
                name: 'tier-cache-any',
                template: 'run-action-tier-cache-any',
                when: '{{steps.tier-0.status}} != Succeeded',
            });

            const tier0 = findTemplate(manifest, 'run-action-tier-0');
            expect(patchMatchExpressions(tier0)).toEqual([
                {
                    key: 'kubernetes.io/hostname',
                    operator: 'In',
                    values: ['node-a'],
                },
            ]);

            const fallback = findTemplate(
                manifest,
                'run-action-tier-cache-any',
            );
            expect(patchMatchExpressions(fallback)).toEqual([
                { key: 'cache-tier', operator: 'In', values: ['true'] },
            ]);
            expect(fallback?.retryStrategy).toEqual({
                limit: 20,
                retryPolicy: 'Always',
            });

            // The required constraint narrows candidates per tier, but the
            // same weighted preference is layered on every tier (including
            // the fallback) so a free, better-ranked node is still favored
            // among whatever that tier allows.
            const expectedPreferred = [
                {
                    weight: 100,
                    preference: {
                        matchExpressions: [
                            {
                                key: 'kubernetes.io/hostname',
                                operator: 'In',
                                values: ['node-a'],
                            },
                        ],
                    },
                },
            ];
            expect(patchPreferredTerms(tier0)).toEqual(expectedPreferred);
            expect(patchPreferredTerms(fallback)).toEqual(expectedPreferred);
        });

        test('widens through top-1, top-2 and top-4 strict tiers before the cache-any fallback with 5+ nodes', async () => {
            (actionRepo.findOneOrFail as jest.Mock).mockResolvedValue(
                baseAction,
            );
            mockListNode.mockResolvedValue({
                items: [
                    node('node-a'),
                    node('node-b'),
                    node('node-c'),
                    node('node-d'),
                    node('node-e'),
                ],
            });

            await service.submit(job('action-uuid'));

            const [call] = mockCreateNamespacedCustomObject.mock.calls;
            const manifest = call[0].body as Manifest;

            const main = findTemplate(manifest, 'main');
            expect(main?.steps).toHaveLength(4);
            expect(main?.steps?.map((s) => s[0]?.name)).toEqual([
                'tier-0',
                'tier-1',
                'tier-2',
                'tier-cache-any',
            ]);

            expect(
                patchMatchExpressions(
                    findTemplate(manifest, 'run-action-tier-0'),
                )[0]?.values,
            ).toHaveLength(1);
            expect(
                patchMatchExpressions(
                    findTemplate(manifest, 'run-action-tier-1'),
                )[0]?.values,
            ).toHaveLength(2);
            expect(
                patchMatchExpressions(
                    findTemplate(manifest, 'run-action-tier-2'),
                )[0]?.values,
            ).toHaveLength(4);

            // Preferred weights halve per rank (100, 50, 25, 12 after
            // flooring) and are capped at the largest configured tier size
            // (4 by default), rather than weighting all 5 eligible nodes
            const tier0Preferred = patchPreferredTerms(
                findTemplate(manifest, 'run-action-tier-0'),
            );
            expect(tier0Preferred.map((t) => t.weight)).toEqual([
                100, 50, 25, 12,
            ]);

            // The exact same shared ranking is layered onto every tier,
            // including ones whose required constraint only allows a
            // subset of it, and onto the cache-any fallback
            expect(
                patchPreferredTerms(findTemplate(manifest, 'run-action-tier-1')),
            ).toEqual(tier0Preferred);
            expect(
                patchPreferredTerms(findTemplate(manifest, 'run-action-tier-2')),
            ).toEqual(tier0Preferred);
            expect(
                patchPreferredTerms(
                    findTemplate(manifest, 'run-action-tier-cache-any'),
                ),
            ).toEqual(tier0Preferred);
        });

        test('honors LOCALITY_TIER_SIZES to customize strict tier sizes', async () => {
            process.env['LOCALITY_TIER_SIZES'] = '1,3';
            (actionRepo.findOneOrFail as jest.Mock).mockResolvedValue(
                baseAction,
            );
            mockListNode.mockResolvedValue({
                items: [node('node-a'), node('node-b'), node('node-c')],
            });

            await service.submit(job('action-uuid'));

            const [call] = mockCreateNamespacedCustomObject.mock.calls;
            const manifest = call[0].body as Manifest;

            const main = findTemplate(manifest, 'main');
            expect(main?.steps).toHaveLength(3);
            expect(
                patchMatchExpressions(
                    findTemplate(manifest, 'run-action-tier-0'),
                )[0]?.values,
            ).toHaveLength(1);
            expect(
                patchMatchExpressions(
                    findTemplate(manifest, 'run-action-tier-1'),
                )[0]?.values,
            ).toHaveLength(3);
        });

        test('ranks only GPU-labeled nodes for a GPU action and ANDs the GPU selector into the fallback tier', async () => {
            (actionRepo.findOneOrFail as jest.Mock).mockResolvedValue({
                ...baseAction,
                template: { ...template, gpuMemory: 8 },
            });
            mockListNode.mockResolvedValue({
                items: [
                    node('cpu-node-a'),
                    node('gpu-node-a', { gpu: 'true' }),
                ],
            });

            await service.submit(job('action-uuid'));

            const [call] = mockCreateNamespacedCustomObject.mock.calls;
            const manifest = call[0].body as Manifest;

            expect(
                patchMatchExpressions(
                    findTemplate(manifest, 'run-action-tier-0'),
                )[0]?.values,
            ).toEqual(['gpu-node-a']);

            expect(
                patchMatchExpressions(
                    findTemplate(manifest, 'run-action-tier-cache-any'),
                ),
            ).toEqual([
                { key: 'cache-tier', operator: 'In', values: ['true'] },
                { key: 'gpu', operator: 'In', values: ['true'] },
            ]);
        });

        test('falls back to no affinity when a GPU action has no eligible GPU-labeled cache-tier node', async () => {
            (actionRepo.findOneOrFail as jest.Mock).mockResolvedValue({
                ...baseAction,
                template: { ...template, gpuMemory: 8 },
            });
            mockListNode.mockResolvedValue({ items: [node('cpu-node-a')] });

            await service.submit(job('action-uuid'));

            const [call] = mockCreateNamespacedCustomObject.mock.calls;
            const manifest = call[0].body as Manifest;
            expect(manifest.spec.entrypoint).toBe('run-action');
            expect(manifest.spec.templates[0]?.podSpecPatch).toBeUndefined();
        });

        test('excludes cordoned and not-Ready nodes from ranking', async () => {
            (actionRepo.findOneOrFail as jest.Mock).mockResolvedValue(
                baseAction,
            );
            mockListNode.mockResolvedValue({
                items: [
                    {
                        ...node('unschedulable-node'),
                        spec: { unschedulable: true },
                    },
                    {
                        ...node('not-ready-node'),
                        status: {
                            conditions: [
                                { type: 'Ready', status: 'False' },
                            ],
                        },
                    },
                    {
                        ...node('healthy-node'),
                        status: {
                            conditions: [{ type: 'Ready', status: 'True' }],
                        },
                    },
                ],
            });

            await service.submit(job('action-uuid'));

            const [call] = mockCreateNamespacedCustomObject.mock.calls;
            const manifest = call[0].body as Manifest;
            expect(
                patchMatchExpressions(
                    findTemplate(manifest, 'run-action-tier-0'),
                )[0]?.values,
            ).toEqual(['healthy-node']);
        });

        test('dispatches a single unconstrained template when locality is disabled', async () => {
            process.env['LOCALITY_ENABLED'] = 'false';
            (actionRepo.findOneOrFail as jest.Mock).mockResolvedValue(
                baseAction,
            );
            mockListNode.mockResolvedValue({
                items: [node('node-a'), node('node-b')],
            });

            await service.submit(job('action-uuid'));

            expect(mockListNode).not.toHaveBeenCalled();
            const [call] = mockCreateNamespacedCustomObject.mock.calls;
            const manifest = call[0].body as Manifest;
            expect(manifest.spec.entrypoint).toBe('run-action');
            expect(manifest.spec.templates[0]?.podSpecPatch).toBeUndefined();
        });

        test('dispatches a single unconstrained template when the node list fetch fails', async () => {
            (actionRepo.findOneOrFail as jest.Mock).mockResolvedValue(
                baseAction,
            );
            mockListNode.mockRejectedValue(new Error('API unreachable'));

            await service.submit(job('action-uuid'));

            expect(mockCreateNamespacedCustomObject).toHaveBeenCalledTimes(1);
            const [call] = mockCreateNamespacedCustomObject.mock.calls;
            const manifest = call[0].body as Manifest;
            expect(manifest.spec.entrypoint).toBe('run-action');
            expect(manifest.spec.templates[0]?.podSpecPatch).toBeUndefined();
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
