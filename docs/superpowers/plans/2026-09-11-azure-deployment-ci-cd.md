# Azure Deployment CI/CD Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable automated deployment of the habit tracker to Azure Container Apps via GitHub Actions on push/PR/manual trigger, with full environment setup documentation for cloning and configuring a fresh instance.

**Architecture:** A GitHub Actions workflow monitors the main branch and manually-triggered deployments. On trigger, the workflow authenticates to Azure using a service principal, logs into ACR, builds and pushes images, and deploys to ACA using the same CLI commands as the manual `deploy.sh` script, but fully automated and parameterized. Setup documentation guides users to fork/clone the repo, configure Azure resources, and store credentials as GitHub secrets.

**Tech Stack:** GitHub Actions, Azure CLI, Docker, Azure Container Registry (ACR), Azure Container Apps (ACA), bash scripting.

**Spec:** Implements the deployment strategy defined in `DEPLOY_AZURE.md` with automation.

---

## Global Constraints

- GitHub Actions workflow must run only on main branch pushes and manual triggers
- All secrets stored in GitHub repository settings (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, etc.)
- Azure service principal credentials required (created once per Azure subscription)
- Workflow must be idempotent (can be re-run without data loss)
- Deployment target is the same Azure Container Apps infrastructure defined in `DEPLOY_AZURE.md`
- Documentation must be clear for users with zero prior GitHub Actions experience
- No hardcoded resource names—all parameterized via workflow inputs/secrets

---

## File Structure

```
habit-tracker/
├── .github/
│   └── workflows/
│       └── deploy-azure.yml          # GitHub Actions workflow for automated deployment
├── docs/
│   ├── SETUP_CI_CD.md               # Step-by-step guide for cloning and configuring CI/CD
│   └── AZURE_SERVICE_PRINCIPAL.md    # How to create Azure service principal for GitHub
├── DEPLOY_AZURE.md                   # (existing) Manual deployment guide
├── deploy.sh                          # (existing) Manual bash script
└── scripts/
    └── deploy-ci.sh                  # Helper script extracted from deploy.sh for CI use
```

**Responsibility breakdown:**
- **deploy-azure.yml**: GitHub Actions workflow that triggers on push/manual, calls Azure CLI commands
- **SETUP_CI_CD.md**: User-facing guide for forking repo, configuring secrets, and triggering first deploy
- **AZURE_SERVICE_PRINCIPAL.md**: Detailed walkthrough of creating an Azure service principal and registering with GitHub
- **deploy-ci.sh**: Non-interactive version of deploy.sh optimized for CI environments (stdin-free, strict error handling)

---

## Task Decomposition

### Task 1: Create Azure Service Principal setup documentation

**Files:**
- Create: `docs/AZURE_SERVICE_PRINCIPAL.md`

**Interfaces:**
- Consumes: Azure subscription ID, resource group pattern
- Produces: service principal ID, secret, Azure tenant ID (values users need to copy into GitHub)

**Steps:**

- [ ] **Step 1: Write documentation for creating an Azure service principal**

Create `docs/AZURE_SERVICE_PRINCIPAL.md` with:
- Prerequisites (Azure CLI, az login)
- Step-by-step `az ad sp create-for-rbac` command with explanation
- How to retrieve the JSON output (service principal credentials)
- How to interpret and store the JSON (appId, password, tenant, subscription)

