# Creating an Azure Service Principal for GitHub Actions

A **service principal** is an Azure identity (a kind of "app account") that GitHub Actions uses to authenticate and deploy to your Azure resources — without ever exposing your personal Azure credentials in CI.

This guide walks through creating one and wiring its four values into your GitHub repository.

## Prerequisites

- **Azure CLI** installed: `az --version`
- **Logged in** to Azure: `az login`
- **Correct subscription selected**: `az account set --subscription <subscription-id>`
  - Find your subscription ID: `az account show --query id -o tsv`

## Step 1 — Create the service principal

```bash
az ad sp create-for-rbac \
  --name "github-actions-habit-tracker" \
  --role Contributor \
  --scopes /subscriptions/$(az account show --query id -o tsv) \
  --json-auth
```

**What each flag does:**

| Flag | Meaning |
|---|---|
| `--name` | Display name for the principal (any unique string). |
| `--role Contributor` | Permission to create/update/delete resources in the scoped subscription. `Owner` also works but is broader than needed; `Contributor` is the right fit for a deploy bot. |
| `--scopes` | Limits the principal to your subscription only (not your whole tenant). |
| `--json-auth` | Prints a single JSON blob with all four values you need. |

**Output** (a JSON object):

```json
{
  "clientId": "11111111-aaaa-bbbb-cccc-222222222222",
  "clientSecret": "S0me-Very-L0ng-S3cret-String",
  "subscriptionId": "c3c7cf3e-d1a9-4653-b9a9-a43188215731",
  "tenantId": "33333333-dddd-eeee-ffff-444444444444",
  "subscription": { "id": "..." , "displayName": "My Subscription" },
  "tenant": { "id": "...", "displayName": "My Org" }
}
```

> **Save this JSON now.** The `clientSecret` is shown **only once** — if you lose it, you must reset it with `az ad app credential reset --id <clientId>`.

### Mapping to GitHub secret names

| JSON field | GitHub secret |
|---|---|
| `clientId` | `AZURE_CLIENT_ID` |
| `clientSecret` | `AZURE_CLIENT_SECRET` |
| `tenantId` | `AZURE_TENANT_ID` |
| `subscriptionId` | `AZURE_SUBSCRIPTION_ID` |

## Step 2 — (Optional) Verify the principal works

From a clean shell (or with `az account clear` first), log in as the principal and confirm it can see the subscription:

```bash
az login --service-principal \
  --username <clientId> \
  --password <clientSecret> \
  --tenant <tenantId>

az account set --subscription <subscriptionId>
az account show   # should succeed
```

## Step 3 — Register the values in GitHub

1. Open your GitHub repo → **Settings** → **Secrets and variables** → **Actions**.
2. Under **Repository secrets**, add:
   - `AZURE_CLIENT_ID`
   - `AZURE_CLIENT_SECRET`
   - `AZURE_TENANT_ID`
   - `AZURE_SUBSCRIPTION_ID`
3. (These are the four values from the JSON above.)

You'll also need to set three **repository variables** (non-secret) — see [SETUP_CI_CD.md](./SETUP_CI_CD.md#step-4-register-variables-in-github):
- `AZURE_RESOURCE_GROUP`
- `AZURE_LOCATION`
- `AZURE_REGISTRY_LOGIN_SERVER`

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Insufficient privileges to perform action` | The principal lacks the `Contributor` role on the scope. Re-create with `--role Contributor`, or grant it: `az role assignment create --assignee <clientId> --role Contributor --scope /subscriptions/<sub-id>`. |
| `AADSTS700016: Application ... not found in the directory` | Wrong `AZURE_TENANT_ID` or `AZURE_CLIENT_ID`. Verify both from the `--json-auth` output. |
| `Invalid client secret provided` | The secret was reset or mistyped. Reset it: `az ad app credential reset --id <clientId> --append=true` (keeps the old one valid until it expires), then copy the new one. |
| `az: command not found` in CI | The workflow installs the Azure CLI (`curl -sL https://aka.ms/InstallAzureCLIDeb \| bash`) — make sure that step runs before the deploy step. |
| `Subscription not found` | The principal's scope (`--scopes`) didn't include the subscription, or `AZURE_SUBSCRIPTION_ID` is wrong. |

## Resetting the secret later

If you suspect the client secret has leaked, or just want to rotate it:

```bash
az ad app credential reset --id <clientId> --append=true
```

`--append=true` keeps the existing secret valid until its expiry so you can update GitHub gradually. Without `--append`, the old secret is invalidated immediately.

## Cleaning up

To remove the principal when you're done:

```bash
# Find the app registration ID
az ad app list --display-name "github-actions-habit-tracker" -o table

# Delete the app registration (and its service principal)
az ad app delete --id <appId>
```
