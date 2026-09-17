import { fileURLToPath } from 'node:url';
import { migrate as drizzleMigrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from './client.js';

export const DEFAULT_MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * Applies pending migrations. Side-effect free: safe to import from bundles.
 * The CLI entry lives in src/cli/migrate.ts.
 */
export async function runMigrations(
  connectionString: string,
  migrationsFolder: string = DEFAULT_MIGRATIONS_FOLDER,
): Promise<void> {
  const { db, pool } = createDb(connectionString, { max: 1 });
  try {
    await drizzleMigrate(db, { migrationsFolder });
  } finally {
    await pool.end();
  }
}