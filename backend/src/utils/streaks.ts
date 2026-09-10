/**
 * Pure streak calculation (docs/SPEC.md §7).
 *
 * The reference implementation from the spec, unchanged. `daysBetween` and
 * `subtractOneDay` operate on UTC-midnight parses of the `YYYY-MM-DD` strings
 * (append `T00:00:00Z` before `new Date(...)`), so day-count math is never
 * affected by DST or local timezone.
 *
 * `todayISO` is passed in by the caller (`new Date().toISOString().slice(0, 10)`)
 * so the function stays pure and testable with an arbitrary "today".
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Whole days from `a` to `b` (positive when `b` is after `a`), UTC-midnight based. */
export function daysBetween(a: string, b: string): number {
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  return Math.round((tb - ta) / MS_PER_DAY);
}

/** The `YYYY-MM-DD` string for the day before `day` (UTC). */
export function subtractOneDay(day: string): string {
  const t = Date.parse(`${day}T00:00:00Z`) - MS_PER_DAY;
  return new Date(t).toISOString().slice(0, 10);
}

export function calculateStreaks(
  dates: string[], // array of 'YYYY-MM-DD', may be unsorted, may contain duplicates
  todayISO: string, // caller passes UTC date: new Date().toISOString().slice(0, 10)
): { current: number; best: number; total: number } {
  const sorted = [...new Set(dates)].sort();
  if (sorted.length === 0) return { current: 0, best: 0, total: 0 };

  // Best streak
  let best = 1, run = 1;
  for (let i = 1; i < sorted.length; i++) {
    // `noUncheckedIndexedAccess`: index into the sorted array defensively.
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (prev === undefined || curr === undefined) continue;
    const diff = daysBetween(prev, curr);
    run = diff === 1 ? run + 1 : 1;
    best = Math.max(best, run);
  }

  // Current streak — walk backwards from today
  let current = 0;
  const dateSet = new Set(sorted);
  let day = todayISO;
  while (dateSet.has(day)) {
    current++;
    day = subtractOneDay(day);
  }

  return { current, best, total: sorted.length };
}
