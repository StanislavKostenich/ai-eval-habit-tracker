import { defineConfig } from 'vitest/config';

/**
 * Unit tests (SPEC §10) run over `src/` only — the Playwright e2e specs in
 * `e2e/` are driven by `@playwright/test` (`npm run test:e2e`) and must not
 * be picked up by vitest.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
