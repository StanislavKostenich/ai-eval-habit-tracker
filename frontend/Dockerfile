# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Frontend — habit-tracker React/Vite SPA (Node 20 build, nginx runtime)
#
# BUILD CONTEXT: the repository ROOT (docker-compose sets build.context to "."
# and build.dockerfile to "frontend/Dockerfile"). The workspace root is needed
# because this is an npm workspaces monorepo with a single package-lock.json at
# the root (npm ci must run from the root).
#
# Multi-stage:
#   builder  — Node 20; installs the workspace, runs `npm run build` (tsc
#              typecheck + vite build) -> frontend/dist/ static assets.
#   runtime  — nginx:stable; serves frontend/dist/ and reverse-proxies /api and
#              /ws to the `backend` compose service (see frontend/nginx.conf).
#
# The frontend only ever issues RELATIVE requests (/api/..., ws://host/ws) so
# the same bundle works through the Vite dev proxy and through this nginx proxy
# without any code change (SPEC §9 / §13). No hardcoded backend origin.
# ---------------------------------------------------------------------------

# === Builder: install workspace + build the SPA (Node 20) ===
FROM node:20-slim AS builder

WORKDIR /repo

# Root manifest + workspace manifests + the single lockfile. (The .dockerignore
# at the repo root keeps node_modules and env files out of the context; a
# per-workspace .dockerignore does NOT apply when the context is the root.)
COPY package.json package-lock.json tsconfig.base.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/

# Full workspace install (dev deps include vite/typescript/tailwind).
RUN npm ci

# Frontend sources + build config (vite.config.ts, tailwind, postcss, tsconfig).
COPY frontend/ frontend/

# `npm run build` = `tsc --noEmit && vite build` -> frontend/dist/.
RUN npm run build --workspace frontend

# === Runtime: nginx serves the static build + proxies /api and /ws ===
FROM nginx:stable AS runtime

# Vite output -> nginx web root.
COPY --from=builder /repo/frontend/dist /usr/share/nginx/html

# SPA fallback + /api and /ws reverse proxy to the `backend` compose service.
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
