import { defineConfig } from '@playwright/test';

// Phase 1: config only — e2e specs arrive in a later phase.
export default defineConfig({
  testDir: './e2e',
  baseURL: 'http://localhost:5173',
  use: {
    trace: 'on-first-retry',
  },
});