```markdown
# Creating an Azure Service Principal for GitHub Actions

## What is a Service Principal?

A service principal is an Azure identity that GitHub Actions uses to authenticate and deploy to your Azure resources, without exposing your personal credentials.

## Prerequisites

- Azure CLI installed (`az --version`)
- Logged in to Azure: `az login`
- Correct subscription selected: `az account set --subscription <subscription-id>`

## Step 1: Create the service principal

Run this command:

\`\`\`bash
az ad sp create-for-rbac \
  --name "github-actions-habit-tracker" \
  --role Contributor \
  --scopes /subscriptions/$(az account show --query id -o tsv) \
  --json-auth
\`\`\`

**Output:** A JSON object with these fields:
- \`clientId\` (= appId) — Service principal ID
- \`clientSecret\` — The password (treat like a password!)
- \`subscriptionId\` — Your Azure subscription
- \`tenantId\` — Your Azure tenant

**Save this JSON somewhere safe.** You'll need it in the next steps.

## Step 2: Register with GitHub

1. Go to your GitHub repository → Settings → Secrets and variables → Actions
2. Create these secrets (one per field):
   - \`AZURE_CLIENT_ID\`: paste the \`clientId\` value
   - \`AZURE_CLIENT_SECRET\`: paste the \`clientSecret\` value
   - \`AZURE_TENANT_ID\`: paste the \`tenantId\` value
   - \`AZURE_SUBSCRIPTION_ID\`: paste the \`subscriptionId\` value

3. Create variables (non-secret, visible in logs):
   - \`AZURE_REGISTRY_LOGIN_SERVER\`: your ACR login server (e.g., \`myregistry.azurecr.io\`)
   - \`AZURE_RESOURCE_GROUP\`: your resource group name (e.g., \`habit-tracker-demo\`)
   - \`AZURE_LOCATION\`: Azure region (e.g., \`eastus\`)

## Troubleshooting

**"Insufficient privileges"**: The service principal needs \`Contributor\` role. Re-create with \`--role Contributor\`.

**"Invalid subscription"**: Run \`az account show\` to verify your subscription, then use its \`id\` in the \`--scopes\` argument.

**"Secret not recognized in GitHub Actions"**: Make sure the secret name is uppercase and matches exactly what the workflow expects.
\`\`\`

- [ ] **Step 2: Run test to verify documentation is complete**

Self-review: Does the doc cover:
- What a service principal is?
- How to create one with the exact command?
- How to extract the JSON output?
- How to register each value in GitHub as a secret?
- How to verify it works?

Expected: Yes to all. If missing, add the section.

- [ ] **Step 3: Commit**

```bash
git add docs/AZURE_SERVICE_PRINCIPAL.md
git commit -m "docs: add Azure service principal setup guide for GitHub Actions"
```

---

### Task 2: Create CI-optimized deployment script

**Files:**
- Create: `scripts/deploy-ci.sh`

**Interfaces:**
- Consumes: environment variables (AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_TENANT_ID, AZURE_SUBSCRIPTION_ID, AZURE_RESOURCE_GROUP, AZURE_LOCATION, AZURE_REGISTRY_LOGIN_SERVER, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, SESSION_SECRET, FRONTEND_URL)
- Produces: deployed Azure Container Apps, printed frontend URL to stdout

**Steps:**

- [ ] **Step 1: Extract and adapt deploy.sh for CI use**

Create `scripts/deploy-ci.sh` — a non-interactive version of `deploy.sh`:
- No prompts (all inputs via environment variables)
- Strict error handling (set -euo pipefail)
- No color output (simpler logs for CI)
- No confirmation prompt (CI should not block on user input)
- Log all key values (resource group, registry, etc.) for debugging

```bash
#!/bin/bash

set -euo pipefail

# CI-friendly deployment script
# All inputs via environment variables (no prompts, no user interaction)

# Require environment variables
required_vars=(
  "AZURE_CLIENT_ID"
  "AZURE_CLIENT_SECRET"
  "AZURE_TENANT_ID"
  "AZURE_SUBSCRIPTION_ID"
  "AZURE_RESOURCE_GROUP"
  "AZURE_LOCATION"
  "AZURE_REGISTRY_LOGIN_SERVER"
  "GOOGLE_CLIENT_ID"
  "GOOGLE_CLIENT_SECRET"
  "GITHUB_CLIENT_ID"
  "GITHUB_CLIENT_SECRET"
  "SESSION_SECRET"
)

echo "Checking required environment variables..."
for var in "${required_vars[@]}"; do
  if [[ -z "${!var:-}" ]]; then
    echo "Error: Required variable $var is not set"
    exit 1
  fi
done
echo "✓ All required variables are set"

# Extract registry name from login server
# Input: myregistry.azurecr.io
# Output: myregistry
AZURE_REGISTRY_NAME=$(echo "$AZURE_REGISTRY_LOGIN_SERVER" | cut -d. -f1)

echo "Deployment configuration:"
echo "  Resource Group:    $AZURE_RESOURCE_GROUP"
echo "  Location:          $AZURE_LOCATION"
echo "  Registry:          $AZURE_REGISTRY_NAME"
echo "  Registry Server:   $AZURE_REGISTRY_LOGIN_SERVER"

# Log in to Azure using service principal
echo "Authenticating to Azure..."
az login --service-principal \
  --username "$AZURE_CLIENT_ID" \
  --password "$AZURE_CLIENT_SECRET" \
  --tenant "$AZURE_TENANT_ID" \
  --output none

az account set --subscription "$AZURE_SUBSCRIPTION_ID"
echo "✓ Authenticated to Azure"

# Create resource group if it doesn't exist
echo "Ensuring resource group exists..."
if ! az group exists --name "$AZURE_RESOURCE_GROUP" --output tsv | grep -q "true"; then
  az group create \
    --name "$AZURE_RESOURCE_GROUP" \
    --location "$AZURE_LOCATION" \
    --output none
  echo "✓ Resource group created"
else
  echo "✓ Resource group already exists"
fi

# Create ACR if it doesn't exist
echo "Ensuring Azure Container Registry exists..."
if ! az acr show --resource-group "$AZURE_RESOURCE_GROUP" --name "$AZURE_REGISTRY_NAME" &> /dev/null; then
  az acr create \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --name "$AZURE_REGISTRY_NAME" \
    --sku Basic \
    --output none
  echo "✓ ACR created"
else
  echo "✓ ACR already exists"
fi

# Build and push images
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "Building backend image..."
az acr build \
  --registry "$AZURE_REGISTRY_NAME" \
  --image habit-tracker-backend:latest \
  --file backend/Dockerfile \
  "$SCRIPT_DIR" \
  --output none
