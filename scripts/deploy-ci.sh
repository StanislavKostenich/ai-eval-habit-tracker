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
#   4. Single Container App — backend + frontend run as two containers in one
#      revision; nginx proxies to 127.0.0.1:3000 (avoids broken ACA internal
#      ingress between separate apps; see docs/AZURE_INTERNAL_INGRESS_ISSUE.md).
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
# Output: a deployed Container App (external ingress on nginx) and the public
# URL printed to stdout.
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

APP_NAME="habit-tracker-app"
ENVIRONMENT_NAME="habit-tracker-env"
# Legacy two-app names — removed after successful unified deploy.
LEGACY_BACKEND_APP="backend-app"
LEGACY_FRONTEND_APP="frontend-app"

# Repository root: this script lives in scripts/, so the parent is the root.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo ""
echo "==> Deployment configuration"
echo "    Resource Group:     $AZURE_RESOURCE_GROUP"
echo "    Location:           $AZURE_LOCATION"
echo "    ACR Name:           $AZURE_REGISTRY_NAME"
echo "    Container App:      $APP_NAME (backend + frontend)"
echo "    Environment:        $ENVIRONMENT_NAME"
echo "    Repo Root:          $SCRIPT_DIR"

# --- 2. Ensure the resource group exists ----------------------------------

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

# --- 4. Build and push both images ----------------------------------------
# Build context is the repository root (npm workspaces monorepo).

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

echo ""
echo "==> Building frontend image (az acr build, nginx.azure.conf for localhost upstream)"
az acr build \
  --registry "$AZURE_REGISTRY_NAME" \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --image habit-tracker-frontend:latest \
  --file frontend/Dockerfile \
  --build-arg NGINX_CONF=nginx.azure.conf \
  "$SCRIPT_DIR" \
  --output none
echo "    Frontend image built and pushed."

BACKEND_IMAGE="${AZURE_REGISTRY_LOGIN_SERVER}/habit-tracker-backend:latest"
FRONTEND_IMAGE="${AZURE_REGISTRY_LOGIN_SERVER}/habit-tracker-frontend:latest"

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

# --- 6. Render multi-container YAML and deploy ----------------------------

CONTAINERAPP_YAML="$(mktemp)"
trap 'rm -f "$CONTAINERAPP_YAML"' EXIT

sed \
  -e "s|__BACKEND_IMAGE__|${BACKEND_IMAGE}|g" \
  -e "s|__FRONTEND_IMAGE__|${FRONTEND_IMAGE}|g" \
  "$SCRIPT_DIR/scripts/containerapp.yaml.tpl" > "$CONTAINERAPP_YAML"

echo ""
echo "==> Deploying unified Container App ($APP_NAME)"
if az containerapp show \
    --name "$APP_NAME" \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --output none 2>/dev/null; then
  az containerapp update \
    --name "$APP_NAME" \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --yaml "$CONTAINERAPP_YAML" \
    --output none
  echo "    Container app updated."
else
  # Initial create must use the CLI, not --yaml: az containerapp create --yaml
  # injects null ingress booleans into the PUT body and ARM returns HTTP 400
  # ("JSON value could not be converted to System.Boolean"). Create a minimal
  # single-container app first, then patch to the multi-container template.
  az containerapp create \
    --name "$APP_NAME" \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --environment "$ENVIRONMENT_NAME" \
    --image "$FRONTEND_IMAGE" \
    --target-port 80 \
    --ingress external \
    --registry-server "$AZURE_REGISTRY_LOGIN_SERVER" \
    --min-replicas 1 \
    --output none
  echo "    Container app created (frontend-only bootstrap)."
  az containerapp update \
    --name "$APP_NAME" \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --yaml "$CONTAINERAPP_YAML" \
    --output none
  echo "    Multi-container template applied."
fi

# --- 7. Set backend secrets and OAuth env vars ----------------------------
# Kept off the YAML file so secrets are not written to disk in the template.

echo ""
echo "==> Configuring backend container environment"
az containerapp update \
  --name "$APP_NAME" \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --container-name backend \
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
    BACKEND_URL="https://placeholder.azurecontainerapps.io" \
  --output none
echo "    Backend env vars set (OAuth URLs updated after FQDN is known)."

# --- 8. Retrieve the public FQDN ------------------------------------------

echo ""
echo "==> Waiting for app to be ready, then retrieving public FQDN"
sleep 15

APP_FQDN=$(az containerapp show \
  --name "$APP_NAME" \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --query 'properties.configuration.ingress.fqdn' -o tsv)

if [[ -z "$APP_FQDN" || "$APP_FQDN" == "None" ]]; then
  echo "ERROR: Failed to retrieve app FQDN."
  echo "       Inspect the app: az containerapp show --name $APP_NAME --resource-group $AZURE_RESOURCE_GROUP"
  exit 1
fi
echo "    App FQDN: $APP_FQDN"

# --- 9. Update OAuth redirect URLs ------------------------------------------
# Both FRONTEND_URL and BACKEND_URL use the public HTTPS origin. OAuth
# callbacks hit /api/auth/*/callback through nginx, not the backend directly.

echo ""
echo "==> Updating backend OAuth URLs"
az containerapp update \
  --name "$APP_NAME" \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --container-name backend \
  --set-env-vars \
    "FRONTEND_URL=https://${APP_FQDN}" \
    "BACKEND_URL=https://${APP_FQDN}" \
  --output none
echo "    FRONTEND_URL and BACKEND_URL set to https://$APP_FQDN"

# --- 10. Remove legacy two-app deployment (if present) --------------------

echo ""
echo "==> Cleaning up legacy separate Container Apps (if any)"
for legacy in "$LEGACY_BACKEND_APP" "$LEGACY_FRONTEND_APP"; do
  if az containerapp show \
      --name "$legacy" \
      --resource-group "$AZURE_RESOURCE_GROUP" \
      --output none 2>/dev/null; then
    az containerapp delete \
      --name "$legacy" \
      --resource-group "$AZURE_RESOURCE_GROUP" \
      --yes \
      --output none
    echo "    Deleted legacy app: $legacy"
  fi
done

# --- 11. Summary ----------------------------------------------------------

echo ""
echo "============================================================"
echo "  DEPLOYMENT SUCCESSFUL"
echo "============================================================"
echo ""
echo "  App URL:        https://$APP_FQDN"
echo "  Architecture:   single Container App (nginx + backend via localhost)"
echo "  Resource Group: $AZURE_RESOURCE_GROUP"
echo "  ACR:            $AZURE_REGISTRY_NAME"
echo ""
echo "  Next steps:"
echo "    1. Register OAuth redirect URIs (see docs/SETUP_CI_CD.md):"
echo "         Google: https://$APP_FQDN/api/auth/google/callback"
echo "         GitHub: https://$APP_FQDN/api/auth/github/callback"
echo "    2. Open https://$APP_FQDN and test login."
echo ""
# Emit a machine-readable marker so the workflow step summary / post-deploy
# tooling can scrape the URL from the log.
echo "FRONTEND_URL=https://$APP_FQDN"
