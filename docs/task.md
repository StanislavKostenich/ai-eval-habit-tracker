Task: Investigate Claude Code safety-classifier forwarding via Enterprise AI Gateway

Goal

Determine how Claude Code identifies and sends requests for its fast/safety classifier, so the Enterprise AI Gateway can route only those requests to GPT-5.5 while keeping normal coding/agent requests on Qwen3.8-27B.

Current Gateway behavior

Main Claude Code model:
qwen3.8-27b
→ Enterprise AI Gateway
→ RunPod Qwen3.8-27B

Target classifier model:
gpt-5-5
→ Enterprise AI Gateway
→ OpenAI GPT-5.5

Do not change any configuration yet. Investigation only.

What to check in Claude Code

1. Configuration

Capture sanitized values/names only:

- ANTHROPIC_BASE_URL;
- ANTHROPIC_MODEL;
- ANTHROPIC_SMALL_FAST_MODEL;
- ANTHROPIC_AUTH_TOKEN presence only;
- any modelOverrides configuration;
- Claude Code version;
- whether auto mode is enabled.

Never print API keys, tokens, Authorization headers, prompts, tool arguments or responses.

2. Request separation

Verify whether Claude Code sends a distinct request for the fast/safety classifier when performing:

- harmless Bash command;
- harmless file write;
- harmless file delete;
- subagent launch;
- network/read-only tool call.

For each request, capture only:

- timestamp;
- endpoint;
- requested model;
- X-AI-Client value, if present;
- stream true/false;
- tool count;
- tool_choice type;
- HTTP status;
- correlation/request ID, if available.

Do not capture user messages, commands, prompts, tool payloads or response content.

3. Identify the classifier signal

Determine which reliable field distinguishes safety-classifier requests from normal agent requests:

- model name, especially ANTHROPIC_SMALL_FAST_MODEL;
- endpoint;
- header;
- request metadata;
- tool schema;
- system metadata;
- client-side request type.

The desired result is a stable rule such as:

Claude Code request with model=<classifier-model>
and X-AI-Client=claude-code
→ safety classifier request

4. Validate model override

Temporarily test, without modifying Gateway:

ANTHROPIC_MODEL=qwen3.8-27b
ANTHROPIC_SMALL_FAST_MODEL=gpt-5-5

Then perform:

- one normal chat request;
- one harmless Bash command;
- one harmless file write/delete in a disposable test folder;
- one subagent request.

Confirm whether Claude Code actually sends gpt-5-5 for safety/permission checks and qwen3.8-27b for the primary agent.

5. Required evidence for Gateway work

Provide a sanitized mapping:

PRIMARY_REQUEST:
- requested model;
- endpoint;
- distinguishing metadata;
- expected route: Qwen3.8-27B.

CLASSIFIER_REQUEST:
- requested model;
- endpoint;
- distinguishing metadata;
- expected route: GPT-5.5.

6. Constraints

- Do not change Gateway configuration.
- Do not change Qwen, RunPod, OpenAI or provider credentials.
- Do not disable Claude Code auto-mode safety checks.
- Do not use production repositories or sensitive data.
- Use only a disposable local test directory.
- Do not expose any secrets.

Expected deliverable

A short Markdown report with:

- Claude Code version;
- relevant configuration variable names and sanitized status;
- whether ANTHROPIC_SMALL_FAST_MODEL is actually used;
- primary-request metadata;
- classifier-request metadata;
- exact reliable signal for Gateway routing;
- result of Bash/write/subagent tests;
- recommendation: Gateway mapping feasible / not feasible;
- if feasible, the proposed safe rule limited to:
  X-AI-Client=claude-code + classifier model alias → gpt-5-5.

Success criterion

The investigation must prove that Gateway can distinguish classifier requests from normal Qwen3.8-27B requests without inspecting prompt text or changing behavior for other clients.