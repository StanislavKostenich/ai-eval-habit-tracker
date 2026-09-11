# 🎯 Habit Tracker with Streaks

[![Node.js](https://img.shields.io/badge/Node.js-20-green?style=flat-square)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue?style=flat-square)](https://www.typescriptlang.org)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED?style=flat-square)](./DOCKER.md)
[![Tests](https://img.shields.io/badge/Tests-backend%20suite-brightgreen?style=flat-square)](./backend/tests)
[![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)](./LICENSE)

Full-stack MVP habit tracking app with daily check-ins, streak calculation, single sign-on (SSO) authentication, and real-time WebSocket milestone notifications. Built with Node.js, React, and SQLite.

**Quick Links:** [☁️ Deploy to Azure](#-deploy-to-azure-github-actions) • [📦 Docker Setup](#-docker-deployment) • [🚀 Quick Start](#-quick-start) • [📚 API Docs](#api-overview) • [🔧 Setup Guide](#environment-setup) • [📖 Full Docs](./DOCKER.md)

---

## ☁️ Deploy to Azure (GitHub Actions)

**New to the project? Want a live URL with automated CI/CD?**

→ **[Follow the CI/CD Setup Guide](./docs/SETUP_CI_CD.md)** (~5 minutes of setup, then every push to `main` deploys automatically).

What you get:
- A **GitHub Actions workflow** that builds and deploys on every push to `main` (or on manual trigger).
- **Azure Container Apps** — backend (internal) + frontend (public HTTPS URL), scaling to zero when idle.
- **No local Docker or CLI needed** for the deploy — images are built by Azure's managed build service.

Other deployment options:
- **Manual deployment (CLI):** [DEPLOY_AZURE.md](./DEPLOY_AZURE.md) — interactive `deploy.sh` with prompts.
- **Local development:** see [Quick Start](#-quick-start) below.

---

## ✨ Features

- **Multi-user SSO** — Log in with Google, GitHub, or Demo Login (for development)
- **Create & manage habits** — Add, edit, pause, and archive habits with full status validation
- **Daily check-ins** — Track daily progress; one check-in per day, today only (UTC)
- **Streak calculation** — Current streak, best streak, and total check-ins
- **Real-time milestone notifications** — WebSocket-driven alerts for 3, 7, and 30-day streaks with acknowledgment
- **Search & filter** — Find habits by name/description and filter by status or completion
- **Responsive design** — Desktop and mobile layouts
- **Automated test suite** — Vitest backend tests covering auth, habits, check-ins, streaks, rate limiting, and WebSocket milestone engine

## 📋 Table of Contents

- [✨ Features](#-features)
- [🏗️ Tech Stack](#️-tech-stack)
- [🚀 Quick Start](#-quick-start)
- [🐳 Docker Deployment](#-docker-deployment)
- [🔧 Environment Setup](#-environment-setup)
- [🔐 OAuth Setup](#-oauth-setup)
- [📚 API Overview](#api-overview)
- [🗄️ Database Schema](#-database-schema)
- [🧪 Testing](#running-tests)
- [❓ FAQ](#-frequently-asked-questions)
- [🆘 Troubleshooting](#troubleshooting)

---

## 🏗️ Tech Stack

| Layer         | Technology                                  |
|---------------|---------------------------------------------|
| **Runtime**   | Node.js 20 + TypeScript (strict mode)       |
| **Backend**   | Fastify 4                                   |
| **Database**  | SQLite via `better-sqlite3`                 |
| **ORM**       | Drizzle ORM                                 |
| **Auth**      | Hand-rolled OAuth2 (Google + GitHub via `fetch`) + Demo Login |
| **Sessions**  | `@fastify/session` + `connect-sqlite3` (SQLite-backed) |
| **WebSocket** | `@fastify/websocket`                        |
| **Frontend**  | React 18 + Vite                             |
| **UI**        | Tailwind CSS (utility-first)                |
| **State**     | TanStack Query v5                           |
| **Testing**   | Vitest + `ws` WebSocket client              |

---

## 🚀 Quick Start

**Choose your setup method:**

### Option A: Docker (Recommended for new users)
```bash
docker compose up --build
# Frontend: http://localhost
# Backend API: http://localhost:3000
```
👉 [Full Docker guide →](./DOCKER.md)

### Option B: Local Development

#### Prerequisites
- Node.js 20 or later
- npm or yarn
- Google and GitHub OAuth credentials (see [Environment Setup](#environment-setup) below)

#### 1. Clone & Install

```bash
git clone <repository-url>
cd habit-tracker
npm install
```

#### 2. Set Up Environment Variables

```bash
cp .env.example .env
```

Edit `.env` with your OAuth credentials (see [Environment Setup](#environment-setup) section below).

#### 3. Set Up Database

From the root directory:

```bash
npm run db:migrate -w backend
npm run db:seed -w backend
```

This creates the database schema and seeds sample data (1 user, 3 habits with check-ins).

**Note:** If seed fails with a UNIQUE constraint error, the sample data already exists — this is safe to ignore.

#### 4. Run Both Servers

From the root directory, start both servers in parallel:

```bash
npm run dev
```

Or in separate terminals:

**Terminal 1 — Backend:**
```bash
npm run dev -w backend
# Backend runs on http://localhost:3000
```

**Terminal 2 — Frontend:**
```bash
npm run dev -w frontend
# Frontend runs on http://localhost:5173
```

Open your browser to **http://localhost:5173** and log in with Google or GitHub.

---

## 🐳 Docker Deployment

For containerized deployment, use Docker Compose:

```bash
# Build and start all services
docker compose up --build

# The app is now available at:
# - Frontend: http://localhost
# - Backend API: http://localhost:3000
```

The Docker setup includes:
- **Backend container** (Node.js 22): Fastify API + WebSocket on port 3000
- **Frontend container** (nginx): React SPA on port 80 with reverse proxies for /api and /ws
- **Data volume** (habit_data): Persists SQLite database and sessions

**Note:** The existing `.env` file is automatically loaded by docker-compose. OAuth callback URLs remain registered to `localhost:3000`, which is accessible directly from the host.

Useful Docker commands:
```bash
# View running containers
docker compose ps

# View logs
docker compose logs -f backend   # Backend logs
docker compose logs -f frontend  # Frontend logs

# Restart services
docker compose restart

# Stop all services (preserves data)
docker compose down

# Stop all services and delete data
docker compose down -v
```

**For detailed Docker troubleshooting, logs, and production notes:** [📖 See DOCKER.md](./DOCKER.md)

---

## 🔧 Environment Setup

### Create `.env` file

Copy `.env.example` to `.env` in the project root:

```bash
cp .env.example .env
```

### Environment Variables

| Variable              | Description                                         | Example                        | Required |
|-----------------------|-----------------------------------------------------|--------------------------------|----------|
| `GOOGLE_CLIENT_ID`    | Google OAuth 2.0 Client ID                          | `abc123.apps.googleusercontent.com` | No (if not using Google login) |
| `GOOGLE_CLIENT_SECRET` | Google OAuth 2.0 Client Secret                      | `secret_key_xyz`              | No (if not using Google login) |
| `GITHUB_CLIENT_ID`    | GitHub OAuth App Client ID                          | `abc123xyz`                   | No (if not using GitHub login) |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth App Client Secret                      | `secret_key_xyz`              | No (if not using GitHub login) |
| `SESSION_SECRET`      | Secret for session encryption (**32+ chars**)       | see below                     | **Yes** — boots hard fail otherwise |
| `DATABASE_PATH`       | SQLite database file location                       | `./data/habits.db`            | No (defaults to `./data/habits.db`) |
| `PORT`                | Backend server port                                 | `3000`                        | No (defaults to `3000`) |
| `FRONTEND_URL`        | Frontend URL for redirects after OAuth              | `http://localhost:5173`       | No (defaults to `http://localhost:5173`) |
| `BACKEND_URL`         | Backend URL for building OAuth redirect URIs        | `http://localhost:3000`       | No (defaults to `http://localhost:3000`) |
| `NODE_ENV`            | Node environment                                    | `development` or `production` | No (defaults to `development`) |

**Important notes:**
- **`SESSION_SECRET` is REQUIRED** and must be at least 32 characters. The app will refuse to boot without it — no fallback constant is used, even in development. This prevents accidental session-secret exposure.
- OAuth redirect URIs are built from `BACKEND_URL`, never hardcoded in route code — this allows the same code to work in Docker/production.
- All three OAuth providers (Google, GitHub, Demo Login) are always available; Demo Login is disabled in production (returns 404).

### Generate SESSION_SECRET

Run this command to generate a secure random string:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copy the output to `SESSION_SECRET` in your `.env` file.

---

## 🔐 OAuth Setup

### Google OAuth Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create or select a project
3. Navigate to **APIs & Services** → **Credentials**
4. Click **Create Credentials** → **OAuth 2.0 Client ID**
5. Choose **Web application**
6. Add **Authorized redirect URI**: `${BACKEND_URL}/api/auth/google/callback`
   - For local dev: `http://localhost:3000/api/auth/google/callback`
7. Copy **Client ID** and **Client Secret** to your `.env` file

### GitHub OAuth Setup

1. Go to [GitHub Developer Settings](https://github.com/settings/developers)
2. Click **OAuth Apps** → **New OAuth App**
3. Fill in the form:
   - **Application name**: Habit Tracker
   - **Homepage URL**: `${FRONTEND_URL}` (for local dev: `http://localhost:5173`)
   - **Authorization callback URL**: `${BACKEND_URL}/api/auth/github/callback`
     - For local dev: `http://localhost:3000/api/auth/github/callback`
4. Copy **Client ID** and **Client Secret** to your `.env` file

**Note:** These URIs are built dynamically from `BACKEND_URL` and `FRONTEND_URL` at runtime — register the callback URLs in OAuth apps using the values you set in `.env`, and they will work in both local dev and production.

---

## 🧪 Running Tests

Run all automated backend tests:

```bash
cd backend
npm test
```

**Test Coverage:**
- **T1**: SSO authentication (demo login, session creation, `/auth/me`)
- **T2**: Habit CRUD operations and streak calculations
- **T3**: Check-in duplicate prevention (409 Conflict)
- **T4**: Check-in validation (future dates, paused habits, status enforcement)
- **T5**: User ownership and authorization (404 vs 403 semantics)
- **T6–T9**: WebSocket milestone engine (real `ws` client, subscription, ack protocol, de-duplication)
- **Rate limiting**: 300 req/15s per IP on all routes
- **Input validation**: Name length (1–100), description (max 500), date format

### Type Checking

Check TypeScript types in backend:

```bash
cd backend
npm run typecheck
```

Check TypeScript types in frontend:

```bash
cd frontend
npm run typecheck
```

## Project Structure

```
habit-tracker/
├── README.md
├── CLAUDE.md                    # Project specification
├── .env.example                 # Environment variable template
├── package.json                 # Root package manifest
│
├── backend/
│   ├── src/
│   │   ├── db/
│   │   │   ├── schema.ts        # Drizzle ORM table definitions (source of truth)
│   │   │   ├── migrate.ts       # Generated migrations and application
│   │   │   ├── seed.ts          # Sample data seeding
│   │   │   └── index.ts         # Database initialization
│   │   ├── routes/
│   │   │   ├── auth.ts          # Auth routes (OAuth, demo-login, logout, /me)
│   │   │   ├── habits.ts        # Habit CRUD + filtering + streak enrichment
│   │   │   └── checkins.ts      # Check-in CRUD with validation
│   │   ├── auth/
│   │   │   └── oauth.ts         # Hand-rolled OAuth2 (Google + GitHub)
│   │   ├── ws/
│   │   │   └── handler.ts       # WebSocket + milestone engine (subscribe/ack protocol)
│   │   ├── utils/
│   │   │   ├── streaks.ts       # Pure streak calculation (current, best, total)
│   │   │   └── date.ts          # Shared "today" UTC helper
│   │   ├── middleware/
│   │   │   ├── requireAuth.ts   # Session authentication guard
│   │   │   └── rateLimit.ts     # Global rate limiting (300 req/15s per IP)
│   │   ├── session/
│   │   │   └── sqliteStore.ts   # SQLite-backed session store
│   │   └── app.ts               # Fastify app setup + plugin registration
│   ├── tests/
│   │   ├── auth.test.ts         # T1: SSO login tests
│   │   ├── habits.test.ts       # T2, T5: Habit CRUD + authorization tests
│   │   ├── checkins.test.ts     # T3, T4: Check-in validation tests
│   │   └── ws.test.ts           # T6–T9: WebSocket + milestone tests
│   ├── drizzle.config.ts        # Drizzle CLI configuration
│   └── package.json
│
└── frontend/
    ├── src/
    │   ├── components/
    │   │   ├── HabitCard.tsx      # Habit card with streak display + check-in toggle
    │   │   ├── HabitModal.tsx     # Create/edit habit modal with status transitions
    │   │   ├── NotificationPanel.tsx  # Toast stack for milestone notifications
    │   │   ├── Calendar.tsx       # Monthly calendar grid with check-in highlights
    │   │   └── LoadingSkeleton.tsx # Loading skeleton for habit list
    │   ├── pages/
    │   │   ├── LoginPage.tsx      # OAuth login (Google, GitHub, Demo)
    │   │   ├── DashboardPage.tsx  # Habit list with search/filter/completed-today toggle
    │   │   └── HabitDetailPage.tsx # Single habit stats + calendar + edit/back actions
    │   ├── hooks/
    │   │   ├── useHabits.ts       # TanStack Query for habit list + filtering
    │   │   ├── useCheckin.ts      # Create/delete check-in mutations
    │   │   └── useWebSocket.ts    # WebSocket connection + milestone subscription
    │   ├── context/
    │   │   └── WebSocketContext.tsx # Global milestone notifications context
    │   ├── lib/
    │   │   ├── api.ts             # Single relative-path HTTP client
    │   │   └── queryClient.ts     # TanStack Query configuration
    │   ├── types.ts               # Shared TypeScript types (User, Habit, Checkin, WS messages)
    │   ├── main.tsx               # React app entry + router
    │   └── index.css              # Tailwind CSS imports
    ├── tailwind.config.ts         # Tailwind configuration
    └── package.json
```

## API Overview

All API routes are prefixed with `/api`. Authentication required except for `/api/auth/*`.

### Authentication Routes

- `POST /api/auth/demo-login` — Find-or-create demo user (dev/testing only; returns 404 in production)
- `GET /api/auth/google` — Redirect to Google OAuth consent
- `GET /api/auth/google/callback` — OAuth callback (auto-create user if first sign-in)
- `GET /api/auth/github` — Redirect to GitHub OAuth consent
- `GET /api/auth/github/callback` — OAuth callback (auto-create user if first sign-in)
- `POST /api/auth/logout` — Destroy session (await before clearing client cache)
- `GET /api/auth/me` — Get current user profile or 401 if not authenticated

### Habits Routes

- `GET /api/habits` — List habits (filter by status, search, completion)
- `POST /api/habits` — Create habit
- `GET /api/habits/:id` — Get habit with streak stats
- `PATCH /api/habits/:id` — Update habit (including status: `active`, `paused`, `archived`)
- `DELETE /api/habits/:id` — **Hard delete** (removes habit + all check-ins + milestones; cannot be undone)

### Check-in Routes

- `GET /api/habits/:id/checkins?month=YYYY-MM` — List check-ins for month, sorted ascending
- `POST /api/habits/:id/checkins` — Create check-in for date (`{ date: "YYYY-MM-DD" }`)
  - Validation: date format → ownership (404) → active status (422) → not future (422) → no duplicate (409)
- `DELETE /api/habits/:id/checkins/:date` — Delete check-in (date must equal today UTC, 422 otherwise)

### WebSocket

- `GET /ws` — WebSocket upgrade (same session cookie required)
  - Client sends `{ "type": "subscribe", "payload": { "milestones": true } }`
  - Server responds with `milestone` messages for 3, 7, 30-day streaks
  - Client acknowledges with `{ "type": "ack", "payload": { "habitId": "...", "milestoneDays": 3 } }`

## Streak Calculation & Timezone Handling

### Timezone Behavior

**All dates in this app use UTC.** Streaks are calculated based on UTC calendar days, not local time.

- Check-in dates are stored as `YYYY-MM-DD` strings (UTC)
- "Today" is always `new Date().toISOString().slice(0, 10)` (UTC)
- Streak calculations walk backwards from UTC today, day by day
- Paused/archived status does NOT preserve streaks — gaps break the current streak

### Example: Streak Calculation

```typescript
// User in New York (UTC-5) checks in at 11 PM local time on Jan 15
// This records as 2024-01-16 in UTC (4 AM next day UTC)
// Streak counter includes this as a Jan 16 check-in in UTC terms

// Next day in New York (Jan 16 local = Jan 17 UTC)
// User checks in at 11 PM New York time (4 AM UTC Jan 17)
// Streak continues: consecutive days in UTC calendar

// This means users in timezones east of UTC see check-ins advance the date earlier
// Users west of UTC see them advance later — but all streaks are calculated consistently in UTC
```

**Important:** If your app needs local-date behavior (e.g., "today in my timezone"), you would need:
1. Client to send local date strings instead of UTC
2. Backend to document timezone offset per user
3. Streak logic to account for user timezone offsets

Currently, this MVP uses UTC throughout for simplicity.

## Database Schema

All IDs are UUIDs. Timestamps are Unix timestamps.

### `users`
```sql
id TEXT PRIMARY KEY
provider TEXT NOT NULL             -- 'google' | 'github' | 'demo'
provider_user_id TEXT NOT NULL
email TEXT                         -- nullable
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
description TEXT
start_date TEXT NOT NULL           -- YYYY-MM-DD
status TEXT NOT NULL DEFAULT 'active'  -- 'active' | 'paused' | 'archived'
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

---

## 🔒 Security & Authorization

All API routes (except `/api/auth/*`) require an authenticated session. User ownership is enforced with semantic HTTP responses:

- **404 Not Found**: Resource does not exist
- **403 Forbidden**: Resource exists but belongs to another user

This two-tier approach prevents information leakage and provides clear error semantics.

### Rate Limiting
- **Global sliding window**: 300 requests per 15 seconds per IP
- Applied to all routes before session deserialization
- Uses IP from `request.ip` (with `trustProxy: 1`)

### WebSocket Security
- Authentication enforced at upgrade via `preValidation` hook (before handshake completes)
- `ack` handler verifies habit ownership before persisting milestone acknowledgments

> **⚠️ Important:** Deleting a habit permanently removes it and ALL its check-in history. To preserve history, use **Archive** instead. See [Habit Deletion & Check-in History](#habit-deletion--check-in-history) for details.

## Business Rules & Design Decisions

### Habit Deletion & Check-in History

**Design Question:** What should happen when a user deletes a habit?

Two approaches were evaluated:

| Approach | Behavior | User Experience |
|----------|----------|-----------------|
| **A: Cascade Delete** ✅ **CHOSEN** | Habit + all check-ins + milestones deleted immediately | One-click deletion; no history kept |
| **B: Block Until Archived** | Deletion blocked; user must archive first | Two-step process; preserves audit trail |

**Chosen Approach: A — Cascade Delete**

When a habit is deleted:
1. The habit record is deleted
2. All associated check-ins are automatically removed (cascade delete)
3. All milestone notifications are automatically removed
4. **This can be done at ANY status (active, paused, or archived) — NO restrictions**
5. **No pre-archival requirement** — Users can delete active/paused habits directly

**Key Point:** Users can delete a habit whenever they want. There is no requirement to archive first.

```sql
CREATE TABLE checkins (
  ...
  habit_id TEXT NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  ...
)

CREATE TABLE milestone_notifications (
  ...
  habit_id TEXT NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  ...
)
```

**Why Cascade Delete (not Block-Until-Archived)?**

| Factor | Cascade Delete | Block-Until-Archived |
|--------|---|---|
| **User Experience** | ✅ Simple one-click deletion | ❌ Two-step workflow friction |
| **Data Cleanup** | ✅ Prevents orphaned records | ❌ Requires manual deletion anyway |
| **Audit Trail** | ⚠️ No history after deletion | ✅ Archived habits keep history |
| **Code Complexity** | ✅ Database constraint (atomic) | ❌ Validation logic needed |
| **Use Case** | ✅ Users who want complete removal | ✅ Users who want to keep history |

**Examples:**

```bash
# ✅ Allowed: Delete an ACTIVE habit directly
DELETE /api/habits/habit-123

# ✅ Allowed: Delete a PAUSED habit directly  
DELETE /api/habits/habit-456

# ✅ Allowed: Delete an ARCHIVED habit directly
DELETE /api/habits/habit-789

# Result in all cases: Habit + check-ins + milestones permanently removed
```

**How to Keep Historical Data:**

Users who want to preserve a habit's history should **archive** instead of delete:
- `PATCH /api/habits/:id` with `{ "status": "archived" }`
- Archived habits keep all check-ins and streaks visible
- Archived habits don't receive new check-ins
- Can be "unarchived" later (transitioned back to active/paused)

**Summary:**
- **Delete** = Complete removal (habit + check-ins + milestones) — works on any status
- **Archive** = Preserve history while stopping new check-ins — reversible

**Tested:** Test T10 verifies cascade deletion works for all dependent records

## Habit Deletion — Frequently Asked Questions

### Can I delete an active habit?
**Yes.** You can delete a habit at any time, regardless of its status (active, paused, or archived). There is no requirement to archive first.

### What happens when I delete a habit?
When you delete a habit:
- ✅ The habit is permanently removed
- ✅ All check-ins for that habit are deleted
- ✅ All milestone notifications are deleted
- ❌ This **cannot be undone**

### I want to keep the check-in history. What should I do?
Use **Archive** instead of **Delete**:
```bash
PATCH /api/habits/:id { "status": "archived" }
```

Archived habits:
- Keep all historical check-ins visible
- Keep streak calculations visible
- Prevent new check-ins from being added
- Can be changed back to active/paused later if needed

### What's the difference between Delete and Archive?

| Action | Removes Data | Reversible | Shows History |
|--------|---|---|---|
| **Delete** | Habit + check-ins + milestones | ❌ No | ❌ No |
| **Archive** | Nothing removed | ✅ Yes | ✅ Yes |

### Why not require archiving before deletion?
This approach was deliberately chosen for:
- **Simplicity**: One-click deletion when you want complete removal
- **User control**: Users decide when they want complete removal vs. history preservation
- **Clear intent**: Archive to keep history; Delete to remove completely

---

## 🆘 Troubleshooting

### "Unauthorized" on API routes
- Check that you're logged in by visiting `/api/auth/me`
- Verify session cookie is being sent with requests
- Check `SESSION_SECRET` is set and consistent

### OAuth login redirects to error page
- Verify `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` are correct
- Confirm redirect URIs match in OAuth app settings
- Check that frontend and backend URLs are correct in `.env`

### Database errors
- Run `npm run db:migrate` to ensure schema is created
- Delete `data/habits.db` and re-run migrations if corrupted
- Check `DATABASE_PATH` points to a writable location

### WebSocket not connecting
- Ensure backend is running on the correct port (default 3000)
- Check browser console for WebSocket errors
- Verify CORS is not blocking the upgrade (should use session auth, not CORS)

---

## 👨‍💻 Development

### Database Commands
```bash
cd backend

# Generate + apply migrations from schema.ts
npm run db:migrate

# Seed sample data (1 user, 3 habits with check-ins)
npm run db:seed

# Reset database (delete and recreate)
rm -rf data/habits.db && npm run db:migrate && npm run db:seed
```

### Type Checking
```bash
# Backend
cd backend && npm run typecheck

# Frontend
cd frontend && npm run typecheck

# Both
npm run typecheck
```

### Checking Everything

```bash
# Run all backend tests
npm test

# Type-check both backend and frontend
npm run typecheck

# Run Playwright e2e tests (requires running app)
npm run test:ui
```

### Reinstall & Reset

```bash
# Clean install (from root)
rm -rf node_modules backend/node_modules frontend/node_modules backend/data
npm install
npm run db:migrate -w backend
npm run db:seed -w backend

# Then start dev servers
npm run dev
```

---

## 📖 Full Documentation

### Getting Started
- **[README.md](./README.md)** — Quick start, API overview, and architecture (you are here)
- **[CLAUDE.md](./CLAUDE.md)** — Project guide and hard rules (must-read for contributors)
- **[docs/SPEC.md](./docs/SPEC.md)** — Complete implementation specification (authoritative source)

### OAuth & Security
- **[docs/OAUTH_SETUP.md](./docs/OAUTH_SETUP.md)** — Step-by-step Google and GitHub OAuth setup
- **[docs/SECURITY.md](./docs/SECURITY.md)** — Security architecture and best practices
- **[docs/AZURE_OIDC_SETUP.md](./docs/AZURE_OIDC_SETUP.md)** — Azure OIDC federation for CI/CD

### Deployment & CI/CD
- **[docs/SETUP_CI_CD.md](./docs/SETUP_CI_CD.md)** — Automated Azure deployment via GitHub Actions (~5 min setup)
- **[docs/CI_CD_SUMMARY.md](./docs/CI_CD_SUMMARY.md)** — CI/CD implementation overview
- **[DOCKER.md](./DOCKER.md)** — Docker Compose setup, commands, and troubleshooting

### API & Architecture
- **[API Overview](#api-overview)** — REST API endpoint reference (in this README)
- **[Database Schema](#database-schema)** — Four-table schema with CASCADE semantics (in this README)
- **[Streak Calculation & Timezone](#streak-calculation--timezone-handling)** — UTC "today" rules and examples (in this README)

---

## 🤝 Support & Contributing

### Reporting Issues
If you encounter bugs or have feature requests:
1. Check [Troubleshooting](#-troubleshooting) and [FAQ](#-frequently-asked-questions)
2. Search existing issues in the repository
3. Create a new issue with:
   - Steps to reproduce
   - Expected vs. actual behavior
   - Environment info (OS, Node version, Docker or local)

### Development Setup
1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make changes and test locally
4. Submit a pull request

### Code Style & Testing
- **TypeScript strict mode** — enforced via `npm run typecheck`
- **No external linters/formatters** — code clarity is the responsibility of authors and reviewers
- **Test coverage** — new backend features should include tests (see `backend/tests/`)
- **Follows CLAUDE.md hard rules** — treat as review blockers; see [Hard rules](./CLAUDE.md#hard-rules-real-bugs-in-prior-implementations--treat-as-review-blockers)

---

## 📝 License

MIT

---

## 🔗 Quick Links

| Resource | Link |
|----------|------|
| **Full Specification** | [docs/SPEC.md](./docs/SPEC.md) |
| **Project Guide** | [CLAUDE.md](./CLAUDE.md) |
| **Tech Stack** | [See above](#-tech-stack) |
| **Docker** | [DOCKER.md](./DOCKER.md) |
| **Report Issues** | [GitHub Issues](../../issues) |