echo "✓ Backend image built and pushed"

echo "Building frontend image..."
az acr build \
  --registry "$AZURE_REGISTRY_NAME" \
  --image habit-tracker-frontend:latest \
  --file frontend/Dockerfile \
  "$SCRIPT_DIR" \
  --output none
echo "✓ Frontend image built and pushed"

# Create Container Apps Environment
ENVIRONMENT_NAME="habit-tracker-env"
echo "Ensuring Container Apps Environment exists..."
if ! az containerapp env show --name "$ENVIRONMENT_NAME" --resource-group "$AZURE_RESOURCE_GROUP" &> /dev/null; then
  az containerapp env create \
    --name "$ENVIRONMENT_NAME" \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --location "$AZURE_LOCATION" \
    --output none
  echo "✓ Environment created"
  sleep 10  # Give environment time to fully initialize
else
  echo "✓ Environment already exists"
fi

# Deploy or update backend app
BACKEND_APP_NAME="backend-app"
echo "Deploying backend Container App..."

if az containerapp show --name "$BACKEND_APP_NAME" --resource-group "$AZURE_RESOURCE_GROUP" &> /dev/null; then
  az containerapp update \
    --name "$BACKEND_APP_NAME" \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --image "${AZURE_REGISTRY_LOGIN_SERVER}/habit-tracker-backend:latest" \
    --set-env-vars \
      NODE_ENV=production \
      PORT=3000 \
      DATABASE_PATH=/data/habits.db \
      SESSION_SECRET="$SESSION_SECRET" \
      GOOGLE_CLIENT_ID="$GOOGLE_CLIENT_ID" \
      GOOGLE_CLIENT_SECRET="$GOOGLE_CLIENT_SECRET" \
      GITHUB_CLIENT_ID="$GITHUB_CLIENT_ID" \
      GITHUB_CLIENT_SECRET="$GITHUB_CLIENT_SECRET" \
      FRONTEND_URL="https://placeholder.azurecontainerapps.io" \
    --output none
  echo "✓ Backend app updated"
else
  az containerapp create \
    --name "$BACKEND_APP_NAME" \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --environment "$ENVIRONMENT_NAME" \
    --image "${AZURE_REGISTRY_LOGIN_SERVER}/habit-tracker-backend:latest" \
    --target-port 3000 \
    --ingress internal \
    --registry-server "$AZURE_REGISTRY_LOGIN_SERVER" \
    --env-vars \
      NODE_ENV=production \
      PORT=3000 \
      DATABASE_PATH=/data/habits.db \
      SESSION_SECRET="$SESSION_SECRET" \
      GOOGLE_CLIENT_ID="$GOOGLE_CLIENT_ID" \
      GOOGLE_CLIENT_SECRET="$GOOGLE_CLIENT_SECRET" \
      GITHUB_CLIENT_ID="$GITHUB_CLIENT_ID" \
      GITHUB_CLIENT_SECRET="$GITHUB_CLIENT_SECRET" \
      FRONTEND_URL="https://placeholder.azurecontainerapps.io" \
    --output none
  echo "✓ Backend app created"
fi

# Wait and get backend FQDN
echo "Retrieving backend internal FQDN..."
sleep 10
BACKEND_FQDN=$(az containerapp show \
  --name "$BACKEND_APP_NAME" \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --query 'properties.configuration.ingress.fqdn' -o tsv)

if [[ -z "$BACKEND_FQDN" ]]; then
  echo "Error: Failed to retrieve backend FQDN"
  exit 1
fi

echo "Backend FQDN: $BACKEND_FQDN"

# Update frontend nginx.conf with backend FQDN
echo "Updating frontend nginx.conf..."
NGINX_CONF="$SCRIPT_DIR/frontend/nginx.conf"
if [[ ! -f "$NGINX_CONF" ]]; then
  echo "Error: nginx.conf not found"
  exit 1
fi

# Create backup and update
cp "$NGINX_CONF" "${NGINX_CONF}.backup"
sed -i '' "s|http://backend:3000|http://$BACKEND_FQDN|g" "$NGINX_CONF"

if grep -q "$BACKEND_FQDN" "$NGINX_CONF"; then
  echo "✓ nginx.conf updated"
else
  echo "Error: Failed to update nginx.conf"
  mv "${NGINX_CONF}.backup" "$NGINX_CONF"
  exit 1
fi

# Rebuild frontend with updated config
echo "Rebuilding frontend image with updated nginx.conf..."
az acr build \
  --registry "$AZURE_REGISTRY_NAME" \
  --image habit-tracker-frontend:latest \
  --file frontend/Dockerfile \
  "$SCRIPT_DIR" \
  --output none
echo "✓ Frontend image rebuilt"

# Deploy or update frontend app
FRONTEND_APP_NAME="frontend-app"
echo "Deploying frontend Container App..."

