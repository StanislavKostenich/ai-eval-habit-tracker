import { expect, test } from '@playwright/test';
import { demoLogin, createHabit } from './helpers';

/**
 * Habit lifecycle (SPEC §9): create a habit, check in for today, undo the
 * check-in. The check-in button toggles between "Check in Today" and
 * "Done Today ✓"; the current-streak metric reflects the toggle.
 */
test.describe('habits', () => {
  test('create a habit, check in for today, then undo', async ({ page }) => {
    await demoLogin(page);

    const card = await createHabit(page, {
      name: 'Morning run',
      description: 'Lap the block before work',
    });

    // The new habit card is present with its description.
    await expect(card.getByText('Lap the block before work')).toBeVisible();

    // Initial: no check-in yet.
    await expect(card.getByRole('button', { name: 'Check in Today' })).toBeVisible();

    // Check in for today → button flips to "Done Today ✓" and the current
    // streak shows "1 day". The three stats (current streak, best streak,
    // total check-ins) all render in `<dl>` stat groups (HabitCard) and are
    // each "1" after a single check-in — assert all three `<dd>` values.
    await card.getByRole('button', { name: 'Check in Today' }).click();
    await expect(card.getByRole('button', { name: 'Done Today ✓' })).toBeVisible();
    await expect(card.locator('dd').filter({ hasText: '1' })).toHaveCount(3); // current + best + total

    // Undo → back to "Check in Today".
    await card.getByRole('button', { name: 'Done Today ✓' }).click();
    await expect(card.getByRole('button', { name: 'Check in Today' })).toBeVisible();
  });

  test('a created habit appears in the list and is editable', async ({ page }) => {
    await demoLogin(page);
    await createHabit(page, { name: 'Read 20 pages' });

    const card = page.getByRole('article').filter({ hasText: 'Read 20 pages' });
    await expect(card).toBeVisible();

    // Open edit, change the name, save, and see the rename reflected.
    await card.getByRole('button', { name: 'Edit Read 20 pages' }).click();
    await page.locator('#habit-name').fill('Read 30 pages');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('heading', { name: 'Read 30 pages' })).toBeVisible();
  });
});
