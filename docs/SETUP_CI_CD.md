# Setting Up CI/CD for Automated Azure Deployment

This guide takes you from a fresh clone to a live habit-tracker deployment on Azure Container Apps, fully driven by GitHub Actions. No manual CLI commands are needed for the deploy itself — once secrets and variables are in place, every push to `main` (or a manual trigger) builds and deploys the app.

## What you'll set up

1. **Azure credentials via device-code login** — no service principal needed. You refresh a ~60-minute access token locally before each deploy.
2. **Six repository secrets** in GitHub (Azure token + OAuth credentials + session secret).
3. **Three repository variables** in GitHub (non-sensitive Azure topology).
4. A **first deployment** (manual trigger or push to `main`).
5. **OAuth redirect URIs** registered with Google and GitHub.

> **Auth model (device-code, no service principal):** GitHub Actions authenticates to Azure with a personal access token that you refresh in a browser before each deploy. This is the "demo" fallback for when you can't get an admin to create a service principal. The token expires in ~60 minutes, so you must run `bash scripts/refresh-azure-token.sh` and be present at deploy time. For a durable setup, prefer a service principal (Option A) — see [AZURE_SERVICE_PRINCIPAL.md](./AZURE_SERVICE_PRINCIPAL.md).

## Prerequisites

- A GitHub account with a repository (this one, or a fork).
- An Azure subscription with active credits, and an account that can sign in to it.
- **Azure CLI installed locally** (`az --version`) — needed to run the device-code login that produces the token.
- **`gh` CLI authenticated** (`gh auth status`) — needed to push the token to the GitHub secret.
- Google and GitHub OAuth apps already created (see `README.md` → OAuth Setup for how to create them).

---

## Step 1 — Clone the repository

```bash
git clone https://github.com/<your-username>/habit-tracker.git
cd habit-tracker
git remote -v   # verify the origin
```

(Or download the zip from the GitHub UI and extract it.)

## Step 2 — Refresh your Azure access token (device-code login)

You don't create a service principal. Instead, you produce a short-lived personal access token with the interactive device-code flow:

```bash
bash scripts/refresh-azure-token.sh
```

What happens:
1. `az login --use-device-code` prints a URL + code. Open the URL in a browser, sign in as your Azure account, and enter the code (you have ~5 minutes).
2. On success, the script captures the resulting access token (valid ~60 minutes).
3. It pushes the token to the `AZURE_ACCESS_TOKEN` GitHub repository secret via `gh api`.

> **Do this before every deploy.** The token expires in ~60 minutes. If you push to `main` to trigger a deploy, refresh the token first, then push.

**Prerequisites for this step:** `az` on PATH, `gh` authenticated, and a browser to complete the flow.

## Step 3 — Register secrets in GitHub

1. GitHub repo → **Settings** → **Secrets and variables** → **Actions**.
2. **New repository secret** for each of the six below:

> `AZURE_SUBSCRIPTION_ID` and `AZURE_TENANT_ID` are **not** secrets — they're hardcoded in `.github/workflows/deploy-azure.yml` (they're non-sensitive identifiers). The `refresh-azure-token.sh` script also hardcodes the tenant + subscription IDs.

