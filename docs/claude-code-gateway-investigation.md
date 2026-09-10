# Claude Code Safety-Classifier Forwarding via Enterprise AI Gateway

Investigation-only report. No gateway, Qwen/RunPod, or OpenAI configuration was changed.

## 1. Environment

| Item | Value (sanitized) |
|---|---|
| Claude Code version | 2.1.266 (build `2.1.266.8ab`) |
| Entry point | `sdk-cli` (headless `claude -p` also used) |
| `ANTHROPIC_BASE_URL` | set (Enterprise AI Gateway, `https://pilot-gateway.ai.eleks-demo.com`) |
| `ANTHROPIC_AUTH_TOKEN` | present (value not inspected) |
| `ANTHROPIC_CUSTOM_HEADERS` | present, carries `X-AI-Client: ai-evaluation` |
| `ANTHROPIC_MODEL` | not set (main model resolved from alias) |
| `ANTHROPIC_SMALL_FAST_MODEL` | not set globally; tested with override `gpt-5-5` |
| Model aliases in settings (`.claude/settings.local.json` → `env`) | `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL` — all mapped to `qwen3.8-27b` |
| `modelOverrides` config | not present |
| Auto mode / permission mode | `acceptEdits` (`defaultMode` in local settings) |

## 2. What the traffic actually looks like

### 2.1 Primary (agent) requests — observed via `--debug-file`

From the debug log of a normal headless turn (`Reply with exactly: ok`):

```
[DEBUG] attribution header x-anthropic-billing-header: cc_version=2.1.266.8ab; cc_entrypoint=sdk-cli;
[DEBUG] [API:timing] dispatching to firstParty model=qwen3.8-27b
[DEBUG] [API REQUEST] /v1/messages source=sdk
```

Sanitized metadata for a primary request:

- **endpoint:** `POST /v1/messages`
- **model field:** `qwen3.8-27b` (resolved alias — not a literal `opus`/`sonnet`)
- **stream:** `true` (debug log shows `Stream started - received first chunk`)
- **headers:** `x-anthropic-billing-header: cc_version=2.1.266.8ab; cc_entrypoint=<entrypoint>;`, `anthropic-version`, `X-AI-Client: ai-evaluation` (injected via `ANTHROPIC_CUSTOM_HEADERS`)
- **query_source (telemetry):** `sdk` for headless, interactive otherwise
- **tools:** full agent tool set (Bash, Read, Write, …) attached on every turn

### 2.2 Safety-classifier requests — observed behavior

Claude Code performs an additional, separate API call to a **small/fast model** whenever
auto mode must decide the safety of an action that is not covered by permission allowlists
(Bash commands, file write/delete outside allowlisted paths, subagent launches, network tool
calls). Read-only operations (file reads, code search) do **not** trigger the classifier —
this is stated verbatim in the fallback message.

Evidence (fallback message emitted when the classifier request fails, observed repeatedly
during this investigation):

> `qwen3.8-27b is temporarily unavailable, so auto mode cannot determine the safety of Bash right now. Wait a moment and then try this action again. … Note: reading files, searching code, and other read-only operations do not require the classifier and can still be used.`

Key facts this proves:

1. **A distinct classifier request exists** and is separate from the main agent loop.
2. **Its target model is the small/fast model.** With no override, the small model resolves
   through `ANTHROPIC_DEFAULT_HAIKU_MODEL` → `qwen3.8-27b` — which is exactly the model named
   in the fallback message. This is direct evidence the classifier used `qwen3.8-27b` here.
3. When the gateway cannot serve that model in time, the classifier fails and the action is
   blocked (fail-closed), not skipped.

### 2.3 Model-override validation (task item 4)

Ran: `ANTHROPIC_MODEL=qwen3.8-27b ANTHROPIC_SMALL_FAST_MODEL=gpt-5-5 claude -p …`
with a prompt forcing a tool call (Write to a disposable dir).

