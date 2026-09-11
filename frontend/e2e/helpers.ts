import type { Page } from '@playwright/test';

/**
 * Shared e2e helpers (SPEC §10).
 *
 * The e2e backend boots with NODE_ENV=test (see playwright.config.ts), so the
 * first-class `POST /api/auth/demo-login` endpoint is live — we use it to get a
 * real, session-cookie-backed login with zero real OAuth. `demoLogin` also
 * lands the page on the dashboard.
 *
 * `createHabit` returns the NEW habit's card, not `page.getByRole('article').filter(...)`:
 * the dashboard is a shared, persistent list — habits created by earlier specs
 * (and by a prior check-in in `habits.spec.ts`) accumulate in the per-run DB, so
 * a bare name filter can match more than one card over a full suite run (e.g. a
 * re-run creates a second "Morning run"). Asserting against the new card by id
 * keeps every spec independent of what the list already contains.
 */

/** Log in through the Demo Login button and wait for the dashboard. */
export async function demoLogin(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Demo Login' }).click();
  // After login the app navigates to `/` and the toolbar's "New habit" button
  // appears (it only renders once the header has an authenticated user).
  await page.getByRole('button', { name: '+ New habit' }).waitFor({ state: 'visible' });
}

/**
 * Create a habit via the "New habit" modal and return a locator scoped to the
 * newly-created card (by its server-returned id, via the Calendar link's href).
 */
export async function createHabit(
  page: Page,
  opts: { name: string; description?: string; status?: 'active' | 'paused' | 'archived' },
): Promise<ReturnType<Page['getByRole']>> {
  await page.getByRole('button', { name: '+ New habit' }).click();
  await page.locator('#habit-name').fill(opts.name);
  if (opts.description) {
    await page.locator('#habit-description').fill(opts.description);
  }
  // Start date defaults to today (getTodayISO) in create mode — leave it.
  if (opts.status) {
    await page.locator('#habit-status').selectOption(opts.status);
  }
  await page.getByRole('button', { name: 'Create habit' }).click();
  // The card renders only once the list query refetches after the mutation.
  const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name: opts.name, exact: true }) });
  await card.getByRole('heading', { name: opts.name, exact: true }).waitFor({ state: 'visible' });
  return card;
}
