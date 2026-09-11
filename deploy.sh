#!/bin/bash

set -euo pipefail

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
RESOURCE_GROUP=""
LOCATION=""
REGISTRY_NAME=""
GOOGLE_CLIENT_ID=""
GOOGLE_CLIENT_SECRET=""
GITHUB_CLIENT_ID=""
GITHUB_CLIENT_SECRET=""
SESSION_SECRET=""
BACKEND_APP_NAME="backend-app"
FRONTEND_APP_NAME="frontend-app"
ENVIRONMENT_NAME="habit-tracker-env"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Helper functions
print_header() {
    echo -e "\n${BLUE}===> $1${NC}\n"
}

print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
    exit 1
}

print_warning() {
    echo -e "${YELLOW}⚠ $1${NC}"
}

show_usage() {
    cat << 'EOF'
Usage: bash deploy.sh [OPTIONS]

Required options:
  --resource-group NAME     Azure resource group name
  --location REGION         Azure region (e.g., eastus, westus2)

Optional options:
  --registry NAME           ACR name (auto-generates if not provided)
  --google-client-id ID     Google OAuth client ID
  --google-client-secret SECRET    Google OAuth client secret
  --github-client-id ID     GitHub OAuth client ID
  --github-client-secret SECRET    GitHub OAuth client secret
  --session-secret SECRET   Session secret (auto-generates if not provided, must be ≥32 chars)
  --help                    Show this help message

Example:
  bash deploy.sh --resource-group my-rg --location eastus \
    --google-client-id abc123.apps.googleusercontent.com \
    --google-client-secret xyz789

Note: If OAuth credentials are not provided, you will be prompted for them.
EOF
}

# Parse command-line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --resource-group)
            RESOURCE_GROUP="$2"
            shift 2
            ;;
        --location)
            LOCATION="$2"
            shift 2
            ;;
        --registry)
            REGISTRY_NAME="$2"
            shift 2
            ;;
        --google-client-id)
            GOOGLE_CLIENT_ID="$2"
            shift 2
            ;;
        --google-client-secret)
            GOOGLE_CLIENT_SECRET="$2"
            shift 2
            ;;
        --github-client-id)
            GITHUB_CLIENT_ID="$2"
            shift 2
            ;;
        --github-client-secret)
            GITHUB_CLIENT_SECRET="$2"
            shift 2
            ;;
        --session-secret)
            SESSION_SECRET="$2"
            shift 2
            ;;
        --help)
            show_usage
            exit 0
            ;;
        *)
            print_error "Unknown option: $1"
            ;;
    esac
done

# Validate required options
if [[ -z "$RESOURCE_GROUP" ]]; then
    print_error "Missing required option: --resource-group"
fi

if [[ -z "$LOCATION" ]]; then
    print_error "Missing required option: --location"
fi

# Check prerequisites
print_header "Checking prerequisites"

command -v az &> /dev/null || print_error "Azure CLI not installed. Visit https://learn.microsoft.com/cli/azure/install-azure-cli"
print_success "Azure CLI found"

command -v docker &> /dev/null || print_warning "Docker not found locally. Will use az acr build instead."

# Check Azure login
if ! az account show &> /dev/null; then
    print_error "Not logged into Azure. Run: az login"
fi
print_success "Logged into Azure"

# Prompt for missing OAuth credentials if needed
if [[ -z "$GOOGLE_CLIENT_ID" ]]; then
    echo -e "\n${YELLOW}OAuth credentials not provided. Please enter them now.${NC}"
    read -p "Google Client ID: " GOOGLE_CLIENT_ID
fi

if [[ -z "$GOOGLE_CLIENT_SECRET" ]]; then
    read -sp "Google Client Secret: " GOOGLE_CLIENT_SECRET
    echo
fi

if [[ -z "$GITHUB_CLIENT_ID" ]]; then
    read -p "GitHub Client ID: " GITHUB_CLIENT_ID
