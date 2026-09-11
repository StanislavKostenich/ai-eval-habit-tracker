```markdown
# Habit Tracker with Streaks — Full Implementation Specification

This document is a complete, self-contained specification for a full-stack, multi-user habit
tracking application with daily check-ins, streak calculation, SSO auth, and real-time
WebSocket milestone notifications. It is written so that it can be implemented from scratch,
by any capable LLM or engineer, without access to any other document or source tree.

It supersedes any other spec for this project. Where informal descriptions elsewhere conflict
with this document, this document wins.

---

## 1. Overview & Goals

Build a habit tracker where a signed-in user can:

- Create, edit, pause/resume, and archive habits.
- Check in a habit once per day (only for "today", no backfilling).
- See computed streaks (current streak, best streak, total check-ins) per habit.
- Search and filter their habit list.
- Receive real-time toast notifications over a WebSocket connection when a habit's current
  streak crosses 3, 7, or 30 days, and dismiss (acknowledge) those notifications so they never
  reappear.
- Log in via Google or GitHub SSO. A "Demo Login" (no external provider, one click) must also be
  available to make local development and automated testing possible without real OAuth
  credentials.

Must run fully locally (dev) and be deployable via Docker Compose (prod-like), and must have an
automated backend test suite that exercises the full HTTP + WebSocket surface.

### Tech stack

| Layer            | Choice                                                     |
|------------------|--------------------------------------------------------------|
| Runtime          | Node.js 20 LTS + TypeScript (strict mode), everywhere — dev, build, and Docker images all pinned to the same major version |
| Backend          | Fastify 4                                                   |
| Database         | SQLite via `better-sqlite3`                                 |
| ORM / migrations | Drizzle ORM — `schema.ts` is the single source of truth; migrations are generated from it (via `drizzle-kit`), never hand-duplicated as raw SQL elsewhere |
| Auth             | Hand-rolled OAuth2 authorization-code flow for Google + GitHub via `fetch`-based token + userinfo exchange (no Passport dependencies) |
| Sessions         | `@fastify/session` + `@fastify/cookie`, SQLite-backed session store in production |
| WebSocket        | `@fastify/websocket`                                        |
| Frontend         | React 18 + Vite                                             |
| UI               | Tailwind CSS, plain utility classes plus a small `@layer components` set of hand-written component classes (buttons, cards, badges, form inputs). Do not depend on shadcn/ui unless you actually install and use its components — don't declare it as a dependency and then hand-roll everything anyway. |
| Server state     | TanStack Query v5                                            |
| Testing          | Vitest + Supertest-style HTTP injection (Fastify's `app.inject()`) for the backend; a real `ws` WebSocket client for WS tests; Playwright for e2e/UI smoke tests |

---

## 2. Repository layout

```
habit-tracker/
├── README.md
├── .env.example
├── package.json          # root — workspaces: backend, frontend; scripts: dev, test, typecheck
├── docker-compose.yml
├── backend/
│   ├── src/
│   │   ├── db/           # schema.ts (source of truth), migrate.ts (runs generated migrations), seed.ts
│   │   ├── routes/       # auth.ts, habits.ts, checkins.ts
│   │   ├── ws/           # handler.ts (WebSocket + milestone engine)
│   │   ├── utils/        # streaks.ts (pure function), date.ts (shared "today" helper)
│   │   ├── middleware/   # requireAuth.ts
│   │   └── app.ts        # Fastify instance + plugin registration; exported createApp() factory
│   ├── tests/
│   │   ├── auth.test.ts
│   │   ├── habits.test.ts
│   │   ├── checkins.test.ts
│   │   ├── streaks.test.ts
│   │   └── ws.test.ts
│   ├── drizzle.config.ts
│   ├── Dockerfile
│   └── package.json
└── frontend/
    ├── src/
    │   ├── components/   # HabitCard, HabitModal, NotificationPanel, Calendar, LoadingSkeleton
    │   ├── pages/        # LoginPage, DashboardPage, HabitDetailPage
    │   ├── hooks/        # useAuth.ts, useHabits.ts, useCheckin.ts, useWebSocket.ts
    │   ├── context/       # WebSocketContext.tsx
    │   ├── lib/           # api.ts (single relative-path HTTP client), queryClient.ts
    │   ├── types.ts       # single source of truth for shared types (User, Habit, Checkin, WS messages, Notification)
    │   └── main.tsx
    ├── Dockerfile
    ├── nginx.conf
    └── package.json
