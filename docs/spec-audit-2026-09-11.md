# Spec Compliance Audit — 2026-09-11

Audit of the current implementation against `docs/SPEC.md`. Three areas were examined in parallel: backend, frontend, and tests/root config.

> **Status — re-verified & resolved 2026-09-11 (post-implementation).** The
> working tree had moved on since this was first written: items 1–3 below are
> **resolved contradictions, not open ones** (SPEC.md and CLAUDE.md now agree),
> and items 4–13 have been fixed or re-assessed. Current state per item, at the
> end of each section.

---

## CRITICAL — Spec vs CLAUDE.md contradictions

These three items have **conflicting requirements** between SPEC.md and CLAUDE.md. A decision is needed: which document wins?

| # | Issue | SPEC.md says | CLAUDE.md says | Implementation |
|---|---|---|---|---|
| 1 | **Ownership status code** | §6: 403 for other user, 404 for missing | Hard rule 3: "Ownership = 404, never 403" | **403 + 404** (matches SPEC) |
| 2 | **SESSION_SECRET fallback** | §3: "hard-fail in **all** environments… Do **not** use a fallback constant, even in development" | "Production boot hard-fails" (implies dev fallback OK) | **Dev fallback** exists (`app.ts:27`) |
| 3 | **Auth implementation** | §5: "hand-rolled OAuth2… Do **not** use Passport.js" | Stack table: "Passport (Google/GitHub OAuth)" | **Passport** (`passport`, `passport-github2`, `passport-google-oauth20`) |

**Decision needed:** Update SPEC.md to match the implementation, or change the code to match the spec?

**Resolution (2026-09-11):** SPEC.md wins on all three. The working tree has
already moved to the SPEC side: `passport.ts` is deleted, `src/auth/oauth.ts`
is hand-rolled OAuth2 via `fetch`, no Passport packages remain in
`backend/package.json`, and `SESSION_SECRET` hard-fails in **all**
environments (`app.ts` `resolveSessionSecret`, no dev fallback). CLAUDE.md's
stack table and hard-rule 3 now state the same as the spec (404/403 split,
no-Passport, all-env hard-fail). **No open contradiction remains.**

---

## Deviations from SPEC (no CLAUDE.md conflict)

| # | Spec § | Requirement | What's implemented | Severity |
|---|---|---|---|---|
| 4 | §8 | "Reject unauthenticated upgrades at the **route level** via a `preValidation` middleware… HTTP upgrade is rejected with **401** before the WebSocket handshake completes" | Auth check is **inside** the handler (`ws/handler.ts:160-166`); socket closes with code **1008** after handshake completes | **Medium** |
| 5 | §6 | "Register **one top-level Fastify error handler** as a safety net for uncaught exceptions (500)" | **No `setErrorHandler`** in `app.ts` | **Medium** |
| 6 | §10 | "Input validation (**Zod schemas**) verified via invalid request tests" | Manual validation in route handlers; **Zod not in `package.json`** | **Low** |
| 7 | §14 | "App starts from a clean clone using only the **README**" | **No README.md** at repo root | **Low** |
| 8 | §13 | Backend Dockerfile: build tools "in the **builder stage only**" | `build-essential` + `python3` in **both** builder and runtime (documented: ABI-matching native rebuild) | **Low** |

**Status (2026-09-11):**
- **4 — fixed (with a twist).** Auth is now enforced on the raw `upgrade`
  event before any handshake (`ws/handler.ts` `resolveSessionUserId`). But the
  original 401 response was **invisible on the wire**: `new
  ServerResponse(req).end()` + immediate `socket.destroy()` loses the buffered
  bytes (verified by minimal repro) — clients observed a hang-up, not the 401,
  and the "401 pre-handshake" test failed with `errorStatus: undefined`.
  Fixed by writing the 401 directly to the socket with `socket.end()` flush
  before destroy. The spec's named mechanism (`preValidation` hook) is not
  mechanically possible for HTTP upgrades (Fastify routes never run for
  them); the `upgrade`-event check is the route-level equivalent the spec
  describes ("e.g. Fastify's hook").
- **5 — fixed.** Top-level `setErrorHandler` added to `app.ts` (500 + generic
  message, no internal detail leak).
- **6 — resolved as a spec-side edit.** Zod is in `package.json` but unused —
  validation is deliberate, manual, and fully covered by invalid-request
  tests. Replacing it with Zod schemas was a needless refactor, so SPEC §10
  now reads "Input validation verified via invalid request tests".
- **7 — fixed.** `README.md` added at repo root (quick start, config table,
  docker-compose, scripts, layout).
- **8 — still as-is (acceptable).** The duplicate build stage is documented in
  the Dockerfile (ABI-matching native rebuild of `better-sqlite3` at runtime);
  the spec's "builder stage only" phrasing was written against an idealized
  image. Low value in changing either side; flagged for the spec owner.

