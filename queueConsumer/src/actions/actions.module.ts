import { AccessControlModule } from '@kleinkram/backend-common';
import { ActionTemplateEntity } from '@kleinkram/backend-common/entities/action/action-template.entity';
import { ActionTriggerEntity } from '@kleinkram/backend-common/entities/action/action-trigger.entity';
import { ActionEntity } from '@kleinkram/backend-common/entities/action/action.entity';
import { ApiKeyEntity } from '@kleinkram/backend-common/entities/auth/api-key.entity';
import { ACTION_DISPATCH_QUEUE_NAME } from '@kleinkram/backend-common/modules/action-dispatcher/action-queue.constants';
import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ACTION_METRIC_PROVIDERS } from './actions.metrics';
import { DispatchStoreService } from './dispatcher/dispatch-store.service';
import { ActionErrorHintService } from './services/action-error-hint.service';
import { ArtifactStatusService } from './services/artifact-status.service';
import { ImageResolutionService } from './services/image-resolution.service';
import { ResourceUsageService } from './services/resource-usage.service';
import { WorkflowCancellationService } from './services/workflow-cancellation.service';
import { WorkflowDispatchService } from './services/workflow-dispatch.service';
import { WorkflowWatchService } from './services/workflow-watch.service';

@Module({
    imports: [
        BullModule.registerQueue({
            name: ACTION_DISPATCH_QUEUE_NAME,
        }),
        TypeOrmModule.forFeature([
            ActionEntity,
            ApiKeyEntity,
            ActionTemplateEntity,
            ActionTriggerEntity,
        ]),
        AccessControlModule,
    ],
    providers: [
        WorkflowDispatchService,
        WorkflowWatchService,
        WorkflowCancellationService,
        ArtifactStatusService,
        ResourceUsageService,
        ImageResolutionService,
        ActionErrorHintService,
        DispatchStoreService,
        ...ACTION_METRIC_PROVIDERS,
    ],
    // DispatcherModule needs WorkflowDispatchService to wire the
    // WORKFLOW_SUBMITTER provider (dispatcher.module.ts) - the dispatcher's
    // callback into the manifest-building/submit logic once it has decided
    // on a node for a given Action.
    exports: [WorkflowDispatchService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class ActionsModule {}
