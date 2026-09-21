import { ActionTemplateEntity } from '@backend-common/entities/action/action-template.entity';
import { ActionEntity } from '@backend-common/entities/action/action.entity';
import { AccessGroupEntity } from '@backend-common/entities/auth/access-group.entity';
import { AccountEntity } from '@backend-common/entities/auth/account.entity';
import { MetadataEntity } from '@backend-common/entities/metadata/metadata.entity';
import { MissionEntity } from '@backend-common/entities/mission/mission.entity';
import { ProjectEntity } from '@backend-common/entities/project/project.entity';
import { MissionAccessViewEntity } from '@backend-common/viewEntities/mission-access-view.entity';
import { ProjectAccessViewEntity } from '@backend-common/viewEntities/project-access-view.entity';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccessControlModule } from '../access-control/access-control.module';
import { ActionDispatcherService } from './action-dispatcher.service';

@Module({
    imports: [
        TypeOrmModule.forFeature([
            ActionEntity,
            ActionTemplateEntity,
            AccessGroupEntity,
            ProjectEntity,
            MissionEntity,
            AccountEntity,
            MetadataEntity,
            MissionAccessViewEntity,
            ProjectAccessViewEntity,
        ]),
        AccessControlModule,
    ],
    providers: [ActionDispatcherService],
    exports: [ActionDispatcherService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class ActionDispatcherModule {}
