#!/usr/bin/env bash

set -euo pipefail

# ---------------------------------------------------------------------------
# Refresh the Azure access token used by the GitHub Actions workflow.
#
# This script:
#   1. Runs `az login --use-device-code` (interactive — you complete the
#      browser flow within ~5 minutes).
#   2. Captures the resulting access token.
#   3. Pushes it to the AZURE_ACCESS_TOKEN GitHub secret via `gh secret set`.
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
# `gh secret set` reads the value from stdin (so it never appears in the
# process list or shell history) and encrypts it locally with the repo's
# public key before sending. This is the supported way to set an Actions
# secret — `gh api` against the secrets endpoint cannot, because it doesn't
# perform the encryption (it would 422 with "encrypted_value, key_id weren't
# supplied").
printf '%s' "$TOKEN" | gh secret set AZURE_ACCESS_TOKEN --repo "$REPO"

echo ""
echo "✅ Token refreshed and stored."
echo "   The workflow can now run. Trigger a deploy:"
echo "     - push to main, or"
echo "     - GitHub → Actions → Deploy to Azure Container Apps → Run workflow"
echo ""
echo "⚠  This token expires in ~60 minutes. Refresh again before the next deploy."
