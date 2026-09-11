# Deploy Habit Tracker to Azure Container Apps

A step-by-step guide to deploy the habit tracker as a serverless demo on Azure Container Apps (ACA).

## Prerequisites

- **Azure subscription** with active credits
- **Azure CLI** installed (`az --version` to verify)
- **Docker** installed locally (for building images)
- **Git** (to tag commits, optional)
- **Google/GitHub OAuth apps** already set up with client IDs and secrets (see [CLAUDE.md](./CLAUDE.md) for setup)

## Overview

This deployment:
- Creates **one Azure Container Registry (ACR)** to hold Docker images
- Creates **one Container Apps Environment** (shared compute layer)
- Deploys **backend app** (Node.js + SQLite, internal network only)
- Deploys **frontend app** (nginx serving React, public HTTPS URL)
- Uses **ephemeral SQLite storage** (data resets on container restart — acceptable for demo)

End result: single public HTTPS URL for the demo, no VMs to manage, ~$0/month when idle (scale-to-zero).

## Step-by-Step (Manual + Script Option)

### Option A: Use the Bash Script (Recommended)

We've provided `deploy.sh` — a fully automated bash script that runs all the commands below.

```bash
cd habit-tracker
bash deploy.sh --resource-group my-rg --location eastus --registry myregistry
```

**Expected output**: the script will print the frontend public URL and next steps at the end.

