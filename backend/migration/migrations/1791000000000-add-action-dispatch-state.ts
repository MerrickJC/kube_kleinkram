import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the locality dispatcher's bookkeeping columns to `action`, orthogonal
 * to the existing `state`/ActionState machine (see queueConsumer/src/actions/dispatcher).
 * All nullable / defaulted so existing rows need no backfill.
 */
export class AddActionDispatchState1791000000000 implements MigrationInterface {
    name = 'AddActionDispatchState1791000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `CREATE TYPE "public"."action_dispatchstate_enum" AS ENUM('QUEUED', 'DISPATCHING', 'DISPATCHED')`,
        );
        await queryRunner.query(
            `CREATE TYPE "public"."action_dispatchkind_enum" AS ENUM('local', 'steal')`,
        );
        await queryRunner.query(
            `ALTER TABLE "action" ADD "dispatchState" "public"."action_dispatchstate_enum"`,
        );
        await queryRunner.query(`ALTER TABLE "action" ADD "homeNode" character varying`);
        await queryRunner.query(`ALTER TABLE "action" ADD "dispatchedAt" TIMESTAMP`);
        await queryRunner.query(`ALTER TABLE "action" ADD "dispatchNode" character varying`);
        await queryRunner.query(
            `ALTER TABLE "action" ADD "dispatchKind" "public"."action_dispatchkind_enum"`,
        );
        await queryRunner.query(
            `ALTER TABLE "action" ADD "dispatchAttempt" integer NOT NULL DEFAULT 0`,
        );
        await queryRunner.query(`ALTER TABLE "action" ADD "lastDispatchError" character varying`);

        // Partial index: only QUEUED/DISPATCHING rows are scanned by the
        // dispatcher's startup load and reconciliation (spec §5.1's
        // dispatch_jobs_queued index, applied to this table instead).
        await queryRunner.query(
            `CREATE INDEX "IDX_action_dispatch_queue" ON "action" ("dispatchState", "createdAt") WHERE "dispatchState" IN ('QUEUED', 'DISPATCHING')`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_action_dispatch_queue"`);
        await queryRunner.query(`ALTER TABLE "action" DROP COLUMN "lastDispatchError"`);
        await queryRunner.query(`ALTER TABLE "action" DROP COLUMN "dispatchedAt"`);
        await queryRunner.query(`ALTER TABLE "action" DROP COLUMN "dispatchAttempt"`);
        await queryRunner.query(`ALTER TABLE "action" DROP COLUMN "dispatchKind"`);
        await queryRunner.query(`ALTER TABLE "action" DROP COLUMN "dispatchNode"`);
        await queryRunner.query(`ALTER TABLE "action" DROP COLUMN "homeNode"`);
        await queryRunner.query(`ALTER TABLE "action" DROP COLUMN "dispatchState"`);
        await queryRunner.query(`DROP TYPE "public"."action_dispatchkind_enum"`);
        await queryRunner.query(`DROP TYPE "public"."action_dispatchstate_enum"`);
    }
}
