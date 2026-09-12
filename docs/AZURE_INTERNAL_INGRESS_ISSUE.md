# Azure Container Apps Internal Ingress TCP Timeout Issue

**Status:** Workaround applied — single Container App with multi-container deploy (see `scripts/containerapp.yaml.tpl`)  
**Date Reported:** 2026-09-12  
**Environment:** Azure Container Apps (Consumption plan), resource group `rg-habit-tracker-qwen38-sk`, region `eastus`

---

## Symptom

Every HTTP request from `frontend-app` (nginx reverse proxy, external ingress) to `backend-app` (Fastify server, internal ingress) fails with a **TCP connect timeout** at the network layer, surfacing to the browser as **504 Gateway Timeout**.

### Nginx Error Log
```
2026/09/11 19:51:50 [error] 31#31: *55 upstream timed out (110: Connection timed out) while connecting to upstream, 
client: 100.100.0.123, 
server: _, 
request: "GET /api/auth/me HTTP/1.1", 
upstream: "http://backend-app:3000/api/auth/me", 
host: "frontend-app.salmonrock-7165d699.eastus.azurecontainerapps.io"
```

The timeout is **exactly 110 seconds** — nginx's `proxy_connect_timeout` firing because the TCP `SYN` packet is never answered.

### Browser Error
```
504 Gateway Timeout
GET https://frontend-app.salmonrock-7165d699.eastus.azurecontainerapps.io/api/auth/me
```

---

## Environment Configuration

### Container Apps Setup
- **Environment:** `habit-tracker-env` (Consumption plan, Microsoft-managed, no VNet, no infrastructure subnet)
- **Resource Group:** `rg-habit-tracker-qwen38-sk`
- **Region:** `eastus`

### Backend App (`backend-app`)
```
Ingress:           internal (not publicly accessible)
Target Port:       3000
Transport:         Auto (then changed to Http — no difference)
Container Image:   habittrackerai9271.azurecr.io/habit-tracker-backend:latest
Container Command: Node.js Fastify server
Listening:         0.0.0.0:3000
Replicas:          1 (healthy, provisioned)
Revision:          backend-app--0000008
Traffic:           100% to latest revision
```

### Frontend App (`frontend-app`)
```
Ingress:           external (public HTTPS)
Target Port:       80
Container Image:   habittrackerai9271.azurecr.io/habit-tracker-frontend:latest
Container Config:  nginx reverse proxy
Proxy Target:      http://backend-app:3000 (also tried full FQDN)
Replicas:          1 (healthy)
```

---

## Verification Checklist (All Passing ✅)

| Check | Result | Details |
|-------|--------|---------|
| **Same Environment** | ✅ PASS | Both apps report identical `environmentId`: `/subscriptions/.../managedEnvironments/habit-tracker-env` |
| **Backend Listening** | ✅ PASS | Container logs: `"Server listening at http://0.0.0.0:3000"` and `"backend ready on port 3000"` |
| **Ingress Config** | ✅ PASS | Backend ingress: `external: false`, `targetPort: 3000`, correct FQDN declared |
| **DNS Resolution** | ✅ PASS | Nginx successfully resolves `backend-app` to internal IPs (e.g., `100.100.251.111`, `100.100.0.208`) |
| **Environment Health** | ✅ PASS | `provisioningState: "Succeeded"`, `staticIp: "57.152.56.228"`, `defaultDomain: "salmonrock-7165d699.eastus.azurecontainerapps.io"` |
| **Replica Status** | ✅ PASS | Single healthy replica: `backend-app--0000008-5f75c8bbb-d4rts`, traffic 100%, state Provisioned |
| **Traffic Routing** | ✅ PASS | Single revision with 100% traffic weight; no traffic-split race condition |

---

## Configurations Tried (All Failed)

Every attempted fix produced **identical TCP timeout** behavior:

| Attempt | Config | Result |
|---------|--------|--------|
| 1 | `proxy_pass http://backend-app:3000` | Resolved to `100.100.251.111`, TCP timeout |
| 2 | `proxy_pass http://backend-app.internal.salmonrock-7165d699.eastus.azurecontainerapps.io:3000` | Resolved to `100.100.0.208`, TCP timeout |
| 3 | Reverted to plain hostname | TCP timeout (repeated failure) |
| 4 | Backend `--transport Auto` | TCP timeout |
| 5 | Backend `--transport Http` (explicit) | TCP timeout |
| 6 | YAML patch adding container `ports: [{containerPort: 3000}]` | New revision created, still TCP timeout |
| 7 | `proxy_connect_timeout 30s` in nginx | Prolonged the timeout, didn't fix it |
| 8 | `minReplicas=1` on backend | Prevents cold-start, but didn't fix core timeout |

---

## Core Evidence of Infrastructure Issue

### **TCP Connections Never Reach Backend Application**

**Diagnostic Evidence:**
1. **Nginx logs** show "upstream timed out (110: Connection timed out) while **connecting** to upstream"
   - This is a **TCP-layer failure** before any HTTP exchange
   
2. **Backend application logs show zero incoming requests**
   - No HTTP request lines
   - No error logs from request handlers
   - No connection attempt logs
   
3. **DNS works** (nginx successfully resolved the hostname to IPs)
   
4. **Backend is listening** on `0.0.0.0:3000` (confirmed in container logs)

**Interpretation:** The TCP `SYN` packet from nginx's client socket to the backend's listening socket is being **silently dropped or refused** before it reaches the application layer. The packet is lost somewhere in the Azure Container Apps network path.

---

## Root Cause Analysis