See [Script Parameters](#script-parameters) below for all flags.

---

### Option B: Manual Step-by-Step

If you prefer to understand or control each step, follow these commands in order.

#### 1. Log in to Azure

```bash
az login
az account set --subscription <your-subscription-id>  # if you have multiple subscriptions
```

#### 2. Create a resource group

```bash
export RESOURCE_GROUP="habit-tracker-demo"
export LOCATION="eastus"
az group create --name $RESOURCE_GROUP --location $LOCATION
```

#### 3. Create Azure Container Registry

```bash
export REGISTRY_NAME="habittracker$(date +%s | tail -c 6)"  # unique name
az acr create \
  --resource-group $RESOURCE_GROUP \
  --name $REGISTRY_NAME \
  --sku Basic
```

#### 4. Build and push images to ACR

The `az acr build` command builds directly in Azure (no local Docker needed), but you can also build locally and push.

**Option A: Build in Azure (recommended, no Docker required locally)**

```bash
# Backend image
az acr build \
  --registry $REGISTRY_NAME \
  --image habit-tracker-backend:latest \
  --file backend/Dockerfile \
  .

# Frontend image
az acr build \
  --registry $REGISTRY_NAME \
  --image habit-tracker-frontend:latest \
  --file frontend/Dockerfile \
  .
```

**Option B: Build locally and push**

```bash
az acr login --name $REGISTRY_NAME

docker build -t habit-tracker-backend:latest -f backend/Dockerfile .
docker tag habit-tracker-backend:latest ${REGISTRY_NAME}.azurecr.io/habit-tracker-backend:latest
docker push ${REGISTRY_NAME}.azurecr.io/habit-tracker-backend:latest

docker build -t habit-tracker-frontend:latest -f frontend/Dockerfile .
docker tag habit-tracker-frontend:latest ${REGISTRY_NAME}.azurecr.io/habit-tracker-frontend:latest
docker push ${REGISTRY_NAME}.azurecr.io/habit-tracker-frontend:latest
```

#### 5. Create Container Apps Environment

```bash
export ENVIRONMENT_NAME="habit-tracker-env"
az containerapp env create \
  --name $ENVIRONMENT_NAME \
  --resource-group $RESOURCE_GROUP \
  --location $LOCATION
```

#### 6. Deploy backend Container App

First, generate a random 32-character session secret:

```bash
export SESSION_SECRET=$(openssl rand -hex 16)
echo "Session secret: $SESSION_SECRET (save this!)"

# If openssl not available, use:
# export SESSION_SECRET=$(python3 -c "import secrets; print(secrets.token_hex(16))")
```

Create the backend app. **Replace the placeholder values** with your actual OAuth credentials:

```bash
az containerapp create \
  --name backend-app \
  --resource-group $RESOURCE_GROUP \
  --environment $ENVIRONMENT_NAME \
  --image ${REGISTRY_NAME}.azurecr.io/habit-tracker-backend:latest \
  --target-port 3000 \
  --ingress internal \
  --registry-server ${REGISTRY_NAME}.azurecr.io \
  --env-vars \
    NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/data/habits.db \
    SESSION_SECRET=$SESSION_SECRET \
    GOOGLE_CLIENT_ID=<your-google-client-id> \
    GOOGLE_CLIENT_SECRET=<your-google-client-secret> \
    GITHUB_CLIENT_ID=<your-github-client-id> \
    GITHUB_CLIENT_SECRET=<your-github-client-secret> \
    FRONTEND_URL=https://placeholder-will-update-later.com
```

Wait for the deployment to complete (check via `az containerapp show --name backend-app --resource-group $RESOURCE_GROUP`).

#### 7. Get backend's internal FQDN

```bash
export BACKEND_FQDN=$(az containerapp show \
  --name backend-app \
  --resource-group $RESOURCE_GROUP \
  --query 'properties.configuration.ingress.fqdn' -o tsv)

echo "Backend internal FQDN: $BACKEND_FQDN"
```

This will look like `backend-app.internal.abc123.eastus.azurecontainerapps.io`.

#### 8. Update `frontend/nginx.conf`

Replace `http://backend:3000` with the backend's internal FQDN in two places:

```bash
sed -i.bak "s|http://backend:3000|http://$BACKEND_FQDN|g" frontend/nginx.conf
cat frontend/nginx.conf  # verify the changes
```

Or edit manually:
- Line 18: change `proxy_pass http://backend:3000;` to `proxy_pass http://$BACKEND_FQDN;`
- Line 26: same change

#### 9. Rebuild and push frontend image

```bash
# Option A: Build in Azure
az acr build \
  --registry $REGISTRY_NAME \
  --image habit-tracker-frontend:latest \
  --file frontend/Dockerfile \
  .

# Option B: Build locally
docker build -t ${REGISTRY_NAME}.azurecr.io/habit-tracker-frontend:latest -f frontend/Dockerfile .
docker push ${REGISTRY_NAME}.azurecr.io/habit-tracker-frontend:latest
```

#### 10. Deploy frontend Container App

```bash
az containerapp create \
  --name frontend-app \
  --resource-group $RESOURCE_GROUP \
  --environment $ENVIRONMENT_NAME \
  --image ${REGISTRY_NAME}.azurecr.io/habit-tracker-frontend:latest \
  --target-port 80 \
  --ingress external \
  --registry-server ${REGISTRY_NAME}.azurecr.io
```

#### 11. Get frontend's public FQDN

```bash
export FRONTEND_FQDN=$(az containerapp show \
  --name frontend-app \
  --resource-group $RESOURCE_GROUP \
  --query 'properties.configuration.ingress.fqdn' -o tsv)

echo "Frontend public URL: https://$FRONTEND_FQDN"
```

Save this URL — that's your demo link!

#### 12. Register OAuth redirect URIs

Before you can log in, register the frontend URL with Google and GitHub:

**Google Cloud Console:**
1. Go to https://console.cloud.google.com → APIs & Services → Credentials
2. Click on your OAuth 2.0 Client ID
3. Under "Authorized redirect URIs", add:
   ```
   https://<FRONTEND_FQDN>/api/auth/google/callback
   ```
4. Save

**GitHub:**
1. Go to https://github.com/settings/developers → OAuth Apps → your app
2. Update "Authorization callback URL" to:
   ```
   https://<FRONTEND_FQDN>/api/auth/github/callback
   ```
3. Save

#### 13. Update backend app with FRONTEND_URL

```bash
az containerapp update \
  --name backend-app \
  --resource-group $RESOURCE_GROUP \
  --set-env-vars FRONTEND_URL=https://$FRONTEND_FQDN
```

This redeploys the backend with the correct frontend URL for session redirects.

#### 14. Smoke test

Wait 30 seconds for the backend to restart, then:

```bash
# Test backend is reachable (should return 401 since not logged in)
curl -i https://$FRONTEND_FQDN/api/auth/me

# Open in browser
echo "Open this in your browser: https://$FRONTEND_FQDN"
```

Expected behavior:
- Page loads with login buttons
- Click "Continue with Google" or "Continue with GitHub"
- You're redirected to the OAuth provider
- After login, you land back on the dashboard
- Create a habit, check in, and watch the WebSocket connect (browser DevTools → Network → WS filter)

---

## Script Parameters

If using `deploy.sh`:

```bash
bash deploy.sh \
  --resource-group <name>      # Azure resource group (required)
  --location <region>          # Azure region, e.g., eastus, westus2 (required)
  --registry <name>            # ACR name, will auto-append timestamp if not provided
  --google-client-id <id>      # OAuth credentials (optional, will prompt if not provided)
  --google-client-secret <secret>
  --github-client-id <id>
  --github-client-secret <secret>
  --session-secret <secret>    # Will generate random if not provided
  --help                       # Show usage
```

Example:

```bash
bash deploy.sh \
  --resource-group my-demo-rg \
  --location eastus \
  --google-client-id abc123.apps.googleusercontent.com \
  --google-client-secret xyz789
  # Script will prompt for GitHub credentials
```

---

## Cleanup

To tear down the demo and stop incurring costs:

```bash
az group delete --name $RESOURCE_GROUP --yes
```

This deletes all Azure resources in the resource group (ACR, ACA environment, container apps).

---

## Troubleshooting

### Backend container crashes on startup

Check logs:

```bash
az containerapp logs show \
  --name backend-app \
  --resource-group $RESOURCE_GROUP \
  --follow
```

**Common issues:**
- Missing `SESSION_SECRET` (must be ≥32 chars)
- Missing or invalid OAuth credentials
- `FRONTEND_URL` not set correctly

### Frontend shows "502 Bad Gateway"

The backend app's internal FQDN in `nginx.conf` is wrong. Verify:

```bash
az containerapp show \
  --name backend-app \
  --resource-group $RESOURCE_GROUP \
  --query 'properties.configuration.ingress.fqdn'
```

Then check `frontend/nginx.conf` lines 18 and 26 match exactly.

### Login redirects to wrong URL or fails

Make sure the frontend's FQDN is:
1. Registered as an OAuth redirect URI on Google and GitHub (with `/api/auth/<provider>/callback` path)
2. Set as `FRONTEND_URL` env var on the backend app
3. Backend app has been restarted after the env var update

### WebSocket not connecting

Check browser DevTools → Network → WS tab. The connection URL should be:
```
wss://<FRONTEND_FQDN>/ws
```

(Note: `wss://` for secure WebSocket, not `ws://`.)

If the connection keeps reconnecting, check:
- Backend container logs (see above)
- `SESSION_SECRET` is set and consistent
- Session cookie is being sent (DevTools → Application → Cookies)

---

## Next Steps

- **For production**: mount Azure Files for persistent SQLite storage, set up a custom domain with TLS, add a CI/CD pipeline (GitHub Actions → ACR → ACA)
- **For more demos**: tag a new image revision in ACR and redeploy the container app
- **Cost monitoring**: set up Azure cost alerts for the subscription

---

## More Info

- [Azure Container Apps docs](https://learn.microsoft.com/en-us/azure/container-apps/)
- [CLAUDE.md](./CLAUDE.md) — tech stack, database schema, API routes
