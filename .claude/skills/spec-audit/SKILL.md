---
name: spec-audit
description: Audits the codebase against the 14-item acceptance checklist in docs/SPEC.md §14 and reports pass/fail per item with evidence. Use when asked to "check acceptance", "run spec audit", or before declaring the implementation done.
---

# Spec Acceptance Audit

Audit the current codebase against `docs/SPEC.md` §14. For EACH of the 14 items below, check the actual code (do not assume), then report one line per item: ✅ pass / ❌ fail / ⚠️ partial — with a file:line or command-output evidence fragment.

1. **SSO + Demo Login**: `POST /api/auth/demo-login` exists and is not env-gated; Google/GitHub OAuth routes present; user row auto-created on first sign-in (find-or-create in the callback).
2. **User record on first SSO**: check the upsert logic in `backend/src/routes/auth.ts`.
3. **Habit CRUD + status transitions**: PATCH enforces the matrix (archived → anything = 422 `Cannot transition from archived to <status>`); `HabitModal` mirrors it client-side.
4. **Check-in + undo**: today check-in toggle on `HabitCard`; `DELETE /habits/:id/checkins/:date` allows only today (UTC), 422 otherwise.
5. **Future date 422 / duplicate 409**: verify the 5-step validation order in the check-in POST handler (format → ownership 404 → active 422 → future 422 → duplicate 409).
6. **Streaks correct + UTC**: `calculateStreaks` pure function matches SPEC §7; frontend uses ONE `getTodayISO()` helper (grep for other `toISOString().slice(0, 10)` occurrences — there must be exactly one definition site).
7. **Paused/archived rejected**: check-in POST returns 422 when habit status ≠ active.
8. **Search + filter**: `GET /habits` `q` matches name AND description (case-insensitive); `status` filter rejects invalid values with 400; `completedToday` filter reuses the streak-enrichment computation (no second query).
9. **Data privacy 404-not-403**: two-session test (T5) exists and passes; route handlers return 404 for both missing and not-owned (grep for `403` in `backend/src/routes/` — must be zero).
10. **WS connect + subscribe**: `WebSocketProvider` enabled per user; `useWebSocket` sends `subscribe` on open.
11. **Milestone toasts**: `NotificationPanel` renders milestone messages; de-duped by `(habitId, milestoneDays)`.
12. **Ack no re-send**: T9 passes (real `ws` client: ack → reconnect → subscribe → no duplicate); `milestone_notifications` written only on `ack`.
13. **Ack ownership check**: the `ack` handler verifies `habit.userId === session userId` before writing (grep the WS handler).
14. **All 9 backend tests pass**: run `cd backend && npm test` and paste the summary line.

Additional structural checks (from §1–§9, reported as extras, not counted in the 14):

- [ ] No `localhost:3000` / absolute backend origin anywhere in `frontend/src` (grep).
- [ ] OAuth redirect URIs built from `BACKEND_URL`, no hardcoded `http://localhost:3000` in `backend/src`.
- [ ] Exactly one Tailwind config file; no defined-but-unused design tokens.
- [ ] `schema.ts` is the only schema source (no hand-written DDL in `migrate.ts`).
- [ ] Drizzle queries use `and(...)` for multi-condition `where` (grep for `&&` between `eq(` calls — must be zero).
- [ ] Session cookie: `secure` is transport-derived, not hardcoded `false`; production boot fails without 32+ char `SESSION_SECRET`.
- [ ] Docker: Node 20 pinned in both Dockerfiles; compose healthcheck gates frontend; named volume for SQLite.
- [ ] `DELETE /habits/:id` cascades to check-ins and milestone notifications.

Finish with a summary: `N/14 acceptance items pass`. If any item fails, list the concrete fix needed for each.
