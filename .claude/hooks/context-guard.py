#!/usr/bin/env python3
"""UserPromptSubmit safety hook: warn before the session overflows the model's
hard context wall.

UPDATED 2026-09-11. The gateway now returns real usage (see
docs/compact-overflow-findings.md §C / §G). This hook PREFERs reading the real
`usage.input_tokens` from the last assistant message in the transcript and only
falls back to a chars-based estimate when the real value is missing or zero
(the old `usage:0` regression case).

Why a hook at all (see docs/compact-overflow-findings.md):
  - The gateway enforces a hard 131072 limit (input + max_output). When the
    next request's real input_tokens + CLAUDE_CODE_MAX_OUTPUT_TOKENS exceeds
    it, the request 400s.
  - /context shows a chars/4 estimate of the in-memory conversation only and
    understates the real request by a large factor on tool-heavy sessions.
  - With CLAUDE_CODE_MAX_CONTEXT_TOKENS=131072 and
    CLAUDE_CODE_AUTO_COMPACT_WINDOW=120000 / 85%, auto-compact now fires at
    ~102k, well before the wall. This hook is a SECONDARY tripwire that warns
    a little earlier and is also the thing that tells the user to /compact if
    the session is already too big for a clean auto-compact.

It never blocks by default; set CLAUDE_CTX_GUARD_BLOCK=1 to block.
"""
import json
import os
import sys

# --- Tunables (override via env) ------------------------------------------
HARD_LIMIT = int(os.environ.get("CLAUDE_CTX_HARD_LIMIT", "131072"))
MAX_OUTPUT = int(os.environ.get("CLAUDE_CODE_MAX_OUTPUT_TOKENS", "4000"))
# Fallback estimate (only used when real usage is absent / zero).
#
# PESSIMISTIC on purpose (see docs/compact-overflow-findings.md §I): the
# gateway's real-usage fix is flaky (usage:0 recurs), and when it does the
# transcript-text estimate understates the REAL request by a factor that
# drifts per session — measured ×8 once (16k est vs 127k real) on a
# tool-heavy session. 3.3 chars/token is the honest raw ratio; 1.8 is the
# pessimistic calibration that makes an est+output crossing 0.85×131072
# correspond to a REAL total near the wall. Consequences of the pessimism:
#   - on tool-heavy sessions (where the real request is much larger than
#     the transcript) the warning fires close to the true danger point;
#   - on text-only sessions (where real ≈ honest est, i.e. the ratio is
#     really ~3.3) it warns ~2× early. That is the accepted trade: a nag
#     before the wall beats a silent 400 at the wall.
CHARS_PER_TOKEN = float(os.environ.get("CLAUDE_CTX_CHARS_PER_TOKEN", "1.8"))
SCHEMA_TOKENS = int(os.environ.get("CLAUDE_CTX_SCHEMA_TOKENS", "4000"))
# Warn when (real_input + max_output) crosses WARN_FRACTION of the wall.
# With REAL usage this is precise, so 0.85 is safe and tight: at 85% of 131072
# we're at ~111k real input, and +4000 output = ~115k, still under 131072 with
# a ~16k margin.
# On the ESTIMATE path (usage:0) a separate, LOWER fraction applies
# (EST_WARN_FRACTION, default 0.30 ≈ 39k line): the transcript chars are a
# small, session-dependent fraction of the real request (measured ×2-×5 on
# tool-heavy sessions, §I) and that factor drifts, so NO fixed ratio
# calibrates the estimate to the wall. The estimate is used only as a
# PROGRESS SIGNAL: a session whose transcript already represents ~30% of the
# wall in raw text is almost certainly tool-heavy and will 400 well before
# the estimate itself nears the wall. This nags mid-session (a few times,
# until the user compacts) instead of once-too-late. Cost: text-only light
# sessions also get an early nag (their est ≈ real, so 39k est is a real
# 39k). Accepted trade: a nag before the wall beats a silent 400 at the wall.
# Real-usage path is unaffected by this.
WARN_FRACTION = float(os.environ.get("CLAUDE_CTX_WARN_FRACTION", "0.85"))
EST_WARN_FRACTION = float(os.environ.get("CLAUDE_CTX_EST_WARN_FRACTION", "0.30"))
BLOCK = os.environ.get("CLAUDE_CTX_GUARD_BLOCK", "0") == "1"


