import { Job } from 'bull';
import {
    actionsNamespace,
    ARGO_GROUP,
    ARGO_VERSION,
    WORKFLOW_PLURAL,
    workflowNameForAction,
} from '../../src/actions/helper/kube-client';
import { WorkflowCancellationService } from '../../src/actions/services/workflow-cancellation.service';

jest.mock('../../src/logger', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPatchNamespacedCustomObject = jest.fn();

jest.mock('../../src/actions/helper/kube-client', () => {
    const actual = jest.requireActual('../../src/actions/helper/kube-client');
    return {
        ...actual,
        getCustomObjectsApi: () => ({
            patchNamespacedCustomObject: mockPatchNamespacedCustomObject,
        }),
    };
});

describe('WorkflowCancellationService', () => {
    let service: WorkflowCancellationService;

    beforeEach(() => {
        jest.clearAllMocks();
        service = new WorkflowCancellationService();
    });

    const job = (uuid: string): Job<{ uuid: string }> =>
        ({ data: { uuid } }) as Job<{ uuid: string }>;

    test('patches the Workflow with a graceful-termination shutdown', async () => {
        mockPatchNamespacedCustomObject.mockResolvedValue({});

        await service.cancel(job('action-uuid'));

        expect(mockPatchNamespacedCustomObject).toHaveBeenCalledWith({
            group: ARGO_GROUP,
            version: ARGO_VERSION,
            namespace: actionsNamespace(),
            plural: WORKFLOW_PLURAL,
            name: workflowNameForAction('action-uuid'),
            body: { spec: { shutdown: 'Terminate' } },
        });
    });

    test('swallows a 404 when the Workflow is already gone or was never submitted', async () => {
        mockPatchNamespacedCustomObject.mockRejectedValue({
            code: 404,
        });

        await expect(service.cancel(job('action-uuid'))).resolves.toBeUndefined();
    });

    test('swallows a 404 reported via statusCode', async () => {
        mockPatchNamespacedCustomObject.mockRejectedValue({
            statusCode: 404,
        });

        await expect(service.cancel(job('action-uuid'))).resolves.toBeUndefined();
    });

    test('rethrows non-404 errors', async () => {
        mockPatchNamespacedCustomObject.mockRejectedValue({
            code: 500,
            message: 'internal error',
        });

        await expect(service.cancel(job('action-uuid'))).rejects.toMatchObject({
            code: 500,
        });
    });
});
