import { parseBytes } from '../helper/pod-requests';
import { outputVolumeSizeLimit } from './dispatcher.config';
import type { JobClass, ResourceVector } from './types';

/** The subset of ActionTemplateEntity the dispatcher's request vector depends on */
export interface ResourceTemplate {
    cpuCores: number;
    cpuMemory: number; // Gi
    gpuMemory: number;
}

export function jobClassForTemplate(template: ResourceTemplate): JobClass {
    return template.gpuMemory > 0 ? 'gpu' : 'cpu';
}

/**
 * Must stay in lockstep with WorkflowDispatchService.buildWorkflowManifest's
 * container.resources - the dispatcher's capacity accounting is only
 * correct if the request it reserves at claim time equals what the pod it
 * creates will actually request.
 */
export function resourceVectorForTemplate(template: ResourceTemplate): ResourceVector {
    return {
        cpuMilli: Math.round(template.cpuCores * 1000),
        memBytes: parseBytes(`${template.cpuMemory.toString()}Gi`),
        ephemeralBytes: parseBytes(outputVolumeSizeLimit()),
        gpu: template.gpuMemory > 0 ? 1 : 0,
    };
}
