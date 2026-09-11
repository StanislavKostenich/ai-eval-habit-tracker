import { describe, expect, it } from 'vitest';
import { getTodayISO } from './getTodayISO';

/**
 * Hard rule 1 (CLAUDE.md / SPEC §7): "today" is UTC, one shared helper, and
 * it must match the server's own definition — `toISOString().slice(0, 10)` —
 * so calendar highlights, the check-in toggle, and undo all agree with the
 * backend's date comparisons.
 */
describe('getTodayISO', () => {
  it('returns the current UTC date as YYYY-MM-DD', () => {
    expect(getTodayISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(getTodayISO()).toBe(new Date().toISOString().slice(0, 10));
  });

  it('is stable within the same UTC instant (no drift between call sites)', () => {
    // Two call sites (calendar highlight vs. check-in toggle) must observe the
    // same value — the helper is the single "today" definition.
    expect(getTodayISO()).toBe(getTodayISO());
  });
});
