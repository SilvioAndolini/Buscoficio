import { fileURLToPath } from 'node:url';
import { runMigrations } from '../migrate.js';

const migrationsFolder = fileURLToPath(new URL('../../migrations', import.meta.url));

const url = process.env['DATABASE_URL'];
if (!url) {
  process.stderr.write('DATABASE_URL is required to run migrations\n');
  process.exit(1);
}

runMigrations(url, migrationsFolder)
  .then(() => {
    process.stdout.write('migrations: OK\n');
  })
  .catch((error: unknown) => {
    process.stderr.write(`migrations failed: ${String(error)}\n`);
    process.exit(1);
  });