import { defineConfig } from '@playwright/test';

// E2E (SPEC §10/§14): the `webServer` block boots the real backend (:3000) and
// frontend (:5173) so `npm run test:ui` is self-contained (no manual
// `npm run dev`). Both run with `reuseExistingServer: false` — Playwright owns
// the servers' full lifecycle (start + teardown) and fails fast if either
// misbehaves.
//
// The backend runs under NODE_ENV=test (NOT production) so the demo-login
// endpoint stays live for the login spec, while still proving the app boots
// "for real" (migrations applied, listening socket). It gets a dedicated,
// wiped DATABASE_PATH so e2e data never pollutes local dev data.

import { mkdirSync, rmSync } from 'node:fs';
import { createHmac } from 'node:crypto';

const REPO_ROOT = new URL('..', import.meta.url).pathname;

/**
 * A unique e2e database file PER RUN, wiped on webServer start.
 *
 * Why per-run instead of one fixed file: `fullyParallel: false` serializes
 * tests, but tests are NOT isolated — habits created by one spec persist in
 * the shared DB and break later specs (e.g. "Demo Login … empty state" fails
 * because a previous spec already created "Morning run"). A fresh DB per run
 * makes every spec file see the app in a clean state.
 *
 * The path is a function of a per-run random salt, so even concurrent
 * `npm run test:ui` invocations get disjoint databases.
 */
function freshE2eDbPath(): string {
  const salt = process.env.E2E_DB_SALT ?? createHmac('sha256', 'e2e').update(String(process.pid) + Date.now()).digest('hex').slice(0, 8);
  const p = `${REPO_ROOT}backend/data/e2e-${salt}.db`;
  rmSync(p, { force: true });
  mkdirSync(`${REPO_ROOT}backend/data`, { recursive: true });
  return p;
}
const E2E_DB_PATH = freshE2eDbPath();

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts/,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  webServer: [
    {
      command: `npm run dev --workspace backend --prefix ${REPO_ROOT}`,
      url: 'http://localhost:3000/healthz',
      reuseExistingServer: false,
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        SESSION_SECRET: 'e2e-secret-0123456789-0123456789-abcdef',
        DATABASE_PATH: E2E_DB_PATH,
        PORT: '3000',
      },
    },
    {
      command: `npm run dev --workspace frontend --prefix ${REPO_ROOT}`,
      url: 'http://localhost:5173',
      reuseExistingServer: false,
      cwd: REPO_ROOT,
      env: { ...process.env },
    },
  ],
});