```

Only **one** Tailwind config file should exist (`tailwind.config.ts` or `.js`, not both). Only one
set of design tokens should exist, and every token that's defined should actually be used
somewhere in markup — don't define an unused color-token system alongside literal Tailwind
color classes.

---

## 3. Environment variables

Copy `.env.example` to `.env` at the repo root. Never commit `.env`.

```bash
# .env.example
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
SESSION_SECRET=                 # random 32+ char string
DATABASE_PATH=./data/habits.db
PORT=3000
FRONTEND_URL=http://localhost:5173
BACKEND_URL=http://localhost:3000   # used to build OAuth callback/redirect URIs — do not hardcode localhost:3000 in route code
NODE_ENV=development
```

Rules:

- At startup, **hard-fail (throw, refuse to boot) in all environments** unless `SESSION_SECRET`
  is set and at least 32 characters. Do not use a fallback constant, even in development — this
  prevents accidental session-secret exposure if the environment variable is forgotten. Developers
  must set it in `.env` locally, and CI/Docker/production must provide it explicitly.
- OAuth redirect/callback URIs must be built from `BACKEND_URL` (or equivalent config), never
  hardcoded as a literal `http://localhost:3000/...` string in route handlers. This is required
  so the same code works in Docker/production where the backend is reachable at a different host.
- The frontend must never hardcode an absolute backend origin (see §9) — this is the frontend-side
  half of the same rule.

**Google OAuth setup:**
1. https://console.cloud.google.com → APIs & Services → Credentials → OAuth 2.0 Client ID (Web application)
2. Authorized redirect URI: `${BACKEND_URL}/api/auth/google/callback`

**GitHub OAuth setup:**
1. https://github.com/settings/developers → OAuth Apps → New
2. Authorization callback URL: `${BACKEND_URL}/api/auth/github/callback`

---

## 4. Database schema

Four tables. All IDs are UUIDs generated via `crypto.randomUUID()` (use the same import — Node's
built-in global `crypto` or `node:crypto` — consistently across the codebase).

Define these in `backend/src/db/schema.ts` using Drizzle's SQLite schema builder. This file is
the **only** source of truth for the schema — generate migrations from it with `drizzle-kit`
and apply them at startup/build time; do not maintain a second, hand-written copy of the DDL in
`migrate.ts` that can drift out of sync.

### `users`
```sql
id TEXT PRIMARY KEY
provider TEXT NOT NULL             -- 'google' | 'github' | 'demo'
provider_user_id TEXT NOT NULL
email TEXT                         -- nullable (GitHub may not expose a public email)
display_name TEXT NOT NULL
avatar_url TEXT                    -- nullable
created_at INTEGER NOT NULL        -- Unix timestamp (seconds)
UNIQUE(provider, provider_user_id)
```

### `habits`
```sql
id TEXT PRIMARY KEY
user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
name TEXT NOT NULL
description TEXT                   -- nullable
start_date TEXT NOT NULL           -- YYYY-MM-DD
status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived'))
created_at INTEGER NOT NULL
updated_at INTEGER NOT NULL
```

### `checkins`
```sql
id TEXT PRIMARY KEY
habit_id TEXT NOT NULL REFERENCES habits(id) ON DELETE CASCADE
user_id TEXT NOT NULL
date TEXT NOT NULL                 -- YYYY-MM-DD
created_at INTEGER NOT NULL
UNIQUE(habit_id, date)
```

### `milestone_notifications`
```sql
id TEXT PRIMARY KEY
habit_id TEXT NOT NULL REFERENCES habits(id) ON DELETE CASCADE
user_id TEXT NOT NULL
milestone_days INTEGER NOT NULL    -- 3 | 7 | 30
sent_at INTEGER NOT NULL
UNIQUE(habit_id, milestone_days)
```

Deleting a habit cascades to its check-ins and milestone notifications (documented product
decision: hard delete, not soft delete/archive-only).

---

## 5. Authentication

- SSO via Google and GitHub only, plus a **Demo Login** for local dev and automated testing:
  `POST /api/auth/demo-login` — no body — finds-or-creates a user with
  `provider='demo', provider_user_id='demo-user'`, sets the session, returns
  `200 { message, userId }`. In **production** this endpoint is not a route at all: it returns
  `404 { error: 'Not found' }` (indistinguishable from a missing endpoint, so its existence can't
  be probed), preventing unauthenticated account impersonation on a live deployment while keeping
  it available for development and automated tests.
