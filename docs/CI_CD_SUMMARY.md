# CI/CD Implementation Summary

This project now deploys to Azure Container Apps automatically via GitHub Actions. Every push to `main` (or a manual trigger) builds the backend and frontend Docker images, pushes them to Azure Container Registry, and deploys/updates the two Container Apps.

## New files

| File | Purpose |
|---|---|
| `.github/workflows/deploy-azure.yml` | GitHub Actions workflow. Triggers on `push: branches: [main]` and `workflow_dispatch`. Resolves `SESSION_SECRET`, installs the Azure CLI, runs `scripts/deploy-ci.sh`, then re-fetches and prints the deployed frontend URL. |
| `scripts/deploy-ci.sh` | Non-interactive deploy script. All inputs via env vars, `set -euo pipefail`, no prompts, no color. Idempotent (reuses existing Azure resources). |
| `docs/AZURE_SERVICE_PRINCIPAL.md` | How to create the Azure service principal GitHub Actions authenticates with, plus troubleshooting and secret-rotation. |
| `docs/SETUP_CI_CD.md` | End-to-end setup: clone → service principal → register secrets/variables → first deploy → OAuth redirect URIs → test → troubleshooting. |

## Modified files

| File | Change |
|---|---|
| `README.md` | Added a **🚀 Deploy to Azure (GitHub Actions)** quick-start section linking to `docs/SETUP_CI_CD.md`. |

## How it works

```
push to main  (or manual "Run workflow")
        |
        v
  GitHub Actions: deploy-azure.yml
        |
        |-- checkout code
        |-- resolve SESSION_SECRET (use provided, or openssl rand -hex 32)
        |-- install Azure CLI
        |-- run scripts/deploy-ci.sh   (with secrets + vars as env)
        |        |
        |        |-- validate 11 required env vars
        |        |-- az login (service principal)
        |        |-- ensure resource group
        |        |-- ensure ACR (Basic, admin-enabled)
        |        |-- az acr build  backend  (context = repo root)
        |        |-- ensure Container Apps Environment
        |        |-- create/update backend-app (ingress: internal)
        |        |-- wait, fetch backend internal FQDN
        |        |-- rewrite frontend/nginx.conf  (backend:3000 -> FQDN)
        |        |-- az acr build  frontend   (SINGLE build, post-rewrite)
        |        |-- create/update frontend-app (ingress: external)
        |        |-- wait, fetch frontend public FQDN
        |        |-- update backend-app FRONTEND_URL=https://<FQDN>
        |
        |-- re-login, fetch frontend FQDN
        |-- print deployment summary (success / failure)
        |
        v
  https://<frontend-FQDN>   (live)
```

## Secrets required (9, in GitHub repo settings)

- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `SESSION_SECRET` (optional — auto-generated if absent, but set it to keep sessions stable across deploys)

## Variables required (3, in GitHub repo settings)

- `AZURE_RESOURCE_GROUP`
- `AZURE_LOCATION`
- `AZURE_REGISTRY_LOGIN_SERVER`

## Manual vs automated

| Aspect | Manual (`deploy.sh`) | Automated (`deploy-ci.sh` + workflow) |
|---|---|---|
| Trigger | Run locally | Push to `main` or manual trigger |
| Inputs | CLI flags + interactive prompts | GitHub secrets/variables |
| Local deps | Azure CLI (Docker optional) | None (Azure CLI installed in CI; images built via `az acr build`) |
| Frontend builds | 2 (v1 + v2) | **1** (single build after nginx rewrite) |
| Best for | Learning the steps, one-off | Repeatable, auditable CI/CD |

Both produce the same Azure topology (ACR + Container Apps Environment + 2 Container Apps) and use the same Dockerfiles.

## Differences from the original plan

The plan's draft `deploy-ci.sh` had two defects that this implementation fixes:

1. **Double frontend build.** The draft built the frontend image once *before* the backend FQDN was known, then a second time *after* rewriting `nginx.conf`. Only the second build is deployed. This implementation builds the frontend **once**, after the rewrite.
2. **BSD `sed -i ''`.** The draft used `sed -i ''` (macOS syntax). GitHub runners are Ubuntu (GNU sed), where `sed -i ''` is interpreted as "in-place with an empty backup suffix" plus a literal `''` argument — breaking the rewrite. This implementation uses a portable temp-file + `mv`.

## Troubleshooting

See [SETUP_CI_CD.md → Troubleshooting](./SETUP_CI_CD.md#troubleshooting) for the common failure modes and fixes.
