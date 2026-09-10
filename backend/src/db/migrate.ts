import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import 'dotenv/config';
import { createDb, type AppDatabase } from './index.js';

/**
 * Folder containing the drizzle-kit generated migrations. Resolved relative to
 * this file so it is CWD-independent (works from `npm run db:migrate`, tests,
 * and the Docker image alike).
 */
const MIGRATIONS_FOLDER = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../drizzle');

/**
 * Runs the drizzle-kit generated migrations on an already-open Drizzle
 * database. Used by tests to migrate an in-memory SQLite connection
 * (`:memory:`); the path-based helper below uses it too.
 */
export function migrateDb(db: AppDatabase): void {
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

/**
 * Applies the drizzle-kit generated migrations (in `./drizzle`) to the database
 * configured by `DATABASE_PATH`. Idempotent — the migrator tracks applied
 * migrations in `__drizzle_migrations`, so running it on every container start
 * is safe (docs/SPEC.md §13).
 *
 * No DDL is written here; schema.ts is the single source of truth (CLAUDE.md
 * hard rule 7).
 */
export function runMigrations(dbPath?: string): void {
  const db = createDb(dbPath);
  migrateDb(db);
}

// Run when invoked directly: `npm run db:migrate`
if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) {
  try {
    runMigrations();
    console.log(`migrations applied (DATABASE_PATH=${process.env.DATABASE_PATH || './data/habits.db'})`);
  } catch (err) {
    console.error('migration failed:', err);
    process.exit(1);
  }
}
