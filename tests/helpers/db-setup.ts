import knex, { type Knex } from 'knex';
import 'dotenv/config';

let testDb: Knex | null = null;

/**
 * Get a shared database connection for tests.
 * Creates the connection on first call, reuses it on subsequent calls.
 */
export function getTestDb(): Knex {
  if (!testDb) {
    const connectionString = process.env['DATABASE_URL'];
    if (!connectionString) {
      throw new Error(
        'DATABASE_URL environment variable is required for integration tests. ' +
        'Set it in .env or export it before running tests.',
      );
    }

    testDb = knex({
      client: 'pg',
      connection: connectionString,
      pool: { min: 1, max: 5 },
      migrations: {
        directory: './src/db/migrations',
        extension: 'ts',
      },
    });
  }

  return testDb;
}

/**
 * Run all migrations and return the database connection.
 */
export async function setupTestDb(): Promise<Knex> {
  const db = getTestDb();
  await db.migrate.latest();
  return db;
}

/**
 * Clean all data from tables (preserving schema).
 * Order matters due to foreign keys.
 */
export async function cleanAllTables(db: Knex): Promise<void> {
  await db.raw('TRUNCATE TABLE page_permissions CASCADE');
  await db.raw('TRUNCATE TABLE page_tree_paths CASCADE');
  await db.raw('TRUNCATE TABLE pages CASCADE');
  await db.raw('TRUNCATE TABLE group_membership_closure CASCADE');
  await db.raw('TRUNCATE TABLE group_ancestor_paths CASCADE');
  await db.raw('TRUNCATE TABLE group_members CASCADE');
  await db.raw('TRUNCATE TABLE groups CASCADE');
  await db.raw('TRUNCATE TABLE workspace_members CASCADE');
  await db.raw('TRUNCATE TABLE workspaces CASCADE');
  await db.raw('TRUNCATE TABLE users CASCADE');
}

/**
 * Destroy the database connection.
 */
export async function teardownTestDb(): Promise<void> {
  if (testDb) {
    await testDb.destroy();
    testDb = null;
  }
}
