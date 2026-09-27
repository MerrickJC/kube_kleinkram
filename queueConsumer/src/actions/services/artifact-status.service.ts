import { ActionEntity } from '@kleinkram/backend-common/entities/action/action.entity';
import { ArtifactState } from '@kleinkram/shared';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import logger from '../../logger';

interface WorkflowArtifact {
    name: string;
    s3?: { key?: string };
}

interface WorkflowNode {
    outputs?: { artifacts?: WorkflowArtifact[] };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WorkflowStatus = Record<string, any> & {
    nodes?: Record<string, WorkflowNode>;
};

/**
 * Argo Workflow's injected `wait` sidecar already staged `/out` to the S3 artifact
 * repository, so just need to read the size/key from the completed Workflow's status
 */
@Injectable()
export class ArtifactStatusService {
    constructor(
        @InjectRepository(ActionEntity)
        private actionRepository: Repository<ActionEntity>,
    ) {}

    async recordFromWorkflowStatus(
        actionUuid: string,
        status: WorkflowStatus,
    ): Promise<void> {
        const nodes = Object.values(status.nodes ?? {});
        const artifact = nodes
            .flatMap((node) => node.outputs?.artifacts ?? [])
            .find((entry) => entry.name === 'results' && entry.s3?.key);

        if (!artifact?.s3?.key) {
            logger.debug(
                `No 'results' artifact recorded on Workflow status for action ${actionUuid}`,
            );
            await this.actionRepository.update(
                { uuid: actionUuid },
                { artifacts: ArtifactState.ERROR },
            );
            return;
        }

        await this.actionRepository.update(
            { uuid: actionUuid },
            {
                artifacts: ArtifactState.UPLOADED,
                // eslint-disable-next-line @typescript-eslint/naming-convention
                artifact_path: artifact.s3.key,
            },
        );
    }
}
