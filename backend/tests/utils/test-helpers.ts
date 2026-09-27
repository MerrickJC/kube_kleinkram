import { UserRole } from '@kleinkram/shared';
import { createMissionUsingPost, createProjectUsingPost } from './api-calls';
import {
    clearAllData,
    database,
    getUserFromDatabase,
    mockDatabaseUser,
} from './database-utilities';

export const setupDatabaseHooks = () => {
    beforeAll(async () => {
        // Wait for Loki to be ready if running against full Docker environment
        for (let index = 0; index < 20; index++) {
            try {
                const response = await fetch('http://127.0.0.1:3100/ready');
                if (response.status === 200 || response.status === 201) {
                    break;
                }
            } catch {
                // Ignore network errors while Loki is booting
            }
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        await database.initialize();
        await clearAllData();
    }, 30_000);

    beforeEach(clearAllData);

    afterAll(async () => {
        await database.destroy();
    });
};

export const setupTestEnvironment = async (
    email = 'test@kleinkram.dev',
    username = 'Test Env User',
    role = UserRole.ADMIN,
) => {
    const userId = await mockDatabaseUser(email, username, role);
    const user = await getUserFromDatabase(userId);
    const projectUuid = await createProjectUsingPost(
        { name: 'test_project', description: 'desc', requiredTags: [] },
        user,
    );
    const missionUuid = await createMissionUsingPost(
        {
            name: 'test_mission',
            projectUUID: projectUuid,
            tags: {},
            ignoreTags: true,
        },
        user,
    );
    return { user, projectUuid, missionUuid };
};
