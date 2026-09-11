import { expect, test, type Page } from '@playwright/test';
import { demoLogin, createHabit } from './helpers';

/**
 * Search + status filtering (SPEC §9 DashboardPage): the search box filters by
 * name substring, the status filter narrows by habit status, and an
 * empty-result state is shown when no habits match.
 */
/**
 * The dashboard list is shared across a run (see helpers.ts), so name-based
 * `hasText` filters can match cards from earlier specs. Scope every card
 * assertion to an exact heading instead — same rule the helpers enforce.
 */
const card = (page: Page, name: string) =>
  page.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) });

test.describe('search & filters', () => {
  test('search by name substring filters the list', async ({ page }) => {
    await demoLogin(page);
    await createHabit(page, { name: 'Alpha stretch' });
    await createHabit(page, { name: 'Beta meditation' });

    // Both visible by default.
    await expect(card(page, 'Alpha stretch')).toBeVisible();
    await expect(card(page, 'Beta meditation')).toBeVisible();

    // Type a substring that only matches "Alpha…".
    await page.getByLabel('Search habits').fill('Alpha');
    await expect(card(page, 'Alpha stretch')).toBeVisible();
    await expect(card(page, 'Beta meditation')).toHaveCount(0);

    // Clear the search → both return.
    await page.getByLabel('Search habits').fill('');
    await expect(card(page, 'Beta meditation')).toBeVisible();
  });

  test('the status filter narrows by habit status', async ({ page }) => {
    await demoLogin(page);
    await createHabit(page, { name: 'Active reading' });
    await createHabit(page, { name: 'Paused journaling', status: 'paused' });

    // Filter to active only → only the active habit shows.
    await page.getByLabel('Filter by status').selectOption('active');
    await expect(card(page, 'Active reading')).toBeVisible();
    await expect(card(page, 'Paused journaling')).toHaveCount(0);

    // Filter to paused only → only the paused habit shows.
    await page.getByLabel('Filter by status').selectOption('paused');
    await expect(card(page, 'Paused journaling')).toBeVisible();
    await expect(card(page, 'Active reading')).toHaveCount(0);
  });

  test('no matches shows the empty-state with a Clear filters button', async ({ page }) => {
    await demoLogin(page);
    await createHabit(page, { name: 'Gamma hydration' });

    await page.getByLabel('Search habits').fill('zzz-no-such-habit');
    await expect(page.getByRole('heading', { name: 'No habits match your filters' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Clear filters' })).toBeVisible();

    // Clearing filters brings the list back.
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(card(page, 'Gamma hydration')).toBeVisible();
  });
});