| Secret name | Value |
|---|---|
| `AZURE_ACCESS_TOKEN` | Set automatically by `scripts/refresh-azure-token.sh` (a fresh token before each deploy). |
| `GOOGLE_CLIENT_ID` | From Google Cloud Console → Credentials |
| `GOOGLE_CLIENT_SECRET` | From Google Cloud Console → Credentials |
| `GH_OAUTH_CLIENT_ID` | From GitHub → Settings → Developer settings → OAuth Apps. (Stored under `GH_OAUTH_*` because GitHub forbids Actions secrets named `GITHUB_*`. The workflow maps it to the app's `GITHUB_CLIENT_ID`.) |
| `GH_OAUTH_CLIENT_SECRET` | Same source as above. Mapped to the app's `GITHUB_CLIENT_SECRET`. |
| `SESSION_SECRET` | A random 32+ character string. Generate: `openssl rand -hex 32` |

> **Note on `SESSION_SECRET`:** the app boot hard-fails without a 32+ char `SESSION_SECRET` (CLAUDE.md §3). The workflow auto-generates one if you don't set this secret, but setting it explicitly keeps sessions stable across redeploys (otherwise each deploy rotates the secret and invalidates logged-in sessions).

## Step 4 — Register variables in GitHub

Still in **Secrets and variables** → **Actions**, click **New repository variable** for each of the three below:

| Variable name | Example value | Notes |
|---|---|---|
| `AZURE_RESOURCE_GROUP` | `habit-tracker-demo` | Created automatically if missing. |
| `AZURE_LOCATION` | `eastus` | Any region where Container Apps + ACR are available. |
| `AZURE_REGISTRY_LOGIN_SERVER` | `habittracker12345.azurecr.io` | **Globally unique** ACR name + `.azurecr.io`. Lowercase alphanumeric, 5–50 chars for the name portion. Verify availability: `az acr check-name --name habittracker12345`. |

**Variable names are case-sensitive.** Use exactly the names above.

## Step 5 — Verify everything is registered

Back in **Settings** → **Secrets and variables** → **Actions**:
- **Repository secrets**: you should see all **6** secrets listed (including `AZURE_ACCESS_TOKEN`, which the refresh script populates).
- **Repository variables**: you should see all **3** variables listed.

If any are missing, add them now.

## Step 6 — Trigger the first deployment

> **Always refresh the token first.** Run `bash scripts/refresh-azure-token.sh` and complete the browser flow. The deploy then has to happen within ~60 minutes, while the token is still valid.

### Option A — Manual trigger (recommended for the first run)

1. Run `bash scripts/refresh-azure-token.sh` and complete the browser device-code flow.
2. GitHub repo → **Actions** tab.
3. Left sidebar → **Deploy to Azure Container Apps**.
4. Click **Run workflow** (top-right) → select `main` → **Run workflow**.
5. Optionally enter a `session_secret` (leave blank to auto-generate).
6. Watch the run live. First deploy takes **~5–10 minutes** (it creates the ACR, the Container Apps Environment, builds two multi-stage images, and provisions two Container Apps). Start it soon after refreshing so the token doesn't expire mid-run.

### Option B — Push to `main`

The workflow is also wired to `push: branches: [main]`, so any push to `main` deploys automatically:

```bash
bash scripts/refresh-azure-token.sh   # refresh the token first
git add .
git commit -m "initial"
git push origin main                  # triggers the deploy
```

Then watch the **Actions** tab. Push promptly after refreshing so the token is still valid when the run starts.

## Step 7 — Find your deployment URL

After the run completes:

1. **Actions** tab → click the completed run → the **Build & deploy to Azure** job.
2. The **Deployment summary (success)** step prints the frontend URL in the run summary.
3. Or, with your personal Azure credentials:

   ```bash
   az login
   az containerapp show \
     --name frontend-app \
     --resource-group <AZURE_RESOURCE_GROUP> \
     --query 'properties.configuration.ingress.fqdn' -o tsv
   ```

   Your app is at `https://<FQDN>`.

## Step 8 — Register OAuth redirect URIs

The deploy worked, but OAuth login won't until you register the frontend URL as a redirect URI with both providers.

### Google Cloud Console

1. https://console.cloud.google.com → **APIs & Services** → **Credentials**.
2. Open your **OAuth 2.0 Client ID** (web application).
3. Under **Authorized redirect URIs**, add:
   ```
   https://<your-frontend-fqdn>/api/auth/google/callback
   ```
4. **Save**.

### GitHub

1. https://github.com/settings/developers → **OAuth Apps** → your app.
2. Replace **Authorization callback URL** with:
   ```
   https://<your-frontend-fqdn>/api/auth/github/callback
   ```
3. **Update application**.

> The backend's `FRONTEND_URL` env var is already set to `https://<FQDN>` by `scripts/deploy-ci.sh`, so the OAuth flow will redirect back correctly once the redirect URIs are registered.

## Step 9 — Test the app

1. Open `https://<your-frontend-fqdn>` in a browser.
2. Click **Continue with Google** or **Continue with GitHub**.
3. You should be redirected to the provider's consent screen, then back to the app dashboard.
4. Create a habit, check it in, and verify streaks calculate.
5. Open DevTools → Network → filter by **WS** to confirm the WebSocket connects.

## Step 10 — (Optional) Auto-deploy on every push

Already on by default: the workflow triggers on `push: branches: [main]`. Any commit to `main` deploys. If you want to restrict that (e.g. only deploy tagged releases), edit the `on:` block in `.github/workflows/deploy-azure.yml`.

---

## Troubleshooting

### Workflow fails: "Required variables are not set"

`scripts/deploy-ci.sh` validates all 10 required env vars up front and lists exactly which are missing. Check that the corresponding GitHub secret/variable is:
- Named **exactly** (case-sensitive) as in this guide.
- Set at the **repository** level (not environment-level, unless your workflow targets that environment).

### Workflow fails: "AZURE_ACCESS_TOKEN expired" or "AuthorizationFailed" / 401

The access token you pushed has expired (it's valid ~60 minutes). This is the expected failure mode of the device-code demo flow:
1. Re-run `bash scripts/refresh-azure-token.sh` and complete the browser flow.
2. Re-run the workflow (Actions → the failed run → **Re-run all jobs**), or push to `main` again.

> For a durable, no-refresh setup, switch to a service principal (Option A): see [AZURE_SERVICE_PRINCIPAL.md](./AZURE_SERVICE_PRINCIPAL.md).

### Workflow fails: "Failed to retrieve backend FQDN"

The backend Container App hasn't fully started. This is usually transient — the script waits 15s after create, but a cold ACR + Container Apps Environment can take longer. **Re-run the workflow** after a couple of minutes; it's idempotent (reuses existing resources).

To inspect:
```bash
az containerapp show --name backend-app --resource-group <RG>
az containerapp logs show --name backend-app --resource-group <RG> --follow
```

### Frontend shows 502 Bad Gateway

The nginx proxy can't reach the backend. Causes:
- Backend not yet up (wait 2–3 min, refresh).
- `nginx.conf` rewrite didn't take (check the deploy log for the `nginx.conf now proxies to:` line).
- Backend is crashing on boot (check backend logs; most common cause is a `SESSION_SECRET` under 32 chars, which the script now rejects early).

### OAuth login fails ("redirect_uri_mismatch" or similar)

The redirect URI you registered doesn't exactly match what the backend sends. Both must be:
- `https://<frontend-fqdn>/api/auth/google/callback` (Google)
- `https://<frontend-fqdn>/api/auth/github/callback` (GitHub)

The `<frontend-fqdn>` must be the exact value from Step 7 (no trailing slash, no `http`).

### ACR name already taken

ACR names are globally unique across all of Azure. If `az acr check-name` reports the name as unavailable, pick a different one (e.g. add a random suffix) and update the `AZURE_REGISTRY_LOGIN_SERVER` variable.

---

## Manual deployment (alternative)

If you'd rather not use GitHub Actions, the existing interactive script does the same work with prompts:

```bash
bash deploy.sh --resource-group habit-tracker-demo --location eastus \
  --registry myacr --google-client-id ... --google-client-secret ... \
  --github-client-id ... --github-client-secret ...
```

See [DEPLOY_AZURE.md](../DEPLOY_AZURE.md) for the full manual walkthrough.

## Cleanup

To tear down everything and stop incurring costs:

```bash
az group delete --name <AZURE_RESOURCE_GROUP> --yes
```

This deletes the resource group, the ACR (and all images), the Container Apps Environment, and both Container Apps.

---

## Next steps

- **Staging + production:** parameterize `scripts/deploy-ci.sh` with an `ENVIRONMENT` suffix and run two workflows (or two `environment:` values) for staging and prod.
- **Approval gates:** attach required-reviewer rules to the `production` GitHub environment.
- **Monitoring:** enable ACA log streaming to Log Analytics; set alerts on container restarts.
- **Persistent storage:** mount an Azure Files volume at `/data` so SQLite survives container restarts (the current deploy uses ephemeral storage — data resets on restart).

See [CI_CD_SUMMARY.md](./CI_CD_SUMMARY.md) for an overview of what was added.