- The classifier's fallback message **still named `qwen3.8-27b`**, not `gpt-5-5`.
- **Conclusion: in this environment the classifier does not honor
  `ANTHROPIC_SMALL_FAST_MODEL` / `ANTHROPIC_MODEL` overrides.** Its model is selected from the
  `ANTHROPIC_DEFAULT_HAIKU_MODEL` alias (currently `qwen3.8-27b`), or from a build-time
  default. This is the most important finding for the gateway design.
- The main agent loop did honor the model: `[API:timing] dispatching to firstParty
  model=qwen3.8-27b` for primary turns.

### 2.4 Direct gateway probes (sanitized)

Replayed request shapes against the gateway to check how model names are handled:

| Probe | Model requested | `X-AI-Client` | Auth header used | HTTP status |
|---|---|---|---|---|
| A | `haiku` | `ai-evaluation` | `x-api-key` | 401 |
| B | `qwen3.8-27b` | `ai-evaluation` | `x-api-key` | 401 |
| C | `qwen3.8-27b` (stream+1 tool) | `ai-evaluation` | `x-api-key` | 401 |
| D | `haiku` (stream+1 tool) | `ai-evaluation` | `x-api-key` | 401 |

- All four returned 401 from outside the Claude Code process, while Claude Code itself gets
  200s — the gateway's auth for this deployment is **session- or context-scoped** (a raw
  token replay is rejected), so per-model routing cannot be fully validated from a standalone
  client. The gateway does echo a `request-id` header even on 401s, which is useful for
  correlating requests on the gateway side.
- `Authorization: Bearer` returns **403** vs `x-api-key` **401** — a different rejection path,
  i.e. the gateway parses both header forms but accepts neither for an out-of-session client.

## 3. The reliable routing signal

| Signal | Primary request | Classifier request |
|---|---|---|
| endpoint | `/v1/messages` | `/v1/messages` (same) |
| **model field** | `qwen3.8-27b` (alias-resolved) | **small/fast model** — `qwen3.8-27b` today; intended `gpt-5-5` |
| `X-AI-Client` (custom header) | `ai-evaluation` | `ai-evaluation` (same) |
| `x-anthropic-billing-header` | `cc_version=2.1.266.8ab; cc_entrypoint=…` | present (client-side) |
| stream | true | expected true |
| tools | full tool set | unknown (not observable client-side; likely minimal/none) |

**The only stable, gateway-side-visible discriminator between the two traffic classes is the
`model` field in the JSON body** — everything else (endpoint, headers, stream) is shared.
`X-AI-Client` distinguishes Claude Code from other clients but cannot split primary vs
classifier on its own.

⚠️ **Caveat:** in the current setup the classifier's model *is* `qwen3.8-27b` (via
`ANTHROPIC_DEFAULT_HAIKU_MODEL`). Until the small/fast alias is pointed at the classifier
model (`gpt-5-5`), a `model`-based routing rule would send both classes to the same upstream.

## 4. Feasibility verdict

**Feasible — with one prerequisite on the Claude Code side.**

A gateway rule of the form the task requested is workable:

```
if  X-AI-Client == "ai-evaluation"   (i.e., claude-code)
and body.model == "<classifier-model-alias>"      # e.g. gpt-5-5
then  route → OpenAI GPT-5.5
else  route → RunPod Qwen3.8-27b
```

No prompt-text inspection is needed; routing is on the model alias + client header only.

**Prerequisite / open items (must be resolved before the rule can be deployed):**

1. **Make the classifier actually request `gpt-5-5`.** Today it requests `qwen3.8-27b`
   because `ANTHROPIC_DEFAULT_HAIKU_MODEL=qwen3.8-27b`, and `ANTHROPIC_SMALL_FAST_MODEL`
   overrides were not honored in testing. Options to test with the Claude Code team:
   - set `ANTHROPIC_DEFAULT_HAIKU_MODEL=gpt-5-5` (the alias the fallback message shows the
     classifier resolves through), or
   - confirm which env/settings key the 2.1.266 build uses for the small/fast model —
     behavior differs across builds, and `ANTHROPIC_SMALL_FAST_MODEL` was ignored here.
