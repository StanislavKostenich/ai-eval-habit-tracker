# Research Summary: Claude Code + Self-Hosted Qwen3.8-27B-FP8

**Goal of this research:** we wanted to evaluate whether Qwen3.8-27B-FP8, self-hosted on our own RunPod H200 GPU, is good enough — in code quality and security — to use as a coding model for everyday development.

**Method:** we used Claude Code's spec-driven development workflow as the test harness. A complete, unambiguous specification (`docs/SPEC.md` — auth, database, real-time features, and 11 named security/correctness rules) was handed to Claude Code running on the model under test, which built a full-stack application end-to-end. We then independently audited the result: read the actual source code against every rule in the spec, ran the type-checkers and test suite, and probed the live deployment directly — rather than trusting the model's own "done" report.

**Answer: yes, adopt it for scoped, well-specified engineering work.** The code-quality result was strong. The one blocking infrastructure issue found during the research (a token-accounting bug in our self-hosted gateway, unrelated to the model's coding ability) has since been root-caused and fixed, and is now holding in production re-verification.

---

## What we tested, and why it's a fair test

Two separate things were evaluated, because a "the model is fine" conclusion is only trustworthy if both hold:

1. **Can Claude Code reliably drive this model at all** — file edits, running commands, multi-step autonomous work, sub-agents — or does the self-hosted setup introduce its own failures that would masquerade as "the model is bad"?
2. **Is the code it actually produces good** — judged against an explicit rulebook, not vibes, and re-verified independently rather than taken from the model's own summary.

## Result 1: Code quality and security — strong

Every one of the 11 named security/correctness rules in the spec was checked by directly reading the produced source code, not by asking the model whether it followed them. All 11 passed:

- Correct access control (ownership checks that distinguish "doesn't exist" from "not yours")
- Correct handling of a known JavaScript footgun that has caused real security bugs in prior versions of this same exercise
- No hardcoded server addresses (a real deployment-breaking mistake models sometimes make)
- Correct state-machine enforcement (an "archived" record can't be silently un-archived)
- Rate limiting configured correctly and in the right place
- No accidental use of a hardcoded secret-key fallback
- No unnecessary third-party auth library pulled in where the spec said not to

Both halves of the codebase compiled clean under the strictest TypeScript settings, with zero shortcuts (`any` types) and zero leftover to-do markers. We also checked the **live deployed application** directly (not just the source) and found it matched its intended configuration on every check but one minor gap (a cookie-security flag not set correctly behind our reverse proxy — a fixable configuration detail, not a code-logic bug).

**Full detail:** [`docs/QWEN_AUDIT_REPORT.md`](./QWEN_AUDIT_REPORT.md)

## Result 2: Tooling reliability — one real infrastructure bug, now fixed and verified

Running Claude Code against a self-hosted model surfaced infrastructure issues that had nothing to do with the model's coding ability, but would have blocked adoption if left unfixed:

- **A gateway bug initially broke multi-step autonomous work** (the model's own sub-tasks were failing even though they'd completed correctly) — traced to a missing accounting field in the gateway's responses. **Fixed and re-verified**; this class of work is now fully functional.
- **A separate, more serious token-accounting bug** caused the coding assistant to occasionally believe a conversation was much shorter than it actually was, which could trigger a hard failure mid-session. We root-caused this ourselves: a cold-start race condition on the GPU pod meant the tokenizer wasn't ready yet, so early requests silently reported a token count of zero. **This has since been fixed** (the pod was restarted with the tokenizer pre-loaded) **and independently re-verified**: every live coding session since the fix landed has reported accurate counts with zero recurrences, across dozens of sessions and thousands of messages. Two narrower verification items remain open — confirming the fix holds day-over-day, and adding a diagnostic signal so this class of issue is easier to catch early next time — but the user-facing failure mode itself is gone.
- **A single-point-of-failure risk was found and has since been fixed.** In our original setup, the same model that writes code was also used to approve whether an action is safe to run — during a brief model outage in testing, this froze all write/execute actions at once. This has been resolved by routing the safety-approval check to a separate model (`gpt-5-5`) instead of sharing the coding model's instance, so a coding-model outage no longer freezes engineering activity.

**Full detail:** [`REPORT.md`](../REPORT.md) (capability verification) and [`docs/gateway-usage-debug-spec.md`](./gateway-usage-debug-spec.md) (the token-accounting root-cause investigation and fix verification).

## Caveats — what this research does and doesn't tell us

- **This is one data point, on one type of task.** The specification we used was unusually explicit and rule-based by design, so the model could be checked against it precisely. It tells us less about how the model performs on ambiguous requirements or open-ended architecture decisions — the kind of judgment-heavy work senior engineers spend a lot of time on.
- **Deployment/CI-CD work took noticeably more back-and-forth than the core application code.** Treat cloud infrastructure changes as needing more review than application logic, at least for now.
- **Never trust a model's own "fully compliant, zero issues" self-report — for this model or any other.** Independent verification is what made this research trustworthy in the first place, and it should stay a standing practice, not a one-time evaluation gate.

## Recommendation for SDLC adoption

**Adopt now, for:** well-specified feature work, security- and correctness-sensitive backend code, and structured multi-step builds where requirements are written down with clear acceptance criteria.

**Not yet recommended for, without further evidence:** ambiguous or exploratory work, novel architecture decisions, and unsupervised cloud infrastructure changes.

**Before wider rollout:**
1. Close the two remaining verification items on the token-accounting fix (day-over-day stability check, diagnostic signal) — the user-facing bug is already gone, this is about making the fix easy to monitor going forward.
2. Keep an independent code-review step in the pipeline — automated or human — regardless of which model wrote the code.
3. Run one more evaluation on a less rigidly-specified task before expanding usage further, to test judgment on ambiguity rather than rule-following.

**Bottom line for leadership:** the research shows the model is genuinely productive for real engineering work today. Both infrastructure risks found during this research — the token-accounting bug and the shared safety-approval single point of failure — have been root-caused, fixed, and verified. There is no remaining infrastructure blocker to adoption on well-scoped work.

---
*Sources: `docs/SPEC.md` (the specification used), `docs/QWEN_AUDIT_REPORT.md` (code-quality audit), `REPORT.md` (tool-capability verification), `docs/gateway-usage-debug-spec.md` (token-accounting root cause and fix verification). Compiled 2026-09-12.*