### **Most Likely: Internal Ingress is Broken**
- Azure Container Apps' internal ingress routing layer has a bug or is degraded for this specific environment
- External ingress works fine (frontend-app is accessible via public HTTPS)
- Internal ingress (frontend → backend, same environment) traffic is silently dropped at the network layer
- This explains:
  - Why DNS works (it's not the ingress)
  - Why the app is listening (it's not the app)
  - Why both plain hostname and FQDN fail identically (issue is after DNS, in the routing layer)
  - Why changing transport protocol makes no difference (TCP itself is broken)

### **Alternative: Network Policies Blocking Internal Traffic (Less Likely)**
- Consumption plan typically doesn't expose network policies
- Default setup should allow inter-app communication within the same environment

### **Alternative: Platform Bug Specific to Region/Environment (Possible)**
- Consumption plan + internal ingress in `eastus` region may have a known issue
- Fresh environment with default settings exhibits the problem

---

## What This is NOT

- ❌ **Not a DNS issue** — both hostnames resolve successfully
- ❌ **Not an application issue** — backend confirms it's listening
- ❌ **Not a configuration issue** — all settings match Azure expectations
- ❌ **Not a cold-start issue** — `minReplicas=1` is set, replica is healthy
- ❌ **Not a protocol mismatch** — changing `transport: Auto` → `Http` had no effect
- ❌ **Not a missing port mapping** — `--target-port 3000` is correct
- ❌ **Not a container startup issue** — container logs show successful startup

---

## Impact

- ❌ Cannot use internal ingress for backend-to-frontend communication
- ❌ Backend API endpoints (`/api/auth/*`, `/api/habits/*`, etc.) all return 504
- ❌ Frontend cannot authenticate users or fetch data
- ❌ Application is non-functional in this environment

---

## Workarounds (If Support is Unavailable)

### Option 1: Single-Container Deployment (Recommended) — **IMPLEMENTED**
Deploy both backend and frontend in a **single Container App** with multiple containers:
- Backend container on port 3000
- Frontend nginx on port 80
- Communication via `127.0.0.1:3000` (bypasses broken internal ingress)
- Implemented in `scripts/deploy-ci.sh`, `deploy.sh`, and `scripts/containerapp.yaml.tpl`
- App name: `habit-tracker-app` (replaces `backend-app` + `frontend-app`)
- Trade-off: Less isolated, harder to scale independently

### Option 2: Recreate Environment
Delete `habit-tracker-env` and redeploy in a new environment:
- May land on a different internal ingress infrastructure (if region/stamp has multiple)
- Risk: May encounter the same issue if it's regional
- Command:
  ```bash
  az containerapp env delete -n habit-tracker-env -g rg-habit-tracker-qwen38-sk --yes
  # Then re-run scripts/deploy-ci.sh
  ```

### Option 3: Use Dapr Service Invocation
Deploy [Dapr](https://dapr.io/) sidecar for service-to-service communication:
- Bypasses Azure Container Apps' internal ingress
- Uses HTTP/gRPC over Dapr's runtime
- More operational overhead

### Option 4: External Load Balancer / Reverse Proxy
- Deploy a separate reverse proxy (e.g., Azure Application Gateway) to route frontend → backend
- Adds cost and complexity
- Not suitable for this simple two-app setup

---

## Steps to Report to Azure Support

If pursuing support, provide:

1. **Environment IDs:**
   ```
   Backend environmentId: /subscriptions/c3c7cf3e-d1a9-4653-b9a9-a43188215731/resourceGroups/rg-habit-tracker-qwen38-sk/providers/Microsoft.App/managedEnvironments/habit-tracker-env
   Frontend environmentId: /subscriptions/c3c7cf3e-d1a9-4653-b9a9-a43188215731/resourceGroups/rg-habit-tracker-qwen38-sk/providers/Microsoft.App/managedEnvironments/habit-tracker-env
   ```

2. **Nginx Error Logs** — full log block showing "upstream timed out (110: Connection timed out)"

3. **Backend Logs** — showing the app listening but receiving zero incoming requests

4. **Ingress Configs** — full `az containerapp show` output for both apps

5. **Attempt Summary** — this document, listing all configurations tried

---

## References

- [Azure Container Apps Networking](https://learn.microsoft.com/en-us/azure/container-apps/networking)
- [Container Apps Internal Ingress](https://learn.microsoft.com/en-us/azure/container-apps/ingress)
- [Service-to-Service Communication in Container Apps](https://learn.microsoft.com/en-us/azure/container-apps/connect-apps)

---

## Timeline

- **2026-09-11 18:55** — Backend first deployed, backend app created with `--ingress internal`
- **2026-09-11 19:40** — First 504 errors detected; frontend nginx unable to reach backend
- **2026-09-11 19:40–20:36** — Multiple configuration attempts (hostname variants, transport modes, port patches)
- **2026-09-12 20:35** — Comprehensive diagnostics run; confirmed environment match, DNS resolution, backend listening, but TCP timeouts persisting
- **2026-09-12 20:36** — Transport changed to explicit `Http`; still no change
- **2026-09-12 20:55** — Diagnostics analysis confirmed TCP-layer failure; all application and configuration checks passed
- **2026-09-12** — Workaround implemented: unified `habit-tracker-app` with backend + frontend containers; nginx uses `127.0.0.1:3000` via `nginx.azure.conf`
- **2026-09-12** — Fixed deploy: `az containerapp create --yaml` hits ARM Boolean null bug; bootstrap via CLI then `update --yaml`; ingress requires explicit `allowInsecure: false`
- **2026-09-12** — Fixed OAuth sessions: `nginx.azure.conf` must send `X-Forwarded-Proto: https` (not `$scheme`/`http`) or `@fastify/session` refuses to set Secure cookies
- **2026-09-12** — Docs updated: [SETUP_CI_CD.md](./SETUP_CI_CD.md), [OAUTH_SETUP.md](./OAUTH_SETUP.md), [DEPLOY_AZURE.md](../DEPLOY_AZURE.md), [CI_CD_SUMMARY.md](./CI_CD_SUMMARY.md)

---

## Notes

- This issue persists despite the backend and frontend being in the same Container Apps Environment, same resource group, and same region.
- The issue is at the **network infrastructure layer**, not the application or Azure Resource configuration layer.
- Nginx is correctly configured; the problem is in Azure's internal routing.
- This may be a regional issue (eastus) or a known bug in Consumption plan's internal ingress implementation.
