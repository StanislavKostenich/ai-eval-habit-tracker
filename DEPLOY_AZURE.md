# Deploy Habit Tracker to Azure Container Apps

A guide to deploy the habit tracker on Azure Container Apps (ACA).

For **automated CI/CD**, prefer **[docs/SETUP_CI_CD.md](./docs/SETUP_CI_CD.md)**.

## Prerequisites

- **Azure subscription** with active credits
- **Azure CLI** (`az --version`)
- **Google/GitHub OAuth apps** — see [docs/OAUTH_SETUP.md](./docs/OAUTH_SETUP.md)
- Optional: **Docker** (images can be built in Azure via `az acr build`)

## Architecture

The deploy creates:

- **One Azure Container Registry (ACR)** — stores Docker images
- **One Container Apps Environment** — shared compute layer
- **One Container App (`habit-tracker-app`)** — two containers in one revision:
  - **frontend** — nginx on port 80 (external HTTPS ingress)
  - **backend** — Fastify on port 3000 (localhost only, no separate ingress)

nginx proxies `/api` and `/ws` to `127.0.0.1:3000` using `frontend/nginx.azure.conf`. This avoids a known ACA Consumption issue where **internal ingress between separate apps drops TCP** — see [docs/AZURE_INTERNAL_INGRESS_ISSUE.md](./docs/AZURE_INTERNAL_INGRESS_ISSUE.md).

**Storage:** ephemeral SQLite at `/data/habits.db` (resets on container restart — fine for demo).

**End result:** one public HTTPS URL, e.g. `https://habit-tracker-app.<env>.eastus.azurecontainerapps.io`.

---

## Option A: Automated script (recommended)

### CI/CD (GitHub Actions)

→ **[docs/SETUP_CI_CD.md](./docs/SETUP_CI_CD.md)**

### Local non-interactive

Set env vars (see `scripts/deploy-ci.sh` header), then:

```bash
bash scripts/deploy-ci.sh
```

---

## Option B: Interactive script

```bash
bash deploy.sh \
  --resource-group my-rg \
  --location eastus \
  --google-client-id "123.apps.googleusercontent.com" \
  --google-client-secret "..." \
  --github-client-id "Ov23..." \
  --github-client-secret "..."
```

The script:

1. Creates resource group + ACR (if missing)
2. Builds backend and frontend images (`az acr build`; frontend uses `NGINX_CONF=nginx.azure.conf`)
3. Creates/updates `habit-tracker-app` via `scripts/containerapp.yaml.tpl`
4. Sets OAuth env vars and `FRONTEND_URL` / `BACKEND_URL`
5. Deletes legacy `backend-app` / `frontend-app` if present

### Script parameters

```bash
bash deploy.sh \
  --resource-group <name>      # required
  --location <region>          # required, e.g. eastus
  --registry <name>            # optional ACR name
  --google-client-id <id>
  --google-client-secret <secret>
  --github-client-id <id>
  --github-client-secret <secret>
  --session-secret <secret>    # optional, auto-generated if omitted (≥32 chars)
  --help
```

---

## After deploy

### 1. Get the public URL

```bash
az containerapp show \
  --name habit-tracker-app \
  --resource-group <RG> \
  --query 'properties.configuration.ingress.fqdn' -o tsv
```

### 2. Register OAuth redirect URIs

Replace `<FQDN>` with the value above:

| Provider | Callback URL |
|---|---|
| Google | `https://<FQDN>/api/auth/google/callback` |
| GitHub | `https://<FQDN>/api/auth/github/callback` |

Details: [docs/OAUTH_SETUP.md](./docs/OAUTH_SETUP.md)

### 3. Smoke test

```bash
# Expected: 401 (not logged in)
curl -i "https://<FQDN>/api/auth/me"

# Expected: Set-Cookie on kickoff; client_id must be Google format for /google
curl -sS -D - -o /dev/null "https://<FQDN>/api/auth/google" | grep -iE 'set-cookie|location'
```

In the browser:

- Login page loads
- **Demo Login** returns 404 in production — use Google or GitHub
- After OAuth, dashboard loads and WebSocket connects (`wss://<FQDN>/ws`)

---

## Manual CLI (advanced)

If you need full control, mirror what `scripts/deploy-ci.sh` does:

1. Create resource group, ACR, Container Apps Environment
2. `az acr build` backend and frontend (`--build-arg NGINX_CONF=nginx.azure.conf` for frontend)
3. Render `scripts/containerapp.yaml.tpl` (substitute `__BACKEND_IMAGE__`, `__FRONTEND_IMAGE__`)
4. `az containerapp create` (bootstrap frontend-only) then `az containerapp update --yaml` for multi-container  
   — required because `create --yaml` hits an ARM Boolean null bug; see AZURE_INTERNAL_INGRESS_ISSUE.md
5. `az containerapp update --container-name backend --set-env-vars ...` for secrets and OAuth URLs

---

## Troubleshooting

### Backend crashes on startup

```bash
az containerapp logs show \
  --name habit-tracker-app \
  --resource-group <RG> \
  --container backend \
  --follow
```

Common causes: `SESSION_SECRET` under 32 chars, missing OAuth env vars.

### 504 on `/api/*`

See [docs/AZURE_INTERNAL_INGRESS_ISSUE.md](./docs/AZURE_INTERNAL_INGRESS_ISSUE.md). Ensure you deploy `habit-tracker-app` (multi-container), not separate internal backend app.

### Google: `invalid_client` / OAuth client not found

Wrong `GOOGLE_CLIENT_ID` — must be from Google Cloud Console (`.apps.googleusercontent.com`), not GitHub (`Ov23…`). Update GitHub secrets and redeploy.

### OAuth succeeds but session lost (401 on `/api/auth/me`)

Redeploy with current `nginx.azure.conf` (`X-Forwarded-Proto: https`). Without it, `@fastify/session` skips Secure cookies in production.

### WebSocket issues

URL should be `wss://<FQDN>/ws`. Check session cookie in DevTools → Application → Cookies.

---

## Cleanup

```bash
az group delete --name <RESOURCE_GROUP> --yes
```

---

## More info

- [docs/SETUP_CI_CD.md](./docs/SETUP_CI_CD.md) — GitHub Actions setup
- [docs/OAUTH_SETUP.md](./docs/OAUTH_SETUP.md) — OAuth credentials
- [docs/AZURE_INTERNAL_INGRESS_ISSUE.md](./docs/AZURE_INTERNAL_INGRESS_ISSUE.md) — ingress post-mortem
- [Azure Container Apps docs](https://learn.microsoft.com/en-us/azure/container-apps/)
- [CLAUDE.md](./CLAUDE.md) — stack, API, conventions
