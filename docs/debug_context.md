Yes. I would treat this as a **Claude Code context-accounting investigation**, not another settings experiment.

The objective is to determine why Claude Code `/context` reports ~14K tokens while the request reaching your Qwen gateway contains ~123K tokens, and whether the difference comes from **Claude Code accounting, MCP/tool schemas, transcript serialization, gateway transformation, or tokenization**.

Below is a spec you can give directly to Claude Code.

---

# Investigation Spec: Claude Code Context Accounting vs Qwen Gateway

## 1. Objective

Investigate the discrepancy between:

```text
Claude Code /context:
~13.9K / 110K tokens
```

and the actual API error from Qwen:

```text
input_tokens = 122881
max_tokens   = 8192
total        = 131073
limit        = 131072
```

The investigation must identify **where the additional ~109K tokens are introduced or counted differently**.

Do not modify production behavior or gateway routing during the investigation.

---

# 2. Hypothesis tree

Investigate these hypotheses independently:

### H1 — `/context` is displaying an internal estimate

Determine exactly what `/context` counts and whether it represents:

* raw conversation tokens
* effective model input tokens
* tool definitions
* MCP schemas
* system prompt
* skills
* agents
* memory
* hidden/internal context
* compaction buffer

Claude Code documentation says `/context` is intended to show what consumes the context window, including system prompt, tools, memory and messages. ([Claude][1])

Determine whether the displayed value is expected to equal the token count calculated by the downstream model. **Do not assume it does.**

---

### H2 — MCP/tool definitions are missing from `/context`

The current session reports:

```text
MCP tools: 65 tools · 0 tokens
```

This is suspicious.

Determine:

1. How `/context` calculates MCP tool token usage.
2. Where MCP tool schemas are stored internally.
3. Whether the 65 tools are actually included in the API request.
4. Total serialized size of those tool definitions.
5. Token count of those tools using the Qwen tokenizer.
6. Whether tools are duplicated for subagents.

Claude Code documentation explicitly notes that unused MCP servers should be disabled because their tool definitions consume context, and that subagents inherit MCP tool definitions from the parent session. ([Claude][1])

---

# 3. Establish a reproducible baseline

Create a minimal test project:

```text
/tmp/claude-context-test/
```

with:

```text
CLAUDE.md
```

containing only:

```text
Context accounting investigation.
Do not read additional files.
```

Start Claude Code with the same gateway configuration.

Record:

```bash
claude --version
env | grep -E '^(ANTHROPIC|CLAUDE_CODE|CLAUDE_AUTO)'
```

Do not print secret values.

Redact:

```text
ANTHROPIC_AUTH_TOKEN
ANTHROPIC_API_KEY
```

---

# 4. Test A — empty/minimal session

Start a completely new session.

Run:

```text
/context
```

Record:

```text
total reported tokens
system prompt
tools
MCP
skills
agents
memory
messages
free space
auto-compact buffer
```

Then send:

```text
hello
```

Run:

```text
/context
```

again.

Record the delta.

### Expected output

Create a table:

| Component | Before | After | Delta |
| --------- | -----: | ----: | ----: |
| System    |        |       |       |
| Tools     |        |       |       |
| MCP       |        |       |       |
| Skills    |        |       |       |
| Agents    |        |       |       |
| Memory    |        |       |       |
| Messages  |        |       |       |
| Total     |        |       |       |

---

# 5. Test B — disable all MCP

Run:

```text
/mcp
```

Identify all enabled MCP servers.

Disable them one by one, or all unused servers:

```text
/mcp disable <server>
```

Then restart Claude Code.

Run:

```text
/context
```

Record the result.

The purpose is to determine whether the:

```text
65 MCP tools
```

are responsible for the discrepancy.

Claude Code's official error guidance specifically recommends disabling unused MCP servers when diagnosing context problems. ([Claude][1])

---

# 6. Test C — compare `/context` with gateway request

This is the **most important test**.

Run Claude Code with debug logging:

```bash
claude --debug-file /tmp/claude-context-debug.log
```

Claude Code supports `--debug-file`, and debug logging can also be configured through `CLAUDE_CODE_DEBUG_LOGS_DIR`. ([Claude][2])

Do not expose authentication headers in the output.

Capture:

```text
request start
model
request type
context/token calculations
compaction events
tool counts
API errors
```

Then make one very small request:

```text
Say OK.
```

At the same time capture the corresponding gateway request.

---

# 7. Gateway-side instrumentation

Add temporary diagnostic logging immediately before the gateway sends the request to Qwen/vLLM.

Log:

```json
{
  "request_id": "...",
  "model": "...",
  "anthropic_input_message_count": 0,
  "tool_count": 0,
  "system_chars": 0,
  "messages_chars": 0,
  "tools_chars": 0,
  "serialized_request_chars": 0,
  "qwen_input_tokens": 0,
  "max_tokens": 0
}
```

Never log:

```text
Authorization
API keys
gateway tokens
full source code
full prompts
PII
```

Prefer hashes or lengths.

---

# 8. Tokenize at the gateway

This is critical.

Do **not** use only the Anthropic token count.

Use the exact tokenizer used by the Qwen deployment.

Calculate:

```text
Qwen tokens before transformation
Qwen tokens after Anthropic → Qwen transformation
```

For example:

```text
Anthropic request
        ↓
gateway parser
        ↓
internal representation
        ↓
Qwen chat template
        ↓
Qwen tokenizer
        ↓
actual input_tokens
```

Log:

```text
anthropic request size
      ↓
converted prompt size
      ↓
Qwen tokenizer count
```

The final number must be compared against the:

```text
input_tokens=122881
```

reported by the API error.

---

# 9. Inspect the Anthropic → Qwen conversion

Locate the gateway code that converts:

```text
POST /v1/messages
```

into the Qwen/vLLM request.

Inspect specifically:

```text
system
messages
tools
tool_choice
thinking
metadata
cache_control
anthropic-beta
chat template
```

Determine whether the gateway:

* duplicates system prompts
* duplicates conversation messages
* embeds tool schemas into the system prompt
* serializes tools multiple times
* includes previous tool results twice
* includes full tool definitions for every message
* adds its own system instructions
* expands agent definitions
* embeds MCP metadata
* adds hidden routing/policy prompts

Produce a before/after token breakdown.

---

# 10. Inspect the Qwen chat template

Determine exactly which chat template is being used.

Capture:

```text
model
tokenizer revision
chat template
template arguments
thinking mode
tool parser
```

The investigation must calculate the token count **after applying the actual Qwen chat template**.

This is important because:

```text
messages token count
```

is not necessarily equal to:

```text
serialized Qwen prompt token count
```

especially with tools.

---

# 11. Test with tools removed

Create a controlled request with:

```text
0 tools
```

Then:

```text
1 tool
```

Then:

```text
10 tools
```

Then:

```text
all 65 tools
```

Measure:

```text
input_tokens
```

for each.

Produce:

| Tools | Input tokens | Delta |
| ----: | -----------: | ----: |
|     0 |              |       |
|     1 |              |       |
|    10 |              |       |
|    65 |              |       |

This will immediately show whether MCP/tool schemas are responsible.

---

# 12. Test with conversation history removed

Create controlled requests:

### Case 1

```text
system only
```

### Case 2

```text
system + one user message
```

### Case 3

```text
system + 10 messages
```

### Case 4

```text
full Claude Code conversation
```

Compare:

```text
Claude Code /context
```

against:

```text
Qwen tokenizer
```

---

# 13. Investigate session transcript

Claude Code exposes the transcript path to hooks and session infrastructure. Its `PreCompact` and `PostCompact` hooks receive `transcript_path`, which can be used for diagnostic inspection. ([Claude][3])

Locate the current session transcript.

Do **not** modify it.

Calculate:

```text
number of messages
number of tool calls
number of tool results
number of assistant messages
number of user messages
number of file reads
number of large tool outputs
```

Identify the largest individual blocks.

Produce:

```text
Top 20 largest context contributors
```

with:

```text
type
size_bytes
estimated_tokens
source
```

---

# 14. Investigate file/tool output accumulation

The original session ran for almost two hours and contained many:

```text
Read
Bash
Agent
Edit
Write
```

operations.

Determine whether Claude Code keeps:

```text
full tool result
+
subsequent transformed representation
+
agent result
```

in the actual API payload.

Especially inspect:

```text
large file reads
git output
test output
diagnostics
agent results
background-agent results
```

---

# 15. Test compaction independently

Create a fresh session.

Generate approximately:

```text
50K
70K
90K
100K
110K
```

