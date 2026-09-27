import { Image } from '@kleinkram/backend-common/entities/action/action.entity';
import { ImageSource } from '@kleinkram/shared';
import { validateDockerImageName } from '@kleinkram/validation';
import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import logger from '../../logger';

const execAsync = promisify(execFile);

/**
 * Resolves the image's registry digest so `ActionEntity.image` records the
 * exact build that ran,
 */
@Injectable()
export class ImageResolutionService {
    async resolveImageDigest(imageTag: string): Promise<Image> {
        try {
            validateDockerImageName(imageTag);
            const { stdout: digestOut } = await execAsync('crane', [
                'digest',
                imageTag,
            ]);
            const sha = digestOut.trim() || null;

            let remoteCreatedAt: Date | undefined;
            try {
                const { stdout: configOut } = await execAsync('crane', [
                    'config',
                    imageTag,
                ]);
                const { created } = JSON.parse(configOut) as {
                    created?: string;
                };
                remoteCreatedAt = created ? new Date(created) : undefined;
            } catch {
                // best-effort only, timestamp is informational
            }

            return {
                sha,
                repoDigests: sha ? [`${imageTag}@${sha}`] : [],
                source: ImageSource.PULLED,
                remoteCreatedAt,
            };
        } catch (error: unknown) {
            const message =
                error instanceof Error ? error.message : String(error);
            logger.warn(
                `Failed to resolve digest for ${imageTag} via crane: ${message}`,
            );
            return { sha: null, repoDigests: [], source: ImageSource.PULLED };
        }
    }
}