if az containerapp show --name "$FRONTEND_APP_NAME" --resource-group "$AZURE_RESOURCE_GROUP" &> /dev/null; then
  az containerapp update \
    --name "$FRONTEND_APP_NAME" \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --image "${AZURE_REGISTRY_LOGIN_SERVER}/habit-tracker-frontend:latest" \
    --output none
  echo "✓ Frontend app updated"
else
  az containerapp create \
    --name "$FRONTEND_APP_NAME" \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --environment "$ENVIRONMENT_NAME" \
    --image "${AZURE_REGISTRY_LOGIN_SERVER}/habit-tracker-frontend:latest" \
    --target-port 80 \
    --ingress external \
    --registry-server "$AZURE_REGISTRY_LOGIN_SERVER" \
    --output none
  echo "✓ Frontend app created"
fi

# Wait and get frontend FQDN
echo "Retrieving frontend public FQDN..."
sleep 10
FRONTEND_FQDN=$(az containerapp show \
  --name "$FRONTEND_APP_NAME" \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --query 'properties.configuration.ingress.fqdn' -o tsv)

if [[ -z "$FRONTEND_FQDN" ]]; then
  echo "Error: Failed to retrieve frontend FQDN"
  exit 1
fi

# Update backend with correct FRONTEND_URL
echo "Updating backend with correct FRONTEND_URL..."
az containerapp update \
  --name "$BACKEND_APP_NAME" \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --set-env-vars FRONTEND_URL="https://$FRONTEND_FQDN" \
  --output none
echo "✓ Backend updated with FRONTEND_URL"

# Success
echo ""
echo "✓ Deployment successful!"
echo ""
echo "Frontend URL: https://$FRONTEND_FQDN"
echo ""
echo "Next steps:"
echo "1. Register the frontend URL with Google and GitHub OAuth apps"
echo "2. Test login at https://$FRONTEND_FQDN"
```

- [ ] **Step 2: Make the script executable and test basic syntax**

```bash
chmod +x scripts/deploy-ci.sh
bash -n scripts/deploy-ci.sh  # Syntax check
```

Expected: No syntax errors.

- [ ] **Step 3: Commit**

```bash
git add scripts/deploy-ci.sh
git commit -m "feat: add CI-optimized deployment script for GitHub Actions"
```

---

### Task 3: Create GitHub Actions workflow

**Files:**
- Create: `.github/workflows/deploy-azure.yml`

**Interfaces:**
- Consumes: GitHub secrets (AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_TENANT_ID, AZURE_SUBSCRIPTION_ID, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, SESSION_SECRET), GitHub variables (AZURE_RESOURCE_GROUP, AZURE_LOCATION, AZURE_REGISTRY_LOGIN_SERVER)
- Produces: Deployed Azure Container Apps, workflow run visible in GitHub Actions tab

**Steps:**

- [ ] **Step 1: Create GitHub Actions workflow file**

Create `.github/workflows/deploy-azure.yml`:

```yaml
name: Deploy to Azure Container Apps

on:
  push:
    branches:
      - main
  workflow_dispatch:
    inputs:
      session_secret:
        description: 'Session secret (optional, generates random if blank)'
        required: false
        default: ''

permissions:
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Generate session secret if needed
        id: secrets
        run: |
          if [[ -z "${{ github.event.inputs.session_secret }}" ]]; then
            SESSION_SECRET=$(openssl rand -hex 16)
          else
            SESSION_SECRET="${{ github.event.inputs.session_secret }}"
          fi
          echo "session_secret=$SESSION_SECRET" >> $GITHUB_OUTPUT

      - name: Deploy to Azure
        env:
          AZURE_CLIENT_ID: ${{ secrets.AZURE_CLIENT_ID }}
          AZURE_CLIENT_SECRET: ${{ secrets.AZURE_CLIENT_SECRET }}
          AZURE_TENANT_ID: ${{ secrets.AZURE_TENANT_ID }}
          AZURE_SUBSCRIPTION_ID: ${{ secrets.AZURE_SUBSCRIPTION_ID }}
          AZURE_RESOURCE_GROUP: ${{ vars.AZURE_RESOURCE_GROUP }}
          AZURE_LOCATION: ${{ vars.AZURE_LOCATION }}
          AZURE_REGISTRY_LOGIN_SERVER: ${{ vars.AZURE_REGISTRY_LOGIN_SERVER }}
          GOOGLE_CLIENT_ID: ${{ secrets.GOOGLE_CLIENT_ID }}
          GOOGLE_CLIENT_SECRET: ${{ secrets.GOOGLE_CLIENT_SECRET }}
          GITHUB_CLIENT_ID: ${{ secrets.GITHUB_CLIENT_ID }}
          GITHUB_CLIENT_SECRET: ${{ secrets.GITHUB_CLIENT_SECRET }}
          SESSION_SECRET: ${{ steps.secrets.outputs.session_secret }}
        run: |
          curl -sL https://aka.ms/InstallAzureCLIDeb | bash
          bash scripts/deploy-ci.sh

      - name: Print deployment summary
        if: success()
        run: |
          echo "## ✅ Deployment Successful" >> $GITHUB_STEP_SUMMARY
          echo "Frontend URL will be available at:" >> $GITHUB_STEP_SUMMARY
          echo "\`\`\`" >> $GITHUB_STEP_SUMMARY
          echo "Check Azure Portal or run:" >> $GITHUB_STEP_SUMMARY
          echo "az containerapp show --name frontend-app --resource-group ${{ vars.AZURE_RESOURCE_GROUP }} --query 'properties.configuration.ingress.fqdn'" >> $GITHUB_STEP_SUMMARY
          echo "\`\`\`" >> $GITHUB_STEP_SUMMARY

      - name: Print deployment error
        if: failure()
        run: |
          echo "## ❌ Deployment Failed" >> $GITHUB_STEP_SUMMARY
          echo "Check the logs above for error details." >> $GITHUB_STEP_SUMMARY
          echo "Common issues:" >> $GITHUB_STEP_SUMMARY
          echo "- Missing or invalid Azure service principal credentials" >> $GITHUB_STEP_SUMMARY
          echo "- Missing GitHub secrets or variables" >> $GITHUB_STEP_SUMMARY
          echo "- Session secret too short (must be ≥32 chars)" >> $GITHUB_STEP_SUMMARY
