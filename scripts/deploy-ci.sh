#!/usr/bin/env bash

set -euo pipefail

# ---------------------------------------------------------------------------
# CI-optimized deployment script for the habit tracker.
#
# This is a non-interactive, stdin-free version of ../deploy.sh intended for
# GitHub Actions (and any other CI environment). All inputs arrive via
# environment variables; there are no prompts, no confirmation steps, and no
# ANSI color. It hard-fails (set -euo pipefail) on any error.
#
# Differences from deploy.sh (the manual, interactive script):
#   1. No prompts — every input is an env var (required ones are validated).
#   2. No confirmation prompt — CI must not block on user input.
#   3. No color — plain stdout for log readability.
#   4. Single frontend image build — the frontend is built ONCE, after
#      frontend/nginx.conf is rewritten with the real backend FQDN. The
#      manual script builds the frontend twice (v1 before the FQDN is known,
#      v2 after); that first build is wasted work and is dropped here.
#   5. Portable in-place sed — uses a temp file + mv instead of `sed -i ''`
#      (which is BSD/macOS-specific and misbehaves on GNU/Linux GitHub runners).
#   6. No local Docker dependency — all image builds go through `az acr build`
#      (Azure's managed build service), so no local Docker daemon is needed.
#
# AUTH:
#   This script does NOT authenticate on its own. In CI, the GitHub Actions
#   workflow authenticates via the `azure/login@v2` action (OIDC federation,
#   no secrets, no manual token refresh). When running locally, authenticate
#   first with `az login`.
#
# Required environment variables (all must be non-empty):
#   AZURE_TENANT_ID              Azure tenant ID
#   AZURE_SUBSCRIPTION_ID        Azure subscription ID
#   AZURE_RESOURCE_GROUP         Target resource group (created if missing)
#   AZURE_LOCATION               Azure region (e.g. eastus)
#   AZURE_REGISTRY_LOGIN_SERVER  ACR login server (e.g. myacr.azurecr.io)
#   GOOGLE_CLIENT_ID             Google OAuth client ID
#   GOOGLE_CLIENT_SECRET         Google OAuth client secret
#   GITHUB_CLIENT_ID             GitHub OAuth client ID
#   GITHUB_CLIENT_SECRET         GitHub OAuth client secret
#   SESSION_SECRET               32+ char session secret (see CLAUDE.md §3)
#
# Output: a deployed pair of Container Apps (backend internal, frontend
# external) and the public frontend URL printed to stdout.
# ---------------------------------------------------------------------------

# --- 0. Validate required environment variables ---------------------------

REQUIRED_VARS=(
  AZURE_TENANT_ID
  AZURE_SUBSCRIPTION_ID
  AZURE_RESOURCE_GROUP
  AZURE_LOCATION
  AZURE_REGISTRY_LOGIN_SERVER
  GOOGLE_CLIENT_ID
  GOOGLE_CLIENT_SECRET
  GITHUB_CLIENT_ID
  GITHUB_CLIENT_SECRET
  SESSION_SECRET
)

echo "==> Validating required environment variables"
MISSING=()
for var in "${REQUIRED_VARS[@]}"; do
  if [[ -z "${!var:-}" ]]; then
    MISSING+=("$var")
  fi
