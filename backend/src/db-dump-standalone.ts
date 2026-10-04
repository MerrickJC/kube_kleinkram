// Entry point for the `db-dumper` image/CronJob. Only needs pg_dump + minimal S3 access,
// not the full set of api-server dependency graph or DB privileges.
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`The environment variable "${name}" cannot be empty.`);
    }
    return value;
}

function resolveS3Endpoint(): string {
    const internal = process.env.S3_ENDPOINT_INTERNAL;
    const raw =
        internal && internal.length > 0 ? internal : requireEnv('S3_ENDPOINT');
    return /^https?:\/\//.test(raw) ? raw : `http://${raw}`;
}

async function main(): Promise<void> {
    const dbHost = requireEnv('DB_HOST');
    const dbPort = requireEnv('DB_PORT');
    const dbUser = requireEnv('DB_USER');
    const dbPassword = requireEnv('DB_PASSWORD');
    const dbName = requireEnv('DB_DATABASE');
    const bucketName = requireEnv('S3_DB_BUCKET_NAME');

    const dumpFile = join(tmpdir(), `backup-${Date.now().toString()}.sql`);

    console.log('Dumping database...');
    await execFileAsync(
        'pg_dump',
        [
            '-h',
            dbHost,
            '-p',
            dbPort,
            '-U',
            dbUser,
            '-F',
            'c',
            '-b',
            '-f',
            dumpFile,
            dbName,
        ],
        { env: { ...process.env, PGPASSWORD: dbPassword } },
    );

    const client = new S3Client({
        endpoint: resolveS3Endpoint(),
        credentials: {
            accessKeyId: requireEnv('S3_ACCESS_KEY'),
            secretAccessKey: requireEnv('S3_SECRET_KEY'),
        },
        region: 'us-east-1',
        forcePathStyle: true,
        requestChecksumCalculation: 'WHEN_REQUIRED',
    });

    const objectName = dumpFile.slice(dumpFile.lastIndexOf('/') + 1);
    console.log(
        `Uploading dump as "${objectName}" to bucket "${bucketName}"...`,
    );
    const { size: dumpFileSize } = await stat(dumpFile);
    await client.send(
        new PutObjectCommand({
            Bucket: bucketName,
            Key: objectName,
            Body: createReadStream(dumpFile),
            ContentLength: dumpFileSize,
        }),
    );

    await unlink(dumpFile);
    console.log('Database dump complete.');
}

main().catch((error: unknown) => {
    console.error('Failed to create database dump:', error);
    process.exit(1);
});
