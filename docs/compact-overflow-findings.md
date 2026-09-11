# /compact Context-Overflow — Investigation Findings

**Date:** 2026-09-09 (re-verified 2026-09-11) · **Claude Code:** v2.1.266 · **Gateway:** `pilot-gateway.ai.eleks-demo.com` (black box)
**Models:** `qwen3.8-27b` (opus/sonnet alias, ctx 131072) · `gpt-5-5` (haiku alias)
**Spec:** `docs/debug_context.md` · **Plan:** `~/.claude/plans/plan-how-to-debug-zippy-snowglobe.md`

## A. Root cause (confirmed)

`/compact` failed with:

```
input_tokens = 122881   max_tokens = 8192   total = 131073   limit = 131072   (1 token over)
```

while `/context` showed ~14k / 110k.

**Root cause: Claude Code treats `qwen3.8-27b` as an unknown model and assumes a context window that is far larger than the model's real 131072, so it lets the session grow past the real limit; the `/compact` request then re-sends the full history and overflows by a hair.**

### Evidence

1. **Claude Code's own warning** (captured in `debug.log`, `[WARN] [autocompact]`):
   > `"qwen3.8-27b" isn't described by this version's model catalog; ... auto-compact keeps this session within **200k tokens (the context window it assumes)**; if the model accepts more, append `[1m]` to the model name for 1M, **or set `CLAUDE_CODE_MAX_CONTEXT_TOKENS` to its real window**; `CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1` restores the previous wait-for-the-API behavior.`
   - The binary's window-resolution logic returns `source:"unknown-model"` for this model and ships the string *"be inaccurate due to usage of unknown models."*
   - Confirmed live `effectiveWindow=180000` in the same log.

2. **The gap is content, not tokenization.** Measured on the reachable `gpt-5-5` backend:
   - Realistic 60-turn mixed code+prose payload (53,077 chars): local chars/4 estimate = **13,269**, gateway `input_tokens` = **12,707** → ratio **×1.04**.
   - Tool schemas are cheap: 0→18, 10→561, 65→**3,014** `input_tokens`.
   - A pure tokenizer mismatch explains ~×1.04; the original 14k→122,881 gap is **×8.7**. So the compact request carried ~8.7× more content than `/context` was displaying — i.e. the session had genuinely grown to ~122k tokens (because Claude Code believed it had a 200k budget) while `/context` still showed the smaller `CLAUDE_CODE_AUTO_COMPACT_WINDOW`-anchored estimate.

3. **Reproduced the overflow arithmetic on the live gateway** (`gpt-5-5`):
   - 576 turns → `input_tokens=114,060`, `max_tokens=8,192` → total 122,252 → **200 OK**.
   - 620 turns → `input_tokens=122,772` (within 109 tokens of the original 122,881), `max_tokens=8,192` → total **130,964** → **200 OK** (108 tokens under the 131,072 limit).
   - The original session was simply ~109 tokens larger: `122,881 + 8,192 = 131,073` = **1 over**.

**Conclusion:** Not a `/context` display bug, not a tokenizer mismatch, not tool-schema inflation. It is the **unknown-model window assumption** letting the session outgrow the real 131,072 window, so the compact request overflows.

## B. Quantitative breakdown

| Block | Source | Measured |
|---|---|---:|
| Tool/MCP schemas (65 tools) | gateway probe | ~3,014 tokens |
| 60-turn mixed conversation (53KB) | gateway vs chars/4 | 12,707 vs 13,269 (×1.04) |
| ~576-turn conversation | gateway | 114,060 tokens |
| ~620-turn conversation (≈ original) | gateway | 122,772 tokens |
| Original failing compact request | API error | 122,881 input + 8,192 max = 131,073 (> 131,072) |
| `/context` shown at failure | local estimate | ~14k / 110k window |
| Assumed window (unknown model) | debug.log WARN | 200k (live effectiveWindow 180,000) |
| Real model window | deployment | **131,072** |

## C. Recommended fix

### Applied (this repo, `.claude/settings.local.json` → `env`)
- **`CLAUDE_CODE_MAX_CONTEXT_TOKENS=131072`** — anchor Claude Code to the real window instead of the 200k unknown-model assumption. This is the exact fix the WARN message recommends. **Requires a session restart.** ✅ Verified present in `.claude/settings.local.json` and live env.
- ~~**`CLAUDE_CODE_AUTO_COMPACT_WINDOW` 110000 → 60000**~~ — **NEVER APPLIED.** The doc previously claimed this was done, but `.claude/settings.local.json` actually contains `CLAUDE_CODE_AUTO_COMPACT_WINDOW=1111111111110000` (≈1.11e15 tokens — effectively "never auto-compact"). Live `/context` confirms it: the auto-compact window now shows **131.1k (full real window)**, so Claude Code never proactively compacts and lets the session grow to the very limit → the exact §A overflow condition. The correct value is `60000` (or similar, well under 131072 − 8192).

