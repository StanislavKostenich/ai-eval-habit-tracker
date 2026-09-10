/**
 * The ONE "today" helper for the whole frontend (SPEC §7, CLAUDE.md hard rule 1).
 *
 * "Today" is always UTC: `YYYY-MM-DD` via `new Date().toISOString().slice(0, 10)`.
 * Used for the calendar today-highlight, the check-in toggle, and undo — never
 * compute "today" independently anywhere else.
 */
export function getTodayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