def text_of(content):
    if isinstance(content, str):
        return len(content)
    if isinstance(content, list):
        n = 0
        for b in content:
            if not isinstance(b, dict):
                continue
            t = b.get("type")
            if t in ("text", "thinking"):
                n += len(b.get("text", "") or "")
            elif t == "tool_use":
                n += len(json.dumps(b.get("input", {}), ensure_ascii=False))
            elif t == "tool_result":
                c = b.get("content")
                n += len(c) if isinstance(c, str) else len(
                    json.dumps(c, ensure_ascii=False)
                )
        return n
    return 0


def real_input_tokens(recs):
    """Walk the transcript backwards and return the last non-zero
    usage.input_tokens found on an assistant message, else None."""
    for rec in reversed(recs):
        if rec.get("type") != "assistant":
            continue
        msg = rec.get("message") or {}
        usage = msg.get("usage") or {}
        it = usage.get("input_tokens")
        if isinstance(it, int) and it > 0:
            return it
    return None


def is_compact_boundary(rec):
    if rec.get("type") == "system" and rec.get("subtype") == "compact_boundary":
        return True
    if rec.get("type") == "user" and rec.get("isCompactSummary"):
        return True
    return False


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)  # no payload / not a hook run: stay silent

    path = payload.get("transcript_path", "")
    if not path or not os.path.exists(path):
        sys.exit(0)

    recs = []
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    recs.append(json.loads(line))
                except ValueError:
                    continue
    except OSError:
        sys.exit(0)

    if not recs:
        sys.exit(0)

    # Prefer the real token count from the gateway's usage. This is the
    # prompt size of the last real request -- the best proxy for what the
    # NEXT request will send (it re-sends the same history).
    real = real_input_tokens(recs)
    if real is not None:
        est_real = real
        source = "real"
    else:
        # Fallback: estimate from chars since the last compact boundary.
        start = 0
        for i in range(len(recs) - 1, -1, -1):
            if is_compact_boundary(recs[i]):
                start = i + 1
                break
        total_chars = 0
        for rec in recs[start:]:
            if rec.get("type") not in ("user", "assistant"):
                continue
            content = (rec.get("message") or {}).get("content")
            if content:
                total_chars += text_of(content)
        est_real = int(total_chars / CHARS_PER_TOKEN) + SCHEMA_TOKENS
        source = "est"

    est_with_output = est_real + MAX_OUTPUT
    # The estimate undercounts the real request by a session-dependent factor,
    # so its danger line sits LOWER than the real-usage line (see §I).
    frac = WARN_FRACTION if source == "real" else EST_WARN_FRACTION
    danger_line = int(frac * HARD_LIMIT)

    # Below the danger band: silent, no overhead.
    if est_with_output < danger_line:
        sys.exit(0)

    headroom = HARD_LIMIT - est_with_output
    pct = round(est_real / HARD_LIMIT * 100)
    src_note = ("real gateway usage" if source == "real"
                else "estimate (gateway returned no usage)")

    if headroom < 0:
        msg = (
            "CONTEXT OVERFLOW RISK (%s): the next request would be ~%d input "
            "tokens + %d output = %d, which EXCEEDS the %d hard limit by ~%d. "
            "This session will 400 on its next API call. Run /compact "
            "immediately; if that also overflows, /clear and start fresh."
            % (src_note, est_real, MAX_OUTPUT, est_with_output, HARD_LIMIT, -headroom)
        )
    else:
        if source == "real":
            msg = (
                "CONTEXT GUARD (%s): current context ~%d tokens (%d%% of the "
                "%d wall) + %d requested output = ~%d, which has crossed the "
                "safety line at %d. Run /compact now to keep a margin before "
                "the gateway's 1-token-over 400."
                % (src_note, est_real, pct, HARD_LIMIT, MAX_OUTPUT,
                   est_with_output, danger_line)
            )
        else:
            # Estimate path: the number itself is a floor, not a measurement —
            # say so, and keep the message actionable.
            msg = (
                "CONTEXT GUARD (estimate — gateway returned no usage, so this "
                "is a LOWER BOUND): the transcript already represents ~%d "
                "tokens (%d%% of the %d wall); the real request is typically "
                "several times LARGER than this on tool-heavy sessions, and "
                "auto-compact is also blind without usage. Run /compact now "
                "to stay safe; this reminder repeats until you do."
                % (est_real, pct, HARD_LIMIT)
            )

    if BLOCK:
        print(json.dumps({"decision": "block", "reason": msg}))
    else:
        print(
            json.dumps(
                {
                    "hookSpecificOutput": {
                        "hookEventName": "UserPromptSubmit",
                        "additionalContext": msg,
                    }
                }
            )
        )
    sys.exit(0)


if __name__ == "__main__":
    main()
