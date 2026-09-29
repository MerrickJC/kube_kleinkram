import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOidcProvider1790659950151 implements MigrationInterface {
    name = 'AddOidcProvider1790659950151';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TYPE "public"."account_provider_enum" RENAME TO "account_provider_enum_old"`,
        );
        await queryRunner.query(
            `CREATE TYPE "public"."account_provider_enum" AS ENUM('google', 'github', 'fake-oauth', 'oidc')`,
        );
        await queryRunner.query(
            `ALTER TABLE "account" ALTER COLUMN "provider" TYPE "public"."account_provider_enum" USING "provider"::"text"::"public"."account_provider_enum"`,
        );
        await queryRunner.query(
            `DROP TYPE "public"."account_provider_enum_old"`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `CREATE TYPE "public"."account_provider_enum_old" AS ENUM('google', 'github', 'fake-oauth')`,
        );
        await queryRunner.query(
            `ALTER TABLE "account" ALTER COLUMN "provider" TYPE "public"."account_provider_enum_old" USING "provider"::"text"::"public"."account_provider_enum_old"`,
        );
        await queryRunner.query(`DROP TYPE "public"."account_provider_enum"`);
        await queryRunner.query(
            `ALTER TYPE "public"."account_provider_enum_old" RENAME TO "account_provider_enum"`,
        );
    }
}