```

**Key features:**
- Triggers on: push to main OR manual workflow_dispatch
- Requires all secrets and variables to be set
- Generates a random SESSION_SECRET if not provided manually
- Logs auth to Azure, builds images, deploys apps
- Posts deployment summary to GitHub Actions tab
- Uses `environment: production` to add additional protection/approval if desired

- [ ] **Step 2: Verify workflow syntax**

Check the file for valid YAML:

```bash
cd /Users/stanislav.kostenich/vscode/habit-tracker
python3 -m yaml < .github/workflows/deploy-azure.yml > /dev/null && echo "✓ Valid YAML" || echo "✗ Invalid YAML"
```

Expected: "✓ Valid YAML"

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/deploy-azure.yml
git commit -m "ci: add GitHub Actions workflow for automated Azure deployment

- Triggered on push to main or manual workflow_dispatch
- Logs into Azure via service principal
- Builds and pushes Docker images to ACR
- Deploys backend (internal) and frontend (external) Container Apps
- Auto-generates SESSION_SECRET if not provided
- Posts deployment summary and error details to Actions tab"
```

---

### Task 4: Create setup documentation for cloning and configuring

**Files:**
- Create: `docs/SETUP_CI_CD.md`

**Interfaces:**
- Consumes: GitHub repository URL, Azure subscription
- Produces: Cloned repository with CI/CD configured and ready to deploy

**Steps:**

- [ ] **Step 1: Write comprehensive CI/CD setup guide**

Create `docs/SETUP_CI_CD.md`:

