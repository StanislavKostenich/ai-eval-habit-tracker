/**
 * Shared UTC "today" helper (docs/SPEC.md §7).
 *
 * "Today" is always UTC everywhere in the system, and dates are plain
 * `YYYY-MM-DD` strings compared as strings — no server-side timezone
 * conversion. This helper is the single source of the server-side "today"
 * string and is used by the habit list/detail routes (streak enrichment,
 * `completedToday` filter) and by the check-in routes (future-date and
 * delete-today checks).
 */
export function getTodayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