done
if (( ${#MISSING[@]} > 0 )); then
  echo "ERROR: The following required variables are not set:"
  for var in "${MISSING[@]}"; do
    echo "  - $var"
  done
  exit 1
fi
echo "    All ${#REQUIRED_VARS[@]} required variables are set."

# Session secret must be at least 32 chars (CLAUDE.md §3 — boot hard-fails
# below this, so fail early here with a clear message).
if (( ${#SESSION_SECRET} < 32 )); then
  echo "ERROR: SESSION_SECRET must be at least 32 characters (got ${#SESSION_SECRET})."
  exit 1
fi

# --- 1. Derive names and print configuration ------------------------------

# ACR name from the login server: myacr.azurecr.io -> myacr
AZURE_REGISTRY_NAME="${AZURE_REGISTRY_LOGIN_SERVER%%.*}"

BACKEND_APP_NAME="backend-app"
FRONTEND_APP_NAME="frontend-app"
ENVIRONMENT_NAME="habit-tracker-env"

# Repository root: this script lives in scripts/, so the parent is the root.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo ""
echo "==> Deployment configuration"
echo "    Resource Group:     $AZURE_RESOURCE_GROUP"
echo "    Location:           $AZURE_LOCATION"
echo "    ACR Name:           $AZURE_REGISTRY_NAME"
echo "    ACR Login Server:   $AZURE_REGISTRY_LOGIN_SERVER"
echo "    Backend App:        $BACKEND_APP_NAME"
echo "    Frontend App:       $FRONTEND_APP_NAME"
echo "    Environment:        $ENVIRONMENT_NAME"
echo "    Repo Root:          $SCRIPT_DIR"

# --- 2. Ensure the resource group exists ----------------------------------
# Authentication is handled upstream: in CI by the `azure/login@v2` action
# (OIDC federation), locally by `az login`. The Azure CLI is already
# authenticated when this script runs.

echo ""
echo "==> Ensuring resource group '$AZURE_RESOURCE_GROUP' exists"
if az group exists --name "$AZURE_RESOURCE_GROUP" --output tsv | grep -q "true"; then
  echo "    Resource group already exists."
else
  az group create \
    --name "$AZURE_RESOURCE_GROUP" \
    --location "$AZURE_LOCATION" \
    --output none
  echo "    Resource group created."
fi

# --- 3. Ensure the Azure Container Registry exists ------------------------

echo ""
echo "==> Ensuring ACR '$AZURE_REGISTRY_NAME' exists"
if az acr show \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --name "$AZURE_REGISTRY_NAME" \
    --output none 2>/dev/null; then
  echo "    ACR already exists."
else
  echo "    Creating ACR (Basic SKU). This can take a few minutes."
  az acr create \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --name "$AZURE_REGISTRY_NAME" \
    --sku Basic \
    --admin-enabled true \
    --output none
  echo "    ACR created."
fi

# --- 4. Build and push the backend image ----------------------------------
# The build context is the repository root (npm workspaces monorepo; the
# Dockerfile expects to find package.json, package-lock.json, and
# tsconfig.base.json at the root). `az acr build` runs the build in Azure,
# so no local Docker daemon is required.

echo ""
echo "==> Building backend image (az acr build)"
az acr build \
  --registry "$AZURE_REGISTRY_NAME" \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --image habit-tracker-backend:latest \
  --file backend/Dockerfile \
  "$SCRIPT_DIR" \
  --output none
echo "    Backend image built and pushed."

# --- 5. Ensure the Container Apps Environment exists ----------------------

echo ""
echo "==> Ensuring Container Apps Environment '$ENVIRONMENT_NAME' exists"
if az containerapp env show \
    --name "$ENVIRONMENT_NAME" \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --output none 2>/dev/null; then
  echo "    Environment already exists."
else
  az containerapp env create \
    --name "$ENVIRONMENT_NAME" \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --location "$AZURE_LOCATION" \
    --output none
  echo "    Environment created. Waiting for it to become ready..."
  sleep 15
fi

# --- 6. Deploy (or update) the backend Container App ----------------------
# Ingress is internal: the frontend nginx proxies /api and /ws to it.
# FRONTEND_URL is set to a placeholder now and corrected in step 11 once the
# frontend's public FQDN is known (used for OAuth redirect back-URLs and CORS).

BACKEND_IMAGE="${AZURE_REGISTRY_LOGIN_SERVER}/habit-tracker-backend:latest"

echo ""
echo "==> Deploying backend Container App ($BACKEND_APP_NAME)"
if az containerapp show \
    --name "$BACKEND_APP_NAME" \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --output none 2>/dev/null; then
  az containerapp update \
    --name "$BACKEND_APP_NAME" \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --image "$BACKEND_IMAGE" \
    --min-replicas 1 \
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
  echo "    Backend app updated."
else
  az containerapp create \
    --name "$BACKEND_APP_NAME" \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --environment "$ENVIRONMENT_NAME" \
    --image "$BACKEND_IMAGE" \
    --target-port 3000 \
    --min-replicas 1 \
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
  echo "    Backend app created."
fi

# --- 6b. Keep one backend replica warm (minReplicas=1) ---------------------
# The backend runs on the ACA **Consumption** workload profile, which autoscales
# to ZERO when idle (minReplicas defaults to 0). The next request after idle
# then triggers a cold start (image pull + Node boot + SQLite open) that can
# exceed the ingress gateway timeout, so the client gets a **504 Gateway
# Timeout** on the first hit — intermittent 504s on /api/* after quiet periods.
#
# `minReplicas: 1` keeps one replica resident so there is no cold start. This
# is the real fix for the 504s; it is NOT a port-exposure issue (the valid
# routing field `ingress.targetPort` is set by --target-port 3000 above, and the
# ContainerAppContainer schema has no `ports` field — the API rejects it).
#
# Idempotent: re-applied on every deploy (update path included).

echo ""
echo "==> Keeping one backend replica warm (min-replicas 1)"
az containerapp update \
  --name "$BACKEND_APP_NAME" \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --min-replicas 1 \
  --output none
echo "    Backend min-replicas set to 1 (no cold-start 504s)."

# --- 7. Verify backend is ready -----------------------------------------------
# Inside Azure Container Apps, containers in the same environment reach each other
# using internal service discovery (app-name:port). The frontend nginx.conf uses
# backend-app:3000, which is already correct and doesn't need updating.

echo ""
echo "==> Waiting for backend to be ready"
sleep 15
echo "    Backend ready (internal service discovery via backend-app:3000)"

# --- 8. Build and push the frontend image ---------------------------------
# The frontend's nginx.conf is static (uses backend-app:3000 for internal service
# discovery), so no rewrite is needed. Just build and push the image.

FRONTEND_IMAGE="${AZURE_REGISTRY_LOGIN_SERVER}/habit-tracker-frontend:latest"

echo ""
echo "==> Building frontend image (az acr build, with corrected nginx.conf)"
az acr build \
  --registry "$AZURE_REGISTRY_NAME" \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --image habit-tracker-frontend:latest \
  --file frontend/Dockerfile \
  "$SCRIPT_DIR" \
  --output none
echo "    Frontend image built and pushed."

# --- 9. Deploy (or update) the frontend Container App ---------------------
# Ingress is external: this is the public HTTPS URL.

echo ""
echo "==> Deploying frontend Container App ($FRONTEND_APP_NAME)"
if az containerapp show \
    --name "$FRONTEND_APP_NAME" \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --output none 2>/dev/null; then
  az containerapp update \
    --name "$FRONTEND_APP_NAME" \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --image "$FRONTEND_IMAGE" \
    --output none
  echo "    Frontend app updated."
else
  az containerapp create \
    --name "$FRONTEND_APP_NAME" \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --environment "$ENVIRONMENT_NAME" \
    --image "$FRONTEND_IMAGE" \
    --target-port 80 \
    --ingress external \
    --registry-server "$AZURE_REGISTRY_LOGIN_SERVER" \
    --output none
  echo "    Frontend app created."
fi

# --- 10. Retrieve the frontend's public FQDN ------------------------------

echo ""
echo "==> Waiting for frontend to be ready, then retrieving public FQDN"
sleep 15

FRONTEND_FQDN=$(az containerapp show \
  --name "$FRONTEND_APP_NAME" \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --query 'properties.configuration.ingress.fqdn' -o tsv)

if [[ -z "$FRONTEND_FQDN" || "$FRONTEND_FQDN" == "None" ]]; then
  echo "ERROR: Failed to retrieve frontend FQDN."
  echo "       Inspect the app: az containerapp show --name $FRONTEND_APP_NAME --resource-group $AZURE_RESOURCE_GROUP"
  exit 1
fi
echo "    Frontend FQDN: $FRONTEND_FQDN"

# --- 11. Update the backend with the real FRONTEND_URL --------------------
# The backend uses FRONTEND_URL for OAuth redirect back-URLs and CORS. It was
# set to a placeholder in step 7; correct it now that we know the real URL.

echo ""
echo "==> Updating backend with real FRONTEND_URL"
az containerapp update \
  --name "$BACKEND_APP_NAME" \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --set-env-vars "FRONTEND_URL=https://${FRONTEND_FQDN}" \
  --output none
echo "    Backend FRONTEND_URL set to https://$FRONTEND_FQDN"

# --- 12. Summary ---------------------------------------------------------------

echo ""
echo "============================================================"
echo "  DEPLOYMENT SUCCESSFUL"
echo "============================================================"
echo ""
echo "  Frontend URL:   https://$FRONTEND_FQDN"
echo "  Backend:        backend-app:3000 (internal service discovery)"
echo "  Resource Group: $AZURE_RESOURCE_GROUP"
echo "  ACR:            $AZURE_REGISTRY_NAME"
echo ""
echo "  Next steps:"
echo "    1. Register OAuth redirect URIs (see docs/SETUP_CI_CD.md):"
echo "         Google: https://$FRONTEND_FQDN/api/auth/google/callback"
echo "         GitHub: https://$FRONTEND_FQDN/api/auth/github/callback"
echo "    2. Open https://$FRONTEND_FQDN and test login."
echo ""
# Emit a machine-readable marker so the workflow step summary / post-deploy
# tooling can scrape the URL from the log.
echo "FRONTEND_URL=https://$FRONTEND_FQDN"