- On first sign-in via any provider, auto-create a `users` row. Do not require account linking
  across providers — one `users` row per `(provider, provider_user_id)` pair, even if the same
  human uses both Google and GitHub.
- Implementation: hand-rolled OAuth2 authorization-code exchange. Exchange the authorization code
  via `fetch` to the provider's token endpoint, then fetch the userinfo endpoint to get the
  user's profile. Do not use Passport.js — it adds complexity without benefit for this flow.
  Must use the same strategy consistently for both Google and GitHub.
- Session cookie: `httpOnly: true`, `sameSite: 'lax'`, `maxAge: 24h`, `secure` set based on actual
  transport — `true` when the app is served over HTTPS (e.g. `NODE_ENV=production` behind a TLS
  terminator), `false` in local HTTP dev. Do not hardcode `secure: false` unconditionally.
- Session store: SQLite-backed (`connect-sqlite3` or equivalent) in production so sessions survive
  restarts; an in-memory store is acceptable in dev/test.
- Session content: a minimal `userId: string` field is enough; do not persist the whole user
  object in the session.
- Routes (mounted at `/api/auth`):

| Method | Path                    | Description                                                        |
|--------|-------------------------|----------------------------------------------------------------------|
| POST   | /demo-login             | Find-or-create the demo user, set session → 200 `{ message, userId }` |
| GET    | /google                 | Redirect to Google OAuth consent, redirect_uri built from `BACKEND_URL` |
| GET    | /google/callback        | Exchange code, upsert user, set session, redirect to `FRONTEND_URL/` — on failure redirect to `FRONTEND_URL/login?error=google_auth_failed` |
| GET    | /github                 | Redirect to GitHub OAuth consent, redirect_uri built from `BACKEND_URL` |
| GET    | /github/callback        | Same pattern as Google; if GitHub's profile has no public email, fall back to `GET /user/emails` and pick the `primary` (or first) address |
| POST   | /logout                 | `await` session destroy, then respond → 204. Must not respond before destroy completes (a fire-and-forget destroy can leave the client still authenticated momentarily). **Frontend requirement**: await the logout response to complete before clearing the client cache; only clear cache and navigate on successful response to prevent session-termination-bypass and fail-open vulnerabilities. |
| GET    | /me                     | Return current user's **safe** profile (`id, provider, email, displayName, avatarUrl, createdAt` — no internal-only fields) or 401 if not logged in |

`User.provider` type: `'google' | 'github' | 'demo'`.

---

## 6. REST API

Base path: `/api`. All routes except `/api/auth/*` require an authenticated session
(`requireAuth` middleware: `if (!request.session.userId) return reply.status(401).send({ error: 'Unauthorized' })`).

**Ownership policy (apply consistently everywhere, no exceptions):** 
- If a requested resource does not exist, return **404 `{ error: 'Not found' }`**.
- If a requested resource exists but belongs to a different user, return **403 `{ error: 'Forbidden' }`**.

This two-tier approach provides better security semantics (distinguishing "not found" from "not authorized") and enables clearer error feedback. Potential information-leakage concerns (user enumeration) are mitigated by the global rate limiter (300 req/15s per client IP, enforced on every route — see §10) and log monitoring, which are stronger defenses than conflating the two cases.

### Habits routes

| Method | Path           | Body / Query                                                          | Response         |
|--------|----------------|------------------------------------------------------------------------|------------------|
| GET    | /habits        | `?status=active\|paused\|archived&q=text&completedToday=true\|false`   | 200 array        |
| POST   | /habits        | `{ name, description?, startDate, status? }`                          | 201 habit        |
| GET    | /habits/:id    | —                                                                       | 200 habit + streaks |
| PATCH  | /habits/:id    | `{ name?, description?, status? }`                                     | 200 habit        |
| DELETE | /habits/:id    | —                                                                       | 204              |

- `q` matches substring, case-insensitively, against **both** `name` and `description` (not name
  only).
- `status` filter, when present, must be one of the three valid enum values; reject anything else
  with 400 rather than silently ignoring it.
