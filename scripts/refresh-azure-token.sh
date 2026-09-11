#!/usr/bin/env bash

set -euo pipefail

# ---------------------------------------------------------------------------
# Refresh the Azure access token used by the GitHub Actions workflow.
#
# This script:
#   1. Runs `az login --use-device-code` (interactive — you complete the
#      browser flow within ~5 minutes).
#   2. Captures the resulting access token.
#   3. Pushes it to the AZURE_ACCESS_TOKEN GitHub secret via `gh api`.
#
# Run this BEFORE each deploy (the token expires in ~60 minutes):
#
#   bash scripts/refresh-azure-token.sh
#
# Prerequisites:
#   - Azure CLI installed and `az` on PATH
#   - `gh` CLI authenticated (for pushing the secret)
#   - Network access to microsoft.com/devicelogin (for the browser flow)
# ---------------------------------------------------------------------------

REPO="StanislavKostenich/ai-eval-habit-tracker"
TENANT_ID="1a54e107-6999-4f70-acdb-194c649c72f2"
SUBSCRIPTION_ID="c3c7cf3e-d1a9-4653-b9a9-a43188215731"

echo "==> Starting Azure device-code login"
echo "    A code and URL will appear below. Open the URL in a browser,"
echo "    sign in as your Azure account, and enter the code."
echo ""

# az login --use-device-code is interactive: it prints the code/URL and
# waits (polls) until the user completes the browser flow or it times out.
az login --use-device-code --tenant "$TENANT_ID" --output none

echo "==> Login complete. Setting subscription..."
az account set --subscription "$SUBSCRIPTION_ID"

echo "==> Capturing access token..."
TOKEN=$(az account get-access-token --query accessToken -o tsv)

if [[ -z "$TOKEN" ]]; then
  echo "ERROR: Failed to capture access token."
  exit 1
fi

echo "    Token captured (${#TOKEN} chars)."

echo "==> Pushing token to GitHub secret AZURE_ACCESS_TOKEN..."
# Build a JSON body with the token and send it to the GitHub API. We write the
# body to a temp file (chmod 600) so the token never appears in the process
# list or shell history, then delete it.
BODY_FILE="$(mktemp)"
trap 'rm -f "$BODY_FILE"' EXIT

# JSON-escape the token (it's a base64url JWT, but escape defensively).
TOKEN_JSON=${TOKEN//\\/\\\\}
TOKEN_JSON=${TOKEN_JSON//\"/\\\"}
printf '{"secret":"%s"}' "$TOKEN_JSON" > "$BODY_FILE"
chmod 600 "$BODY_FILE"

gh api \
  -X PUT \
  "repos/${REPO}/actions/secrets/AZURE_ACCESS_TOKEN" \
  --input "$BODY_FILE" \
  -H "Accept: application/vnd.github+json"

echo ""
echo "✅ Token refreshed and stored."
echo "   The workflow can now run. Trigger a deploy:"
echo "     - push to main, or"
echo "     - GitHub → Actions → Deploy to Azure Container Apps → Run workflow"
echo ""
echo "⚠  This token expires in ~60 minutes. Refresh again before the next deploy."
