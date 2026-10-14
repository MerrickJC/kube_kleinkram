import { ActionDto, AuditLogDto, DockerImageDto } from '@kleinkram/api-dto';
import { ActionEntity } from '@kleinkram/backend-common/entities/action/action.entity';
import { ActionState, ArtifactState } from '@kleinkram/shared';
import { actionTemplateEntityToDto } from './action-template';
import { missionEntityToDto, userEntityToDto } from './index';

export const actionEntityToDto = (action: ActionEntity): ActionDto => {
    if (action.creator === undefined) {
        throw new Error('Action must have a creator');
    }

    if (action.mission === undefined) {
        throw new Error('Action must have a mission');
    }

    if (action.template === undefined) {
        throw new Error('Action must have a template');
    }

    let runtime: number | undefined;
    if (action.actionContainerStartedAt) {
        const end = action.actionContainerExitedAt
            ? action.actionContainerExitedAt.getTime()
            : Date.now();
        runtime = (end - action.actionContainerStartedAt.getTime()) / 1000;
    }

    // Time spent queued (e.g. awaiting Kueue admission) before the Action's
    // container actually started, kept separate from `runtime` above so the
    // dashboard doesn't report wall-clock queue wait as execution time.
    let queueWaitSeconds: number | undefined;
    if (action.actionContainerStartedAt) {
        queueWaitSeconds =
            (action.actionContainerStartedAt.getTime() -
                action.createdAt.getTime()) /
            1000;
    } else if (
        action.state === ActionState.PENDING ||
        action.state === ActionState.STARTING
    ) {
        queueWaitSeconds = (Date.now() - action.createdAt.getTime()) / 1000;
    }

    let computedArtifactState = action.artifacts;
    if (
        action.artifactExpirationDate &&
        action.artifactExpirationDate < new Date() &&
        action.artifacts === ArtifactState.UPLOADED
    ) {
        computedArtifactState = ArtifactState.EXPIRED;
    }

    return {
        artifactUrl:
            computedArtifactState === ArtifactState.EXPIRED
                ? ''
                : (action.artifact_path ?? ''),
        artifacts: computedArtifactState,
        artifactSize: action.artifact_size,
        artifactFiles: action.artifact_files,
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        auditLogs: (action.auditLogs as unknown as AuditLogDto[]) ?? [],
        createdAt: action.createdAt,
        creator: userEntityToDto(action.creator),
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        image: (action.image as DockerImageDto) ?? { repoDigests: [] },
        runtime,
        queueWaitSeconds,

        mission: missionEntityToDto(action.mission),
        state: action.state,
        stateCause:
            action.state_cause === 'Container exited with code 0'
                ? 'Completed Successfully'
                : (action.state_cause ?? ''),
        template: actionTemplateEntityToDto(action.template),
        updatedAt: action.updatedAt,
        uuid: action.uuid,
        workflowName: action.workflowName ?? null,
        triggerSource: action.triggerSource,
        triggerUuid: action.triggerUuid,
        errorHint: action.errorHint,
        exitCode: action.exit_code,
        resourceUsage: action.resourceUsage,
        maxMemoryBytes: action.maxMemoryBytes,
        avgCpuPercent: action.avgCpuPercent,
        efficiencyScore: action.efficiencyScore,
    };
};
