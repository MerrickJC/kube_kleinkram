const mockEnvironment: {
    S3_DATA_BUCKET_NAME: string;
    STORAGE_QUOTA_BYTES?: number;
} = {
    S3_DATA_BUCKET_NAME: 'test-bucket',
    STORAGE_QUOTA_BYTES: 1000,
};

jest.mock('@kleinkram/backend-common/environment', () => ({
    /* eslint-disable-next-line @typescript-eslint/naming-convention */
    __esModule: true,
    default: mockEnvironment,
}));

import {
    CategoryEntity,
    FileEntity,
    MissionEntity,
    UserEntity,
} from '@kleinkram/backend-common';
import { FileAuditService } from '@kleinkram/backend-common/audit/file-audit.service';
import { IStorageBucket } from '@kleinkram/backend-common/modules/storage/types';
import { HttpException, HttpStatus } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { MissionGuardService } from '../../src/endpoints/auth/mission-guard.service';
import { FileLifecycleService } from '../../src/services/file-lifecycle.service';
import { TriggerService } from '../../src/services/trigger.service';

describe('File Upload Pre-Flight Capacity Check', () => {
    let service: FileLifecycleService;
    let mockGetRawOne: jest.Mock;
    let mockFileRepository: jest.Mocked<Repository<FileEntity>>;
    let mockMissionRepo: jest.Mocked<Repository<MissionEntity>>;
    let mockUserRepo: jest.Mocked<Repository<UserEntity>>;
    let mockDataSource: jest.Mocked<DataSource>;

    beforeEach(() => {
        mockEnvironment.STORAGE_QUOTA_BYTES = 1000;

        // usedBytes = 800, STORAGE_QUOTA_BYTES = 1000 -> 200 free bytes
        mockGetRawOne = jest.fn().mockResolvedValue({ total: '800' });
        const queryBuilder: Record<string, jest.Mock> = {};
        queryBuilder.select = jest.fn().mockReturnValue(queryBuilder);
        queryBuilder.where = jest.fn().mockReturnValue(queryBuilder);
        queryBuilder.getRawOne = mockGetRawOne;

        mockFileRepository = {
            createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
        } as unknown as jest.Mocked<Repository<FileEntity>>;

        mockMissionRepo = {
            findOneOrFail: jest.fn().mockResolvedValue({
                uuid: 'mission-uuid',
                project: { uuid: 'project-uuid' },
            }),
        } as unknown as jest.Mocked<Repository<MissionEntity>>;

        mockUserRepo = {
            findOneOrFail: jest.fn().mockResolvedValue({ uuid: 'user-uuid' }),
        } as unknown as jest.Mocked<Repository<UserEntity>>;

        const mockDataStorage = {
            generateTemporaryCredential: jest.fn().mockResolvedValue({}),
        } as unknown as jest.Mocked<IStorageBucket>;

        mockDataSource = {
            transaction: jest
                .fn()
                .mockImplementation(
                    (callback: (mgr: unknown) => Promise<unknown>) =>
                        callback({
                            find: jest.fn().mockResolvedValue([]),
                            transaction: jest
                                .fn()
                                .mockImplementation(
                                    (
                                        callback2: (
                                            mgr2: unknown,
                                        ) => Promise<unknown>,
                                    ) =>
                                        callback2({
                                            save: jest.fn().mockResolvedValue({
                                                uuid: 'file-uuid',
                                                filename: 'test.bag',
                                            }),
                                            create: jest
                                                .fn()
                                                .mockReturnValue({}),
                                        }),
                                ),
                        }),
                ),
        } as unknown as jest.Mocked<DataSource>;

        service = new FileLifecycleService(
            mockFileRepository,
            mockMissionRepo,
            mockUserRepo,
            {} as unknown as jest.Mocked<Repository<CategoryEntity>>,
            mockDataStorage,
            mockDataSource,
            { log: jest.fn() } as unknown as jest.Mocked<FileAuditService>,
            {
                addFileEvent: jest.fn(),
            } as unknown as jest.Mocked<TriggerService>,
            {
                canAccessMission: jest.fn().mockResolvedValue(true),
            } as unknown as jest.Mocked<MissionGuardService>,
        );
    });

    it('should generate credentials if requested size fits within free space', async () => {
        const result = await service.getTemporaryAccess(
            ['test.bag'],
            'mission-uuid',
            'user-uuid',
            undefined,
            'CLI',
            [150], // 150 bytes requested < 200 free bytes
        );
        expect(result).toBeDefined();
        expect(mockGetRawOne).toHaveBeenCalledTimes(1);
    });

    it('should allow upload when requested size exactly equals free space', async () => {
        const result = await service.getTemporaryAccess(
            ['test.bag'],
            'mission-uuid',
            'user-uuid',
            undefined,
            'CLI',
            [200], // exactly 200 free bytes
        );
        expect(result).toBeDefined();
        expect(mockGetRawOne).toHaveBeenCalledTimes(1);
    });

    it('should throw INSUFFICIENT_STORAGE if requested size exceeds free space', async () => {
        await expect(
            service.getTemporaryAccess(
                ['test.bag'],
                'mission-uuid',
                'user-uuid',
                undefined,
                'CLI',
                [250], // 250 bytes requested > 200 free bytes
            ),
        ).rejects.toThrow(
            new HttpException(
                'Insufficient storage space on the server',
                HttpStatus.INSUFFICIENT_STORAGE,
            ),
        );
    });

    it('should sum all file sizes for multi-file uploads', async () => {
        // Two files: 100 + 150 = 250 > 200 free bytes
        await expect(
            service.getTemporaryAccess(
                ['a.bag', 'b.bag'],
                'mission-uuid',
                'user-uuid',
                undefined,
                'CLI',
                [100, 150],
            ),
        ).rejects.toThrow(
            new HttpException(
                'Insufficient storage space on the server',
                HttpStatus.INSUFFICIENT_STORAGE,
            ),
        );
    });

    it('should skip capacity check when fileSizes is not provided', async () => {
        const result = await service.getTemporaryAccess(
            ['test.bag'],
            'mission-uuid',
            'user-uuid',
            undefined,
            'CLI',
            // no fileSizes argument
        );
        expect(result).toBeDefined();
        expect(mockGetRawOne).not.toHaveBeenCalled();
    });

    it('should skip capacity check when fileSizes is an empty array', async () => {
        const result = await service.getTemporaryAccess(
            ['test.bag'],
            'mission-uuid',
            'user-uuid',
            undefined,
            'CLI',
            [],
        );
        expect(result).toBeDefined();
        expect(mockGetRawOne).not.toHaveBeenCalled();
    });

    it('should skip capacity check when no storage quota is configured', async () => {
        mockEnvironment.STORAGE_QUOTA_BYTES = undefined;

        const result = await service.getTemporaryAccess(
            ['test.bag'],
            'mission-uuid',
            'user-uuid',
            undefined,
            'CLI',
            [150],
        );
        expect(result).toBeDefined();
        expect(mockGetRawOne).not.toHaveBeenCalled();
    });
});
