# Habit Tracker — Project Guide

Full implementation spec: **`docs/SPEC.md`** (authoritative — when in doubt, the spec wins).

## Stack

npm workspaces: root + `backend/` + `frontend/`. Node 20, TypeScript strict everywhere.

- **Backend**: Fastify 4, better-sqlite3, Drizzle ORM, Passport (Google/GitHub OAuth), `@fastify/session` + `@fastify/cookie`, `@fastify/websocket`, Vitest (`app.inject()` + real `ws` client).
- **Frontend**: React 18 + Vite, Tailwind (single config file), TanStack Query v5, react-router-dom v6, Playwright e2e.

## Hard rules (real bugs in prior implementations — treat as review blockers)

1. **UTC "today" everywhere.** Dates are `YYYY-MM-DD` strings. Server: no timezone conversion, string comparison only. Frontend: ONE shared `getTodayISO()` helper (`new Date().toISOString().slice(0, 10)`) used for calendar highlight, check-in toggle, and undo — never compute "today" independently in a second place.
2. **Drizzle conditions**: always `and(eq(a, x), eq(b, y))`. Plain-JS `eq(a, x) && eq(b, y)` silently drops the first condition (JS short-circuit) — this has caused real milestone-dedup and ownership bugs in this app.
3. **Ownership = 404, never 403.** Missing resource AND resource belonging to another user both return `404 { error: 'Not found' }`. Applies to GET/PATCH/DELETE habit, check-ins, and the WS `ack` (silently ignore).
4. **Status transitions**: `active` ↔ `paused` OK; `active`|`paused` → `archived` OK; `archived` → anything (incl. no-op) = **422**. Enforced server-side in PATCH and mirrored client-side in `HabitModal`.
5. **No hardcoded origins.** OAuth redirect/callback URIs built from `BACKEND_URL`. Frontend makes only relative requests (`/api/...`; WS URL from `window.location` host) — same bundle works under the Vite dev proxy and the nginx proxy. Grep the shipped frontend for `localhost:3000` — must be zero hits.
6. **WS `ack`**: verify `habit.userId === <connected session userId>` before `INSERT OR IGNORE` into `milestone_notifications`. Persist ONLY on `ack`, never at send time (unacked milestones intentionally re-appear on next `subscribe`).
7. **Schema single source of truth**: `backend/src/db/schema.ts` + `drizzle-kit` generated migrations. Never hand-write DDL in `migrate.ts` or anywhere else.
8. **One Tailwind config, one design-token set**, every token used in markup.

## Commands

```bash
npm install                    # root, all workspaces
npm run dev                    # backend :3000 + frontend :5173
cd backend && npm run dev
cd frontend && npm run dev
cd backend && npm run db:migrate   # generate + apply from schema.ts
cd backend && npm run db:seed
cd backend && npm test         # all 9 backend tests
cd backend && npm run typecheck
cd frontend && npm run typecheck
npm run test:ui                # Playwright e2e
```

## Test discipline (SPEC §10)

- In-memory SQLite (`:memory:`), fresh in `beforeAll`, reset in `beforeEach` — order-independent.
- No real OAuth: authenticate via `POST /api/auth/demo-login` (a first-class endpoint, not env-gated).
- T6–T9 must use a **real `ws` client** against the running Fastify instance — HTTP streak assertions are not sufficient.
- T5 (ownership) uses **two real separately-authenticated sessions**, not a random nonexistent ID.
- Check-in `POST` validation order: date format → ownership (404) → active (422) → not future (422) → duplicate (409).

## Conventions

- UUIDs via `crypto.randomUUID()` (same import style everywhere).
- Error shape is always `{ error: string }`.
- One shared `frontend/src/types.ts` for `User`, `Habit`, `Checkin`, `WSMessage`, `Notification`.
- One shared API client (`frontend/src/lib/api.ts`); one canonical React Query key shape per resource; mutations invalidate their own keys in `onSuccess`.
- `requireAuth` middleware on every non-`/api/auth/*` route; session holds only `userId: string`.
- Session cookie: `httpOnly`, `sameSite: 'lax'`, `maxAge: 24h`, `secure` per actual transport (not hardcoded `false`).
- Production boot hard-fails without a 32+ char `SESSION_SECRET`.
