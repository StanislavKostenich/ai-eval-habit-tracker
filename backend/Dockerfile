# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Backend — habit-tracker Fastify API (Node 20, ESM, better-sqlite3 native)
#
# BUILD CONTEXT: the repository ROOT (docker-compose sets build.context to "."
# and build.dockerfile to "backend/Dockerfile"). The whole workspace is needed
# because this is an npm workspaces monorepo:
#   - a single package-lock.json lives at the repo root (npm ci must run from
#     the root so the workspace is installed exactly as locked), and
#   - backend/tsconfig.json extends ../tsconfig.base.json, which only resolves
#     when the repo root is the build context.
#
# Multi-stage:
#   builder  — Node 20 + native build toolchain; installs the full workspace,
#              compiles backend TS -> backend/dist/, and builds the
#              better-sqlite3 native module against Node 20.
#   runtime  — Node 20 (slim); prod-only backend deps rebuilt fresh so the
#              native .node binary is compiled against the RUNTIME Node, plus
#              the compiled backend/dist/ and backend/drizzle/ migrations.
#
# The image is CWD-independent: `dist/db/migrate.js` resolves the migrations
# folder via `import.meta.url` (../../drizzle), so `drizzle/` just needs to sit
# in the workdir as a sibling of `dist/`. Migrations run idempotently at boot
# (src/index.ts -> runMigrations()) BEFORE the server starts, per SPEC §13.
# ---------------------------------------------------------------------------

# === Builder: install workspace + compile TypeScript + build native deps ===
FROM node:20-slim AS builder

WORKDIR /repo

# better-sqlite3 is a native module and needs a C++ toolchain to compile its
# .node binary. node:20-slim (Debian bookworm) does not ship gcc/make/python3,
# so install the build toolchain here. It is NOT copied into the runtime stage
# (the prod stage installs its own toolchain to rebuild the binary there).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        python3 \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Root manifest + workspace manifests + the single lockfile. (The .dockerignore
# at the repo root keeps node_modules, env files, and the data dir out of the
# context. NOTE: a per-workspace .dockerignore file does NOT apply when the
# context is the repo root — only the root .dockerignore does.)
COPY package.json package-lock.json tsconfig.base.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/

# Full workspace install (incl. dev deps) — dev deps provide `tsc`/typescript
# and the better-sqlite3 source that gets compiled for Node 20 in this stage.
RUN npm ci

# Backend sources (tsc reads ../tsconfig.base.json via extends).
COPY backend/tsconfig.json backend/
COPY backend/src backend/src

# tsc emits ESM to backend/dist (NodeNext, explicit .js specifiers).
RUN npm run build --workspace backend

# === Runtime: lean Node 20, prod-only, native module rebuilt ===
FROM node:20-slim AS runtime

# The runtime stage ALSO needs the native build toolchain: `npm install`
# rebuilds better-sqlite3 from source against the runtime's Node 20. Without a
# toolchain the build would fail. This is the critical native-module step —
# it guarantees the .node binary matches the Node major the app actually runs
# on. We deliberately do NOT copy node_modules out of the builder stage.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        python3 \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Non-root user for the running process.
RUN groupadd --system nodejs && useradd --system --gid nodejs nodejs

WORKDIR /app

ENV NODE_ENV=production

# Install ONLY the backend workspace's prod deps, compiled fresh against THIS
# stage's Node 20. npm workspaces require a root manifest listing the
# workspace, so we write a throwaway root package.json that declares the
# backend workspace alone (rather than COPY the real one, which also declares
# the frontend workspace and would drag its prod deps into the image).
COPY backend/package.json backend/
RUN printf '{"name":"habit-tracker","private":true,"workspaces":["backend"]}\n' > package.json \
    && npm install --omit=dev

# Compiled application (ESM) from the builder, and the drizzle migrations
# copied directly from the build context (they're static SQL, no build needed).
# `drizzle/` sits as a sibling of `dist/` under the workdir, exactly where
# `dist/db/migrate.js` expects it (`import.meta.url` + ../../drizzle).
COPY --from=builder /repo/backend/dist ./dist
COPY backend/drizzle ./drizzle

# The SQLite data directory (DATABASE_PATH=/data/habits.db) is a named volume
# in docker-compose. Create it and hand it to the non-root user so the app can
# write the DB (and the session store that shares the same file) at runtime.
RUN mkdir -p /data && chown -R nodejs:nodejs /data

USER nodejs

# Migrations run idempotently on boot inside dist/index.js before listen().
CMD ["node", "dist/index.js"]
