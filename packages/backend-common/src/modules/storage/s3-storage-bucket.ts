import {
    DeleteObjectCommand,
    DeleteObjectTaggingCommand,
    GetObjectCommand,
    GetObjectTaggingCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    NotFound,
    PutObjectCommand,
    PutObjectTaggingCommand,
    _Object,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Logger } from '@nestjs/common';
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StorageAuthService } from './storage-auth.service';
import { S3ClientContainer } from './storage-config.factory';
import {
    IStorageBucket,
    StorageCredentials,
    StorageItem,
    StorageItemStat,
} from './types';

export class S3StorageBucket implements IStorageBucket {
    constructor(
        private readonly bucketName: string,
        private readonly clients: S3ClientContainer,
        private readonly authService: StorageAuthService,
    ) {}

    private async generatePresignedUrl(
        objectName: string,
        expirySeconds: number,
        isInternal: boolean,
        responseDisposition?: Record<string, string>,
    ): Promise<string> {
        const command = new GetObjectCommand({
            Bucket: this.bucketName,
            Key: objectName,
            ResponseContentDisposition:
                responseDisposition?.['response-content-disposition'],
        });
        const client = isInternal
            ? this.clients.internal
            : this.clients.external;
        return getSignedUrl(client, command, {
            expiresIn: expirySeconds,
        });
    }

    async getPresignedDownloadUrl(
        objectName: string,
        expirySeconds: number,
        responseDisposition?: Record<string, string>,
    ): Promise<string> {
        return this.generatePresignedUrl(
            objectName,
            expirySeconds,
            false,
            responseDisposition,
        );
    }

    async getInternalPresignedDownloadUrl(
        objectName: string,
        expirySeconds: number,
        responseDisposition?: Record<string, string>,
    ): Promise<string> {
        return this.generatePresignedUrl(
            objectName,
            expirySeconds,
            true,
            responseDisposition,
        );
    }

    async downloadFile(
        objectName: string,
        destinationPath: string,
    ): Promise<void> {
        const command = new GetObjectCommand({
            Bucket: this.bucketName,
            Key: objectName,
        });
        const response = await this.clients.internal.send(command);
        if (response.Body instanceof Readable) {
            await pipeline(response.Body, createWriteStream(destinationPath));
        } else {
            throw new TypeError('S3 body is not a readable stream');
        }
    }

    async getFileStream(objectName: string): Promise<Readable> {
        const command = new GetObjectCommand({
            Bucket: this.bucketName,
            Key: objectName,
        });
        const response = await this.clients.internal.send(command);
        if (response.Body instanceof Readable) {
            return response.Body;
        }
        throw new TypeError('S3 body is not a readable stream');
    }

    async listFiles(): Promise<StorageItem[]> {
        const command = new ListObjectsV2Command({
            Bucket: this.bucketName,
        });
        const response = await this.clients.internal.send(command);
        return (
            response.Contents?.map((item: _Object) => ({
                name: item.Key ?? '',
                lastModified: item.LastModified ?? new Date(),
                etag: item.ETag ?? '',
                size: item.Size ?? 0,
            })) ?? []
        );
    }

    async getFileInfo(
        objectName: string,
    ): Promise<StorageItemStat | undefined> {
        const command = new HeadObjectCommand({
            Bucket: this.bucketName,
            Key: objectName,
        });
        try {
            const response = await this.clients.internal.send(command);
            return {
                size: response.ContentLength ?? 0,
                etag: response.ETag ?? '',
                lastModified: response.LastModified ?? new Date(),
                metaData: response.Metadata ?? {},
            };
        } catch (error: unknown) {
            let statusCode: number | undefined;
            let errorCode: string | undefined;

            if (typeof error === 'object' && error !== null) {
                const errorObject = error as Record<string, unknown>;
                if (typeof errorObject.name === 'string') {
                    errorCode = errorObject.name;
                } else if (typeof errorObject.Code === 'string') {
                    errorCode = errorObject.Code;
                }

                if (
                    typeof errorObject.$metadata === 'object' &&
                    errorObject.$metadata !== null
                ) {
                    const metadata = errorObject.$metadata as Record<
                        string,
                        unknown
                    >;
                    if (typeof metadata.httpStatusCode === 'number') {
                        statusCode = metadata.httpStatusCode;
                    }
                }
            }

            if (
                error instanceof NotFound ||
                statusCode === 404 ||
                errorCode === 'NotFound' ||
                errorCode === 'NoSuchKey'
            ) {
                return undefined;
            }
            throw error;
        }
    }

    async uploadFile(
        objectName: string,
        filePath: string,
        metaData?: Record<string, string>,
    ): Promise<void> {
        const command = new PutObjectCommand({
            Bucket: this.bucketName,
            Key: objectName,
            Body: createReadStream(filePath),
            Metadata: metaData,
        });
        await this.clients.internal.send(command);
    }

    async deleteFile(objectName: string): Promise<void> {
        const command = new DeleteObjectCommand({
            Bucket: this.bucketName,
            Key: objectName,
        });
        await this.clients.internal.send(command);
    }

    /**
     * Object tagging isn't part of the core S3 API and support varies across
     * S3-compatible implementations. Nothing in this app reads tags back
     * (they're mirrored onto the object purely for out-of-band visibility),
     * so a tagging failure is logged and swallowed rather than failing the
     * caller's operation (e.g. an upload-confirm request).
     */
    async getTags(objectName: string): Promise<Record<string, string>> {
        try {
            const command = new GetObjectTaggingCommand({
                Bucket: this.bucketName,
                Key: objectName,
            });
            const response = await this.clients.internal.send(command);
            const tags: Record<string, string> = {};
            if (response.TagSet) {
                for (const tag of response.TagSet) {
                    if (tag.Key && tag.Value) {
                        tags[tag.Key] = tag.Value;
                    }
                }
            }
            return tags;
        } catch (error) {
            Logger.warn(
                `Failed to get tags for ${objectName}: ${String(error)}`,
                'S3StorageBucket:getTags',
            );
            return {};
        }
    }

    async addTags(
        objectName: string,
        tags: Record<string, string>,
    ): Promise<void> {
        try {
            const command = new PutObjectTaggingCommand({
                Bucket: this.bucketName,
                Key: objectName,
                Tagging: {
                    TagSet: Object.entries(tags).map(([key, value]) => ({
                        Key: key,
                        Value: value,
                    })),
                },
            });
            await this.clients.internal.send(command);
        } catch (error) {
            Logger.warn(
                `Failed to add tags for ${objectName}: ${String(error)}`,
                'S3StorageBucket:addTags',
            );
        }
    }

    async removeTags(objectName: string): Promise<void> {
        try {
            const command = new DeleteObjectTaggingCommand({
                Bucket: this.bucketName,
                Key: objectName,
            });
            await this.clients.internal.send(command);
        } catch (error) {
            Logger.warn(
                `Failed to remove tags for ${objectName}: ${String(error)}`,
                'S3StorageBucket:removeTags',
            );
        }
    }

    async generateTemporaryCredential(
        filename: string,
    ): Promise<StorageCredentials> {
        return this.authService.generateTemporaryCredential(
            filename,
            this.bucketName,
        );
    }
}
