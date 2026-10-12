import { DataSource } from 'typeorm';
import { getConfig } from '../prod/production-datasource.config';

async function main() {
    const dataSource = new DataSource(getConfig());
    await dataSource.initialize();

    try {
        const hasPendingMigrations = await dataSource.showMigrations();
        if (!hasPendingMigrations) {
            // eslint-disable-next-line no-console
            console.log('No pending migrations. Skipping migration run.');
            return;
        }

        // eslint-disable-next-line no-console
        console.log('Pending migrations found. Running migration:run...');
        await dataSource.runMigrations();
    } finally {
        await dataSource.destroy();
    }
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