- `completedToday` filter must be computed once, alongside the streak enrichment for each habit,
  and reused for the filter — do not issue a second, separate query to recompute it.
- `GET /habits/:id` and `GET /habits` both include computed fields:
  ```json
  { "currentStreak": 5, "bestStreak": 12, "totalCheckins": 34, "completedToday": true }
  ```
- `POST /habits`: 400 if `name` or `startDate` missing; 400 if `status` provided and not a valid
  enum value; default `status` to `'active'`.
- Status transition rules (enforce in PATCH), symmetric with §7's client-side mirror:
  - `active` ↔ `paused` — allowed
  - `active` | `paused` → `archived` — allowed
  - `archived` → anything (including re-setting `archived` as a no-op) — **forbidden**, 422
    `{ error: 'Cannot transition from archived to <status>' }`
- `DELETE /habits/:id` cascades to check-ins and milestone notifications; 204 regardless of
  whether follow-up cascaded rows existed.

### Checkins routes

| Method | Path                          | Body / Notes                               | Response |
|--------|-------------------------------|----------------------------------------------|----------|
| GET    | /habits/:id/checkins          | `?month=YYYY-MM` for calendar view, sorted ascending by date | 200 array |
| POST   | /habits/:id/checkins          | `{ date: "YYYY-MM-DD" }`                     | 201      |
| DELETE | /habits/:id/checkins/:date    | `date` must equal today (UTC)                | 204      |

`POST` validation, in order:
1. `date` must match `^\d{4}-\d{2}-\d{2}$` → 400 otherwise.
2. Habit must exist and be owned by the caller → 404 otherwise (per the unified ownership
   policy above).
3. Habit must be `active` → 422 otherwise (`{ error: 'Habit is not active' }`).
4. Date must not be in the future (UTC string compare against today) → 422 otherwise.
5. No existing checkin for `(habitId, date)` → 409 otherwise (`{ error: 'Check-in already exists for this date' }`).

`DELETE /habits/:id/checkins/:date`: 422 if `date !== today` (UTC)
(`{ error: "Can only delete today's check-in" }`); 404 if habit not found/owned.

**Correctness note for implementers using Drizzle ORM:** when combining multiple `where`
conditions, always use `and(eq(a, x), eq(b, y))`. Writing `eq(a, x) && eq(b, y)` in plain
JavaScript silently evaluates to just the second condition due to JS `&&` short-circuit
semantics, which can make an ownership or uniqueness check match the wrong row. This has caused
real milestone-deduplication bugs in prior implementations of this app — treat it as a required
code-review check, not just a suggestion.

Error response shape is uniformly `{ error: string }` with the status codes above. Register one
top-level Fastify error handler as a safety net for uncaught exceptions (500), in addition to each
route's explicit validation responses.

---

## 7. Streak Calculation

Implement as a **pure function** in `backend/src/utils/streaks.ts`, called on every
`GET /habits` and `GET /habits/:id`.

```typescript
export function calculateStreaks(
  dates: string[],   // array of 'YYYY-MM-DD', may be unsorted, may contain duplicates
  todayISO: string   // caller passes UTC date: new Date().toISOString().slice(0, 10)
): { current: number; best: number; total: number } {
  const sorted = [...new Set(dates)].sort();
  if (sorted.length === 0) return { current: 0, best: 0, total: 0 };

  // Best streak
  let best = 1, run = 1;
  for (let i = 1; i < sorted.length; i++) {
    const diff = daysBetween(sorted[i - 1], sorted[i]);
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
```

`daysBetween` and `subtractOneDay` operate on UTC midnight parses of the `YYYY-MM-DD` strings
(e.g. append `T00:00:00Z` before `new Date(...)`), so day-count math is never affected by DST or
local timezone.

**Timezone rule:** "Today" is always UTC, everywhere in the system — server and client alike.
The client computes "today" as `new Date().toISOString().slice(0, 10)` and sends that string when
checking in; the server stores it as-is and does string comparisons only, with no server-side
timezone conversion. On the frontend, implement this as **one shared helper function** (e.g.
`getTodayISO()` in a single utils module) and use it everywhere "today" is needed — the calendar's
"is this today" highlight, the dashboard's check-in/undo toggle, etc. Do not compute "today"
independently in multiple places; that has caused real UI inconsistencies (a date highlighted as
"today" in one component not matching the date used for a check-in action in another).

---

## 8. WebSocket Protocol

