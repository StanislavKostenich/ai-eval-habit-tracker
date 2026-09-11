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
3. **No change to `CLAUDE_CODE_*` settings.** They are already correct (S-2). Do not lower the auto-compact window further to "compensate" for `usage:0` — that only trades a 400 for overly-aggressive compaction, and it masks the real bug.

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

❌ **Does not exist.** OVER 400 headers: `server`, `date`, `content-type`, `content-length`, `connection`, `x-request-id`, `x-content-type-options`, `strict-transport-security`. Only `x-ai-policy-*` headers (route/reason/provider/model) appear on **200** responses. No `X-Gateway-Usage-Diagnostic`, no `?diagnostic=1` flag honored.

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

## 7. Open questions for the gateway owners

1. Is `usage` populated on the **streaming** terminal event today, or only non-stream? (This is the single most likely cause — H1.) **Update 09-11:** the gateway team's own answer (findings §K) supersedes H1 — the root cause is a **tokenizer availability race** on the RunPod pod (cold start → preflight count falls back to 0), not the streaming path. The Phase A non-stream-vs-stream probe is now only needed to *confirm* the race is upstream of the response path.
2. Is the zero a **regression from a specific deploy** (H4) or a **code path** (H1/H2)? A deploy timestamp around the 2026-09-10 → 09-11 window would narrow it fast.
3. Can the diagnostic header (S-3.3) be added behind a flag for this evaluation tenant specifically, to unblock verification without a full rollout?
4. Is the `gpt-5-5` 403 (GW-5) related to the same identity/policy change, and is a corrected token available?

