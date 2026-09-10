---
name: spec-conventions
description: Fast grep-only guard for the CLAUDE.md "hard rules" (ownership=404 not 403, Drizzle and() not &&, single getTodayISO, no hardcoded origins, 422 transition matrix). Run after editing any backend route/handler or frontend component, BEFORE finishing a change. Use when asked to "check conventions", "guard conventions", or "is this rule-safe".
user-invocable: false
---

# Spec Convention Guard

You just wrote or edited code in `backend/` or `frontend/`. Run the fast convention greps below and report violations with `file:line` **before** the user is told the change is done. This is a *pre-flight* check on the files you touched — it is NOT the full acceptance audit (that is `spec-audit`). If everything is clean, say so in one line.

Work from the repo root. Run each check; only flag real hits (a `403` inside a comment is a false positive — read the line before reporting).

## 1. Ownership = 404, never 403 (CLAUDE.md rule 3)
```bash
grep -rn "403" backend/src/routes/ backend/src/app.ts 2>/dev/null
```
Must be **zero** in route/error code. Missing AND not-owned both return `404 { error: 'Not found' }` — for GET/PATCH/DELETE habit, check-ins, and the WS `ack` (which silently ignores foreign ids).

## 2. Drizzle: `and(...)`, never JS `&&` between `eq` (rule 2)
```bash
grep -rn "&&" backend/src/ --include=*.ts | grep -E "eq\(" 
```
Must be **zero**. Plain-JS `eq(a,x) && eq(b,y)` short-circuits and silently drops the first condition (caused real milestone-dedup + ownership bugs). Always `and(eq(a,x), eq(b,y))`.

## 3. Exactly ONE `getTodayISO()` definition (rule 1)
```bash
grep -rn "function getTodayISO\|const getTodayISO\|getTodayISO =" frontend/src/
grep -rn "toISOString().slice(0, 10)" frontend/src/
```
There must be **exactly one** definition site (the shared helper, `new Date().toISOString().slice(0, 10)`), and every other `toISOString().slice(0,10)` must be that same helper — never a second independent "today" for calendar highlight / check-in toggle / undo.

## 4. No hardcoded origins (rule 5)
```bash
grep -rn "localhost:3000" frontend/src/
grep -rn "http://localhost" backend/src/
```
Frontend: **zero** hits (only relative `/api/...`; WS URL from `window.location` host). Backend OAuth URIs must be built from `BACKEND_URL`, not a hardcoded `http://localhost:3000`.

## 5. Status-transition matrix (rule 4) — spot-check if you touched status logic
- `active` ↔ `paused` OK; `active`|`paused` → `archived` OK.
- `archived` → **anything (incl. no-op) = 422**.
- Enforced server-side in PATCH **and** mirrored client-side in `HabitModal`. If you edited either, confirm the `archived`-source guard returns 422.

## 6. WS `ack` (rule 6) — spot-check if you touched the WS handler
- Verify `habit.userId === <connected session userId>` **before** `INSERT OR IGNORE` into `milestone_notifications`.
- Persist ONLY on `ack`, never at send time.

---

**Report format:**
- Clean: one line — `✅ conventions clean (checked: 404-only, and(), single getTodayISO, no hardcoded origins)` + which extra spot-checks (5/6) applied.
- Violations: one line each — `❌ [rule] file:line — what's wrong — the fix`. End with `N convention violation(s)`.

Do NOT fix automatically; report and let the user (or `spec-audit`/`spec-impl`) act.