```markdown
# Setting Up CI/CD for Automated Azure Deployment

This guide walks you through:
1. Cloning the habit tracker repository
2. Configuring Azure credentials for GitHub Actions
3. Setting up OAuth app callback URLs
4. Triggering your first automated deployment

## Prerequisites

- GitHub account with a repository (fork or your own)
- Azure subscription with active credits
- Azure CLI installed (`az --version`)

## Step 1: Clone the Repository

```bash
git clone https://github.com/YOUR_USERNAME/habit-tracker.git
cd habit-tracker
git remote -v  # Verify remotes
```

(Or download the zip file and extract it.)

## Step 2: Create an Azure Service Principal

GitHub Actions needs Azure credentials to deploy. You'll create a **service principal**—a special Azure identity just for CI/CD.

Follow the complete guide in [AZURE_SERVICE_PRINCIPAL.md](./AZURE_SERVICE_PRINCIPAL.md).

**Save the JSON output.** You'll need these values:
- \`clientId\`
- \`clientSecret\`
- \`subscriptionId\`
- \`tenantId\`

## Step 3: Register Secrets in GitHub

1. Go to your GitHub repository → **Settings** (top menu)
2. Left sidebar → **Secrets and variables** → **Actions**
3. Click **New repository secret** and add each:

| Secret Name | Value |
|---|---|
| \`AZURE_CLIENT_ID\` | clientId from service principal JSON |
| \`AZURE_CLIENT_SECRET\` | clientSecret from service principal JSON |
| \`AZURE_TENANT_ID\` | tenantId from service principal JSON |
| \`AZURE_SUBSCRIPTION_ID\` | subscriptionId from service principal JSON |
| \`GOOGLE_CLIENT_ID\` | From Google Cloud Console |
| \`GOOGLE_CLIENT_SECRET\` | From Google Cloud Console |
| \`GITHUB_CLIENT_ID\` | From GitHub OAuth Apps |
| \`GITHUB_CLIENT_SECRET\` | From GitHub OAuth Apps |
| \`SESSION_SECRET\` | A random 32+ character string (e.g., \`openssl rand -hex 32\`) |

## Step 4: Register Variables in GitHub

Still in **Secrets and variables** → **Actions**, click **New repository variable** for each:

| Variable Name | Example Value |
|---|---|
| \`AZURE_RESOURCE_GROUP\` | \`habit-tracker-demo\` |
| \`AZURE_LOCATION\` | \`eastus\` |
| \`AZURE_REGISTRY_LOGIN_SERVER\` | \`myregistry.azurecr.io\` |

**Note:** Variable names are case-sensitive. Use exactly the names shown above.

## Step 5: Verify Secrets and Variables Are Set

1. In GitHub, go to **Settings** → **Secrets and variables** → **Actions**
2. Under **Repository secrets**: You should see all 9 secrets listed
3. Under **Repository variables**: You should see all 3 variables listed

If any are missing, scroll down and click **New secret** or **New variable** to add them.

## Step 6: Trigger Your First Deployment

### Option A: Manual Trigger (Recommended First Time)

1. Go to your GitHub repo → **Actions** tab
2. Left sidebar: Click **Deploy to Azure Container Apps**
3. Click **Run workflow** button
4. Leave defaults, click **Run workflow**
5. Watch the workflow run in real-time (takes ~5-10 minutes)

### Option B: Automatic Trigger (On Every Push)

The workflow is configured to run automatically when you push to the \`main\` branch.

```bash
git add .
git commit -m "initial commit"
git push origin main
```

Then go to **Actions** tab to watch it deploy.

## Step 7: Find Your Deployment URL

After the workflow completes:

1. Go to **Actions** tab
2. Click the **Deploy to Azure Container Apps** run that just completed
3. Scroll down to see the deployment summary
4. Or, run this Azure CLI command:

\`\`\`bash
az login  # Use your personal Azure credentials
az containerapp show \
  --name frontend-app \
  --resource-group habit-tracker-demo \
  --query 'properties.configuration.ingress.fqdn' -o tsv
\`\`\`

Your app will be at: \`https://<FQDN>\`

## Step 8: Register OAuth Redirect URIs

The GitHub Actions workflow deployed your app, but OAuth login won't work yet. You need to register the frontend URL with Google and GitHub.

### Google Cloud Console

1. Go to https://console.cloud.google.com → **APIs & Services** → **Credentials**
2. Click on your OAuth 2.0 Client ID (web application)
3. Under **Authorized redirect URIs**, add:
   \`\`\`
   https://<your-frontend-fqdn>/api/auth/google/callback
   \`\`\`
4. Click **Save**

### GitHub

1. Go to https://github.com/settings/developers → **OAuth Apps** → your app
2. Under **Authorization callback URL**, replace with:
   \`\`\`
   https://<your-frontend-fqdn>/api/auth/github/callback
   \`\`\`
3. Click **Update application**

## Step 9: Test the App

1. Open \`https://<your-frontend-fqdn>\` in your browser
2. Click **Continue with Google** or **Continue with GitHub**
3. You should be redirected to the OAuth provider, then back to the app dashboard
4. Create a habit, check it in, verify streak calculation works
5. Open **DevTools** → **Network** → filter by **WS** to see WebSocket connection

## Step 10: Enable Auto-Deploy on Every Push (Optional)

By default, the workflow only runs on manual trigger. To auto-deploy on every push to main:

The workflow is already configured to trigger on push (see `.github/workflows/deploy-azure.yml`). Just push to main and it will automatically deploy:

\`\`\`bash
git add .
git commit -m "my changes"
git push origin main
\`\`\`

Check **Actions** tab to see it deploy automatically.

## Troubleshooting

### Workflow fails with "Missing required variable"

Make sure all 9 secrets and 3 variables are registered in GitHub:
- **Settings** → **Secrets and variables** → **Actions**
- Verify names match exactly (case-sensitive)

### Workflow fails with "Failed to retrieve backend FQDN"

The backend Container App didn't fully deploy. Check the workflow logs:
1. Go to **Actions** → the failed run
2. Click **Deploy to Azure** step
3. Scroll to see error messages
4. Common causes:
   - Invalid Azure credentials (check service principal is correct)
   - Azure region doesn't exist (use \`az account list-locations\`)
   - Resource group doesn't exist yet (workflow creates it automatically, but may need time)

**Solution:** Re-run the workflow after 2-3 minutes:

1. Go to **Actions** → the failed run
2. Click **Re-run all jobs**

### Frontend shows "502 Bad Gateway"

The nginx proxy can't reach the backend. This usually means the backend Container App hasn't fully started yet, or the internal FQDN is wrong.

**Solution:** Wait 2-3 minutes and refresh the browser. Container Apps can take time to start.

If it still fails, check backend logs:
\`\`\`bash
az containerapp logs show \
  --name backend-app \
  --resource-group habit-tracker-demo \
  --follow
\`\`\`

### OAuth login fails

Make sure you've registered the frontend URL as a redirect URI on both Google and GitHub (Step 8 above). The \`<your-frontend-fqdn>\` value must match exactly.

## Manual Deployment (Alternative)

If you prefer to deploy manually without GitHub Actions, use the existing script:

\`\`\`bash
bash deploy.sh --resource-group habit-tracker-demo --location eastus
\`\`\`

See [DEPLOY_AZURE.md](../DEPLOY_AZURE.md) for details.

## Next Steps

- **Scale up:** Modify \`scripts/deploy-ci.sh\` to deploy to multiple environments (staging, production)
- **Auto-approve:** Add approval gates via GitHub environment protection rules
- **Monitoring:** Set up Azure alerts for container app health
- **Persistent storage:** Mount Azure Files to keep SQLite data across restarts

## Cleanup

To remove all Azure resources and stop incurring costs:

\`\`\`bash
az group delete --name habit-tracker-demo --yes
\`\`\`

---

See [DEPLOY_AZURE.md](../DEPLOY_AZURE.md) for the manual deployment guide.
\`\`\`

- [ ] **Step 2: Review documentation for completeness**

Self-check: Does it cover:
- Prerequisites?
- Cloning the repo?
- Creating service principal?
- Registering secrets in GitHub?
- Triggering first deploy?
- Finding the deployment URL?
- Registering OAuth redirect URIs?
- Testing the app?
- Troubleshooting common issues?

Expected: Yes to all.

- [ ] **Step 3: Commit**

```bash
git add docs/SETUP_CI_CD.md
git commit -m "docs: add CI/CD setup guide for cloning and configuring GitHub Actions

