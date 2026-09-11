import { expect, test } from '@playwright/test';

/**
 * Login flow (SPEC §9 routing): unauthenticated users are redirected to
 * /login; the Demo Login button signs them in (real session cookie, no OAuth)
 * and lands them on the dashboard; logout returns them to /login.
 */
test.describe('login', () => {
  test('unauthenticated visit to / redirects to /login', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole('button', { name: 'Demo Login' })).toBeVisible();
  });

  test('Demo Login signs in and lands on the dashboard', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: 'Demo Login' }).click();

    // Redirected to the dashboard (not /login) and the demo user is shown.
    // We do NOT assert on habit-list contents: e2e tests share one backend DB
    // per run, so earlier specs may have created habits — the dashboard's
    // contract here is "redirected to / and authenticated as Demo User".
    await page.waitForURL(/\/$/);
    await expect(page.getByRole('heading', { name: 'Habit Tracker' })).toBeVisible();
    await expect(page.getByText('Demo User')).toBeVisible();
    await expect(page.getByRole('button', { name: '+ New habit' })).toBeVisible();
  });

  test('a signed-in user visiting /login is bounced back to the dashboard', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: 'Demo Login' }).click();
    await page.waitForURL(/\/$/);

    // Now force /login again — the app should immediately replace it with /.
    await page.goto('/login');
    await expect(page).toHaveURL(/\/$/);
  });

  test('logout returns to /login and clears the session', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: 'Demo Login' }).click();
    await page.waitForURL(/\/$/);

    await page.getByRole('button', { name: 'Log out' }).click();
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole('button', { name: 'Demo Login' })).toBeVisible();

    // The session is gone: hitting / now redirects back to /login.
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
  });
});