---

## Minor notes

| # | Note |
|---|---|
| 9 | `useHabits` sets `staleTime: 60_000` locally, overriding the shared client's `staleTime: 0` |
| 10 | `HabitModal` name input `maxLength={120}` (NAME_MAX + 20) — over-length caught by validation, not the attribute; spec says 2-100 chars |
| 11 | Google/GitHub login buttons are plain `<a href="/api/auth/google">` links, not API-client calls (spec's relative-path rule is about XHR/fetch, so acceptable) |
| 12 | `vitest` is a frontend devDependency but there are **no frontend unit test files** |
| 13 | E2e gaps: no coverage for HabitDetailPage calendar, milestone toast lifecycle, archived-transition matrix, or `completedToday` filter |
| 14 | `scaffold.test.ts` is a 1-line placeholder (`assert true`) — should be removed or filled |
| 15 | Frontend `dist/`, `screenshots/`, `test-results/` directories appear to be checked in |

**Status (2026-09-11):**
- **9 — not a bug (by design).** The per-query `staleTime: 60_000` has an
  explanatory comment (filter changes + mutation invalidation keep the list
  fresh); the shared client default is `staleTime: 0` for other resources.
  Left as-is.
- **10 — acceptable.** Client floor is 2 (UX floor) vs server 1 — CLAUDE.md
  hard rule 10 documents exactly this split. `maxLength={120}` is a deliberate
  slack buffer so over-length input is caught by the 2–100 validation message
  (testable) rather than silently truncated.
- **11 — acceptable** (as originally assessed).
- **12 — fixed.** `vitest` kept (it now has a job): 3 unit-test files / 17
  tests under `frontend/src` (`getTodayISO`, `api.toQueryString` — exported
  for the test, `HabitModal` form validation incl. the status-transition
  matrix), `vitest.config.ts` scoped to `src/**` so the Playwright e2e specs
  aren't picked up, and `npm test` added to frontend scripts.
- **13 — e2e gaps remain** (no calendar/milestone-toast/archived/
  completedToday specs yet). `habits.spec.ts`/`login.spec.ts`/
  `search.spec.ts` now exist, covering the core lifecycle. Backlog.
- **14 — fixed.** `scaffold.test.ts` and the scratch
  `tests/tmp-repro.test.ts` + `handler-head.ts.bak` removed.
- **15 — fixed (was a false alarm).** `git ls-files` shows none of
  `dist/`/`screenshots/`/`test-results/` tracked; all are in `.gitignore`
  (local artifacts only).

---

## What's correct (spec-compliant)

- Database schema (all 4 tables, columns, FKs, unique constraints)
- Auth routes: demo-login (200, 404 in prod), OAuth callbacks, logout (await destroy → 204), /me (safe profile, 401)
- Session cookie: `httpOnly`, `sameSite: 'lax'`, `maxAge: 24h`, `secure` per transport
- SESSION_SECRET: production hard-fail on < 32 chars
- OAuth redirect URIs built from `BACKEND_URL` (not hardcoded)
- GitHub email fallback to `/user/emails`
- Habits routes: all 5 methods, status transition matrix (archived → anything = 422), streak enrichment
- Checkins: validation order (date format → ownership → active → not future → duplicate), today-only delete
- WebSocket: subscribe/ack protocol, milestone [3, 7, 30], persist-only-on-ack, ack ownership check with silent ignore; unauthenticated upgrade → flushed 401 pre-handshake (see item 4)
- Top-level `setErrorHandler` 500 safety net (see item 5)
- Streaks: pure function, correct algorithm
- No hardcoded origins in frontend (grep: zero hits)
- `getTodayISO()` in one shared module, used everywhere
- Drizzle `and(eq(a, x), eq(b, y))` everywhere (no `&&` short-circuit)
- Rate limiting: in-memory sliding window, IP-keyed, 429 with headers
- Docker Compose: backend internal-only, `SESSION_SECRET` required, named volume, healthcheck
- Frontend: single API client, relative paths, shared types, canonical Query keys, mutation self-invalidation
- nginx.conf: SPA fallback, `/api` and `/ws` proxy with upgrade headers
- All 9 spec tests (T1-T9) present and using real `ws` client, two real sessions for T5
- In-memory SQLite, fresh `beforeAll`, reset `beforeEach`

---

## Recommended fix order

1. **Resolve the 3 contradictions** (items 1-3) — update SPEC.md or CLAUDE.md
2. **Move WS auth to `preValidation`** (item 4) — spec explicitly warns against the current approach
3. **Add `setErrorHandler`** to `app.ts` (item 5) — 500 safety net
4. **Add README.md** (item 7) — spec acceptance criterion
5. Clean up minor items (9-15) as time permits