Covers:
- Cloning the repository
- Creating Azure service principal for GitHub
- Registering secrets and variables in GitHub
- Triggering first deployment
- Finding the deployed app URL
- Registering OAuth redirect URIs
- Testing the app
- Troubleshooting common issues
- Manual deployment alternative"
```

---

### Task 5: Create GitHub repository template/README section for CI/CD

**Files:**
- Modify: `README.md` (add CI/CD section at top/bottom)

**Interfaces:**
- Consumes: Existing README content
- Produces: Updated README with CI/CD quick-start link

**Steps:**

- [ ] **Step 1: Read the existing README**

```bash
head -100 /Users/stanislav.kostenich/vscode/habit-tracker/README.md
```

- [ ] **Step 2: Add CI/CD quick-start section**

Edit `README.md` to add this section near the top (after intro, before local setup):

```markdown
## 🚀 Quick Start: Deploy to Azure (GitHub Actions)

New to the project? Want to deploy to Azure with automated CI/CD?

**[Follow the CI/CD Setup Guide](./docs/SETUP_CI_CD.md)** (5 minutes)

This will:
1. Fork/clone the repo
2. Set up Azure credentials
3. Deploy to Azure Container Apps automatically

No manual CLI commands needed — GitHub Actions handles everything.

---

## 📚 Other Deployment Options