**Endpoint:** `GET /ws` (HTTP upgrade, same session cookie required).
**Reject** unauthenticated upgrades at the **route level** via a `preValidation` middleware (e.g.
Fastify's hook), so the HTTP upgrade is rejected with `401` before the WebSocket handshake
completes. Do not move auth logic into the handler *after* the upgrade succeeds, since that
leaves a window where the connection is accepted but not yet authorized.

All messages are JSON with the envelope:
```json
{ "type": "<message_type>", "payload": { ... } }
```

### Server → Client

| type        | Payload                                                                 | When                                      |
|-------------|---------------------------------------------------------------------------|--------------------------------------------|
| `connected` | `{ userId: string }`                                                       | Immediately after upgrade                  |
| `milestone` | `{ habitId, habitName, milestoneDays: 3\|7\|30, currentStreak: number }`   | After `subscribe`, for each unacknowledged milestone |

### Client → Server

| type        | Payload                                          | Server behavior                                                     |
|-------------|-----------------------------------------------------|------------------------------------------------------------------------|
| `subscribe` | `{ milestones: true }`                               | Evaluate milestones for all of the connected user's habits, push unacknowledged ones |
| `ack`       | `{ habitId: string, milestoneDays: 3\|7\|30 }`      | Verify the habit exists **and belongs to the connected user**; if so, `INSERT OR IGNORE` into `milestone_notifications` |

### Milestone logic (on `subscribe`)
1. Load all habits for the user.
2. For each habit, run `calculateStreaks()` over its check-in dates.
3. For each milestone in `[3, 7, 30]`: if `currentStreak >= milestone` **and** no row exists in
   `milestone_notifications` for `(habit_id, milestone_days)` → send a `milestone` message.
4. Do **not** persist to `milestone_notifications` at send time — only persist on `ack`. This
   means a client that disconnects without acking will see the same milestone message again on
   the next `subscribe`; that's expected and desired (it's how "not yet acknowledged" is defined).

