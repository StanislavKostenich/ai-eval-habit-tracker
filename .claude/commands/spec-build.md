---
description: Build the habit-tracker app from docs/SPEC.md in dependency-ordered phases, with a test gate per phase. Optional arg: start phase (scaffold|db|auth|habits|checkins|ws|frontend|docker|verify), default scaffold.
---

# /spec-build $ARGUMENTS

Orchestrate the full implementation of `docs/SPEC.md`. Phases are strictly sequential; a phase is **done only when its gate passes**. On failure: do NOT advance — debug the failure (systematic-debugging approach: reproduce, isolate, fix, re-run) until the gate is green.

Dispatch each phase's implementation to the `spec-impl` subagent with the phase's SPEC sections and test IDs; verify the gate yourself by running the commands.

## Phase 1 — Scaffold (SPEC §2, §3, §11)

Root npm workspaces (`package.json` with `dev`/`test`/`typecheck` scripts), `backend/package.json` + `frontend/package.json`, strict tsconfigs for both, single Tailwind config, Vite config with `/api` → `http://localhost:3000` and `/ws` → `ws://localhost:3000` proxies, `.env.example` (per §3), `docker-compose.yml` skeleton, `frontend/nginx.conf` (SPA fallback + `/api`/`/ws` proxy to backend service).

**Gate:** `npm install` clean; `npm run dev` boots both servers; `npm run typecheck` (both) passes.

## Phase 2 — DB layer (SPEC §4)

`backend/src/db/schema.ts` (4 tables: users, habits, checkins, milestone_notifications — UUID PKs, cascades, uniques exactly per §4), `drizzle.config.ts`, generated migrations, `migrate.ts`, `seed.ts`. No hand-written DDL anywhere else.

**Gate:** `npm run db:migrate` on a clean DB; `npm run db:seed`.

## Phase 3 — Auth (SPEC §5)

Demo login first (`POST /api/auth/demo-login`, find-or-create, no env gate). Then Passport Google + GitHub (Option A, actually wired through `passport.authenticate`), redirect URIs from `BACKEND_URL`, failure redirect to `FRONTEND_URL/login?error=...`, session cookie flags per spec, SQLite-backed store in prod, `/api/auth/me` safe profile, `/api/auth/logout` (await destroy before 204), `requireAuth` middleware.

**Gate:** `auth.test.ts` (T1) green.

## Phase 4 — Habits + streaks (SPEC §6, §7)

Pure `calculateStreaks` in `backend/src/utils/streaks.ts` + `streaks.test.ts` first. Then habit routes: list with `q` (name+description), `status` (400 on invalid), `completedToday` (reuses enrichment — no second query); create (400 validation, default status active); detail + list include `currentStreak/bestStreak/totalCheckins/completedToday`; PATCH with the status matrix (422 from archived); DELETE cascade. Unified 404 ownership everywhere.

**Gate:** `habits.test.ts` (T2, T5 — two real separately-authenticated sessions) + `streaks.test.ts` green.

## Phase 5 — Check-ins (SPEC §6)

`GET /habits/:id/checkins?month=`, `POST` with the exact 5-step validation order, `DELETE .../:date` today-only (UTC, 422 otherwise).

**Gate:** `checkins.test.ts` (T3, T4) green.

## Phase 6 — WebSocket (SPEC §8)

`GET /ws` with session required (reject unauthenticated upgrade, 1008/401), `connected` on upgrade, `subscribe` → milestone evaluation for all user habits (3/7/30, unacked only, no persistence at send), `ack` with ownership check (silently ignore non-owned) → `INSERT OR IGNORE`.

**Gate:** `ws.test.ts` (T6–T9) green with a real `ws` client.

## Phase 7 — Frontend (SPEC §9)

`lib/api.ts` (relative paths only), `types.ts` (single source), `queryClient.ts`, canonical query keys, `useAuth`/`useHabits`/`useCheckin`/`useWebSocket` hooks, `WebSocketContext`, `LoginPage` (3 buttons, `?error=` banner), `DashboardPage` (search/status/completedToday filters, skeleton, empty states, user header + logout), `HabitCard`, `HabitModal` (validation mirrors server, transition matrix, char counter, spinner, submit error banner), `HabitDetailPage` (stats, Calendar with shared `getTodayISO()` today-highlight, edit invalidates both key shapes), `NotificationPanel` (top-right toast stack, de-duped, ack on dismiss, no auto-dismiss). `frontend-design` plugin drives the visual pass. Mobile: single column, modal as bottom sheet.

**Gate:** `npm run typecheck` (frontend); `npm run dev` — manual walk: demo login → create habit → check in → streak shows → search/filter → logout.

## Phase 8 — Docker (SPEC §13)

Multi-stage Dockerfiles both pinned to Node 20; backend runs migrations idempotently at container start; compose: backend internal-only, `SESSION_SECRET` required (fail fast), named volume for SQLite + sessions, healthcheck (`GET /api/auth/me`, any non-5xx = healthy) gating frontend; nginx proxies `/api` and `/ws` by service name.

**Gate:** `docker compose up` from a clean state; app usable through nginx at the frontend port.

## Phase 9 — Verification sweep

1. `cd backend && npm test` — all 9 pass.
2. `npm run typecheck` both workspaces.
3. `npm run test:ui` (Playwright e2e: demo login, create habit, check in, see streak, search/filter, log out).
4. Playwright MCP live smoke against the running app (optional, if servers up).
5. `/spec-audit` — require 14/14.
6. `code-review` plugin pass over the full diff; fix findings.
7. Commit with `commit-commands`.

Do not stop at a failing gate. Report after each gate: `Phase N — GATE PASS/FAIL (<evidence>)`.