tokens of controlled conversation.

At each point:

```text
/context
```

then:

```text
/compact
```

Record:

```text
Claude Code reported tokens
gateway input_tokens
compact success/failure
compact output tokens
```

Create:

| CC reported | Gateway actual | `/compact` |
| ----------: | -------------: | ---------- |
|         50K |                |            |
|         70K |                |            |
|         90K |                |            |
|        100K |                |            |
|        110K |                |            |

This determines the actual relationship between Claude Code's accounting and Qwen's accounting.

---

# 16. Investigate the compaction request itself

This is critical because your current failure occurs specifically during:

```text
/compact
```

Capture the compaction request separately.

Determine:

```text
normal request input tokens
compact request input tokens
compact max_tokens
compact system prompt
compact tools
compact instructions
```

Check whether `/compact` sends:

```text
full conversation
+
all tools
+
MCP schemas
```

to Qwen.

If yes, determine whether there is a way to exclude tools from the compaction request.

---

# 17. Check Claude Code version

Run:

```bash
claude --version
```

Record the exact version.

Your investigation should also check the Claude Code changelog for context/compaction fixes. Recent Claude Code releases have included fixes around `/compact` context overflow and `/context` accounting, so version matters. ([Claude][4])

Do **not** upgrade during the investigation.

First establish a baseline.

---

# 18. Debug logging requirements

Run:

```bash
claude --debug-file /tmp/claude-context-debug.log
```

For more verbose diagnostics:

```bash
CLAUDE_CODE_DEBUG_LOG_LEVEL=verbose \
claude --debug-file /tmp/claude-context-debug.log
```

Claude Code documents `CLAUDE_CODE_DEBUG_LOG_LEVEL=verbose` for high-volume diagnostics. ([Claude][2])

Search the resulting log for:

```text
compact
context
token
input
output
tool
MCP
request
response
131072
122881
```

---

# 19. Do NOT change these during investigation

Keep constant:

```text
model = qwen3.8-27b
context = 131072
max output = 8192
gateway URL
chat template
tool parser
reasoning configuration
```

Do not simultaneously change:

```text
auto compact
MCP
gateway conversion
model
tokenizer
context length
```

Otherwise we won't know which change caused the difference.

---

# 20. Final deliverable

Claude Code should produce:

## A. Root cause

One of:

```text
Claude Code accounting bug
```

or:

```text
MCP/tool accounting mismatch
```

or:

```text
Anthropic → Qwen transformation inflation
```

or:

```text
Qwen tokenizer/chat-template inflation
```

or:

```text
duplicate transcript/tool data
```

or:

```text
combination of the above
```

## B. Quantitative breakdown

For the failing request:

```text
Claude Code reported:       ~13.9K
Gateway input:             122,881
Difference:                ~108,981
```

Explain where every significant portion comes from.

## C. Recommended fix

Provide a concrete recommendation for:

```text
Claude Code configuration
+
MCP configuration
+
gateway transformation
+
Qwen context configuration
```

## D. Regression test

Create an automated test that fails if:

```text
Claude Code estimated tokens
```

and:

```text
gateway/Qwen tokens
```

diverge by more than an agreed threshold.

---

# Success criteria

The investigation is complete only when we can explain this exact discrepancy:

```text
/context
13.9K / 110K
```

versus:

```text
Qwen
122,881 input tokens
```

and reproduce it with a controlled test.

**Do not conclude that `/context` is wrong until the gateway-side Qwen tokenizer measurement proves the actual discrepancy.**

---

### Recommended first command

I would start with:

```bash
claude --debug-file /tmp/claude-context-debug.log
```

then:

```text
/context
```

and perform **one simple request**.

At the same time, instrument the gateway to record the **post-transformation Qwen token count**.

That single experiment should tell us whether the problem is primarily **inside Claude Code or between Claude Code and Qwen**.

[1]: https://code.claude.com/docs/en/errors?utm_source=chatgpt.com "Error reference - Claude Code Docs"
[2]: https://code.claude.com/docs/en/env-vars?utm_source=chatgpt.com "Environment variables - Claude Code Docs"
[3]: https://code.claude.com/docs/en/hooks?utm_source=chatgpt.com "Hooks reference - Claude Code Docs"
[4]: https://code.claude.com/docs/en/changelog?utm_source=chatgpt.com "Changelog - Claude Code Docs"
