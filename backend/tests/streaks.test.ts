import { describe, expect, it } from 'vitest';
import { calculateStreaks, daysBetween, subtractOneDay } from '../src/utils/streaks.js';

/**
 * Unit tests for the pure streak function (docs/SPEC.md §7).
 *
 * `calculateStreaks` is pure — `todayISO` is passed in explicitly — so these
 * tests are deterministic with no database, app, or network involved.
 */
describe('streaks — calculateStreaks (pure function)', () => {
  it('empty date list → all zeros', () => {
    expect(calculateStreaks([], '2026-09-10')).toEqual({ current: 0, best: 0, total: 0 });
  });

  it('single check-in on today → current 1, best 1, total 1', () => {
    expect(calculateStreaks(['2026-09-10'], '2026-09-10')).toEqual({ current: 1, best: 1, total: 1 });
  });

  it('single check-in in the past (not today) → current 0', () => {
    expect(calculateStreaks(['2026-09-09'], '2026-09-10')).toEqual({ current: 0, best: 1, total: 1 });
  });

  it('consecutive days ending today → current == best == total', () => {
    const dates = ['2026-09-10', '2026-09-09', '2026-09-08', '2026-09-07'];
    expect(calculateStreaks(dates, '2026-09-10')).toEqual({ current: 4, best: 4, total: 4 });
  });

  it('a gap resets the current run; best keeps the longest run', () => {
    // 3-day run (09-04..09-06), gap on 09-07, 3-day run (09-08..09-10).
    const dates = ['2026-09-04', '2026-09-05', '2026-09-06', '2026-09-08', '2026-09-09', '2026-09-10'];
    expect(calculateStreaks(dates, '2026-09-10')).toEqual({ current: 3, best: 3, total: 6 });
  });

  it('a longer past run dominates `best` even though the current run is shorter', () => {
    // Long run 09-01..09-05 (5), gap, short run ending today 09-08..09-09 (2).
    const dates = [
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
      '2026-09-04',
      '2026-09-05',
      '2026-09-08',
      '2026-09-09',
    ];
    expect(calculateStreaks(dates, '2026-09-09')).toEqual({ current: 2, best: 5, total: 7 });
  });

  it('handles unsorted input and duplicate dates (dedup, then sort)', () => {
    const dates = ['2026-09-10', '2026-09-08', '2026-09-09', '2026-09-09', '2026-09-10'];
    expect(calculateStreaks(dates, '2026-09-10')).toEqual({ current: 3, best: 3, total: 3 });
  });

  it('current streak is 0 when yesterday is missing (today has no check-in)', () => {
    // Only 09-07 and 09-08 exist; today is 09-10 with no check-in.
    const dates = ['2026-09-07', '2026-09-08'];
    expect(calculateStreaks(dates, '2026-09-10')).toEqual({ current: 0, best: 2, total: 2 });
  });

  it('current streak only counts the run anchored on today', () => {
    // 09-08, 09-09, 09-10 are consecutive ending today → current 3, even
    // though 09-05/09-06 form a separate run.
    const dates = ['2026-09-05', '2026-09-06', '2026-09-08', '2026-09-09', '2026-09-10'];
    expect(calculateStreaks(dates, '2026-09-10')).toEqual({ current: 3, best: 3, total: 5 });
  });

  it('best is at least 1 when there is any check-in, even a single isolated day', () => {
    expect(calculateStreaks(['2026-09-01'], '2026-09-10')).toEqual({ current: 0, best: 1, total: 1 });
  });
});

describe('streaks — date helpers (UTC-midnight math)', () => {
  it('daysBetween counts whole days between two dates', () => {
    expect(daysBetween('2026-09-08', '2026-09-10')).toBe(2);
    expect(daysBetween('2026-09-10', '2026-09-08')).toBe(-2);
    expect(daysBetween('2026-09-10', '2026-09-10')).toBe(0);
  });

  it('daysBetween handles a month boundary (UTC, no DST skew)', () => {
    expect(daysBetween('2026-08-31', '2026-09-01')).toBe(1);
  });

  it('subtractOneDay steps back exactly one calendar day', () => {
    expect(subtractOneDay('2026-09-10')).toBe('2026-09-09');
    expect(subtractOneDay('2026-09-01')).toBe('2026-08-31');
  });
});