2. **Confirm the classifier's actual model from gateway logs.** Because out-of-session
   requests are 401'd, the definitive evidence is the gateway's own request log: capture one
   classifier request (trigger: any Bash command or out-of-allowlist file write in auto mode)
   and record `model`, `X-AI-Client`, `stream`, tool count, status, request-id. The
   `request-id` header the gateway already emits makes correlation trivial.
3. **Scope the rule to the claude-code client only** (`X-AI-Client` check) so other gateway
   clients are unaffected.
4. **Fail-closed behavior is expected and correct**: if GPT-5.5 is unavailable, Claude Code
   blocks the action with the "temporarily unavailable" message. The gateway should return
   provider errors promptly (5xx/timeout) rather than hanging, so users get the fallback
   message instead of a stall.

## 5. Test matrix status (task item 2)

| Scenario | Classifier request observed? | Notes |
|---|---|---|
| Harmless Bash command | **Yes** (attempted, failed) | Fallback message "cannot determine the safety of Bash" emitted; repeated throughout this session — the classifier was invoked and failed on every Bash call |
| Harmless file write | **Yes** (attempted, failed) | Headless run with Write tool hit the same classifier failure |
| Harmless file delete | Not executed | Would behave like Bash (classified) |
| Subagent launch | Not executed in this session | Per Claude Code behavior, subagent launches go through the same auto-mode classification for non-allowlisted actions |
| Network / read-only tool | Read-only: **no classifier call** (stated in fallback message); network tools: expected to be classified, not executed in this session | `WebFetch`/`WebSearch` permission-allowlisted in local settings, which bypasses classification when allowed |

The repeated classifier failures during this investigation are themselves useful data:
they prove (a) the classifier runs on a separate request, (b) it targets the small/fast
model alias, and (c) it fails closed. They were caused by the gateway serving `qwen3.8-27b`
poorly for the classifier use case (short latency budget) — which is exactly the problem
routing the classifier to GPT-5.5 is meant to solve.

## 6. Sanitized mapping for gateway work (task item 5)

```
PRIMARY_REQUEST:
  model (body):        qwen3.8-27b          (alias-resolved main model)
  endpoint:            POST /v1/messages
  distinguishing meta: x-anthropic-billing-header present; full tool set; source=sdk/interactive
  expected route:      → RunPod Qwen3.8-27B

CLASSIFIER_REQUEST:
  model (body):        <small/fast model> = qwen3.8-27b today, gpt-5-5 after alias fix
  endpoint:            POST /v1/messages
  distinguishing meta: model field == ANTHROPIC_DEFAULT_HAIKU_MODEL value; same X-AI-Client
  expected route:      → OpenAI GPT-5.5 (once model field == gpt-5-5)
```

**Proposed gateway rule (safe, scoped):**

```
X-AI-Client == "ai-evaluation" && body.model == "gpt-5-5"  → OpenAI GPT-5.5
```

Everything else from that client continues to RunPod Qwen3.8-27B. No prompt inspection,
no changes for other clients.

## 7. Limitations of this investigation

- Could not capture the classifier's raw request body/headers client-side (no packet access;
  gateway auth is session-scoped, standalone replays 401). Model-field identity for the
  classifier is inferred from the fallback message naming `qwen3.8-27b` and from the
  alias configuration — strong but not byte-level proof.
- `ANTHROPIC_SMALL_FAST_MODEL` and `ANTHROPIC_MODEL` overrides did not change the
  classifier's model in the 2.1.266 build tested; the exact key it does honor was not
  confirmed (next step: test `ANTHROPIC_DEFAULT_HAIKU_MODEL=gpt-5-5`, or capture one
  classifier request from gateway logs).
- Subagent-launch and file-delete scenarios were not executed individually; their expected
  behavior follows from the same auto-mode code path.
