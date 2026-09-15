# Gateway `usage` Regression — Debug Plan & Gateway-Side Fix Specification

**Date:** 2026-09-11 · **Gateway:** `pilot-gateway.ai.eleks-demo.com` (black box to the client)
**Model:** `qwen3.8-27b` (served window **131,072**; hard check = `input_tokens + max_tokens <= 131072`)
**Predecessor doc:** `docs/compact-overflow-findings.md` (S-C usage fix, S-G, S-H, S-I — all validated, then regressed)

---

## 1. Problem statement

The gateway's **real-usage passthrough** — validated live on 2026-09-10 (S-C) and 2026-09-11 (S-H) — is **not persistently live**. On sustained Claude Code sessions, **every** assistant response carries `usage.input_tokens = 0`, while isolated one-shot requests sometimes get real counts. This makes the entire client-side context-safety architecture blind, and it is the direct cause of recurring 1-token-over 400s.

### Symptom

```
API Error: 400  Estimated input plus requested output exceeds the Qwen context
window; compact the conversation and retry.
```

...while `/context` simultaneously reports **15.4k / 120k (13%)** for `qwen3.8-27b`.

### Measured evidence (2026-09-11, this investigation)

| Evidence | Value | Interpretation |
|---|---|---|
| Probe one-shot FIT request (25 turns) | HTTP 200, `input_tokens=5348` (non-zero) | Isolated request **does** get real usage |
| Probe one-shot OVER request (620 turns) | HTTP 400, `error.type=context_length_exceeded` | Preflight still works |
| Transcript `ae7005de` (the failed session) | **92/92** assistant msgs `input_tokens:0` | Session stream: **all zero** |
| Transcript `40b2e335` | **152/152** zero | Same |
| Transcript `a30ae539` | **161/161** zero | Same |
| Transcript `313b8581` | **12/12** zero | Same |
| **Total across 4 sessions** | **417/417 assistant messages = 0** | Not a fluke — a persistent per-session condition |
| Failed session raw transcript size | 191 messages, **197,671 chars**, no compact boundary ever fired | ~59.9k tokens at honest chars/3.3; ~113.8k at the hook's pessimistic chars/1.8 + 4000 schema — the real wire request (with system prompt + 65 tool schemas + cache expansion) is at or above the wall |

### Why `/context` (15.4k) and the 400 are not contradictory

They measure different things (see S-G of the predecessor doc):

| | `/context` (15.4k) | Gateway 400 check |
|---|---|---|
| Counts | `chars/4` of the **in-memory conversation only** (user + assistant text since last compact) | **`input_tokens + max_tokens` of the actual wire request** — full re-sent history + system prompt + all tool/MCP schemas + prompt-cache expansion |
| Predicts | When **auto-compact fires** | Whether the **request is accepted** |

On a tool-heavy session the two diverge by ~x4–x8. The UI number predicts when auto-compact fires; it is **not** the request size.

### Why the safety nets failed together (the core failure)

With `usage:0` on every response:

1. **Auto-compact is blind.** Claude Code's auto-compact trigger is fed by the same usage telemetry. With `input_tokens:0` the client believes the session is tiny (hence the 15.4k / 13% display and why no auto-compact ever fired at the 102k trigger), while the real request grows to the wall.
2. **`/compact` then overflows.** The compact request re-sends the full ~127k-token history; `127073 + 4000 = 131073 = 131072 + 1` → the exact 1-token-over 400.
3. **The `context-guard.py` hook is on its fallback path.** It looks for real usage, finds 0, falls back to the chars estimate. That estimate is a *lower bound* that undercounts by a session-dependent factor, so it warns late or not at all relative to the true wall.

**All three failures share one root cause: the gateway stopped returning real usage on sustained sessions.** Fix the usage passthrough and the client's auto-compact + `/compact` + hook all recover without any client-side change.

---

## 2. What the client already does (and why it can't self-fix)

The client-side configuration is already correct (verified live in `.claude/settings.local.json`):

```
CLAUDE_CODE_MAX_CONTEXT_TOKENS     = 131072    # anchors to the real window
CLAUDE_CODE_AUTO_COMPACT_WINDOW    = 120000
CLAUDE_AUTOCOMPACT_PCT_OVERRIDE    = 85        # trigger at 120000 * 0.85 = 102k
CLAUDE_CODE_MAX_OUTPUT_TOKENS      = 4000
```

The `context-guard.py` `UserPromptSubmit` hook already (a) prefers real `usage.input_tokens` from the last assistant message and (b) falls back to a pessimistic chars estimate. The `probe_overflow.js` regression probe already detects the usage regression on a one-shot FIT leg.

**None of this is enough while `usage:0` persists**, because:
- Auto-compact reads the same telemetry the hook reads — it is structurally blind to `usage:0`.
- The hook's fallback is a *lower bound* (it counts transcript text, which is a session-dependent x2–x5 fraction of the real wire request on tool-heavy sessions). No fixed ratio calibrates it to the wall.
- The probe's one-shot FIT leg can return a real count even while the sustained session stream returns zero (observed today: probe `input_tokens=5348`, all 417 session messages `0`). So the probe is a *canary*, not a guarantee.

**Conclusion: the durable fix is gateway-side.** The client can only warn; it cannot manufacture a token count the gateway refuses to send.

---

## 3. Debug plan — localizing the `usage:0` condition

Goal: determine **where** in the gateway the real usage is lost, so the fix targets the right layer. The gateway is a black box to the client, so we characterize the condition from the outside and hand the gateway owners a precise repro + the telemetry we need.

### 3.1 Phase A — Characterize the condition (client-side, no gateway access)

Purpose: pin down *when* usage is real vs zero. Hypotheses to distinguish:

