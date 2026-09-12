# OAuth Setup Guide

This app supports **Google** and **GitHub** login. Credentials are configured in different places depending on environment:

| Environment | Where credentials go |
|---|---|
| Local dev | `.env` file |
| Azure (CI/CD) | GitHub Actions **secrets** → injected by `scripts/deploy-ci.sh` |

> **Not here:** [myaccount.google.com](https://myaccount.google.com) is your personal Google Account settings (password, privacy). OAuth Client IDs are created in **[Google Cloud Console](https://console.cloud.google.com)**.

---

## Credential formats (don't mix them up)

| Provider | Client ID looks like | GitHub secret name (CI) | `.env` name (local) |
|---|---|---|---|
| Google | `123456789-abc.apps.googleusercontent.com` | `GOOGLE_CLIENT_ID` | `GOOGLE_CLIENT_ID` |
| GitHub | `Ov23li…` or similar | `GH_OAUTH_CLIENT_ID` | `GITHUB_CLIENT_ID` |

GitHub forbids repository secrets named `GITHUB_*`, so CI stores GitHub OAuth credentials as `GH_OAUTH_CLIENT_ID` / `GH_OAUTH_CLIENT_SECRET`. The workflow maps them to the app's `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` env vars.

**Common mistake:** putting the GitHub Client ID (`Ov23…`) in `GOOGLE_CLIENT_ID`. Google then shows **“OAuth client was not found” / `401: invalid_client`**.

---

## Google OAuth Setup

1. Open **[Google Cloud Console](https://console.cloud.google.com/)** (not myaccount.google.com).
2. Create or select a **project**.
3. Configure the **OAuth consent screen** (APIs & Services → OAuth consent screen). For a demo, **External** + **Testing** mode is fine; add test users if not published.
4. Go to **APIs & Services** → **Credentials** → **Create Credentials** → **OAuth 2.0 Client ID**.
5. Application type: **Web application**.
6. Add **Authorized redirect URIs** (see table below).
7. Copy **Client ID** and **Client Secret**.

### Redirect URIs

| Environment | Authorized redirect URI |
|---|---|
| Local (Vite proxy) | `http://localhost:3000/api/auth/google/callback` |
| Docker Compose | `http://localhost:8080/api/auth/google/callback` if using port 8080, or match your `BACKEND_URL` |
| Azure | `https://<app-fqdn>/api/auth/google/callback` |

On Azure, `<app-fqdn>` is the Container App FQDN, e.g. `habit-tracker-app.salmonrock-7165d699.eastus.azurecontainerapps.io`. Get it after deploy:

```bash
az containerapp show \
  --name habit-tracker-app \
  --resource-group <RG> \
  --query 'properties.configuration.ingress.fqdn' -o tsv
```

---

## GitHub OAuth Setup

1. Go to **[GitHub Developer Settings](https://github.com/settings/developers)** → **OAuth Apps** → **New OAuth App** (or edit existing).
2. Fill in:
   - **Application name:** Habit Tracker
   - **Homepage URL:** your app URL (local: `http://localhost:5173`; Azure: `https://<app-fqdn>`)
   - **Authorization callback URL:** see table below
3. Copy **Client ID** and generate **Client Secret**.

### Callback URLs

| Environment | Authorization callback URL |
|---|---|
| Local | `http://localhost:3000/api/auth/github/callback` |
| Azure | `https://<app-fqdn>/api/auth/github/callback` |

---

## Local development (`.env`)

```bash
GOOGLE_CLIENT_ID=your_google_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your_google_client_secret
GITHUB_CLIENT_ID=your_github_client_id
GITHUB_CLIENT_SECRET=your_github_client_secret
SESSION_SECRET=<32+ random chars>
BACKEND_URL=http://localhost:3000
FRONTEND_URL=http://localhost:5173
```

Generate `SESSION_SECRET`:

```bash
openssl rand -hex 32
```

**Never commit `.env`** — it is in `.gitignore`.

Start the app: `npm run dev` → http://localhost:5173/login

---

## Azure production (GitHub Actions + Container Apps)

### 1. Register secrets in GitHub

Repo → **Settings** → **Secrets and variables** → **Actions**:

| Secret | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | From Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | From Google Cloud Console |
| `GH_OAUTH_CLIENT_ID` | From GitHub OAuth App |
| `GH_OAUTH_CLIENT_SECRET` | From GitHub OAuth App |
| `SESSION_SECRET` | `openssl rand -hex 32` (keeps sessions stable across redeploys) |

### 2. Deploy

```bash
bash scripts/refresh-azure-token.sh   # before CI deploy
bash scripts/deploy-ci.sh             # or push to main
```

The script sets on the **backend** container:

- `FRONTEND_URL=https://<app-fqdn>`
- `BACKEND_URL=https://<app-fqdn>`

OAuth callbacks use `BACKEND_URL` + `/api/auth/<provider>/callback` — the same public origin nginx proxies to the backend.

### 3. Register redirect URIs with Google and GitHub

Use the **exact** FQDN from deploy (printed as `FRONTEND_URL=…` in logs):

```
https://<app-fqdn>/api/auth/google/callback
https://<app-fqdn>/api/auth/github/callback
```

### 4. Verify deployed client IDs

After deploy, check what the live app sends (Google ID must end in `.apps.googleusercontent.com`):

```bash
curl -sS -D - -o /dev/null "https://<app-fqdn>/api/auth/google" | grep -i location
curl -sS -D - -o /dev/null "https://<app-fqdn>/api/auth/github" | grep -i location
```

If both show the same `client_id=Ov23…`, fix `GOOGLE_CLIENT_ID` in GitHub secrets and **redeploy**.

### 5. Demo Login on Azure

**Demo Login is disabled in production** (`NODE_ENV=production` → `POST /api/auth/demo-login` returns 404). Use Google or GitHub on the live URL.

---

## How OAuth works for all users

Your OAuth client ID/secret identify **your app** to Google/GitHub, not you personally. Each visitor signs in with **their own** Google/GitHub account; the backend creates a separate `users` row per person. Secrets stay on the server (Azure env vars / GitHub secrets), never in the browser.

---

## Troubleshooting

### Google: “OAuth client was not found” / `401: invalid_client`

- `GOOGLE_CLIENT_ID` in GitHub secrets is wrong (often the GitHub ID was pasted).
- Fix secrets, redeploy, verify redirect URL `client_id` as above.

### “Redirect URI mismatch”

- Callback URL in Google/GitHub must **exactly** match `https://<app-fqdn>/api/auth/<provider>/callback` (no trailing slash, `https` not `http`).

### Login succeeds but `/api/auth/me` stays 401

- Session cookie not set. Ensure the frontend image was built with `nginx.azure.conf` (`X-Forwarded-Proto: https`). Redeploy after pulling latest code.
- Check DevTools → Application → Cookies for `sessionId` on your app domain.

### Google consent screen: “Access blocked” (app in Testing)

- Add the user's Gmail as a **Test user** on the OAuth consent screen, or publish the app.

### Local: “Invalid Client”

- Verify Client ID/Secret in `.env`, restart backend after changes.

### Session issues (local)

- Sessions live in SQLite (`DATABASE_PATH`). Delete the DB file only if you intend to reset all data.

See also [SETUP_CI_CD.md](./SETUP_CI_CD.md) and [AZURE_INTERNAL_INGRESS_ISSUE.md](./AZURE_INTERNAL_INGRESS_ISSUE.md).