- **Manual deployment:** [DEPLOY_AZURE.md](./DEPLOY_AZURE.md) — step-by-step with explanations
- **Local development:** See [Local Development](#local-development) below
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add CI/CD quick-start section to README"
```

---

### Task 6: Verify end-to-end workflow

**Files:**
- No new files

**Interfaces:**
- Consumes: All files from previous tasks
- Produces: Verified, working CI/CD pipeline (simulation without running on real Azure)

**Steps:**

- [ ] **Step 1: Verify all files exist and are in correct locations**

```bash
cd /Users/stanislav.kostenich/vscode/habit-tracker

files_to_check=(
  ".github/workflows/deploy-azure.yml"
  "scripts/deploy-ci.sh"
  "docs/AZURE_SERVICE_PRINCIPAL.md"
  "docs/SETUP_CI_CD.md"
)

for file in "${files_to_check[@]}"; do
  if [[ -f "$file" ]]; then
    echo "✓ $file"
  else
    echo "✗ $file MISSING"
  fi
done
```

Expected: All files exist.

- [ ] **Step 2: Verify GitHub Actions workflow syntax**

```bash
python3 -m yaml < .github/workflows/deploy-azure.yml > /dev/null && echo "✓ Valid YAML syntax"
```

Expected: "✓ Valid YAML syntax"

- [ ] **Step 3: Verify deploy-ci.sh is executable and has no syntax errors**

```bash
[[ -x scripts/deploy-ci.sh ]] && echo "✓ deploy-ci.sh is executable"
bash -n scripts/deploy-ci.sh && echo "✓ No bash syntax errors"
```

Expected: Both pass.

- [ ] **Step 4: Verify documentation links are correct**

Check that:
- `README.md` links to `docs/SETUP_CI_CD.md` ✓
- `SETUP_CI_CD.md` links to `AZURE_SERVICE_PRINCIPAL.md` ✓
- `SETUP_CI_CD.md` links to `DEPLOY_AZURE.md` ✓
- All links use relative paths (no absolute URLs) ✓

```bash
grep -l "SETUP_CI_CD.md" README.md > /dev/null && echo "✓ README links to SETUP_CI_CD.md"
grep -l "AZURE_SERVICE_PRINCIPAL.md" docs/SETUP_CI_CD.md > /dev/null && echo "✓ SETUP_CI_CD.md links to service principal doc"
```

- [ ] **Step 5: Create a summary document listing all new files**

Create `docs/CI_CD_SUMMARY.md`:

```markdown
# CI/CD Implementation Summary

## What Was Added

This project now has fully automated deployment to Azure Container Apps via GitHub Actions.

### New Files

1. **`.github/workflows/deploy-azure.yml`**
   - GitHub Actions workflow
   - Triggers on: push to main OR manual workflow_dispatch
   - Deploys backend and frontend Container Apps to Azure

2. **`scripts/deploy-ci.sh`**
   - Non-interactive deployment script optimized for CI
   - All inputs via environment variables (no prompts)
   - Called by the GitHub Actions workflow
   - Can also be used locally if needed

3. **`docs/AZURE_SERVICE_PRINCIPAL.md`**
   - Guide to creating an Azure service principal
   - Required for GitHub Actions to authenticate to Azure
   - Step-by-step with exact commands

4. **`docs/SETUP_CI_CD.md`**
   - Complete end-to-end setup guide
   - Covers: cloning repo → configuring secrets → triggering deploy
   - Includes troubleshooting for common issues

### Modified Files

1. **`README.md`**
   - Added quick-start section linking to CI/CD setup guide

## How It Works

```
User pushes to main
    ↓
GitHub detects push
    ↓
Workflow triggers (deploy-azure.yml)
    ↓
Workflow runs on GitHub runner:
  1. Check out code
  2. Generate SESSION_SECRET if needed
  3. Call scripts/deploy-ci.sh
  4. Post deployment summary
    ↓
scripts/deploy-ci.sh:
  1. Validate all env vars are set
  2. Log into Azure
  3. Create/update Azure resources
  4. Build Docker images
  5. Push to ACR
  6. Deploy Container Apps
  7. Update nginx.conf
  8. Restart apps
    ↓
Frontend is live at: https://<FQDN>
```

## Secrets Required (in GitHub)

9 repository secrets must be set in GitHub Settings:
- AZURE_CLIENT_ID
- AZURE_CLIENT_SECRET
- AZURE_TENANT_ID
- AZURE_SUBSCRIPTION_ID
- GOOGLE_CLIENT_ID
- GOOGLE_CLIENT_SECRET
- GITHUB_CLIENT_ID
- GITHUB_CLIENT_SECRET
- SESSION_SECRET

## Variables Required (in GitHub)

3 repository variables must be set:
- AZURE_RESOURCE_GROUP
- AZURE_LOCATION
- AZURE_REGISTRY_LOGIN_SERVER

## Getting Started

1. Fork or clone the repo
2. Follow [docs/SETUP_CI_CD.md](./SETUP_CI_CD.md)
3. Push to main (or manually trigger from Actions tab)
4. Workflow deploys your app automatically

## Manual vs. Automated Deployment

| Aspect | Manual (`deploy.sh`) | Automated (GitHub Actions) |
|---|---|---|
| Trigger | Run command locally | Push to main or manual trigger |
| User interaction | Prompts for missing values | Uses secrets/variables |
| Requires | Azure CLI installed locally | GitHub account + Azure subscription |
| Best for | Testing, understanding steps | Production CI/CD, repeatable deploys |

Both use the same underlying Docker images and Azure resources.

## Troubleshooting

See [docs/SETUP_CI_CD.md](./SETUP_CI_CD.md#troubleshooting) for common issues and fixes.
```

- [ ] **Step 6: Final commit with all CI/CD files**

```bash
git add docs/CI_CD_SUMMARY.md
git commit -m "docs: add CI/CD implementation summary"
```

---

## Self-Review Checklist

**Spec Coverage:**
- ✅ How to clone the app (SETUP_CI_CD.md Step 1)
- ✅ How to set up automated deployment (SETUP_CI_CD.md Steps 2-4)
- ✅ How to trigger deploys on push/manual (deploy-azure.yml triggers, SETUP_CI_CD.md Step 6)
- ✅ Step-by-step setup instructions (SETUP_CI_CD.md comprehensive)
- ✅ GitHub Actions workflow (deploy-azure.yml complete)
- ✅ Secrets/env var requirements (AZURE_SERVICE_PRINCIPAL.md, SETUP_CI_CD.md)

**Placeholder Check:**
- ✅ All code blocks shown in full (no "TBD", "fill in", "etc.")
- ✅ All CLI commands are complete and ready to run
- ✅ All file paths are exact and relative
- ✅ All secrets/variables named exactly

**Type/Interface Consistency:**
- ✅ Environment variables match between deploy-azure.yml and deploy-ci.sh
- ✅ Secret names consistent throughout docs
- ✅ Variable names consistent (case-sensitive)
- ✅ Script paths consistent (.github/workflows, scripts/, docs/)

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-11-azure-deployment-ci-cd.md`.

**Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach would you like?
