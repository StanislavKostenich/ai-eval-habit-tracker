# Claude Code Capability Verification — Open Qwen (`qwen3.8-27b`)

**Date:** 2026-09-12 (updated) · **Original evaluation:** 2026-09-08
**System:** Claude Code **v2.1.263** via `pilot-gateway.ai.eleks-demo.com`, header `X-AI-Client: ai-evaluation`. All three model slots (`ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`) → `qwen3.8-27b`.

**Summary:** ✅ **17/17 full pass** (after fixes for Finding A: `input_tokens` + `e.replace`), ❌ **0 regressions**. *(Initially 15/17 + 2 partial — see re-tests below.)*
**Gateway usage fix:** ✅ **Validated on the local GX-10 stack** — see [Gateway `usage` fix status](#gateway--usage--fix-status-validated-on-the-local-gx-10-stack) below, based on `docs/gateway-usage-debug-spec.md`.

---

## 📊 Pass-rate by category


| Category                                             | ✅ Full | ⚠️ Partial | ❌ Fail | Total | Pass-rate* |
| ---------------------------------------------------- | ------ | ---------- | ------ | ----- | ---------- |
| Filesystem (Read/Write/Edit/Notebook)                | 4      | 0          | 0      | 4     | **100%**   |
| Shell / Bash (foreground + background)               | 2      | 0          | 0      | 2     | **100%**   |
| Search (Grep/Glob)                                   | 1      | 0          | 0      | 1     | **100%**   |
| Web (WebFetch + WebSearch)                           | 2      | 0          | 0      | 2     | **100%**   |
| Planning / instructions (plan mode, AskUserQuestion) | 2      | 0          | 0      | 2     | **100%**   |
| Scheduling (Task, Cron, ScheduleWakeup)              | 3      | 0          | 0      | 3     | **100%**   |
| Memory (persistent filesystem)                       | 1      | 0          | 0      | 1     | **100%**   |
| **Agents (Agent, Workflow)**                         | 2      | 0          | 0      | 2     | **100%** ✅ |
| **Total**                                            | **17** | **0**      | **0**  | **17**| **100%** ✅ |


Pass-rate is computed as `(Full + 0.5·Partial) / Total`. Counting full passes only: **100%**.

### Visual distribution

```
Filesystem    ████████████████████ 100%  (4/4)
Shell/Bash    ████████████████████ 100%  (2/2)
Search        ████████████████████ 100%  (1/1)
Web           ████████████████████ 100%  (2/2)
Plan/instr.   ████████████████████ 100%  (2/2)
Scheduling    ████████████████████ 100%  (3/3)
Memory        ████████████████████ 100%  (1/1)
Agents        ████████████████████ 100%  (2/2) ← fixed
─────────────────────────────────────────────
TOTAL         ████████████████████ 100%  (17/17)
```



### Distribution by status (pie chart)

```
        ✅ Full pass    ████████████████████████████████████████  17  (100%)
        ⚠️ Partial      (empty)                                     0   (0.0%)
        ❌ Fail         (empty)                                     0   (0.0%)
```

---



## Capability matrix


| #   | Capability                                                                                 | Result | Confirmation                                                                     |
| --- | ------------------------------------------------------------------------------------------ | ------- | -------------------------------------------------------------------------------- |
| 1   | **Bash** (exec, stdout/stderr, exit codes, pipes, `$()` subst, conditionals, loops, case, heredoc) | ✅ PASS | Full batch: `python3 3.9.6`, `git 2.39.5` (node not present)                     |
| 2   | **Bash background** (`run_in_background`)                                                  | ✅ PASS | Task `b94mu3gi0`, exit code 0, output file readable                              |
| 3   | **Read**                                                                                   | ✅ PASS | Read `probe.py` (5 lines)                                                        |
| 4   | **Write**                                                                                  | ✅ PASS | Created `probe.py`, `probe.ipynb`, memory files                                  |
| 5   | **Edit** (exact-match)                                                                     | ✅ PASS | Inserted `EDITED_MARKER`                                                         |
| 6   | **NotebookEdit** (insert cell)                                                             | ✅ PASS | Inserted code cell `478e9c25`                                                    |
| 7   | **Grep / Glob** (search)                                                                   | ✅ PASS | `grep -rn` found `def add`; `find` listed files; `grep -c` counted                |
| 8   | **WebFetch**                                                                               | ✅ PASS | `example.com` → "Example Domain"                                                 |
| 9   | **WebSearch**                                                                              | ✅ PASS* | Runs + returns structure; one query returned an empty result                     |
| 10  | **Agent** (subagent launch)                                                                | ✅ PASS | After the `input_tokens` + `e.replace` fix: `status: completed`, correct answer  |
| 11  | **Workflow** (orchestration)                                                               | ✅ PASS | After the `input_tokens` fix: `agents_done:2, error:0`, tokens returned          |
| 12  | **AskUserQuestion**                                                                        | ✅ PASS | Question sent, answer received                                                   |
| 13  | **EnterPlanMode / ExitPlanMode**                                                           | ✅ PASS | Clean entry into and exit from plan mode                                         |
| 14  | **Task tools** (Create/Get/List/Update)                                                    | ✅ PASS | 10 tasks created, read, updated, listed                                          |
| 15  | **Cron** (Create/List/Delete)                                                              | ✅ PASS | One-shot task `12b50975` created, listed, cancelled                               |
| 16  | **ScheduleWakeup**                                                                         | ✅ PASS | 60-second wakeup scheduled, fired (twice)                                        |
| 17  | **Persistent Memory** (filesystem)                                                         | ✅ PASS | Wrote `eval-probe.md` + index `MEMORY.md`                                        |


---



## 🚨 Finding A — Subagents and Workflow crash: missing `usage.input_tokens`

**Both** — standalone `Agent` and `Workflow` leaf agents — crashed with:

```
undefined is not an object (evaluating 'd.input_tokens')
```

The subagent transcript (`a8794d8b0f4e72cfe.output`) contained only **4 lines** and ended at the assistant's `Bash` tool_use — the gateway response was **missing** the `usage`, `input_tokens`, and `stop_reason` fields. Claude Code's agent runner reads `usage.input_tokens` after every model turn for cost/context tracking, hit `undefined`, and crashed — *after the agent had already done its work*. The workflow `journal.jsonl` confirms: both parallel agents reached `{"type":"failed"}` (2× started, 2× failed).

**Status (last confirmation 20:36):** unchanged — transcript still 4 lines, usage fields still absent, workflow journal `2 started / 2 failed`.

### ✅ Re-test after fix (2026-09-08, ~20:45)

After the backend fix, **Workflow fully recovered**:

- Result: `{"alpha":"ALPHA","beta":"BETA","orchestrated":true}` — both leaf agents **returned tokens** (previously `null`).
- Usage: `agents_done: 2, agents_error: 0` (previously `2 failed`).
- Journal `wf_c7c57684-c8e`: `2 started / 2 result` (previously `2 started / 2 failed`).

**Standalone Agent: partial.** Transcript `a66687b77ff9767da` now contains a `usage` block with `input_tokens` (2 blocks, `stop_reason: tool_use` → `end_turn`), the transcript grew to **11 lines** (was 4), and the agent gave the **correct answer** ("2 entries: REPORT.md and docs"). So the **original crash** on `input_tokens` is **resolved**.

**🚨 But a new crash appeared** — `undefined is not an object (evaluating 'e.replace')`. It:

- is **not** in the transcript (0 matches) → it is a **Claude Code post-processing crash** after the agent turn finishes, not a backend response problem.
- Causes the agent task to still be marked `status: failed`, even though the agent's answer was formed and saved.

**Re-test conclusion:** The `usage.input_tokens` fix worked — Workflow is 100% OK. For standalone `Agent`, a **new latent post-processing bug** remains (`e.replace` on an undefined string), which must be tracked separately from the already-fixed Finding A. Most likely the harness calls `.replace()` somewhere on a response field (e.g. `content`/`text`/`model`/`id`) that the backend does not return.

### ✅ Re-test #2 after the `e.replace` fix (2026-09-08, ~20:5x)

Standalone `Agent` (`a6e53633427878dd2`) now **fully passes**:

- `status: completed` (was `failed`).
- **0** matches of the crash signature `undefined is not an object` (previously `e.replace`).
- The only match of the string `e.replace` in the transcript is the **test prompt's own text** ("re-test of the e.replace post-processing fix"), **not** an error.
- `is_error: false` on tool_result; final `stop_reason: end_turn`; 2 `usage` blocks with `input_tokens`.
- The agent returned the correct answer: *"The command printed exactly 2 lines: REPORT.md and docs"*.

**Conclusion:** Both latent post-processing bugs are fixed. **Agent and Workflow are now 100% functional.** Overall pass-rate updated to **17/17 (100%)**.

**Impact:** All functionality that spawns a child agent (`Agent`, `Workflow`, likely background/teammate agents) **was non-functional** on this backend — the agent ran, but its result was lost and the parent was told about a "failure". This is a **backend response-format incompatibility**, not a model-intelligence issue. An open Qwen gateway must emit the Anthropic `usage: {input_tokens, output_tokens, ...}` block and `stop_reason` in **every** completion.

---



## ⚠️ Finding B — Safety classifier on the same flaky model

The safety classifier (which gates Bash, Write, Edit, Agent, WebSearch, Cron, Monitor, ScheduleWakeup, and background runs in auto mode) **is also routed through** `qwen3.8-27b`. During the field check, for ~5–6 min the model was intermittently unavailable, and **all** gated tools were blocked with the message:

> `qwen3.8-27b is temporarily unavailable, so auto mode cannot determine the safety of [tool] right now.`

A **~50–70% block rate** of gated calls was observed in the window, followed by full recovery. Only **read-only** tools (Read, WebFetch, Task, AskUserQuestion, plan-mode entry/exit) remained available.

**Impact:** A temporary `qwen3.8-27b` outage makes **all write/execute actions of the interactive agent impossible** — a single point of failure. The classifier should run on a separate, more reliable/replicated model.

---

## Gateway `usage` fix status (validated on the local GX-10 stack)

Per `docs/gateway-usage-debug-spec.md` (2026-09-11): the remote gateway's `usage:0` regression — the direct cause of the recurring 1-token-over `context_length_exceeded` 400s — has a confirmed root cause and a validated fix path.

### Root cause (per the gateway team, findings §K)

Not the streaming path (H1) — it is a **tokenizer availability race on the RunPod pod**: cold start → the preflight token count falls back to 0 → the response carries `usage.input_tokens = 0` on every sustained-session message, while one-shot probes still got real counts. That zeroed telemetry made the client's auto-compact blind (it believed the session was ~13% of the window), which in turn made `/compact` re-send a ~127k-token history and hit the exact 1-token-over 400.

### Verified on the local GX-10 stack (2026-09-11, ~17:30 UTC)

The local chain — Claude Code → repo proxy (`127.0.0.1:18080`) → LiteLLM (`127.0.0.1:4000`, `openai/qwen38-27b`) → vLLM (`127.0.0.1:8000`, `Qwen/Qwen3.8-27B-FP8`, `--max-model-len 160000`) — **does not exhibit the `usage:0` regression**. Real usage is present and correct on both one-shot and sustained-session paths:

| Req | Local status | Evidence |
|---|---|---|
| **GW-1** real usage on every response (incl. streaming terminal) | ✅ **Pass** — 0 zeros | Current session 13/13 non-zero; synthetic streaming ladder non-zero at every rung (1/20/60/120/200/400 turns). |
| **GW-2** preflight count == returned usage | ✅ **Pass** | Stream and non-stream return the identical count on the identical payload; single static vLLM tokenizer — no divergence. |
| **GW-3** 400 body carries the arithmetic | ✅ **Pass** — better than the remote rewrite | Forced OVER 400 body carries the raw vLLM arithmetic verbatim (window, requested output, prompt length) — numbers present, not hidden. |
| **GW-4** stable tokenizer | ✅ **Effectively holds** | Static in-process tokenizer — no cold-start race, no day-to-day drift (the remote failure mode was exactly that race). |

All Phase A hypotheses (H1 streaming, H2 caching, H3 length, H4 intermittency, H5 per-instance) were **ruled out locally**. Cached prefixes are charged as `cache_read_input_tokens` (53,312 observed on a live message), never dropped to 0.

**Note:** this validates the *fix approach* (a single stable tokenizer serving both preflight and response). The remote gateway's two-part fix (RunPod `--tokenizer` + gateway-image embed) is scheduled for **Monday 2026-09-14** — the remote re-verification (§6.5 baseline in the spec) still has to be re-run after that deploy lands.

### Remaining items (not blockers for the capability pass)

- **Remote re-verification** after the 09-14 deploy: session-stream audit must flip to non-zero (GW-1), the OVER 400 body must carry the arithmetic (GW-3), and ideally the diagnostic header (GW-2/S-3.3) must appear.
- **GW-5** — `gpt-5-5` (haiku tier) is gated behind an "evaluation identity" the current token does not satisfy (every request → `403 evaluation_policy_block`). Separate policy/identity issue; the gateway should accept the existing `ai-evaluation` identity or return `404 model unavailable` so the model-picker can fall back. Not applicable on the local stack.
- **Client-side hardening** (enabled once real usage is back, per spec §5): keep `context-guard.py` preferring real usage, and extend `probe_overflow.js` with a sustained-leg (K small requests in a row, assert the last still has non-zero usage) to catch the "one-shot real / sustained zero" split.

---

## Conclusion

The core of the interactive agent **works well** on the open Qwen: file I/O, shell, search, web, planning, scheduling, task management, memory, user interaction — all functional. The two backend defects that blocked a clean pass have both been addressed:

1. **(Blocker for agent features — FIXED & RE-TESTED)** The gateway now returns `usage.input_tokens`/`output_tokens`/`stop_reason` in every completion; the follow-on `e.replace` post-processing crash was also fixed. Agent and Workflow are 100% functional (17/17).
2. **(Reliability — root cause confirmed)** The `usage:0` telemetry regression was traced to a RunPod pod tokenizer cold-start race; the fix approach is validated on the local GX-10 stack, and the remote two-part fix is scheduled for 2026-09-14 with a clean re-verification baseline in the spec.
3. **(Still open — reliability)** The safety classifier shares its model with the agent; its outages freeze all write/execute tools. A separate, reliable model is still needed for the classifier.

---

*Report generated during AI-evaluation (header* `X-AI-Client: ai-evaluation`*). Updated 2026-09-12: translated to English; gateway usage fix status added per `docs/gateway-usage-debug-spec.md`.*