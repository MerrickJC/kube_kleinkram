import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import environment from '@backend-common/environment';
import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'node:crypto';
import { StorageCredentials } from './types';

// JuiceFS's gateway (like AWS STS) requires a RoleArn to be present on
// AssumeRole, but ignores its value entirely for role-self-assumption so
// any syntactically plausible, sufficiently long string is accepted
const PLACEHOLDER_ROLE_ARN =
    'arn:aws:iam::000000000000:role/kleinkram-upload-session';

@Injectable()
export class StorageAuthService {
    private readonly stsClient: STSClient;
    private readonly logger = new Logger(StorageAuthService.name);

    constructor() {
        let endpointUrl = environment.S3_ENDPOINT_INTERNAL;

        if (endpointUrl) {
            if (!endpointUrl.includes('://')) {
                endpointUrl = `http://${endpointUrl}`;
            }
            if (!endpointUrl.split('://')[1].includes(':')) {
                endpointUrl = `${endpointUrl}:9000`;
            }
        } else {
            endpointUrl = 'http://seaweedfs:9000';
        }

        this.stsClient = new STSClient({
            endpoint: endpointUrl,
            region: environment.S3_REGION ?? 'us-east-1',
            credentials: {
                accessKeyId: environment.S3_ACCESS_KEY,
                secretAccessKey: environment.S3_SECRET_KEY,
            },
            systemClockOffset: 0,
        });
    }

    async generateTemporaryCredential(
        filename: string,
        bucketName: string,
    ): Promise<StorageCredentials> {
        const policy = {
            Version: '2012-10-17',
            Statement: [
                {
                    Effect: 'Allow',
                    Action: [
                        's3:PutObject',
                        's3:AbortMultipartUpload',
                        's3:ListMultipartUploadParts',
                    ],
                    Resource: [`arn:aws:s3:::${bucketName}/${filename}*`],
                },
            ],
        };
        const sessionName = `UploadSession-${crypto.randomUUID()}`;

        const command = new AssumeRoleCommand({
            RoleArn: PLACEHOLDER_ROLE_ARN,
            RoleSessionName: sessionName,
            Policy: JSON.stringify(policy),
            DurationSeconds: 60 * 60 * 4, // 4 hours
        });

        try {
            const response = await this.stsClient.send(command);

            if (!response.Credentials) {
                throw new Error(
                    'STS AssumeRole response did not include credentials.',
                );
            }

            return {
                accessKey: response.Credentials.AccessKeyId ?? '',
                secretKey: response.Credentials.SecretAccessKey ?? '',
                sessionToken: response.Credentials.SessionToken ?? '',
            };
        } catch (error: unknown) {
            this.logger.error(
                'Failed to generate temporary STS credential',
                error instanceof Error ? error.message : error,
            );
            throw error;
        }
    }
}
