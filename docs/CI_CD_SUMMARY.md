# CI/CD Implementation Summary

This project deploys to Azure Container Apps automatically via GitHub Actions. Every push to `main` (or a manual trigger) builds the backend and frontend Docker images, pushes them to Azure Container Registry, and deploys/updates a **single multi-container Container App**.

## New files

| File | Purpose |
|---|---|
| `.github/workflows/deploy-azure.yml` | GitHub Actions workflow. Triggers on `push: branches: [main]` and `workflow_dispatch`. Runs `scripts/deploy-ci.sh`, then fetches the public app URL. |
| `scripts/deploy-ci.sh` | Non-interactive deploy script. All inputs via env vars, `set -euo pipefail`, idempotent. |
| `scripts/containerapp.yaml.tpl` | Multi-container ACA template (backend + frontend in one revision). |
| `frontend/nginx.azure.conf` | Azure nginx config: proxies `/api` and `/ws` to `127.0.0.1:3000`, sends `X-Forwarded-Proto: https` for session cookies. |
| `scripts/refresh-azure-token.sh` | Refreshes the ~60-min `AZURE_ACCESS_TOKEN` GitHub secret before each deploy. |
| `docs/AZURE_INTERNAL_INGRESS_ISSUE.md` | Post-mortem: ACA internal ingress TCP timeouts; why we use multi-container + localhost. |
| `docs/SETUP_CI_CD.md` | End-to-end setup guide. |
| `docs/OAUTH_SETUP.md` | OAuth credentials for local dev and Azure production. |

## Architecture (current)

```
https://habit-tracker-app.<env>.azurecontainerapps.io  (external ingress)
        |
        v
  Container App: habit-tracker-app
  +------------------+------------------+
  | frontend (nginx) | backend (Fastify)|
  | :80              | :3000            |
  +------------------+------------------+
        nginx --127.0.0.1:3000--> backend
```

Legacy separate apps (`backend-app` + `frontend-app` with internal ingress) are **deleted on deploy**. See [AZURE_INTERNAL_INGRESS_ISSUE.md](./AZURE_INTERNAL_INGRESS_ISSUE.md).

## How deploy works

```
push to main  (or manual "Run workflow")
        |
        v
  GitHub Actions: deploy-azure.yml
        |
        |-- checkout, resolve SESSION_SECRET
        |-- az login (device-code token)
        |-- scripts/deploy-ci.sh
        |        |-- validate env vars
        |        |-- ensure resource group + ACR
        |        |-- az acr build  backend
        |        |-- az acr build  frontend  (--build-arg NGINX_CONF=nginx.azure.conf)
        |        |-- ensure Container Apps Environment
        |        |-- create/update habit-tracker-app (multi-container YAML)
        |        |-- set backend OAuth env vars (GOOGLE_*, GITHUB_*, SESSION_SECRET)
        |        |-- set FRONTEND_URL + BACKEND_URL to public FQDN
        |        |-- delete legacy backend-app / frontend-app if present
        |
        v
  https://<app-FQDN>   (live)
```

## Secrets required (6, in GitHub repo settings)

| Secret | Source | Notes |
|---|---|---|
| `AZURE_ACCESS_TOKEN` | `scripts/refresh-azure-token.sh` | Expires ~60 min; refresh before each deploy |
| `GOOGLE_CLIENT_ID` | [Google Cloud Console](https://console.cloud.google.com) → Credentials | Must end in `.apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | Same | **Not** the GitHub client ID |
| `GH_OAUTH_CLIENT_ID` | GitHub → Developer settings → OAuth Apps | Usually starts with `Ov23` |
| `GH_OAUTH_CLIENT_SECRET` | Same | Mapped to `GITHUB_CLIENT_ID` in the workflow |
| `SESSION_SECRET` | `openssl rand -hex 32` | Optional in workflow (auto-generated); set explicitly to keep sessions across redeploys |

## Variables required (3)

- `AZURE_RESOURCE_GROUP`
- `AZURE_LOCATION`
- `AZURE_REGISTRY_LOGIN_SERVER`

## Manual vs automated

| Aspect | Manual (`deploy.sh`) | Automated (`deploy-ci.sh` + workflow) |
|---|---|---|
| Trigger | Run locally | Push to `main` or manual trigger |
| Inputs | CLI flags + prompts | GitHub secrets/variables |
| Topology | Same: one multi-container app | Same |
| Frontend nginx | `nginx.azure.conf` via build arg | Same |

Both use `scripts/containerapp.yaml.tpl` and produce the same Azure topology.

## Troubleshooting

See [SETUP_CI_CD.md → Troubleshooting](./SETUP_CI_CD.md#troubleshooting) and [OAUTH_SETUP.md → Azure production](./OAUTH_SETUP.md#azure-production-github-actions--container-apps).

Common issues after deploy:

- **504 Gateway Timeout** — fixed by multi-container deploy (see AZURE_INTERNAL_INGRESS_ISSUE.md).
- **401 on `/api/auth/me` before login** — expected when logged out.
- **Google `invalid_client` / OAuth client not found** — `GOOGLE_CLIENT_ID` is wrong (often GitHub ID pasted by mistake); redeploy after fixing secrets.
- **OAuth works at GitHub but session lost** — redeploy with `nginx.azure.conf` fix (`X-Forwarded-Proto: https`).