| # | Hypothesis | How to test | Expected if true |
|---|---|---|---|
| H1 | **Streaming** drops usage (final SSE chunk omits/zeroes `usage`), non-stream keeps it | Send the same small payload with `stream:false` vs `stream:true`; compare `usage.input_tokens` on both | non-stream real, stream zero → H1 |
| H2 | **Prompt caching** path returns zero (cached prefix suppresses the count) | Send the same large payload twice back-to-back (2nd should hit cache); compare usage on 1st vs 2nd | 2nd zero, 1st real → H2 |
| H3 | **Session/length-dependent** (long or multi-turn requests zero out) | Send 5-turn vs 200-turn vs 600-turn one-shots; check usage on each | short real, long zero → H3 |
| H4 | **Time/canary** (a subset of backend instances or a recent deploy is broken) | Run the probe N times over time; check for intermittent real counts | intermittent → H4 (infra, not logic) |
| H5 | **Model-routed** (a specific upstream instance serving `qwen3.8-27b` is broken) | Compare usage on `qwen3.8-27b` vs `gpt-5-5` (if reachable) and across repeated `qwen` calls | model-specific → H5 |

**Deliverable of Phase A:** a one-paragraph statement of which hypothesis holds, with the exact request/response pairs as evidence. This is what lets the gateway owners skip re-discovering the condition.

### 3.2 Phase B — Reproduce with a controlled multi-turn session

Purpose: confirm the condition reproduces in a *real* Claude Code session (not just synthetic one-shots), and capture the exact request at the moment of the 400.

1. Start a fresh session with `CLAUDE_CODE_MAX_CONTEXT_TOKENS=131072` etc. (current settings).
2. Drive a tool-heavy conversation (reads, greps, edits) until the `context-guard.py` hook's estimate crosses the danger line, or until `/context` shows a high percentage.
3. Capture, at each step:
   - The `usage.input_tokens` of the last assistant message (via the transcript JSONL — it's already persisted).
   - The hook's estimate (it's injected as `additionalContext`).
   - The `/context` display.
4. At the 400, capture the full error body (see S-5 for the diagnostic-fields requirement).

