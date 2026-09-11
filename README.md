# 🎯 Habit Tracker with Streaks

[![Node.js](https://img.shields.io/badge/Node.js-22-green?style=flat-square)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue?style=flat-square)](https://www.typescriptlang.org)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED?style=flat-square)](./DOCKER.md)
[![Tests](https://img.shields.io/badge/Tests-49/49-brightgreen?style=flat-square)](./backend/tests)
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

- **Multi-user SSO** — Log in with Google or GitHub
- **Create & manage habits** — Add, edit, pause, and archive habits
- **Daily check-ins** — Track daily progress with status enforcement
- **Streak calculation** — Current streak, best streak, and total check-ins
- **Real-time notifications** — WebSocket-driven milestone alerts for 3, 7, and 30-day streaks
- **Search & filter** — Find habits by name and filter by status or completion
- **Responsive design** — Works on desktop and mobile
- **Automated tests** — Comprehensive test suite with 9 test scenarios

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
| **Auth**      | Passport.js (Google + GitHub strategies)    |
| **Sessions**  | `@fastify/session` + `connect-sqlite3`      |
| **WebSocket** | `@fastify/websocket`                        |
| **Frontend**  | React 18 + Vite                             |
| **UI**        | Tailwind CSS + shadcn/ui                    |
| **State**     | TanStack Query v5                           |
| **Testing**   | Vitest + Supertest                          |

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

| Variable              | Description                                         | Example                        |
|-----------------------|-----------------------------------------------------|--------------------------------|
| `GOOGLE_CLIENT_ID`    | Google OAuth 2.0 Client ID                          | `abc123.apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | Google OAuth 2.0 Client Secret                      | `secret_key_xyz`              |
| `GITHUB_CLIENT_ID`    | GitHub OAuth App Client ID                          | `abc123xyz`                   |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth App Client Secret                      | `secret_key_xyz`              |
| `SESSION_SECRET`      | Secret for session encryption (32+ random chars)    | see below                     |
| `DATABASE_PATH`       | SQLite database file location                       | `./data/habits.db`            |
| `PORT`                | Backend server port                                 | `3000`                        |
| `FRONTEND_URL`        | Frontend URL for CORS and redirects                 | `http://localhost:5173`       |

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
6. Add **Authorized redirect URI**: `http://localhost:3000/api/auth/google/callback`
7. Copy **Client ID** and **Client Secret** to your `.env` file

### GitHub OAuth Setup

1. Go to [GitHub Developer Settings](https://github.com/settings/developers)
2. Click **OAuth Apps** → **New OAuth App**
3. Fill in the form:
   - **Application name**: Habit Tracker
   - **Homepage URL**: `http://localhost:5173`
   - **Authorization callback URL**: `http://localhost:3000/api/auth/github/callback`
4. Copy **Client ID** and **Client Secret** to your `.env` file

---

## 🗄️ Database Schema

Run all 49 automated tests:

```bash
cd backend
npm test
```

**Test Coverage:**
- **T1**: SSO login (Google/GitHub, session creation)
- **T2**: Create and retrieve habits (CRUD operations)
- **T3**: Duplicate check-in prevention (409 status)
- **T4**: Future-date and status validation (422 errors)
- **T5**: User ownership enforcement (403 on unauthorized access)
- **T6–T8**: Milestone notifications (3, 7, 30-day streaks)
- **T9**: Milestone de-duplication after reconnect
- **Streaks**: Current, best, and total check-in calculations

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
│   │   │   ├── schema.ts        # Drizzle ORM table definitions
│   │   │   ├── migrate.ts       # Database migrations
│   │   │   └── seed.ts          # Sample data seeding
│   │   ├── routes/
│   │   │   ├── auth.ts          # Authentication routes (Google, GitHub, logout, /me)
│   │   │   ├── habits.ts        # Habit CRUD operations
│   │   │   └── checkins.ts      # Check-in routes
│   │   ├── ws/
│   │   │   └── handler.ts       # WebSocket handler + milestone engine
│   │   ├── utils/
│   │   │   └── streaks.ts       # Pure streak calculation function
│   │   ├── middleware/
│   │   │   └── requireAuth.ts   # Session authentication guard
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
    │   │   ├── HabitCard.tsx      # Habit card with streak display
    │   │   ├── HabitModal.tsx     # Create/edit habit modal
    │   │   ├── NotificationPanel.tsx  # Real-time milestone notifications
    │   │   └── Calendar.tsx       # Monthly calendar view
    │   ├── pages/
    │   │   ├── LoginPage.tsx      # OAuth login page
    │   │   ├── DashboardPage.tsx  # Habit list + search/filter
    │   │   └── HabitDetailPage.tsx # Single habit detail + calendar
    │   ├── hooks/
    │   │   ├── useHabits.ts       # Habit data fetching with TanStack Query
    │   │   ├── useCheckin.ts      # Check-in mutations
    │   │   └── useWebSocket.ts    # WebSocket connection + milestone listener
    │   ├── main.tsx               # React app entry point
    │   └── index.css              # Tailwind CSS imports
    └── package.json
```

## API Overview

All API routes are prefixed with `/api`. Authentication required except for `/api/auth/*`.

### Authentication Routes

- `GET /api/auth/google` — Redirect to Google OAuth consent
- `GET /api/auth/google/callback` — OAuth callback (auto-create user)
- `GET /api/auth/github` — Redirect to GitHub OAuth consent
- `GET /api/auth/github/callback` — OAuth callback (auto-create user)
- `POST /api/auth/logout` — Destroy session
- `GET /api/auth/me` — Get current user profile

### Habits Routes

- `GET /api/habits` — List habits (filter by status, search, completion)
- `POST /api/habits` — Create habit
- `GET /api/habits/:id` — Get habit with streak stats
- `PATCH /api/habits/:id` — Update habit (including status: `active`, `paused`, `archived`)
- `DELETE /api/habits/:id` — **Hard delete** (removes habit + all check-ins + milestones; cannot be undone)

### Check-in Routes

- `GET /api/habits/:id/checkins?month=YYYY-MM` — List check-ins for month
- `POST /api/habits/:id/checkins` — Create check-in for date
- `DELETE /api/habits/:id/checkins/:date` — Delete check-in (must be today)

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
provider TEXT NOT NULL             -- 'google' | 'github'
provider_user_id TEXT NOT NULL
email TEXT
display_name TEXT NOT NULL
avatar_url TEXT
created_at INTEGER NOT NULL
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

## 🧪 Running Tests

- [x] Multi-user SSO (Google, GitHub)
- [x] Create, edit, pause, archive habits
- [x] Daily check-ins with status enforcement
- [x] Streak tracking (current, best, total check-ins)
- [x] Real-time milestone notifications (3, 7, 30 days via WebSocket)
- [x] Search and filter habits by name and status
- [x] Responsive mobile-friendly design
- [x] Automated test suite (9 test scenarios + cascade deletion tests)
- [x] Type-safe TypeScript throughout
- [x] Authorization: user ownership enforced on all resources

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

# Run migrations to create schema
npm run db:migrate

# Seed sample data (1 user, 3 habits, check-ins)
npm run db:seed

# Reset and rebuild database
npm run db:reset
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

### Debug Logging
```bash
# Backend with debug logs
DEBUG=habit-tracker:* npm run dev -w backend

# Frontend with debug logs
DEBUG=habit-tracker:* npm run dev -w frontend
```

### Reset Everything
```bash
# Delete database and sessions
rm -rf backend/data

# Reinstall dependencies and reseed
cd backend && npm run db:migrate && npm run db:seed
```

---

## 📖 Documentation

### Getting Started
- **[README.md](./README.md)** — Quick start, API overview, and business rules (you are here)
- **[CLAUDE.md](./CLAUDE.md)** — Full project specification and requirements
- **[DOCKER.md](./DOCKER.md)** — Complete Docker setup, commands, and troubleshooting

### Setup & Configuration
- **[docs/OAUTH_SETUP.md](./docs/OAUTH_SETUP.md)** — Step-by-step Google and GitHub OAuth setup
- **[docs/SECURITY.md](./docs/SECURITY.md)** — Security hardening and best practices
- **[docs/SETUP_CI_CD.md](./docs/SETUP_CI_CD.md)** — Automated Azure deployment via GitHub Actions
- **[docs/AZURE_SERVICE_PRINCIPAL.md](./docs/AZURE_SERVICE_PRINCIPAL.md)** — Creating the Azure CI/CD identity
- **[docs/CI_CD_SUMMARY.md](./docs/CI_CD_SUMMARY.md)** — Overview of the CI/CD implementation

### Verification & Testing
- **[docs/ACCEPTANCE_VERIFIED.md](./docs/ACCEPTANCE_VERIFIED.md)** — Acceptance criteria checklist (14/14 ✅)
- **[docs/E2E_TESTS.md](./docs/E2E_TESTS.md)** — End-to-end test documentation and results

### Learning & Future Development
- **[docs/lessons-learned.md](./docs/lessons-learned.md)** — 17 key insights from building the MVP
- **[docs/recommendations.md](./docs/recommendations.md)** — Actionable guidance for next projects and features

### API Reference
- **[API Overview](#api-overview)** — REST API endpoint reference (in this README)

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

### Code Style
- TypeScript with strict mode enabled
- ESLint configuration in workspace
- Consistent formatting via Prettier (if configured)
- Test coverage: new features should include tests

---

## 📝 License

MIT

---

## 🔗 Links

| Resource | Link |
|----------|------|
| GitHub Issues | [Report bugs or request features](../../issues) |
| Docker Documentation | [DOCKER.md](./DOCKER.md) |
| Project Spec | [CLAUDE.md](./CLAUDE.md) |
| Tech Stack | [See above](#-tech-stack)

