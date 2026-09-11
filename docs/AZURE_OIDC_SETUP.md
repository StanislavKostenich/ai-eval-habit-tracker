# Azure OIDC Setup for GitHub Actions

This is the one-time setup for passwordless, secret-free deployment to Azure
from GitHub Actions. It uses **OIDC federation** — GitHub mints a short-lived
token each run, Azure exchanges it for access. No service-principal secrets,
no 60-minute token refresh, no `az login` in CI.

## Why OIDC (and not a stored access token)

The Azure CLI has **no supported way to authenticate from a raw Bearer token
via an environment variable.** The earlier `AZURE_AUTH` / `AZURE_ACCESS_TOKEN`
approach was based on a false premise — the CLI silently ignores those vars and
still demands `az login`. OIDC is the supported mechanism for exactly this
scenario.

## What you'll create

| Resource | Where | Used by |
|---|---|---|
| App registration | Entra ID (tenant) | The identity GitHub federates as |
| Federated identity credential | App registration → Credentials | Binds the GitHub repo+branch to the app |
| Contributor role assignment | Subscription → Access control | Grants the app deploy rights |
| `AZURE_CLIENT_ID` secret | GitHub repo → Secrets | The workflow's `azure/login@v2` client-id |

## Step 1: Create the app registration

1. Azure Portal → **Microsoft Entra ID** → **Identity** → **App registrations** → **New registration**.
2. Name: `habit-tracker-github-actions` (any name works).
3. Supported account types: **Single tenant** (your organization's directory only).
4. Leave redirect URI blank.
5. **Register.**
6. Note the **Application (client) ID** — you'll need it as a GitHub secret.

## Step 2: Create the federated identity credential

1. In the app registration, go to **Certificates & secrets** → **Federated credentials** → **Add a credential** → **Federated identity credential**.
2. Fill in:
   - **Name**: `github-main` (any name).
   - **Identity provider**: `OIDC`.
   - **Issuer**: `https://token.actions.githubusercontent.com`
   - **Subject**: `repo:StanislavKostenich/ai-eval-habit-tracker:main`
     (Use your actual repo owner/name. To allow all branches, use
     `repo:StanislavKostenich/ai-eval-habit-tracker:*`.)
   - **Audiences**: `api://AzureADTokenExchange`
3. **Add**.

> The Subject format is `repo:<owner>/<repo>:<branch>`. The workflow's
> `azure/login@v2` action presents GitHub's OIDC token, whose `sub` claim must
> match this exactly.

## Step 3: Assign the Contributor role

1. Azure Portal → your **Subscription** (the one in the workflow) → **Access control (IAM)** → **Add** → **Add role assignment**.
2. **Role**: `Contributor`.
3. **Assign access to**: `Azure service principal, security group, or managed identity`.
4. Click **Select members** → **+ Select from directory** → find the app registration
   (`habit-tracker-github-actions`) → **Select** → **OK**.
5. **Review + assign**.

> If you want a tighter scope, assign the role to the **resource group**
> (`habit-tracker-demo`) instead of the subscription — but the workflow also
> checks `az group exists` at the subscription level, so subscription scope is
> simplest.

## Step 4: Store the client ID as a GitHub secret

1. GitHub repo → **Settings** → **Secrets and variables** → **Actions**.
2. **New repository secret**:
   - Name: `AZURE_CLIENT_ID`
   - Value: the **Application (client) ID** from Step 1.

> That's the only secret the workflow needs for Azure auth. The tenant and
> subscription IDs are in the workflow file.

## Step 5: Clean up the old (unused) token secrets

These are no longer used and should be removed to avoid confusion:

- `AZURE_ACCESS_TOKEN`

## Verify

Push to `main` (or trigger the workflow from the Actions tab). The
**Authenticate to Azure (OIDC)** step should succeed without prompting. If it
fails, the error message will tell you which piece is misconfigured:

- `AADSTS70002` / `not a valid federated credential` → Subject mismatch in
  Step 2 (check owner/repo/branch).
- `AADSTS65001` → issuer/audience mismatch (should be
  `https://token.actions.githubusercontent.com` / `api://AzureADTokenExchange`).
- `AuthorizationFailed` / `RoleAssignments` → the role assignment (Step 3) is
  missing or scoped to the wrong place.

## Reverting to the old flow

If you need to pause OIDC (e.g. for troubleshooting), the previous
device-code + `AZURE_ACCESS_TOKEN` approach is in git history
(`scripts/refresh-azure-token.sh` and the `AZURE_AUTH` block in
`deploy-ci.sh`). But note it never actually worked end-to-end — the CLI ignores
`AZURE_AUTH` — so OIDC is the only supported path for headless CI.
