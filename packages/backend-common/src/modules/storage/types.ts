import { Stream } from 'node:stream';

export interface StorageItem {
    name: string;
    lastModified: Date;
    etag: string;
    size: number;
}

export interface StorageItemStat {
    size: number;
    etag: string;
    lastModified: Date;
    metaData: Record<string, string>;
}

export interface StorageCredentials {
    accessKey: string;
    secretKey: string;
    sessionToken: string;
}

export interface IStorageBucket {
    getPresignedDownloadUrl(
        objectName: string,
        expirySeconds: number,
        responseDisposition?: Record<string, string>,
    ): Promise<string>;

    getInternalPresignedDownloadUrl(
        objectName: string,
        expirySeconds: number,
        responseDisposition?: Record<string, string>,
    ): Promise<string>;

    downloadFile(objectName: string, destinationPath: string): Promise<void>;

    getFileStream(objectName: string): Promise<Stream.Readable>;

    listFiles(): Promise<StorageItem[]>;

    getFileInfo(objectName: string): Promise<StorageItemStat | undefined>;

    uploadFile(
        objectName: string,
        filePath: string,
        metaData?: Record<string, string>,
    ): Promise<void>;

    deleteFile(objectName: string): Promise<void>;

    getTags(objectName: string): Promise<Record<string, string>>;

    addTags(objectName: string, tags: Record<string, string>): Promise<void>;

    removeTags(objectName: string): Promise<void>;

    generateTemporaryCredential(
        filename: string, // This is usually the UUID/object name used for the ARN
    ): Promise<StorageCredentials>;
}
