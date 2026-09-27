import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `WorkerEntity` and `ActionRunnerEntity` are not needed in Kubernetes setup
 * but aren't deleted yet to preserve data
 * 
 * action.workerUuid is replaced by action.workflowName, which records the Argo
 * Workflow submitted for the run instead of the worker it ran on
 */
export class RemoveWorkerEntities1789981250471 implements MigrationInterface {
    name = 'RemoveWorkerEntities1789981250471';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "action" ADD "workflowName" character varying`,
        );

        await queryRunner.query(
            `ALTER TABLE "action" DROP CONSTRAINT IF EXISTS "FK_8add324fcb3c33f895a48ad2f5f"`,
        );
        await queryRunner.query(
            `ALTER TABLE "action" DROP COLUMN IF EXISTS "workerUuid"`,
        );

        // await queryRunner.query(`DROP TABLE IF EXISTS "action_runner"`);
        // await queryRunner.query(`DROP TABLE IF EXISTS "worker"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // await queryRunner.query(
        //     `CREATE TABLE "worker" ("uuid" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "deletedAt" TIMESTAMP, "identifier" character varying NOT NULL, "hostname" character varying NOT NULL, "cpuMemory" double precision NOT NULL, "gpuModel" character varying, "gpuMemory" double precision NOT NULL DEFAULT '-1', "cpuCores" integer NOT NULL, "cpuModel" character varying NOT NULL, "storage" integer NOT NULL, "lastSeen" TIMESTAMP NOT NULL, "reachable" boolean NOT NULL, CONSTRAINT "PK_52e67de404e8f86a670a5ba9359" PRIMARY KEY ("uuid"))`,
        // );
        // await queryRunner.query(
        //     `CREATE UNIQUE INDEX "unique_worker_identifier_active" ON "worker" ("identifier") WHERE "deletedAt" IS NULL`,
        // );

        // await queryRunner.query(
        //     `CREATE TABLE "action_runner" ("uuid" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "deletedAt" TIMESTAMP, "hostname" character varying NOT NULL, "version" character varying NOT NULL, "gitHash" character varying NOT NULL, "startedAt" TIMESTAMP NOT NULL, "lastSeenAt" TIMESTAMP NOT NULL, CONSTRAINT "PK_7142c1ef313c280d5f666438263" PRIMARY KEY ("uuid"))`,
        // );
        // await queryRunner.query(
        //     `CREATE INDEX "IDX_352c56378e3f57ebfad9211f8e" ON "action_runner" ("deletedAt") `,
        // );

        await queryRunner.query(`ALTER TABLE "action" ADD "workerUuid" uuid`);
        await queryRunner.query(
            `ALTER TABLE "action" ADD CONSTRAINT "FK_8add324fcb3c33f895a48ad2f5f" FOREIGN KEY ("workerUuid") REFERENCES "worker"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION`,
        );

        await queryRunner.query(
            `ALTER TABLE "action" DROP COLUMN "workflowName"`,
        );
    }
}
