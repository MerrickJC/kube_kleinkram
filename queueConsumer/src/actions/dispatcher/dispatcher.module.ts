import { ActionEntity } from '@kleinkram/backend-common/entities/action/action.entity';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ActionsModule } from '../actions.module';
import { WorkflowDispatchService } from '../services/workflow-dispatch.service';
import { ClusterStateService } from './cluster-state.service';
import { DispatchStoreService } from './dispatch-store.service';
import { DISPATCHER_METRIC_PROVIDERS } from './dispatcher.metrics';
import { LeaderLockService } from './leader-lock.service';
import { LocalityDispatcherService, WORKFLOW_SUBMITTER } from './locality-dispatcher.service';

/**
 * Registered unconditionally in app.module.ts; every service here no-ops
 * in its onModuleInit when ACTION_DISPATCHER_ENABLED is unset, so running
 * this module costs nothing on a deployment that isn't the action-dispatcher
 * (see each service's guard and the plan's architecture decision - this
 * app.module.ts-level simplicity is traded for a runtime check instead of
 * conditional NestJS module wiring).
 *
 * WORKFLOW_SUBMITTER delegates to WorkflowDispatchService.submitForDispatcher
 * (imported via ActionsModule, which exports it for exactly this purpose) -
 * the Phase 5 cutover's real callback for "build and submit the Workflow
 * now that a node has been decided".
 */
@Module({
    imports: [TypeOrmModule.forFeature([ActionEntity]), ActionsModule],
    providers: [
        ClusterStateService,
        DispatchStoreService,
        LeaderLockService,
        LocalityDispatcherService,
        {
            provide: WORKFLOW_SUBMITTER,
            useFactory: (service: WorkflowDispatchService) => ({
                submit: (actionUuid: string, node: string) =>
                    service.submitForDispatcher(actionUuid, node),
            }),
            inject: [WorkflowDispatchService],
        },
        ...DISPATCHER_METRIC_PROVIDERS,
    ],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class DispatcherModule {}