**Security-critical rule:** the `ack` handler must verify `habit.userId === <the connected
session's userId>` before writing to `milestone_notifications`. Without this check, one user
could forge acks for another user's habit IDs and suppress their milestone notifications. If the
habit doesn't exist or isn't owned by the caller, silently ignore the `ack` (no error message
needed, just don't write).

There is no server-initiated heartbeat/ping required, but the client is responsible for
reconnection (see §9).

---

## 9. Frontend

### Global architecture rules

- **Single relative-path API client (REQUIRED).** All REST calls go through one client module
  (`frontend/src/lib/api.ts`) that issues requests to **relative** paths (e.g. `/api/habits`,
  `/api/auth/me`), never an absolute `http://localhost:3000/...` origin. This is required so the
  same built frontend works through the Vite dev proxy (`/api` → backend, in dev) and through the
  nginx reverse proxy (`/api` → backend service, in Docker/prod) without code changes. Every page
  (Login, Dashboard, etc.) must use this client for auth actions (demo-login, logout, OAuth
  redirect kickoff) too — do not have individual components construct their own absolute URLs.
  **Violation audit**: Search for `http://` or `localhost:3000` in frontend source code; any match
  is a deployment blocker.
- The WebSocket client builds its URL the same way: relative to `window.location`
  (`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`), which already
  routes correctly through both proxies — keep this pattern.
- **One shared type module.** `frontend/src/types.ts` is the single source of truth for `User`,
  `Habit`, `Checkin`, `WSMessage` variants, and `Notification`. Import these everywhere; do not
  redeclare a local, structurally-similar `Notification` interface in multiple components.
- **One canonical React Query key shape per resource.** E.g. habits list keyed as
  `['habits', { status, q, completedToday }]`, single habit as `['habits', habitId]`, checkins as
  `['checkins', habitId, month]`. Every screen that needs the habit list uses the same hook
  (`useHabits`) with the same key shape — don't have one page build its own ad-hoc `useQuery` with
  differently-named filter params. Every mutation hook (create/update/delete habit, create/delete
  checkin) invalidates the relevant keys itself in its own `onSuccess`, consistently — don't leave
  cache invalidation as a responsibility the calling component has to remember to do manually.

### Routing

`react-router-dom` v6. Routes:
- `/login` → `LoginPage`
- `/` → `DashboardPage`, behind a `ProtectedRoute` (redirects to `/login` if not authenticated)
- `/habits/:id` → `HabitDetailPage`, behind the same `ProtectedRoute`

A `WebSocketProvider` (see below) wraps the authenticated part of the app so
`NotificationPanel` can render globally, on top of any page, whenever a user is logged in.

### LoginPage (`/login`)
- Three buttons: **Continue with Google** → `/api/auth/google`, **Continue with GitHub** →
  `/api/auth/github`, and **Demo Login** → `POST /api/auth/demo-login` via the shared API client,
  then invalidate `['auth', 'me']` and navigate to `/`.
- Reads an `?error=` query param (`google_auth_failed` | `github_auth_failed`) and shows a
  corresponding inline error banner, then clears the param from the URL.
- No other inputs. Redirect here if unauthenticated.

### DashboardPage (`/`)
- Habit list via the shared `useHabits` hook (TanStack Query).
- Per card (`HabitCard`): name, status badge, current streak 🔥, best streak ⭐, total check-ins,
  today check-in toggle (button label swaps between "Check in Today" and "Done Today"/"✓ Done
  Today" depending on `completedToday`), Edit and Delete actions (Delete confirms via a dialog
  naming the habit).
- Search input + status filter dropdown + "completed today" toggle, all driving the single
  `useHabits` query key.
- Empty state when no habits (distinct copy for "no habits at all" vs. "no results for current
  filters"). Loading skeleton (`LoadingSkeleton`) while fetching.
- Button to open `HabitModal` in create mode.
- Header shows the current user's display name/avatar and a Logout button (calls
  `POST /api/auth/logout` via the shared client, clears the query cache, navigates to `/login`).

### HabitModal (create / edit)
- Fields: Name (required, 2–100 chars), Description (optional, max 500 chars, with a live
  character counter), Start date (create only), Status (select; edit mode warns if setting
  `archived`, since archived habits can't receive new check-ins).
- Client-side validation mirrors the server's rules exactly, including the status-transition
  matrix from §6 (`active`/`paused` can go to any of the three; `archived` can only stay
  `archived`).
- Submit button shows a spinner while the mutation is in flight; surfaces a submit-level error
  banner on failure.

### HabitDetailPage (`/habits/:id`)
- Stats row: current streak, best streak, total check-ins.
- Monthly calendar grid (`Calendar` component) — highlight checked-in dates, and highlight
  "today" using the same shared `getTodayISO()` helper used elsewhere (§7).
- Edit button opens `HabitModal`; on success, invalidate **both** the single-habit query key and
  the general habits-list key prefix, so the dashboard doesn't show stale data after an edit made
  from this page.
- Back button to the dashboard.

### NotificationPanel
- Fixed top-right corner toast stack, driven by `WebSocketContext`'s `notifications` array.
- Shows incoming `milestone` WS messages: habit name + "N-day streak!" badge + current streak.
- Auto-dismisses after 4 seconds; dismiss button allows immediate manual close.
- Manual dismiss or auto-dismiss → calls `dismissNotification(habitId, milestoneDays)`, which sends an `ack` over
  the WebSocket and removes the toast locally.
- When adding a new notification, de-duplicate by `(habitId, milestoneDays)` so the same milestone
  arriving twice before it's acked doesn't produce two toasts.

### WebSocketContext / useWebSocket hook
- `useWebSocket({ enabled, onMilestone })` manages one WebSocket connection, sends `subscribe`
  immediately on open, exposes `subscribe()` and `ack(habitId, milestoneDays)`, and reconnects
  with exponential backoff (e.g. `min(1000 * 2^attempts, 10000)` ms) up to a bounded number of
  attempts on unexpected close; does not reconnect at all while `enabled` is false (e.g. logged
  out).
- `WebSocketProvider` wires this hook to the current authenticated user (`enabled: !!user`) and
  exposes `{ notifications, dismissNotification, isConnected }` via context.

### Responsive behavior
- Mobile: single-column card layout, cards stack vertically, modal becomes a bottom sheet.

### Required UI polish
- Consistent spacing + typography across all screens (pick one heading font, one body font).
- Visible hover and focus states on all interactive elements.
- Empty states: no habits, no search results, no check-ins yet (with lightweight illustrative
  copy/emoji, not just blank space).
- At least one loading skeleton (habit list).
- Client-side form validation feedback (inline field errors, not just a submit-time alert).
- Light theme only.

---

## 10. Required Tests

All backend tests use an **in-memory SQLite** database (`:memory:`), constructed fresh
(`beforeAll`) and reset (`beforeEach`) so tests are fully isolated and can run in any order. No
real Google/GitHub network calls — authenticate test sessions via the `/api/auth/demo-login`
endpoint, which requires no network access and is part of the app's real behavior.

**Security testing:**
- Rate limiting verified on test coverage (300 req/15s per IP, global, enforced on all routes)
- Input validation (Zod schemas) verified via invalid request tests
- OAuth CSRF state parameter verified on callback tests
- Session security (httpOnly, sameSite, secure flags) verified in session tests
- WebSocket authentication enforced at route level (preValidation) — verified via test attempts without auth
- Error handler verified to not leak internal messages on 5xx responses
- Ownership/authorization split (404 vs 403) verified via cross-user access tests

| ID  | File               | What to test                                                                                  |
|-----|--------------------|-------------------------------------------------------------------------------------------------|
| T1  | auth.test.ts       | Demo/mocked login → session created → `/auth/me` returns the profile; `/auth/me` without a session → 401 |
| T2  | habits.test.ts     | `POST /habits` → 201. `GET /habits` returns it, including computed streak fields.               |
| T3  | checkins.test.ts   | `POST` check-in for today → 201. Second identical `POST` → 409.                                 |
| T4  | checkins.test.ts   | `POST` with a future date → 422. `POST` on a paused (or archived) habit → 422.                  |
| T5  | habits.test.ts     | **Two distinct users**: user B's session accessing user A's habit → 403 on GET, PATCH, and DELETE (ownership forbidden). Additionally, test that accessing a truly nonexistent habit returns 404. This must use two real, separately-authenticated sessions, not just a random nonexistent ID. |
| T6  | ws.test.ts         | Using a real `ws` client: seed 3 consecutive check-ins for a habit, connect to `/ws` with the session cookie, send `subscribe`, assert a `milestone` message with `milestoneDays: 3` is received. |
| T7  | ws.test.ts         | Same scenario with 7 consecutive check-ins → assert `milestoneDays: 7`.                        |
| T8  | ws.test.ts         | Same scenario with 30 consecutive check-ins → assert `milestoneDays: 30`.                       |
| T9  | ws.test.ts         | T6 scenario → send `ack` over the same WS connection → disconnect → reconnect → send `subscribe` again → assert **no** duplicate `milestone` message is received for that `(habit, milestoneDays)` pair. |

T6–T9 must use an actual WebSocket client connection (e.g. the `ws` package) against the running
Fastify server instance — asserting the same outcome indirectly via HTTP streak values is not
sufficient, since it doesn't exercise the WS handler, the `subscribe`/`ack` message protocol, or
the ack-ownership check at all.

Run all backend tests:
```bash
cd backend && npm test
```

A Playwright e2e suite (`e2e/`) may additionally smoke-test the UI (login via Demo Login, create
a habit, check in, see a streak, search/filter, log out), but it is a supplement to, not a
replacement for, the backend test suite above.

---

## 11. Commands

```bash
# Install all dependencies (run from root, npm workspaces)
npm install

# Run both dev servers concurrently
npm run dev

# Run backend dev server only (port 3000)
cd backend && npm run dev

# Run frontend dev server only (port 5173)
cd frontend && npm run dev

# Generate + apply database migrations from schema.ts
cd backend && npm run db:migrate

# Seed sample data (1 user, 3 habits, check-ins)
cd backend && npm run db:seed

# Run backend tests
cd backend && npm test

# Type-check backend / frontend
cd backend && npm run typecheck
cd frontend && npm run typecheck

# End-to-end tests
npm run test:ui
```

---

## 12. Authorization Rules

Enforce on **every** habit and check-in operation, and on the WebSocket upgrade:

```typescript
// requireAuth middleware — attach to all /api/habits and /api/checkins routes
if (!req.session.userId) return reply.status(401).send({ error: 'Unauthorized' });

// ownership guard — inside each route handler; split into two checks
const habit = await db.query.habits.findFirst({ where: eq(habits.id, req.params.id) });
if (!habit) {
  return reply.status(404).send({ error: 'Not found' });
}
if (habit.userId !== req.session.userId) {
  return reply.status(403).send({ error: 'Forbidden' });
}
```

Rationale: Separate 404 (missing) from 403 (forbidden) provides clearer semantics and better error
feedback to clients, while preventing accidental authorization bypasses if the ownership check is
ever refactored or removed.

Apply the same split pattern to all routes touching user-owned resources. For WebSocket: enforce
auth at the route level via `preValidation` so the upgrade itself is rejected pre-handshake.
For the `ack` message handler: silently ignore if the referenced habit isn't owned by the
connected user (no error message needed, just don't write).

---

## 13. Docker / Deployment

- Multi-stage Dockerfiles for both `backend` and `frontend`, both pinned to the same Node LTS
  major version used in dev (Node 20) — do not let one image drift to a newer major version than
  the other or than what's declared in this spec.
- `backend` Dockerfile: install native build tools needed for `better-sqlite3` in the builder
  stage only; production stage installs prod-only deps and copies just the compiled output; runs
  migrations before starting the server on every container start (idempotent).
- `docker-compose.yml`: backend bound to an internal/loopback address only, not exposed publicly
  on its own; required env vars (especially `SESSION_SECRET`) must fail the compose run fast if
  unset; a named volume persists the SQLite data + sessions directory; a healthcheck (e.g.
  `GET /api/auth/me`, treating any non-5xx response as healthy) gates frontend startup until the
  backend is ready.
- `frontend` Dockerfile: builds the Vite app, serves the static output via nginx; `nginx.conf`
  provides SPA fallback routing and reverse-proxies `/api/` and `/ws` to the backend service (by
  Docker Compose service name, not `localhost`). Because the frontend code only ever issues
  relative requests (§9), this proxy is actually effective in this deployment — there must be no
  hardcoded absolute backend origin anywhere in the shipped frontend bundle.

---

## 14. Acceptance Checklist

**Functional requirements:**
- [ ] New user can log in with Google, GitHub, and Demo Login
- [ ] User record created automatically on first SSO sign-in
- [ ] User can create, edit, and archive habits; status transitions enforced (both server- and client-side)
- [ ] User can check in a habit for today and undo the check-in
- [ ] Future-date check-in rejected (422); duplicate rejected (409)
- [ ] Current streak, best streak, total check-ins display correctly and consistently with the server's UTC "today" rule
- [ ] Paused/archived habits cannot receive new check-ins
- [ ] Search (name + description) and status filter work on the habit list
- [ ] Data is private: a second user's habits return 403 Forbidden on GET/PATCH/DELETE, nonexistent habits return 404 Not Found, verified with two real authenticated sessions
- [ ] WebSocket connects on login; `subscribe` triggers milestone evaluation
- [ ] Milestone notifications appear in the UI for 3-, 7-, and 30-day streaks
- [ ] Acknowledged milestones are not re-sent after reconnect, verified via a real WebSocket test client (not just an HTTP streak assertion)
- [ ] The `ack` handler rejects/ignores acks for habits the connected user does not own

**Security verification:**
- [ ] Rate limiting active: verify rate-limit headers on repeated requests to `/api/auth/demo-login`
- [ ] Input validation active: malformed requests (invalid date format, oversized name, invalid status) return 400
- [ ] OAuth CSRF protection: callback without valid state parameter is rejected
- [ ] Error handler active: forced 500 errors return generic message, not stack traces
- [ ] Session security: cookies are httpOnly + sameSite + secure (in production)
- [ ] WebSocket auth: connection without session cookie is rejected at upgrade
- [ ] Docker: container runs as non-root user, production image has no build tools
- [ ] Logout security: frontend awaits logout completion before clearing cache (no session-termination-bypass)
- [ ] No hardcoded origins: grep frontend code for `http://localhost` or `localhost:3000` — should find zero matches
- [ ] Dependency audit: no unused packages (Passport, express-session); drizzle-kit in devDependencies only

**Testing & deployment:**
- [ ] All 58 automated backend tests pass: `cd backend && npm test`
- [ ] TypeScript strict mode passes: `cd backend && npm run typecheck`
- [ ] E2e smoke tests: `npm run test:ui` (14+ passing, known brittle tests are test harness not product bugs)
- [ ] The frontend issues only relative API/WS requests — no hardcoded `localhost` origins anywhere in shipped code
- [ ] App starts from a clean clone using only the README, both in local dev and via `docker-compose up`

```

