import { MigrationInterface, QueryRunner } from 'typeorm';

// All of these FKs are ON UPDATE NO ACTION, so repointing "user"."uuid"
// requires bypassing the FK check until the referencing rows are updated
// too. Neither `SET session_replication_role` nor `ALTER TABLE ...
// DISABLE TRIGGER` work for this without Postgres superuser. Dropping
// and recreating the constraint itself is ordinary DDL the table owner
// is allowed to do
const constraints = [
    {
        table: 'action',
        name: 'FK_65d5fd46d2baf1d1d04aed18fc1',
        column: 'creatorUuid',
        onDelete: 'NO ACTION',
    },
    {
        table: 'action_template',
        name: 'FK_2c6ce32d7ef9690cd202506ddff',
        column: 'creatorUuid',
        onDelete: 'NO ACTION',
    },
    {
        table: 'mission',
        name: 'FK_09a47a85ae3cc20dd215278c93e',
        column: 'creatorUuid',
        onDelete: 'NO ACTION',
    },
    {
        table: 'project',
        name: 'FK_3efb531ce858475d93ca2c8d8f7',
        column: 'creatorUuid',
        onDelete: 'NO ACTION',
    },
    {
        table: 'category',
        name: 'FK_b0ebe26a74adea2c452566606b5',
        column: 'creatorUuid',
        onDelete: 'NO ACTION',
    },
    {
        table: 'group_membership',
        name: 'FK_6b4d2fbf128cee85f97f082933e',
        column: 'userUuid',
        onDelete: 'CASCADE',
    },
    {
        table: 'tag',
        name: 'FK_9857972d0bb698a79a9a9e1497f',
        column: 'creatorUuid',
        onDelete: 'SET NULL',
    },
    {
        table: 'access_group',
        name: 'FK_d7623d6ba5a2747e0accf801698',
        column: 'creatorUuid',
        onDelete: 'NO ACTION',
    },
    {
        table: 'file_entity',
        name: 'FK_2a601a65aeaa1d39169e2c1b91c',
        column: 'creatorUuid',
        onDelete: 'NO ACTION',
    },
];

export class UpdateSystemUserUuid1769000000000 implements MigrationInterface {
    name = 'UpdateSystemUserUuid1769000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const oldUuid = '10000000-0000-0000-0000-000000000000';
        const newUuid = '00000000-0000-4000-8000-000000000000';

        for (const c of constraints) {
            await queryRunner.query(
                `ALTER TABLE "${c.table}" DROP CONSTRAINT "${c.name}"`,
            );
        }

        try {
            // Update User table
            await queryRunner.query(
                `UPDATE "user" SET "uuid" = '${newUuid}' WHERE "uuid" = '${oldUuid}'`,
            );

            // Update referencing tables
            for (const c of constraints) {
                await queryRunner.query(
                    `UPDATE "${c.table}" SET "${c.column}" = '${newUuid}' WHERE "${c.column}" = '${oldUuid}'`,
                );
            }
        } finally {
            for (const c of constraints) {
                await queryRunner.query(
                    `ALTER TABLE "${c.table}" ADD CONSTRAINT "${c.name}" FOREIGN KEY ("${c.column}") REFERENCES "user"("uuid") ON DELETE ${c.onDelete} ON UPDATE NO ACTION`,
                );
            }
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const oldUuid = '10000000-0000-0000-0000-000000000000';
        const newUuid = '00000000-0000-4000-8000-000000000000';

        for (const c of constraints) {
            await queryRunner.query(
                `ALTER TABLE "${c.table}" DROP CONSTRAINT "${c.name}"`,
            );
        }

        try {
            for (const c of constraints) {
                await queryRunner.query(
                    `UPDATE "${c.table}" SET "${c.column}" = '${oldUuid}' WHERE "${c.column}" = '${newUuid}'`,
                );
            }

            await queryRunner.query(
                `UPDATE "user" SET "uuid" = '${oldUuid}' WHERE "uuid" = '${newUuid}'`,
            );
        } finally {
            for (const c of constraints) {
                await queryRunner.query(
                    `ALTER TABLE "${c.table}" ADD CONSTRAINT "${c.name}" FOREIGN KEY ("${c.column}") REFERENCES "user"("uuid") ON DELETE ${c.onDelete} ON UPDATE NO ACTION`,
                );
            }
        }
    }
}
