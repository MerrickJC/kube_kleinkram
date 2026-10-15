import {
    jobClassForTemplate,
    resourceVectorForTemplate,
} from '../../src/actions/dispatcher/job-request';

describe('jobClassForTemplate', () => {
    test('should classify a template with gpuMemory as gpu', () => {
        expect(jobClassForTemplate({ cpuCores: 1, cpuMemory: 1, gpuMemory: 4 })).toBe('gpu');
    });

    test('should classify a template with no gpuMemory as cpu', () => {
        expect(jobClassForTemplate({ cpuCores: 1, cpuMemory: 1, gpuMemory: 0 })).toBe('cpu');
    });
});

describe('resourceVectorForTemplate', () => {
    test('should convert whole cpu cores to millicores and Gi memory to bytes', () => {
        const vector = resourceVectorForTemplate({ cpuCores: 2, cpuMemory: 4, gpuMemory: 0 });
        expect(vector.cpuMilli).toBe(2000);
        expect(vector.memBytes).toBe(4 * 2 ** 30);
        expect(vector.gpu).toBe(0);
    });

    test('should request exactly one gpu device whenever gpuMemory is positive', () => {
        const vector = resourceVectorForTemplate({ cpuCores: 1, cpuMemory: 1, gpuMemory: 16 });
        expect(vector.gpu).toBe(1);
    });
});