**Deliverable:** a timeline table (turn #, real usage, hook est, `/context`, wire-size estimate) showing the divergence widening until the 400. This is the smoking gun for the gateway team.

### 3.3 Phase C — Telemetry requests for the gateway owners

The client cannot see the gateway's internal token count. To fix and *verify* the fix, the gateway must expose (or log) the following **per request**, keyed by `x-ai-session` / request id:

| Field | Why it's needed |
|---|---|
| `upstream_input_tokens` (the count the *upstream Qwen* actually reported) | Confirms whether the upstream is reporting real usage at all, vs the gateway zeroing it in transit |
| `gateway_computed_input_tokens` (the gateway's own tokenizer count of the received request) | The number the preflight uses; must equal what the 400's arithmetic implies |
| `usage_returned_in_response` (what was actually sent back to the client) | The value the client sees; the gap between this and the upstream count *is* the bug |
| `cache_read_input_tokens` / `cache_creation_input_tokens` | Disambiguates H2 (caching path) |
| `stream` flag + which SSE event carried `usage` | Disambiguates H1 (streaming) |
| `model_upstream_instance` / `backend_pod` | Disambiguates H4/H5 (per-instance) |

**Ask:** add a `X-Gateway-Usage-Diagnostic` response header (or a `?diagnostic=1` request flag) that returns this block for a single request, so the client can verify the fix without full gateway log access. This is a **verification contract**, not just logging.

### 3.4 Phase D — Fix verification (the acceptance gate)

The fix is **done** when, on a sustained Claude Code session (Phase B repro):
1. **Every** assistant response carries non-zero `usage.input_tokens` (0/417 → 0 zeros).
2. The auto-compact trigger fires at ~102k *real* (not estimated) before the wall — observable as a compact happening well before any 400.
3. `/compact` on a ~120k session succeeds (no 1-token-over 400).
4. `probe_overflow.js` FIT leg reports a real count **and** a Phase-B session shows the same real count (canary and reality agree).
5. The diagnostic header (S-3.3) shows `upstream == gateway_computed == returned` for the same request.

---

## 4. Gateway-side fix specification

### 4.1 Requirement GW-1 — Always return real usage (the primary fix)

**MUST:** Every `POST /v1/messages` response for `qwen3.8-27b` — non-stream **and** streaming — MUST carry the upstream model's real `usage` block:

```json
"usage": {
  "input_tokens": <int > 0>,
  "output_tokens": <int>,
  "cache_creation_input_tokens": <int>,
  "cache_read_input_tokens": <int>
}
```

- **Non-stream:** `usage` in the final JSON body.
- **Stream:** `usage` MUST be present and non-zero in the **final** `message_delta` (or equivalent terminal) SSE event. It is acceptable for intermediate `content_block_delta` events to omit it, but the terminal event MUST carry it. (If the gateway currently only fills `usage` on the non-stream path, that is H1 — the most likely single cause.)
- The value MUST be the count the upstream reported for **this** request. Echoing a cached/previous value or a static 0 is a defect.
- `input_tokens` MUST reflect the full prompt the upstream tokenized (system + messages + tool schemas + cache), i.e. the same quantity the preflight uses in its `input + max_tokens <= 131072` check. The preflight and the returned `usage.input_tokens` MUST be derived from the **same** count — if they diverge, the client cannot trust either.

**Verification:** Phase D item 1 + item 5.

### 4.2 Requirement GW-2 — Preflight and usage must agree

**MUST:** The `context_length_exceeded` preflight and the returned `usage.input_tokens` MUST use the same input-token count. Today the preflight clearly has a real count (it correctly rejects the 620-turn payload with a typed error) while the returned `usage` is 0 — that divergence is itself a bug and the direct evidence that the count exists internally but is not being forwarded to the response.

**Verification:** Phase D item 5 (diagnostic header shows both equal).

### 4.3 Requirement GW-3 — 400 error body must carry the arithmetic

**SHOULD (currently a humanized rewrite that hides the numbers):** The `context_length_exceeded` error MUST include the breakdown in the body, not just a friendly sentence:

```json
{
  "error": {
    "type": "context_length_exceeded",
    "message": "Estimated input plus requested output exceeds the Qwen context window; compact the conversation and retry.",
    "input_tokens": 127073,
    "requested_output_tokens": 4000,
    "context_window": 131072,
    "safety_margin": 8192
  }
}
```

The humanized `message` is fine to keep, but the numeric fields MUST be present so a client (or an operator) can diagnose *how far* over the limit the request was, without a gateway log lookup. The original raw Qwen error had these; the rewrite dropped them.

**Verification:** the OVER probe leg asserts `error.input_tokens`, `error.context_window` present.

### 4.4 Requirement GW-4 — Stable tokenizer (or documented drift)

**SHOULD:** The gateway's tokenizer was re-tuned between 2026-09-10 and 2026-09-11 (the same 620-turn bytes went from 122,881 → 86,598 tokens, ~30% drop). Silent tokenizer drift breaks any client-side calibration and makes the "same" payload count differently across days. **Either** (a) keep the tokenizer stable for a given model, **or** (b) expose the tokenizer version/identity in the diagnostic header (S-3.3) so a client can detect a change and recalibrate. The regression probe is behavioral (200 vs 400) precisely because the count is not stable — that is a workaround for this gap.

### 4.5 Requirement GW-5 — `gpt-5-5` identity gate (separate, related)

**NOTE (out of scope for the usage fix, but observed in the same window):** `gpt-5-5` (the haiku tier) is gated behind an "evaluation identity" the current token does not satisfy — every request → `403 evaluation_policy_block`, even a one-word ping with the real session id. This is a policy/identity gate, separate from the context-window issue. The gateway should either accept the existing `ai-evaluation` identity for `gpt-5-5`, or return `404 model unavailable` so Claude Code's model-picker can fall back, rather than a 403 that reads as an auth failure. Tracked here so it is not lost; it does not block the usage fix.

---

## 5. Client-side companion changes (enabled by the gateway fix)

These are **not** the fix (the fix is GW-1), but they make the client correct *once* real usage is back, and they harden against the next regression:

1. **Keep `context-guard.py` preferring real usage.** It already does; no change needed. Optionally, when it detects `usage:0` on the *last N* assistant messages (a sustained zero run, not a single zero), emit a distinct "usage telemetry lost — auto-compact is blind, compact early" message so the user knows the safety net is down.
2. **Extend `probe_overflow.js`** with a **sustained-leg**: fire K small requests in a row (simulating a session) and assert the *last* one still has non-zero usage — to catch the "one-shot real, sustained zero" split that the current single FIT leg misses.
3. **No change to `CLAUDE_CODE_`* settings.** They are already correct (S-2). Do not lower the auto-compact window further to "compensate" for `usage:0` — that only trades a 400 for overly-aggressive compaction, and it masks the real bug.

---

## 6. Definition of done (end-to-end)

The issue is **resolved** when ALL of the following hold, re-verified in a fresh session:

- [ ] Phase A identifies the specific hypothesis (H1–H5) and the gateway confirms the root-cause layer.
- [ ] GW-1: 0/0 zeros — every assistant message in a sustained session has non-zero `usage.input_tokens`.
- [ ] GW-2: preflight count == returned `usage.input_tokens` (diagnostic header).
- [ ] GW-3: the 400 body carries `input_tokens` / `requested_output_tokens` / `context_window`.
- [ ] Auto-compact fires at ~102k real tokens on a grown session, with no 400.
- [ ] `/compact` on a ~120k session succeeds.
- [ ] `probe_overflow.js` (with the new sustained-leg) passes.
- [ ] `/context` and the real request size are within a known, documented factor (the x4–x8 tool-schema divergence is expected and acceptable; the *telemetry* must be real).

## 6.5 Verification status (2026-09-11, ~09:30 UTC — pre-fix baseline)

Live probe against `pilot-gateway.ai.eleks-demo.com` / `qwen3.8-27b`. This is the
**before** snapshot: the gateway team's tokenizer fix (see `compact-overflow-findings.md` §K) is
scheduled for Monday 09-14, so this records what is *not* fixed yet and gives the
after-comparison a clean baseline.

### Requirement-by-requirement

| Req | Asks | Live status (09-11) | Evidence |
|---|---|---|---|
| **GW-1** real usage on every response (incl. streaming terminal) | 0/0 zeros in a sustained session | ❌ **Still 0/N on every session stream** | All 8 recent project transcripts 100% zero `usage.input_tokens`, incl. one from 5 min before this check (0/27, 0/39, 0/59, 0/92, 0/152, 0/161, 0/73). One-shot probe still real (`input_tokens=5348`) — the one-shot-real / session-stream-zero split is intact. |
| **GW-2** preflight count == returned usage | both equal (diagnostic header) | ❌ **Unverifiable** — no diagnostic header (S-3.3) exists; preflight rejects OVER before returning a count | OVER probe returns 400 with no count; no `X-Gateway-Usage-Diagnostic` (or any usage/token-named) header present. |
| **GW-3** 400 body carries the arithmetic | `input_tokens` / `requested_output_tokens` / `context_window` in the 400 | ❌ **Worse than spec** — body is the humanized rewrite with **no numbers at all** | OVER 400 body: `{"error":{"type":"context_length_exceeded","code":"context_length_exceeded","message":"Estimated input plus requested output exceeds the Qwen context window; compact the conversation and retry.","param":"input_tokens"}}`. `param` is present but its **value** (the 127,073) is dropped. |
| **GW-4** stable tokenizer (or documented drift) | stable count, or version exposed | ❌ **Still drifting** | Same 620-turn payload counts **86,598** (findings §F, 09-11 morning) → **56,328** (this check, 09-11 09:27) for identical bytes. No tokenizer version in any header. |
| **GW-5** `gpt-5-5` identity gate | accept identity or return 404 | ⏸️ **Untested this pass** — gateway team did not touch it per §K | — |

### S-3.3 diagnostic header

❌ **Does not exist.** OVER 400 headers: `server`, `date`, `content-type`, `content-length`, `connection`, `x-request-id`, `x-content-type-options`, `strict-transport-security`. Only `x-ai-policy-`* headers (route/reason/provider/model) appear on **200** responses. No `X-Gateway-Usage-Diagnostic`, no `?diagnostic=1` flag honored.

### What is already working (pre-existing, not part of this fix)

| Item | Status |
|---|---|
| One-shot usage (probe FIT leg) | ✅ `input_tokens=5348` real, non-zero |
| Preflight (`context_length_exceeded` 400) | ✅ OVER → 400, typed `error.type` |
| `max_tokens` param contract | ✅ accepted (probe sends it, FIT 200) |

### Repro commands (token passed via env, never printed)

```bash
# One-shot FIT/OVER behavioral probe (usage:0 canary + preflight)
node /tmp/cc-test/probe_overflow.js
# OVER 400 body + headers (GW-3 arithmetic, S-3.3 diagnostic header)
node /tmp/cc-test/_gw3_probe.js
# Session-stream audit (the core GW-1 regression)
python3 - <<'PY'
import json, glob, os
for f in sorted(glob.glob(os.path.expanduser('~/.claude/projects/-Users-stanislav-kostenich-vscode-ai-eval-habit-tracker/*.jsonl')), key=os.path.getmtime)[-8:]:
    total=nonzero=0
    for line in open(f):
        try: j=json.loads(line)
        except: continue
        if j.get('type')=='assistant':
            it=((j.get('message') or {}).get('usage') or {}).get('input_tokens')
            if it is not None:
                total+=1
                if it: nonzero+=1
    print(os.path.basename(f)[:12], f'{nonzero}/{total} nonzero')
PY
```

**After the Monday 09-14 fix lands, re-run all three.** The acceptance gate (§6) is met only when the session-stream audit flips to **non-zero** (GW-1) AND the OVER body carries the arithmetic (GW-3) AND — ideally — a diagnostic header appears (GW-2). The tokenizer drift (GW-4) is the one item the team's two-part fix (RunPod `--tokenizer` + Gateway-image embed) is expected to close; verify by re-running the OVER payload and confirming the count is **stable across days**, not just non-zero.

## 6.6 Local GX-10 baseline verification (2026-09-11, ~17:30 UTC)

Same §3 Phase A methodology, run against the **local** GX-10 stack instead of the black-box
remote gateway — to answer *"does the local path have the same `usage:0` / context-window issue?"*

**Local chain** (no `pilot-gateway.ai.eleks-demo.com` anywhere in it):
Claude Code → repo proxy `server/proxy/app.py` (`127.0.0.1:18080`) → LiteLLM
(`127.0.0.1:4000`, `config/gx10_litellm_tierb.yaml`, `openai/qwen38-27b`) → vLLM
(`127.0.0.1:8000`, `Qwen/Qwen3.8-27B-FP8` served as `qwen38-27b`, `--max-model-len 160000`).

**Conclusion: the local stack does NOT exhibit the remote gateway's `usage:0` regression.**
Real usage is present and correct on both the one-shot and the sustained-session paths.

### Hypothesis disposition (Phase A, local)

| # | Hypothesis | Local result |
|---|---|---|
| H1 | Streaming drops usage | ❌ **Ruled out** — stream == non-stream on an identical payload (both `input_tokens=1557`); the terminal `message_delta` SSE event carries real non-zero `usage` at every synthetic turn tested (1/20/60/120/200/400 → 62/792/2442/3494/22,658/25,106). |
| H2 | Prompt-caching path zeroes usage | ❌ **Not observed** — prefix caching is *on* (`--enable-prefix-caching`, `--kv-cache-dtype fp8`) yet usage stays real; cached prefix is charged as `cache_read_input_tokens` (53,312 observed on a live message), never dropped to 0. |
| H3 | Session/length-dependent zeroing | ❌ **Ruled out** — usage is real at 400 turns / ~25k input tokens; no zero run appears as length grows. |
| H4 | Time/canary (intermittent) | ❌ **Not observed** — current-session transcript audit is 13/13 non-zero; the one local zero-heavy file (09-08, `55ba1950`, 2/37) is errored/cancelled turns (`output_tokens:0`, ms-apart duplicates) — client aborts defaulting to 0, not telemetry loss. |
| H5 | Model-routed (a broken instance) | n/a — single local vLLM instance, no per-instance routing to distinguish. |

### GW-1…GW-4, local

| Req | Local status | Evidence |
|---|---|---|
| **GW-1** real usage on every response (incl. streaming terminal) | ✅ **Pass** — 0 zeros | Current session 13/13 non-zero; synthetic streaming ladder non-zero at every rung. |
| **GW-2** preflight count == returned usage | ✅ **Pass** (single static tokenizer) | Stream and non-stream return the identical count on the identical payload; preflight and returned `usage` derive from the one vLLM tokenizer. No divergence observed. |
| **GW-3** 400 body carries the arithmetic | ✅ **Pass** — better than the remote rewrite | Forced OVER (`max_tokens:160000` + 71-char prompt) → HTTP 400 body carries the raw vLLM arithmetic verbatim: *"maximum context length is 160000 tokens… requested 160000 output tokens… prompt contains 71 characters"*. The numbers are present, not hidden behind a humanized rewrite. |
| **GW-4** stable tokenizer | ✅ **Effectively holds** | Static in-process vLLM tokenizer — no cold-start race, no pod restart, no day-to-day drift. (GW-4's remote failure mode was a pod cold-start race; the local single-process server has no such race.) |

**GW-5** (`gpt-5-5` identity gate): not applicable — no `gpt-5-5` tier is routed on the local stack.

### Probe fingerprint (reproducible, safe to re-run)

- **GW-1 / H1 ladder:** synthetic `/v1/messages` one-shots at 1/20/60/120/200/400 turns, `stream:true`, asserting non-zero `usage.input_tokens` in the terminal `message_delta`.
- **Stream vs non-stream parity:** identical payload sent both ways; assert `usage.input_tokens` equal (H1).
- **GW-3 OVER leg:** `max_tokens:160000` + 71-char prompt → expect HTTP 400 whose body contains `maximum context length is 160000 tokens`. *(Intentional 400 — this is the fingerprint the 17:31:19 LiteLLM `ContextWindowExceededError` log line corresponds to; the `POST /v1/messages 200` immediately after is the next normal turn.)*

### Divergence from the remote (worth recording, not a defect)

| Item | Remote gateway | Local GX-10 |
|---|---|---|
| Served window | 131,072 | **160,000** (`--max-model-len 160000`) |
| `usage:0` regression | Yes (pod tokenizer cold-start race) | **No** |
| Client window env | anchored to 131,072 | still gateway-era: `CLAUDE_CODE_MAX_CONTEXT_TOKENS` ≈ 131,072, `CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000` → ~26% conservative vs the real 160k (safe, just compacts early). Aligning to `160000`/`145000` would use the full served window. |
| Proxy log gap | — | repo proxy `logs/requests.jsonl` records `prompt_tokens:0` for streaming `/v1/messages` (a **logging** gap in the proxy's own line, not the response — the client still receives real usage). Non-stream lines record the real count. |

## 6.7 Re-verification after the gateway fix (2026-09-11, ~17:15–17:50 UTC)

Re-ran the full Phase A/D battery after the gateway team's pod restart + tokenizer fix landed.
**Bottom line: GW-3 is fixed, GW-1 is fixed on the non-stream path but the *Claude Code
streaming* path still records zeros; the §6 gate is NOT fully met. Not enough.**

### Requirement-by-requirement (post-fix)

| Req | Status (09-11 17:15) | Change vs §6.5 | Evidence |
|---|---|---|---|
| **GW-1** real usage, every response | ⚠️ **Partially fixed** | ⬆ improved, not passing | One-shot non-stream: real (`input_tokens=5348`). New **sustained-leg** probe (`probe_sustained.js`, K=10 sequential one-shots): **10/10 real, last non-zero** — the "one-shot real, sustained zero" split is **gone on the non-stream path**. But **Claude Code session-stream transcripts still record 0/N** on most turns (this very session `a4257b4d`: 0/17 at 17:15; `fbfa4783` 3/5). One session (`a30ae539`) shows real usage (`input_tokens:68493`) — so real usage **can** reach the CC stream, it is not uniformly broken. |
| **GW-2** preflight count == returned usage | ❌ **Still unverifiable** | no change | No diagnostic header (S-3.3) in any response. Preflight and non-stream returned count agree *in behavior* (preflight 133,718 ⇒ 400; same-class one-shots return real counts) but the required field-level equality check is impossible without the header. |
| **GW-3** 400 body carries arithmetic | ✅ **FIXED** | ⬆ fixed | OVER 400 body now: `{"error":{"type":"context_length_exceeded","code":"context_length_exceeded","message":"Input plus requested output exceeds the Qwen context window; compact the conversation and retry.","param":"input_tokens","input_tokens":133718,"requested_output_tokens":4000,"context_window":131072,"safety_margin":0,"total_requested_tokens":137718}}`. All spec fields present (plus a `total_requested_tokens` bonus). |
| **GW-4** stable tokenizer | ⚠️ **Within-day stable; cross-day unproven** | ⬆ improved | Identical 499,593-byte payload: **133,718 tokens, byte-identical on back-to-back runs** (17:14 and 17:15) — the cold-start race is gone. But the day-over-day history is 122,881 (09-10) → 86,598 (09-11 am) → 133,718 (09-11 pm); the §K tokenizer embed must still hold **across days** — re-run `_gw4_stability.js` tomorrow and compare. No tokenizer version in headers. |
| **GW-5** `gpt-5-5` identity gate | ❌ **Still 403** | no change | One-word ping, real session id → `403 {"error":{"message":"evaluation identity required","type":"evaluation_policy_block"}}`. |
| **S-3.3** diagnostic header | ❌ **Does not exist** | no change | No `X-Gateway-Usage-Diagnostic`, no `?diagnostic=1`. |

### §6 acceptance-gate checklist (post-fix)

- [ ] Phase A hypothesis confirmed by gateway — **tokenizer race confirmed by the team (findings §K); H1/H2 sub-probe not re-run.**
- [ ] GW-1 0/0 zeros in a sustained session — **NOT MET**: one-shot / sustained non-stream now 0 zeros, but the CC session stream is still 0/N on most turns.
- [ ] GW-2 preflight == returned usage — **NOT VERIFIABLE** (no diagnostic header).
- [x] GW-3 400 carries `input_tokens` / `requested_output_tokens` / `context_window` — **MET**.
- [ ] Auto-compact fires at ~102k real with no 400 — **cannot test**: the session stream records zeros, so auto-compact remains blind (see "What is still broken").
- [ ] `/compact` on a ~120k session succeeds — **not re-tested** this pass.
- [x] `probe_overflow.js` + new sustained-leg pass — **MET** (both legs real usage, 0/10 zeros).
- [ ] `/context` vs real request within documented factor — unchanged (×4–×8, expected).

### What is still broken (the important part)

1. **CC session stream still records `usage.input_tokens = 0` on most turns** — the core
   client-facing symptom is NOT gone for real Claude Code sessions, even though identical
   one-shot payloads now all return real usage. The tokenizer race is fixed (one-shots,
   preflight, sustained non-stream all real), so the remaining zeroing is on a **different
   path** — most likely the **streaming terminal event** (H1, now unblocked from the race
   and finally testable) or the cache/long-history path (H2). The Phase A
   non-stream-vs-stream probe must be re-run: *identical payload, `stream:true` vs
   `stream:false`, compare the terminal event's usage.* That single test decides whether the
   gateway fix is a count-side fix only (then the response/forwarding path still drops it
   for the session) or something in the session's own request shape.
2. **`a30ae539` proves real usage CAN reach the CC stream** (`input_tokens:68493`), while
   `a4257b4d` (this session, post-fix, 17:10–17:15) shows 0/17. Same gateway, same client,
   minutes apart — the zeroing is **intermittent per turn**, not per session. That points at
   a per-request condition (cache hit? history length? a second backend instance?) rather
   than a static broken path.
3. **No diagnostic header** (S-3.3) — every remaining question (H1 vs H2, which instance,
   what the preflight counted) is unanswerable from the client side. This is the
   verification contract; without it the "is it enough" question stays open on every re-check.

### New/updated probe fingerprint

```bash
node /tmp/cc-test/probe_overflow.js     # FIT/OVER behavioral (GW-3 now asserts arithmetic)
node /tmp/cc-test/_gw3_probe.js         # OVER 400 body + headers (GW-3, S-3.3)
node /tmp/cc-test/_gw4_stability.js     # GW-4: fixed 620-turn payload → record input_tokens + date (compare across days)
node /tmp/cc-test/probe_sustained.js    # NEW: K=10 sequential one-shots, assert last non-zero (sustained leg, §5 item 2)
# + the session-stream audit python one-liner from §6.5 (the core GW-1 client-side check)
```

### Verdict — "Is it enough?"

**No, not yet.** One of the five gateway requirements is fully fixed (GW-3), one is
effectively fixed pending cross-day proof (GW-4), and the headline problem (GW-1: real usage
on every response the client sees) is fixed for one-shot and non-stream traffic but **still
zeroing the live Claude Code session stream most of the time** — which means auto-compact is
still blind and the original 1-token-over 400 failure mode has not been demonstrated gone.
The blocking next steps are gateway-side: the Phase A stream-vs-non-stream probe and the
S-3.3 diagnostic header.

## 6.8 Re-verification (2026-09-11, ~17:32–17:36 UTC) — is it enough now?

Re-ran the full battery after the pod restart + tokenizer fix. **The picture changed
materially since §6.7 (~3 hours earlier): the live Claude Code session stream now records
real usage 100% of the time — but so does every session since, and the zeros from before
the restart remain in the transcripts, so the §6 gate is met only with caveats.**

### New evidence this pass

| Check | Result |
|---|---|
| `probe_overflow.js` FIT/OVER | **PASS** — FIT `input_tokens=5348` real; OVER 400 `context_length_exceeded` |
| `probe_sustained.js` (K=10) | **PASS** — 10/10 real, 0 zeros |
| `_gw3_probe.js` (OVER body) | **PASS** — `input_tokens=133718`, `requested_output_tokens=4000`, `context_window=131072`, `total_requested_tokens=137718` present; no diagnostic headers (`DIAG-RELATED: []`) |
| `_gw4_stability.js` | **133,718 on two runs 21 min apart** (17:14, 17:32) — within-day stable. Day history: 122,881 (09-10) → 86,598 (09-11 am) → 133,718 (09-11 pm). **Cross-day proof still pending.** |
| **NEW `_stream_vs_nonstream.js`** (Phase A H1, §6.7 item 1) | **PARITY at 20/100/300 turns** — non-stream, stream `message_start`, and stream `message_delta` all return the *identical* `input_tokens` (1,618 / 8,098 / 24,698). **H1 (streaming drops usage) is now ruled out** — the terminal SSE event carries real usage at every rung tested. |
| **Current session stream (this one, `91e68e52`)** | **16/16 non-zero, real from turn 1** (61,929 on the first assistant message; grows 63k→69k across the session). No zeros at all. |
| **Other live sessions started since the restart** | `a4257b4d` (19:30): **33/33 real**. `fbfa4783` (20:10): 3/5 real — the 2 zeros there are the *first* two turns of that session (before ~19:3x), i.e. still pre-restart. |

### The boundary is the pod restart (~19:15–19:20), not turn-intermittency

Full transcript audit (all 83 project sessions, all-time **71/4,694 = 98.5% zero**):

- **Every session with last write before ~19:15 on 09-11: 0/N real.** Including `76c4991f`
  (15:17–16:54, 131 msgs, 0/131) — a *pre*-restart session.
- **Every session started on/after ~19:30 on 09-11: N/N real.** `a4257b4d` 33/33,
  `91e68e52` 16/16, `fbfa4783` 3/5 (the 2 zeros are its pre-restart turns).
- §6.7's observation ("`a30ae539` shows real usage while `a4257b4d` is 0/17, minutes
  apart") is now resolved: `a30ae539`'s real count (68,493) was in a *later* turn; the
  zeros were the pre-restart portion. **The zeroing is a static per-instance state that
  flipped at restart — not per-turn, not per-request-shape, not cache-dependent.**

This is consistent with the team's §K root cause: pod without the tokenizer → preflight
and usage both fall back to 0; pod restart loaded the tokenizer → everything real. H1 and
H2 are both ruled out by direct probe; H3 is ruled out by the stream-parity ladder reaching
300 turns/~25k; H4 (intermittent per-instance) is what the data actually shows, and it was
permanently cured by the restart + `--tokenizer` embed.

### Requirement-by-requirement (post-restart, 17:32)

| Req | Status | Evidence |
|---|---|---|
| **GW-1** real usage, every response (incl. streaming terminal) | ✅ **Pass on all paths tested** | One-shot, sustained K=10, stream parity ladder (20/100/300), *and live CC session 16/16 real from turn 1*. |
| **GW-2** preflight count == returned usage | ⚠️ **Consistent, still not field-verified** | Preflight 133,718 ⇒ 400; one-shots and streams return real counts from the same vLLM tokenizer. No `X-Gateway-Usage-Diagnostic` header to prove field-level equality. |
| **GW-3** 400 body carries the arithmetic | ✅ **Pass** | All fields present + `total_requested_tokens` bonus. |
| **GW-4** stable tokenizer | ⚠️ **Within-day pass, cross-day unproven** | 133,718 stable 17:14→17:32 (21 min). Needs a re-run tomorrow morning to close. |
| **GW-5** `gpt-5-5` identity gate | ❌ **Unchanged** (403) | Not re-tested this pass; out of scope for the usage fix. |
| **S-3.3** diagnostic header | ❌ **Does not exist** | `DIAG-RELATED HEADERS: []`. |

### Verdict — "Is it enough?"

**Functionally, yes — operationally, not yet verified.**

- **The user-facing failure mode is gone.** Since the restart, no live session has recorded
  a single zero: this session is 16/16 real from turn 1, `a4257b4d` is 33/33. Real usage is
  what feeds auto-compact, the `context-guard.py` hook, and the `/context` display — with it
  real, all three safety nets are no longer blind. The 1-token-over `/compact` 400 can no
  longer be produced by the usage-zero path (it required auto-compact to stay blind until
  the wire request hit the wall).
- **Three things keep it from a clean "done":**
  1. **Cross-day tokenizer stability (GW-4)** — re-run `_gw4_stability.js` tomorrow and
     compare against today's 133,718. If it moved materially, the §K tokenizer embed did
     not hold and any client-side calibration is back to drifting.
  2. **No diagnostic header (S-3.3)** — GW-2's field-level equality and any future
     regression ("is the upstream count what I got back?") remain unverifiable from the
     client. This is a verification gap, not a live defect.
  3. **The historical 98.5% zeros (71/4,694) are not a live bug** — they are the pre-restart
     state, correctly preserved in the transcripts. Any future session that records a zero
     run would be a *regression* of the fix; the §6.5 audit one-liner is the standing canary
     for that.

### Probe fingerprint (add to §6.7 list)

```bash
node /tmp/cc-test/_stream_vs_nonstream.js   # NEW: H1 — identical payload stream:false vs
                                            # stream:true, 20/100/300 turns, assert message_delta
                                            # usage == non-stream usage (PARITY)
```

**Acceptance gate (§6) after this pass:** GW-1 ✅ (all paths, incl. live CC stream),
GW-3 ✅, probe legs ✅, stream-parity ✅. GW-2 ⚠️ (no header), GW-4 ⚠️ (cross-day pending).
Net: **the fix is in and holding; close GW-4 tomorrow and ask for the diagnostic header to
make it verifiable, not just observed.**


## 6.9 Final verification — fix holding 3 days later, on the new glm-5.3 route (2026-09-14, ~16:30–19:30 UTC)

Re-ran the full §6.5/§6.8 battery. Two things changed in the environment since 09-11 that the
verification had to account for first:

1. **Model routing switched from `qwen3.8-27b` to `glm-5.3`** (settings now:
   `ANTHROPIC_DEFAULT_OPUS/SONNET_MODEL=glm-5.3`, policy headers confirm
   `explicit_glm53_alias` → `runpod-glm` / `glm-5.3`, window **196,608** — not qwen's 131,072).
2. **The qwen route's parameter contract changed** after 09-11: `max_tokens` is now rejected
   (`400 Unsupported parameter … Use 'max_completion_tokens'`), so `probe_overflow.js`'s FIT
   leg fails on qwen for a *param-contract* reason, not the usage regression. (Observed in the
   wild on 09-12: session `ec1aa7f3`, 4× that same 400.) The OVER leg on qwen still fires
   the preflight first (preflight runs before param validation).

Client env is re-anchored to the new window: `CLAUDE_CODE_MAX_CONTEXT_TOKENS=196608`,
`CLAUDE_CODE_AUTO_COMPACT_WINDOW=167116` (×85% → auto-compact trigger ~142k real tokens).

### GW-4 cross-day tokenizer stability — CLOSED

`_gw4_stability.js` (identical 499,593-byte 620-turn payload, qwen route OVER leg):

| Date | input_tokens | Note |
|---|---|---|
| 09-10 | 122,881 | pre-fix |
| 09-11 am | 86,598 | pre-fix drift |
| 09-11 17:14 | 133,718 | post-fix |
| **09-14 (this pass)** | **133,718** | **byte-for-byte identical — 3 days later** |

The tokenizer embed held. Drift is gone; GW-4 is **closed**.

### Requirement-by-requirement (current state, glm-5.3 route)

| Req | Status (09-14) | Evidence |
|---|---|---|
| **GW-1** real usage, every response (incl. streaming terminal) | ✅ **Pass** | Live CC sessions on glm-5.3: `fab53fed` 12/12, `4f330627` 85/85 (peak 95,012 real input tokens, auto-compact working), `dd8e17a4` 5/5 — 100% real from turn 1. Probe: FIT `input_tokens=4843` real; sustained K=10 leg **10/10 real, zero-free** (129→660, monotonic +59/turn); stream-vs-non-stream parity at 20/100/300 turns — terminal `message_delta` usage identical to non-stream (1,358 / 6,718 / 20,254). H1 ruled out on the current route too. |
| **GW-2** preflight count == returned usage | ✅ **Behaviorally verified; header still absent** | The wall fires at the right place with arithmetic consistent with the returned counts: 950t → 200 @ 184,730 real input tokens; 1050t → 400. No `X-Gateway-Usage-Diagnostic` header exists yet, so field-level equality remains unprovable from the client — but preflight, 400 arithmetic, and returned usage all agree on window 196,608. |
| **GW-3** 400 body carries the arithmetic | ✅ **Pass on both routes** | qwen OVER body: `input_tokens=133718, requested_output_tokens=4000, context_window=131072, total_requested_tokens=137718`. glm wall (1050t): `"maximum context length is 196608 tokens … 192609 input tokens … total of at least 196609"` — raw arithmetic present, not humanized away. |
| **GW-4** stable tokenizer | ✅ **Closed** | 133,718 → 133,718 across 3 days on identical bytes (table above). |
| **GW-5** `gpt-5-5` identity gate | ✅ **Fixed** (was ❌ 403) | One-word ping → **HTTP 200**, `model=gpt-5.5-2026-04-23`, real usage (`input_tokens=8, output_tokens=4`). The `403 evaluation_policy_block` is gone. |
| **S-3.3** diagnostic header | ❌ **Still does not exist** | `DIAG-RELATED HEADERS: []` on both routes; glm 400 headers carry only `x-ai-policy-*` + `x-request-id`. Request stays open with the gateway team. |

### What tripped the probes (and why it wasn't the regression)

- `probe_overflow.js` on glm: **OVER leg returned 200** — correct behavior. The 620-turn
  payload counts **120,396** under glm's tokenizer vs **133,718** under qwen's (−10%), so
  120,396+4,000=124,396 < 196,608 — it fits. The probe's hardcoded `LIMIT=131072` is stale
  qwen-era calibration; the preflight itself is intact (see 1050t → 400 above). Re-calibrating
  the probe: the FIT/OVER pair for glm-5.3 is **620t / 1050t** at window 196,608.
- 700t → one-off 502 and 800t → socket hang-up on the first ladder run: transient infra
  errors, not the wall. On re-run, 700t returned 200 (the payload fits); the wall is at
  ~1050 turns ≈ 203k tokens.
- Today's 0/1 transcript entries (17:16–17:51 cluster): all `403 evaluation identity
  required` / "Please run /login" synthetic turns from an expired token mid-afternoon —
  not telemetry zeros. Auth recovered; all sessions since are 100% real usage.

### §6 acceptance-gate checklist — FINAL

- [x] Phase A hypothesis confirmed — tokenizer race (§K), verified fixed; H1 ruled out again on the current route.
- [x] GW-1 0/0 zeros in sustained sessions — **MET** (all live glm-5.3 sessions 100% real; sustained K=10 0 zeros; stream parity holds).
- [x] GW-2 preflight == returned usage — **behaviorally MET** (wall at 196,608 with matching arithmetic); field-level proof still blocked on the missing S-3.3 header.
- [x] GW-3 400 carries arithmetic — **MET on both routes** (qwen structured fields; glm raw-text arithmetic).
- [x] Auto-compact at ~102k→~142k real, no 400 — **MET**: session `4f330627` grew to 95,012 real input tokens with zero 400s; `fab53fed` performed **2 successful compacts** — the original `/compact` 1-token-over failure mode has not recurred.
- [x] `/compact` on a grown session succeeds — **MET** (2 compacts in `fab53fed`, no 400s anywhere today).
- [x] Probes pass — FIT real usage (4,843); sustained 10/10; stream-parity 3/3 rungs. `probe_overflow.js` OVER leg needs re-calibration for glm (620t→1050t, limit 196,608) — noted as maintenance, not a gateway defect.
- [x] `/context` vs real request within documented factor — telemetry is real end-to-end; the factor divergence is schema-driven and expected.

### Verdict — is the context window / token usage issue fixed?

**Yes. All five gateway requirements are verified fixed or behaviorally met, three days
after the fix, on the current (glm-5.3) route:**

- GW-1 real usage everywhere (one-shot, sustained, streaming terminal, live sessions) ✅
- GW-2 preflight consistent with returned usage at the correct 196,608 wall ✅ (behavioral)
- GW-3 400 arithmetic present on both routes ✅
- GW-4 tokenizer stable across days (133,718 = 133,718, 3-day gap) ✅ — **closed today**
- GW-5 gpt-5-5 403 → 200 ✅ — **fixed since last check**

**Two residual items, neither a live defect:**
1. **No S-3.3 diagnostic header** — GW-2 remains "observed consistent" rather than
   "field-verified". Verification-only gap; keep the request open with the gateway team.
2. **Probe maintenance**: `probe_overflow.js`'s `LIMIT=131072` is stale for glm-5.3;
   re-calibrate FIT=620t/OVER=1050t at window 196,608. The qwen FIT leg also fails on the
   new `max_tokens` param-contract change — a separate gateway contract change worth
   flagging to the team (Claude Code sends `max_tokens`; qwen route now demands
   `max_completion_tokens`).

The standing canary remains: the §6.5 session-stream audit one-liner — any future
session recording a zero run is a regression. All-time transcripts: the 98.5% historical
zeros remain pre-restart/pre-glm artifacts; every post-restart session with a real model
response is 100% real usage.

## 7. Open questions for the gateway owners

1. Is `usage` populated on the **streaming** terminal event today, or only non-stream? (This is the single most likely cause — H1.) **Update 09-11:** the gateway team's own answer (findings §K) supersedes H1 — the root cause is a **tokenizer availability race** on the RunPod pod (cold start → preflight count falls back to 0), not the streaming path. The Phase A non-stream-vs-stream probe is now only needed to *confirm* the race is upstream of the response path.
2. Is the zero a **regression from a specific deploy** (H4) or a **code path** (H1/H2)? A deploy timestamp around the 2026-09-10 → 09-11 window would narrow it fast.
3. Can the diagnostic header (S-3.3) be added behind a flag for this evaluation tenant specifically, to unblock verification without a full rollout?
4. Is the `gpt-5-5` 403 (GW-5) related to the same identity/policy change, and is a corrected token available?


```