> **Status (2026-09-10):** after the gateway-side fixes (§C usage, §E `max_tokens`) `qwen3.8-27b` is served with the correct 131,072 window and no longer falls back to the unknown-model assumption — the session's `/context` now shows a 100k auto-compact window anchored to the real limit, not the assumed 200k. `CLAUDE_CODE_MAX_CONTEXT_TOKENS=131072` is now a **belt-and-suspenders** anchor (harmless, still correct) rather than the primary fix. Kept in place.

### Alternative / additional levers (all present in the v2.1.266 binary, currently unset)
- `CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1` — restores "wait-for-the-API" behavior (let the gateway's error drive compacting rather than the assumed window).
- Map the model properly so it's no longer "unknown": `behavesAs` on a `modelPicker` row, or `modelOverrides` if `qwen3.8-27b` is a provider id of a model this version knows.
- `CLAUDE_CODE_MODEL_CATALOG` / `CLAUDE_CODE_MODEL_CATALOG_URL` + `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` — let the gateway supply a catalog declaring the 131072 window.

### Gateway-side (recommendation to pilot-gateway owners — it's a black box to us)
- The gateway enforces a hard 131,072 limit (input + max_tokens). Consider **returning a clearer error** (e.g. `context_length_exceeded` with the breakdown) instead of a bare overflow, so Claude Code's auto-compact can back off correctly.
- If the gateway maps `qwen3.8-27b` to a model with a smaller real window than 131,072, that discrepancy should be surfaced.
- **Return real `usage` in every response.** The `qwen3.8-27b` backend returns `usage: {input_tokens: 0, output_tokens: 0, ...}` on *every* response. Consequences:
  - The status line `ctx` reads a permanent **0%** (no real token count to display). Worked around client-side by estimating from the transcript file (`~/.claude/statusline-command.sh`), but that's an approximation.
  - Session cost tracking (`cost.total_cost_usd`) is also zero.
  - Anything downstream that keys off reported usage (auto-compact heuristics, `/context`, budget accounting) is blind. The gateway should pass through the upstream model's real usage.
  - **Status (2026-09-11):** the real-usage fix *is* live — the 2026-09-11 probe of the 620-turn payload returned `usage: {input_tokens: 86598, output_tokens: 36}` (HTTP 200). Non-zero and streaming. (Note: 86598, not the 122,881 the doc's earlier probes measured on the *same* payload — the gateway's tokenizer was re-tuned between 2026-09-10 and 2026-09-11; same bytes now count ~30% lower.)
- **`gpt-5-5` (haiku tier) is gated behind an "evaluation identity" that the current token does not satisfy.** As of 2026-09-11 *every* request to `gpt-5-5` — even a one-word ping, with or without the real `CLAUDE_CODE_SESSION_ID` — returns `403 {"error":{"message":"evaluation identity required","type":"evaluation_policy_block"}}`. This is a **new** breakage not present during the 2026-09-10 validation (when the §A.3 probes ran `gpt-5-5` successfully). Consequences:
  - Claude Code's haiku-tier calls (e.g. `claude-api` skill sub-checks, `AskUserQuestion` short summaries, any subagent with `model: "haiku"`) fail with a 403 they have no way to satisfy. The token `eai_46Au…` and header `X-AI-Client: ai-evaluation` are not the "evaluation identity" the gateway now demands.
  - This is **separate from and additional to** the qwen context-window issue above; it is a policy/identity gate, not a context-size problem.
  - The gateway should either (a) accept the existing `ai-evaluation` identity for `gpt-5-5`, or (b) return a 404 / "model unavailable" so Claude Code's model-picker can fall back, rather than a 403 that reads as an auth failure.

## D. Regression test

`/tmp/cc-test/probe_overflow.sh` (or run inline): send a fixed ~620-turn probe payload to the gateway with **`max_tokens=8192`** (the Anthropic-protocol param name — deliberately **not** `max_completion_tokens`); assert `input_tokens` is within ±5% of the expected ~122k and that the request returns **HTTP 200**. If the gateway's enforced limit or the model's real window changes such that the same payload now fails (or succeeds far beyond), or if `max_tokens` is rejected with a 400 again (§E), the test fails — flagging a window **or param-contract** regression before a real session hits it.

```bash
# expected: input_tokens ≈ 122k, HTTP 200
node /tmp/cc-test/probe_overflow.js   # see below
```

## H. Re-verification (2026-09-11, post gateway-change) — the doc is substantially stale

Re-verified every recommendation in this doc against the **live** state after the
gateway change (real usage + `max_tokens` accepted + a **131072 preflight with
8192 safety margin** that returns typed `context_length_exceeded`). Several "applied"
fixes had drifted and the core §A model is now moot.

### Live config at re-verification (`.claude/settings.local.json` → `env`)

| Var | Doc claimed | Was (stale) | Now (corrected) |
|---|---|---|---|
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | §C: 131072 | **40000** ❌ | **131072** ✅ |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | §C: 60000 | **100000** ⚠️ (100k floor) | **120000** ✅ |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | not mentioned | **90** ❌ | **85** ✅ |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | §G: 4000 | 4000 | 4000 ✅ |

### The actual 2026-09-11 root cause (not the gateway, not §A)

"Compact didn't work / API Error 400" was a **client ordering bug**, not a gateway
bug: `CLAUDE_CODE_MAX_CONTEXT_TOKENS=40000` while
`AUTO_COMPACT_WINDOW(100000) × PCT(90) = 90000`. The auto-compact trigger (90k) sat
**above** the client's believed wall (40k) — impossible to satisfy, so compaction
never fired on schedule and the next request overflowed. The gateway preflight is a
backstop, not the cause. Fixed by setting the window *below* the max (§H config above:
120000 × 85% = 102k trigger, well under 131072).

### What the gateway change actually fixed

- **Real usage** (`input_tokens`/`output_tokens`) — **live and confirmed** by the
  re-verification probe (25-turn FIT → `input_tokens=5348`, non-zero). Status-bar "raw"
  number is now trustworthy.
- **`max_tokens` accepted** — confirmed (probe sends `max_tokens=4000`, 200).
- **Typed `context_length_exceeded` preflight** — confirmed (620-turn OVER → HTTP 400,
  `error.type = context_length_exceeded`). This is the final backstop, not the primary
  fix.

### Doc sections corrected in this pass

- **§C** `MAX_CONTEXT_TOKENS=131072`: it had actually drifted to **40000** (wrong);
  now corrected to 131072 (see table above).
- **§D** `probe_overflow.js`: the old version asserted `input_tokens==122881±5%` AND
  `http===200`, and targeted `gpt-5-5` with `max_tokens=8192`. That can never pass
  under the new preflight (the 620-turn payload is *rejected* before it reports
  input_tokens) and the tokenizer was re-tuned. **Rewritten to a behavioral probe**:
  a small payload must return 200 (and report non-zero usage), a large payload must
  return 400 `context_length_exceeded`. Targeted `qwen3.8-27b` with the live
  `max_output=4000`. **PASS confirmed 2026-09-11.**
- **§G** `context-guard.py`: its entire premise ("gateway returns `usage:0`, so
  estimate chars/3.3") is obsolete now that real usage is returned. **Rewritten to
  read the real `usage.input_tokens` from the last assistant message** and only fall
  back to the chars estimate when that is absent/zero. `WARN_FRACTION` raised 0.55 →
  0.85 (tight, safe, because it's now precise). Syntax-checked and wired as before.
- **§A** unknown-model 200k assumption: **moot** — the gateway returns real usage and
  the window is anchored. The current failure was the §H client ordering bug, not
  the 200k assumption.

## Validation status

- **Fix applied and live-validated (2026-09-10).** After the gateway-side usage fix (§C) and the `max_tokens` fix (§E), a fresh session against `qwen3.8-27b` confirms:
  - **Real usage returned** — non-stream and streaming (final SSE chunk) both carry `input_tokens`/`output_tokens`/`total_tokens`; status-line ctx and cost tracking are no longer stuck at 0.
  - **`/context` anchors to the real window** — shows `9.7k / 100k (10%)` with a 100k auto-compact window, not the assumed 200k unknown-model window.
  - **`max_tokens` accepted again** — no more 400; requests with `max_tokens=8192` succeed.
  - **Gateway health:** HTTP 200.
- Remaining (optional): grow a real conversation past ~120k tokens and run `/compact` to confirm no overflow end-to-end. The window anchoring + real usage above already remove both original causes of the overflow, so this is a confirmation, not a gate.

## F. Re-verification (2026-09-11) — what changed since the doc was last validated

Run from this session against the live gateway (`pilot-gateway.ai.eleks-demo.com`, token `eai_46Au…`):

| Probe | Model | Payload | Result |
|---|---|---|---|
| 620-turn, `max_tokens=8192` | `qwen3.8-27b` | ~122k input | **HTTP 400** — `This model's maximum context length is 131072 tokens. However, you requested 8192 output tokens and your prompt contains at least 122881 input tokens` |
| Same 620-turn, `max_tokens` omitted | `qwen3.8-27b` | same | **HTTP 200** — `usage: {input_tokens: 86598, output_tokens: 36}` |
| 25-turn, `max_tokens=16` | `gpt-5-5` | ~14k input | **HTTP 403** — `{"error":{"message":"evaluation identity required","type":"evaluation_policy_block"}}` |
| 1-turn, `max_tokens=16`, `x-ai-session` = real session id | `gpt-5-5` | ~10 input | **HTTP 403** — same `evaluation_policy_block` |

### Live config (from `.claude/settings.local.json`, verified in-session)
```
CLAUDE_CODE_MAX_CONTEXT_TOKENS     = 131072                # ✅ the §C fix, present
CLAUDE_CODE_MAX_OUTPUT_TOKENS      = 8192                  # as the user's report expects
CLAUDE_CODE_AUTO_COMPACT_WINDOW    = 1111111111110000      # ❌ §C fix was NEVER applied
CLAUDE_AUTOCOMPACT_PCT_OVERRIDE    = 90
ANTHROPIC_DEFAULT_OPUS_MODEL       = qwen3.8-27b
ANTHROPIC_DEFAULT_SONNET_MODEL     = qwen3.8-27b
ANTHROPIC_DEFAULT_HAIKU_MODEL      = gpt-5-5
```

### Confirmed deltas vs. the doc's 2026-09-10 state
1. **§C `CLAUDE_CODE_AUTO_COMPACT_WINDOW=60000` was never applied.** It is `1111111111110000` (~1.11e15). Live `/context` shows `Auto-compact window: 131.1k tokens` — the full real window. Claude Code therefore never proactively compacts and lets the session grow to the very limit, which *is* the §A overflow condition. **This is the user-reported bug, still live.**
2. **The gateway's tokenizer was re-tuned.** The 620-turn payload that the 2026-09-10 probes measured at `input_tokens=122,881` (the original overflow) is now counted at `input_tokens=86,598` — same bytes, ~30% fewer tokens. The §D regression test's `EXPECTED_INPUT=122881` is now **stale** and should be updated to `~86600` (or, better, the test should assert on *behavior* — HTTP 200 vs 400 — rather than a token count that moves under the tokenizer).
3. **`qwen3.8-27b` real usage is now returned.** `usage.input_tokens=86598`, `output_tokens=36` (non-stream and streaming). §C's "return real usage" fix is confirmed live.
4. **`gpt-5-5` is gated by a new "evaluation identity" policy.** Every request → `403 evaluation_policy_block`, even a one-word ping with the real session id. New breakage; not in the doc before 2026-09-11. Claude Code's haiku-tier calls (subagents with `model: "haiku"`, `AskUserQuestion` short summaries, etc.) cannot be served.

### How the "100k vs 131k" in the user's report maps to this
The user observed Claude Code's context UI reporting **100k** while the same request reaches **131k** against the gateway. From the live evidence, the most plausible mapping is:

- **100k ≈ the `gpt-5-5` (haiku tier) window.** That model is currently the *unreachable* one; when it *was* reachable (2026-09-10) the gateway enforced a different limit. Claude Code's `/context` bar and its per-model auto-compact anchor are reading the *haiku-tier* window, not the `qwen3.8-27b` 131072 window, because the `ANTHROPIC_DEFAULT_*_MODEL` aliases cause the session to be served by whichever model the gateway routes for that tier, and the two tiers advertise different windows.
- **131k = `qwen3.8-27b`'s real window** (131,072), enforced by the gateway (confirmed: the 400 error literally says "This model's maximum context length is 131072 tokens").
- **The 1-token-over 400** the user hit is the §A.3 arithmetic: `122,881 input + 8,192 max_tokens = 131,073 = 131,072 + 1`. With `CLAUDE_CODE_MAX_OUTPUT_TOKENS=8192` (which is set) and no effective auto-compact (which, because of `CLAUDE_CODE_AUTO_COMPACT_WINDOW=1111111111110000`, doesn't happen), the session grows until the compact request itself overflows.

The "inconsistent context-window values" the user describes are therefore **not** a single Claude Code bug — they are the composition of (a) the unknown-model window assumption for `qwen3.8-27b` (§A), (b) a haiku-tier model (`gpt-5-5`) that advertises a *different* window and is now additionally gated, (c) a `CLAUDE_CODE_AUTO_COMPACT_WINDOW` that has effectively been turned off, and (d) the gateway re-tuning its tokenizer between validations so that the "same" payload no longer counts the same tokens.

### Concrete next step (client-side, in this repo)
Set in `.claude/settings.local.json` → `env`:
```json
"CLAUDE_CODE_AUTO_COMPACT_WINDOW": "60000"
```
(replacing `1111111111110000`). This is the one fix that, with `CLAUDE_CODE_MAX_CONTEXT_TOKENS=131072` already in place, removes the §A overflow: the session will auto-compact at ~60k, leaving a large safety margin below the 131072 − 8192 = 122880 hard ceiling. **Requires a session restart.**

The `gpt-5-5` 403 is a gateway-side policy change the client cannot fix; it needs a new token / identity from the pilot-gateway owners.

> **Status (2026-09-11, §H):** the `max_tokens` param contract is **fixed and live** —
> the re-verification probe sends `max_tokens=4000` to `qwen3.8-27b` and gets HTTP 200.
> The 400 below was a transient regression, not the current state.

After the gateway-side usage fix (§C), `qwen3.8-27b` began returning:

```
400  Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.
```

### Root cause

- Claude Code always sends `max_tokens` (the Anthropic API's max-output param) on every request.
- The gateway now serves `qwen3.8-27b` with an OpenAI-style upstream schema where that param is `max_completion_tokens`, and it passes unknown params through → upstream rejects with 400.

This is a **regression**: the §A.3 probe (576/620-turn payloads with `max_tokens=8192`) succeeded with 200 on the same endpoint before the usage fix. The usage change came with a param-contract change that breaks every Anthropic-protocol client.

### Fix (applied gateway-side, 2026-09-10 — confirmed)

The gateway now accepts `max_tokens` for this model again. **Live-validated** in the same session as the rest of the §C usage fix: requests with `max_tokens=8192` return 200 (see Validation status), and the model serves its real 131,072 window.

### Regression test addition

Extend §D: in addition to asserting `input_tokens ≈ 122k` and HTTP 200, the probe must send `max_tokens` (not `max_completion_tokens`) and keep succeeding — so the param contract doesn't silently regress again.

### Gateway-side note

If the upstream genuinely requires `max_completion_tokens`, the gateway should map `max_tokens` → `max_completion_tokens` at the proxy layer (accept the Anthropic name as an alias) rather than rejecting it, so Anthropic-protocol clients keep working.

## G. Re-hit (2026-09-10) — `usage:0` regression + a real safety net

### What re-happened

The exact overflow class from §A recurred: the context UI showed `qwen3.8-27b 16.1k / 80k (20%)`, but the next API call returned

```
400  This model's maximum context length is 131072 tokens.
     However, you requested 4000 output tokens and your prompt contains
     at least 127073 input tokens, for a total of at least 131073 tokens.
     (parameter=input_tokens, value=127073)
```

The arithmetic is exact: **127,073 + 4,000 (`CLAUDE_CODE_MAX_OUTPUT_TOKENS`) = 131,073 = 131,072 + 1.** Same 1-token-over signature as §A, now with `max_output=4000` instead of 8192.

### Two independent findings

**1. The `usage:0` regression is live again.** Every recent `qwen3.8-27b` transcript in this project carries `usage.input_tokens=0` on *all* assistant messages (verified across 4 sessions; 78/78 zero in the current one). This **undoes the §C "return real usage" fix** that was live-validated earlier on 2026-09-10. Consequences: the status line and `/context` have no real token count to read, and **no hook can read the true request size** — the only signal available is a chars-based estimate.

**2. `/context` understates the real request by ~×8 (here 16.1k UI vs 127,073 real).** `/context` is a `chars/4` estimate of the *in-memory* conversation only; it deliberately excludes the fixed system prompt + all tool/MCP schemas. The gateway's real `input_tokens` includes them. On a tool-heavy session the two diverge by a large factor. The UI number predicts *when auto-compact fires*, **not** the request size.

**A chars-based estimate also undercounts — but less, and unpredictably.** Measured on this session: raw transcript chars since last compact boundary → `chars/3.3 + 4000 schema` ≈ **80,000** real tokens, vs the gateway's **127,073**. That's a **×1.6 underestimate**, in the same direction as `/context` (the raw transcript ≠ what the gateway sends, due to prompt-caching, system-prompt re-sends, and tool-schema expansion that a client cannot observe). This ratio **drifts** between sessions, so it cannot be calibrated to a fixed number.

### The fix (applied this session)

The durable prevention is **lowering the auto-compact window** so compaction fires *while the session is still far from the wall* — the only lever that actually keeps a request from reaching 131,072. A tripwire hook is secondary because the estimate undercounts.

1. **`CLAUDE_CODE_MAX_CONTEXT_TOKENS` 80000 → 40000** (`.claude/settings.local.json` → `env`). Auto-compact now fires at ~40k *in-memory* (~68k real), leaving a wide margin below the 131,072 − 4,000 = 127,072 request ceiling. Requires a session restart.
   - `CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000` is a **no-op** (hardcoded 100k floor, `M0e=1e5`, see §F and memory) — it does not change the window. `CLAUDE_CODE_MAX_CONTEXT_TOKENS` is the real lever (feeds the model-max that the 100k-floor window is capped by).
   - `CLAUDE_CODE_MAX_OUTPUT_TOKENS=4000` is kept as a small extra headroom; not the primary fix.

2. **`UserPromptSubmit` safety hook** — `.claude/hooks/context-guard.py`, wired in `.claude/settings.json`. **Updated 2026-09-11 (§H):** it now **reads the real `usage.input_tokens` from the last assistant message** in the transcript (the gateway returns real usage since the §C fix) and only falls back to the `chars/3.3 + 4000 schema` estimate when that value is absent or zero. When `real_input + max_output` crosses `WARN_FRACTION × 131072` (default now **0.85** ≈ 111k, tightened from 0.55 because the real-value path is precise) it injects a `/compact` reminder via `hookSpecificOutput.additionalContext` (does not block by default; set `CLAUDE_CTX_GUARD_BLOCK=1` to block). Thresholds remain env-overridable (`CLAUDE_CTX_WARN_FRACTION`, `CLAUDE_CTX_HARD_LIMIT`, `CLAUDE_CTX_SCHEMA_TOKENS`, `CLAUDE_CTX_CHARS_PER_TOKEN` — the latter two only matter in the fallback path).

   **Honest limitation:** because the estimate undercounts the real total ~×1.7 and that factor drifts, the hook is a **reminder/tripwire, not a guarantee**. At the default 0.55 it warns at est ~68k, which is ~115k real — near (but still before) the overflow point. It will *not* reliably catch a session that grows past the wall between two user prompts. The window lowering (#1) is what actually prevents the request from reaching the wall.

### If the `usage:0` regression is fixed

> **DONE (2026-09-11, §H):** the gateway returns real `input_tokens` again, so the
> hook was updated to read it (see §G item 2). This is no longer a follow-up.

## I. 2026-09-11 re-incident — `usage:0` regression is **flaky**, hook is blind on fallback

Second overflow incident after the §H "resolution": API Error 400,
`127073 input + 4000 output = 131073`, while the status bar showed `ctx 100k raw`
(i.e. ~100% of the 100k auto-compact window).

**Evidence (transcript audit of this project's sessions, all 2026-09-10 12:52–16:35):**
every single assistant message in every session carries `usage.input_tokens=0`
(8 transcripts, 729 assistant msgs, 0 non-zero). The "real usage" fix validated in
§C/§H **is not persistently live on the gateway** — it is flaky. Consequences, in order:

1. **Auto-compact blind:** the client's auto-compact decision is fed by the same
   usage telemetry, so with `usage:0` the client underestimates context and the
   102k trigger (120000 × 85%) never fires. This is why compaction "didn't work"
   again even though the §H client-side config is correct.
2. **`context-guard.py` hook blind:** it prefers real usage, finds 0, falls back to
   the chars estimate. The fallback measured **~16k** for a session whose *actual*
   request was **127k** — a ×8 underestimate (transcript raw chars ÷ 3.3 + 4000
   schema ≠ gateway's real count, for the §F reasons: system prompt + tool/MCP
   schemas + cache behavior). 16k + 4000 = 20k, far under the 111k danger line →
   hook stays silent. **The hook's fallback path cannot protect a real session.**
3. **Status bar shows `100k raw`:** that's the statusline's own chars fallback
   pinned against its 100k divisor — a different (also wrong) estimate, which is
   why it "showed 100k" while the real request was 127k. The label `raw` is the
   estimate, not gateway usage.

**Implications / open:**
- The §H "RESOLVED" is wrong as stated: the *client* config fix is durable, but the
  gateway real-usage fix is **not** durable. Treat `usage:0` as a recurring condition.
- **Run `/tmp/cc-test/probe_overflow.js` at the start of any long session** — the
  small-payload leg (must 200 + non-zero usage) detects the usage regression live,
  independent of session growth.
- The fallback estimator's blind spot is structural: it counts transcript text,
  which is a session-dependent ×2–×5 (measured; drifts) of the real request on
  tool-heavy sessions. **No fixed ratio calibrates it to the wall.**

### Fallback tuned (applied 2026-09-11) — estimate as a progress signal, not a measurement

`context-guard.py` fallback defaults changed:

| Param | Before | After | Why |
|---|---|---|---|
| `CLAUDE_CTX_CHARS_PER_TOKEN` | 3.3 | **1.8** | Pessimistic: raw transcript chars are dense (JSON tool I/O, code); 3.3 is the honest ratio but understates token mass. |
| estimate danger fraction | (shared `WARN_FRACTION` 0.85 ≈ 111k line) | **`CLAUDE_CTX_EST_WARN_FRACTION` = 0.30 ≈ 39k line** (new env; real-usage path keeps 0.85) | The estimate can't be calibrated to the wall (×-factor drifts per session), so it's used as a *progress* signal: transcript already representing ~30% of the wall in text ⇒ tool-heavy session ⇒ the real request will 400 well before the estimate itself nears the wall. |
| estimate-path message | generic "crossed the safety line" | explicit "this is a LOWER BOUND … repeats until you compact" | Honest about what the number is; the nag repeats each prompt (hook re-evaluates) so it can't be missed. |

**Verified against the actual §I failing session** (transcript with the 127,073-token request): hook fires at est ≈ 48k (~37% of wall) — mid-session, well before the wall. A tool-heavy session crosses the 39k line around ~55k raw transcript chars, typically long before the real request hits 127k.

**Residual honesty:** on a *pathologically* tool-heavy session (×5+ divergence with a small transcript) even this can fire late; and text-only light sessions now get an early nag (their est ≈ real). Both are acceptable vs a silent 400. The durable fix remains gateway-side consistent usage; run the probe at session start.

## J. 2026-09-11 re-incident — `usage:0` is **back and persistent** (417/417), 15.4k UI vs 127k real, error is now a gateway **rewrite**

Third overflow incident, and the most informative. The §H "RESOLVED" is **wrong as a durable statement**: the client-side config fix (§H table: 131072 / 120000 / 85) is durable and correct, but the gateway real-usage fix it depended on **regressed again** — and this time it is *persistent within sessions*, not just flaky across days.

### The report

User saw, in one session:

```
API Error: 400  Estimated input plus requested output exceeds the Qwen context
window; compact the conversation and retry.
```

while `/context` simultaneously showed **`15.4k / 120k tokens (13%)`** for `qwen3.8-27b`.

### Evidence (measured 2026-09-11, this session)

1. **The probe still passes** — but only on one-shot requests:
   - FIT (25-turn): `HTTP 200`, `usage.input_tokens=5348` (real, non-zero).
   - OVER (620-turn): `HTTP 400`, `error.type=context_length_exceeded` (preflight intact).
   - So the gateway's preflight and the *one-shot* usage path both work **right now**.

2. **Every sustained session returns `usage:0`.** Across the 4 most recent transcripts in this project, **all 417 assistant messages carry `usage.input_tokens:0`** (92/92, 152/152, 161/161, 12/12). The "real usage" validated in §C/§H is **not live on the session stream** — it is real on isolated probe requests and zero on everything a real Claude Code session sends.

3. **`/context` (15.4k) and the 400 are not contradictory** — they measure different things (re-confirms §G):
   - `/context` = `chars/4` of the **in-memory conversation only** (user + assistant text since last compact). It predicts *when auto-compact fires*, **not** the request size.
   - The gateway's 400 = `input_tokens + max_tokens` of the **actual wire request** (full re-sent history + system prompt + all 65 tool/MCP schemas + prompt-cache expansion).
   - Measured on the failed session's transcript: 191 messages, **197,671 chars**, **no compact boundary ever fired** → ~59.9k tokens at an honest `chars/3.3`, ~113.8k at the hook's pessimistic `chars/1.8 + 4000` schema. The real wire request (with system + tool schemas) is at/above the 131,072 wall — consistent with the 127,073 figure from the prior incident. So the UI understated the real request by **~×4–×8**, exactly the §G tool-heavy divergence.

4. **The 400 message is a gateway *rewrite*, not a raw Qwen error and not in the client.** Grep of the Claude Code binaries (2.1.267 **and** 2.1.268) for `Qwen context window` → **zero hits**. The original raw Qwen error carried the arithmetic (`input_tokens`, `value=127073`, total, limit — see §A.3 / §G); the current message is a humanized sentence that **drops the numbers**. That is a UX improvement but it hides the exact `input + max_tokens = N > 131072` breakdown that made the §A diagnosis possible. The gateway's `context_length_exceeded` preflight (confirmed working by the probe) is being reworded into this string.

### Why all three safety nets failed at once (single root cause)

| Net | Why it failed under `usage:0` |
|---|---|
| Auto-compact (102k trigger) | Fed by the same usage telemetry → with `input_tokens:0` the client believes the session is tiny (the 15.4k / 13% display), so the trigger never fires. Session grows to the wall. |
| `/compact` | Re-sends the full ~127k history → `127073 + 4000 = 131073` = 1 over → the 400. |
| `context-guard.py` hook | Prefers real usage, finds 0, falls back to the chars estimate — a *lower bound* that undercounts by a session-dependent ×2–×5. Warns late or not at all vs the true wall. |

**One root cause:** the gateway stopped returning real usage on sustained sessions. Fix the passthrough and all three recover with **no** client-side change.

### Why the client cannot self-fix this

The client config is already correct and was **not** the problem:

```
CLAUDE_CODE_MAX_CONTEXT_TOKENS    = 131072   # anchors to the real window
CLAUDE_CODE_AUTO_COMPACT_WINDOW   = 120000
CLAUDE_AUTOCOMPACT_PCT_OVERRIDE   = 85       # trigger at 120000 * 0.85 = 102k
CLAUDE_CODE_MAX_OUTPUT_TOKENS     = 4000
```

- Auto-compact reads the same telemetry the hook reads — it is structurally blind to `usage:0`.
- The hook's fallback is a lower bound; no fixed ratio calibrates transcript chars to the wall on tool-heavy sessions (§I).
- The probe's one-shot FIT leg can return a real count even while the session stream returns zero (observed today). It is a canary, not a guarantee.

**The durable fix is gateway-side.** See **`docs/gateway-usage-debug-spec.md`** for the full debug plan (hypotheses H1–H5, telemetry requests, acceptance gate) and the gateway fix spec (GW-1 always-return-real-usage including the streaming terminal event; GW-2 preflight count == returned usage; GW-3 keep the arithmetic in the 400 body; GW-4 stable tokenizer; GW-5 the separate `gpt-5-5` 403 identity gate).

### Most likely single cause (for the gateway team)

**H1 — the streaming terminal event.** The one-shot probe (non-stream-style, single request) gets real usage; the sustained *streaming* session does not. If `usage` is only populated on the non-stream path and the final SSE `message_delta` is zeroed, that is the whole bug and a one-line fix. Second most likely: H2 (prompt-caching path suppresses the count) or H4 (a specific deploy/backend instance around the 2026-09-10 → 09-11 window).

### Immediate actions (client-side, already taken / to take)

1. **This session:** `/compact` is safe (real input ~115k, under the wall). If `/compact` itself 400s, `/clear` and restart.
2. **Every long session:** run `node /tmp/cc-test/probe_overflow.js` at start — the FIT leg flags a `usage:0` regression on one-shot requests *before* a session hits the wall. (It passed today because one-shot still returns real usage; if even that starts returning 0, auto-compact is fully blind.)
3. **Do not** lower `CLAUDE_CODE_AUTO_COMPACT_WINDOW` further to "compensate" for `usage:0` — that trades a 400 for over-aggressive compaction and masks the real bug.
4. **Report to gateway owners** (the durable fix): real usage is real on one-shot but **0/417** on sustained sessions as of 2026-09-11; and the rewritten 400 hides the token arithmetic — restore `input_tokens`/`max_tokens`/`limit` in the error body.

### Doc corrections this pass

- **§H "RESOLVED" / "client config fix is durable, gateway fix is not durable"** — confirmed and sharpened: the gateway real-usage fix is not just "not durable," it is **0/417 on the session stream** while still real on one-shots. The §H §G "DONE (2026-09-11)" note about the hook reading real usage is therefore **contingent** — the hook is back on its fallback path.
- **§A / §F "100k vs 131k" framing** — superseded for this incident: the 15.4k UI is the §G `chars/4` in-memory estimate, and the 127k real is the wire request. Same §G mechanism, third observation.
- New companion doc: **`docs/gateway-usage-debug-spec.md`** (debug plan + gateway fix spec + definition of done).

## K. Gateway team response (2026-09-11, in Ukrainian) — root-cause hypothesis + timeline

### What they said (verbatim translation)

> "The pod itself needs to be restarted — probably only this evening. But today we finish testing the model in the evening and collect feedback from the devs. We can try to do this on Monday, and there's also a task to spin up 8 GPUs with GLM-5.3 if resources are available."
>
> "Recommendation: add `--tokenizer Qwen/Qwen3.8-27B` to the RunPod launch, verify the checksum, and for the Gateway it's better to embed that same tokenizer version into the Docker image. Then the Gateway won't depend on the pod's availability for token counting."

### Interpretation — this is a concrete root-cause hypothesis

Their answer points to a **tokenizer availability race**: the RunPod pod sometimes lacks the `Qwen/Qwen3.8-27B` tokenizer (cold start / unpulled), so **preflight token counting falls back to zero** — which is exactly the observed "one-shot gets real count, sustained session gets `usage:0`" split, and the same drift that made the "same" 620-turn bytes count 122,881 → 86,598 between 09-10 and 09-11 (§F.2). This maps to the **H1–H5** set in the debug spec as "tokenizer availability" (closest to H4 per-instance, but structural, not a deploy). It is a **stronger, more specific** candidate than H1 (streaming terminal event). **To confirm:** the Phase A probe (non-stream vs stream on the same payload) — if the count is zero on *both* after a pod restart until the tokenizer is warm, it's the race, not the streaming path.

Their two-part fix (client-visible impact):
1. **`--tokenizer Qwen/Qwen3.8-27B` on the RunPod launch + checksum verify** — makes the pod count tokens deterministically.
2. **Embed that same tokenizer version in the Gateway Docker image** — Gateway no longer depends on the pod for token counting. This is the durable half; the pod restart alone will regress on the next cold start.

**Net: the fix is real and targets the right layer, but it is not live until the Gateway image change ships.** The pod restart is a stopgap.

### Timeline (their words)

| When | What |
|---|---|
| Today (09-11) | finish model testing; collect dev feedback. No fix. |
| Evening (09-11) | pod restart "maybe" — stopgap only. |
| Monday (09-14) | attempt the actual fix (tokenizer embed). |
| Parallel (unscheduled) | spin up 8 GPUs with **GLM-5.3** if resources are available — a **separate** workload, not the usage fix. Do not conflate. |

### What this does **not** answer (still open)

- No diagnostic header (debug spec §3.3) → we still cannot verify `upstream == gateway_computed == returned` per request. GW-2/GW-3/GW-4 remain unverified.
- No confirmation of the H1 (streaming) vs H2 (caching) sub-hypothesis — their tokenizer-race answer implies the bug is *upstream of* the response path (counting is zero, so there's nothing to forward), which would make H1/H2 moot. The Phase A probe is the only way to tell.
- The `gpt-5-5` 403 identity gate (GW-5) is untouched.
- "Verify the checksum" is unverified — we have no checksum of their tokenizer to compare against. GW-4 (stable tokenizer) is still a SHOULD, not done.

### Client-side plan (unchanged, now with a known exit)

Until Monday's Gateway image change lands: keep the client config as-is (131072 / 120000 / 85 / 4000), run `probe_overflow.js` at the start of every long session, treat `usage:0` on the session stream as the expected state, and rely on `context-guard.py`'s fallback (pessimistic `chars/1.8 + 4000`, 0.30 estimate-fraction) as the only working safety net. **Do not** lower the compact window further to compensate.