fi

if [[ -z "$GITHUB_CLIENT_SECRET" ]]; then
    read -sp "GitHub Client Secret: " GITHUB_CLIENT_SECRET
    echo
fi

# Generate session secret if not provided
if [[ -z "$SESSION_SECRET" ]]; then
    if command -v openssl &> /dev/null; then
        SESSION_SECRET=$(openssl rand -hex 16)
    elif command -v python3 &> /dev/null; then
        SESSION_SECRET=$(python3 -c "import secrets; print(secrets.token_hex(16))")
    else
        print_error "Cannot generate session secret. Install openssl or python3, or provide --session-secret manually."
    fi
fi

if [[ ${#SESSION_SECRET} -lt 32 ]]; then
    print_error "Session secret must be at least 32 characters (got ${#SESSION_SECRET})"
fi

# Generate registry name if not provided
if [[ -z "$REGISTRY_NAME" ]]; then
    REGISTRY_NAME="ht$(date +%s | tail -c 6)"
fi

print_success "Configuration validated"

echo -e "\n${BLUE}Deployment Configuration:${NC}"
echo "  Resource Group:    $RESOURCE_GROUP"
echo "  Location:          $LOCATION"
echo "  Registry:          $REGISTRY_NAME"
echo "  Backend App:       $BACKEND_APP_NAME"
echo "  Frontend App:      $FRONTEND_APP_NAME"
echo "  Environment:       $ENVIRONMENT_NAME"

# Confirm before proceeding
read -p $'\nProceed with deployment? (y/n) ' -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    print_error "Deployment cancelled"
fi

# Step 1: Create resource group
print_header "Step 1: Creating resource group"
if az group exists --name "$RESOURCE_GROUP" --output tsv | grep -q "true"; then
    print_success "Resource group '$RESOURCE_GROUP' already exists"
else
    az group create --name "$RESOURCE_GROUP" --location "$LOCATION" > /dev/null
    print_success "Resource group created"
fi

# Step 2: Create Azure Container Registry
print_header "Step 2: Creating Azure Container Registry"
if az acr show --resource-group "$RESOURCE_GROUP" --name "$REGISTRY_NAME" &> /dev/null; then
    print_success "ACR '$REGISTRY_NAME' already exists"
else
    az acr create \
        --resource-group "$RESOURCE_GROUP" \
        --name "$REGISTRY_NAME" \
        --sku Basic \
        --admin-enabled true \
        --output none
    print_success "ACR created"
fi

# Ensure admin credentials are enabled (required for az acr build to push).
# If the ACR was created before --admin-enabled was added, enable it now.
if ! az acr update --resource-group "$RESOURCE_GROUP" --name "$REGISTRY_NAME" --admin-enabled true --output none 2>/dev/null; then
    print_warning "Could not enable ACR admin credentials (may already be enabled)."
fi

# Step 3: Build and push images
print_header "Step 3: Building and pushing images to ACR"

# Backend image
echo "Building backend image..."
az acr build \
    --registry "$REGISTRY_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --image habit-tracker-backend:latest \
    --file backend/Dockerfile \
    "$SCRIPT_DIR" \
    --output none
print_success "Backend image pushed"

# Frontend image (first iteration, will rebuild later with correct BACKEND_FQDN)
echo "Building frontend image (v1)..."
az acr build \
    --registry "$REGISTRY_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --image habit-tracker-frontend:latest \
    --file frontend/Dockerfile \
    "$SCRIPT_DIR" \
    --output none
print_success "Frontend image pushed"

# Step 4: Create Container Apps Environment
print_header "Step 4: Creating Container Apps Environment"
if az containerapp env show --name "$ENVIRONMENT_NAME" --resource-group "$RESOURCE_GROUP" &> /dev/null; then
    print_success "Environment '$ENVIRONMENT_NAME' already exists"
else
    az containerapp env create \
        --name "$ENVIRONMENT_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --location "$LOCATION" \
        --output none
    print_success "Environment created"
fi

# Step 5: Deploy backend Container App
print_header "Step 5: Deploying backend Container App"

if az containerapp show --name "$BACKEND_APP_NAME" --resource-group "$RESOURCE_GROUP" &> /dev/null; then
    print_warning "Backend app already exists, updating..."
    az containerapp update \
        --name "$BACKEND_APP_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --image "${REGISTRY_NAME}.azurecr.io/habit-tracker-backend:latest" \
        --set-env-vars \
            NODE_ENV=production \
            PORT=3000 \
            DATABASE_PATH=/data/habits.db \
            SESSION_SECRET="$SESSION_SECRET" \
            GOOGLE_CLIENT_ID="$GOOGLE_CLIENT_ID" \
            GOOGLE_CLIENT_SECRET="$GOOGLE_CLIENT_SECRET" \
            GITHUB_CLIENT_ID="$GITHUB_CLIENT_ID" \
            GITHUB_CLIENT_SECRET="$GITHUB_CLIENT_SECRET" \
            FRONTEND_URL=https://placeholder.azurecontainerapps.io \
        --output none
    print_success "Backend app updated"
else
    az containerapp create \
        --name "$BACKEND_APP_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --environment "$ENVIRONMENT_NAME" \
        --image "${REGISTRY_NAME}.azurecr.io/habit-tracker-backend:latest" \
        --target-port 3000 \
        --ingress internal \
        --registry-server "${REGISTRY_NAME}.azurecr.io" \
        --env-vars \
            NODE_ENV=production \
            PORT=3000 \
            DATABASE_PATH=/data/habits.db \
            SESSION_SECRET="$SESSION_SECRET" \
            GOOGLE_CLIENT_ID="$GOOGLE_CLIENT_ID" \
            GOOGLE_CLIENT_SECRET="$GOOGLE_CLIENT_SECRET" \
            GITHUB_CLIENT_ID="$GITHUB_CLIENT_ID" \
            GITHUB_CLIENT_SECRET="$GITHUB_CLIENT_SECRET" \
            FRONTEND_URL=https://placeholder.azurecontainerapps.io \
        --output none
    print_success "Backend app created"
fi

# Step 6: Get backend's internal FQDN
print_header "Step 6: Retrieving backend internal FQDN"
echo "Waiting for backend app to be ready..."
sleep 10

BACKEND_FQDN=$(az containerapp show \
    --name "$BACKEND_APP_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --query 'properties.configuration.ingress.fqdn' -o tsv)

if [[ -z "$BACKEND_FQDN" ]]; then
    print_error "Failed to retrieve backend FQDN. Check the backend app status with: az containerapp logs show --name $BACKEND_APP_NAME --resource-group $RESOURCE_GROUP"
fi

print_success "Backend FQDN: $BACKEND_FQDN"

# Step 7: Update frontend/nginx.conf
print_header "Step 7: Updating frontend/nginx.conf with backend FQDN"

NGINX_CONF="$SCRIPT_DIR/frontend/nginx.conf"
if [[ ! -f "$NGINX_CONF" ]]; then
    print_error "nginx.conf not found at $NGINX_CONF"
fi

# Backup original
cp "$NGINX_CONF" "${NGINX_CONF}.backup"
print_success "Backed up original nginx.conf"

# Replace http://backend:3000 with backend FQDN (handle both http:// and potential https://)
sed -i '' "s|http://backend:3000|http://$BACKEND_FQDN|g" "$NGINX_CONF"

# Verify the replacement
if grep -q "$BACKEND_FQDN" "$NGINX_CONF"; then
    print_success "nginx.conf updated with backend FQDN"
else
    print_error "Failed to update nginx.conf. Restored backup."
    mv "${NGINX_CONF}.backup" "$NGINX_CONF"
fi

# Step 8: Rebuild and push frontend image
print_header "Step 8: Rebuilding frontend image with updated nginx.conf"
echo "Building frontend image (v2 with correct backend proxy)..."
az acr build \
    --registry "$REGISTRY_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --image habit-tracker-frontend:latest \
    --file frontend/Dockerfile \
    "$SCRIPT_DIR" \
    --output none
print_success "Frontend image rebuilt and pushed"

# Step 9: Deploy frontend Container App
print_header "Step 9: Deploying frontend Container App"

if az containerapp show --name "$FRONTEND_APP_NAME" --resource-group "$RESOURCE_GROUP" &> /dev/null; then
    print_warning "Frontend app already exists, updating..."
    az containerapp update \
        --name "$FRONTEND_APP_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --image "${REGISTRY_NAME}.azurecr.io/habit-tracker-frontend:latest" \
        --output none
    print_success "Frontend app updated"
else
    az containerapp create \
        --name "$FRONTEND_APP_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --environment "$ENVIRONMENT_NAME" \
        --image "${REGISTRY_NAME}.azurecr.io/habit-tracker-frontend:latest" \
        --target-port 80 \
        --ingress external \
        --registry-server "${REGISTRY_NAME}.azurecr.io" \
        --output none
    print_success "Frontend app created"
fi

# Step 10: Get frontend's public FQDN
print_header "Step 10: Retrieving frontend public FQDN"
echo "Waiting for frontend app to be ready..."
sleep 10

FRONTEND_FQDN=$(az containerapp show \
    --name "$FRONTEND_APP_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --query 'properties.configuration.ingress.fqdn' -o tsv)

if [[ -z "$FRONTEND_FQDN" ]]; then
    print_error "Failed to retrieve frontend FQDN. Check status with: az containerapp logs show --name $FRONTEND_APP_NAME --resource-group $RESOURCE_GROUP"
fi

print_success "Frontend FQDN: $FRONTEND_FQDN"

# Step 11: Update backend with correct FRONTEND_URL
print_header "Step 11: Updating backend with correct FRONTEND_URL"
az containerapp update \
    --name "$BACKEND_APP_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --set-env-vars FRONTEND_URL="https://$FRONTEND_FQDN" \
    --output none
print_success "Backend updated with FRONTEND_URL"

# Success
print_header "🎉 Deployment Complete!"

echo -e "${GREEN}Frontend URL:${NC} https://$FRONTEND_FQDN"
echo -e "${GREEN}Backend FQDN:${NC} $BACKEND_FQDN (internal)"
echo -e "${GREEN}Resource Group:${NC} $RESOURCE_GROUP"
echo -e "${GREEN}Registry:${NC} $REGISTRY_NAME"

cat << EOF

${YELLOW}⚠  Next Steps:${NC}

1. Register OAuth Redirect URIs:

   Google Cloud Console (https://console.cloud.google.com):
   - APIs & Services → Credentials → Your OAuth 2.0 Client ID
   - Add to "Authorized redirect URIs":
     https://$FRONTEND_FQDN/api/auth/google/callback

   GitHub (https://github.com/settings/developers):
   - OAuth Apps → Your app
   - Update "Authorization callback URL":
     https://$FRONTEND_FQDN/api/auth/github/callback

2. Test the deployment:
   - Open: https://$FRONTEND_FQDN
   - Click "Continue with Google" or "Continue with GitHub"
   - Create a habit and check in
   - Verify WebSocket connects (DevTools → Network → WS filter)

3. Check logs if needed:
   Backend: az containerapp logs show --name $BACKEND_APP_NAME --resource-group $RESOURCE_GROUP --follow
   Frontend: az containerapp logs show --name $FRONTEND_APP_NAME --resource-group $RESOURCE_GROUP --follow

4. Clean up when done:
   az group delete --name $RESOURCE_GROUP --yes

See DEPLOY_AZURE.md for more details and troubleshooting.
EOF

print_success "Deployment script completed successfully!"
