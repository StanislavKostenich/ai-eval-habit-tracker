import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

export type AppDatabase = BetterSQLite3Database<typeof schema>;

/** Default location of the SQLite file (docs/SPEC.md §3). */
export const DEFAULT_DATABASE_PATH = './data/habits.db';

/** Path from the DATABASE_PATH env var, falling back to the default. */
export function resolveDatabasePath(): string {
  return process.env.DATABASE_PATH || DEFAULT_DATABASE_PATH;
}

/**
 * Open a SQLite database and wrap it with Drizzle.
 * Pass ':memory:' for tests; otherwise the parent directory is created if
 * missing and foreign keys are enabled on the connection.
 */
export function createDb(dbPath?: string): AppDatabase {
  const resolved = dbPath ?? resolveDatabasePath();
  if (resolved !== ':memory:') {
    const dir = path.dirname(resolved);
    if (dir && dir !== '.' && dir !== ':') {
      mkdirSync(dir, { recursive: true });
    }
  }
  const sqlite = new Database(resolved);
  sqlite.pragma('foreign_keys = ON');
  return drizzle(sqlite, { schema });
}

/** Convenience factory for the app's configured DATABASE_PATH. */
export function getDb(dbPath?: string): AppDatabase {
  return createDb(dbPath);
}

export { schema };
