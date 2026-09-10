# Claude Code Capability Verification — Open Qwen (`qwen3.8-27b`)

**Дата:** 2026-09-08
**Система:** Claude Code **v2.1.263** через `pilot-gateway.ai.eleks-demo.com`, header `X-AI-Client: ai-evaluation`. Усі три слоти моделей (`ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`) → `qwen3.8-27b`.

**Підсумок:** ✅ **17/17 повних pass** (після виправлення Finding A: `input_tokens` + `e.replace`), ❌ **0 зливів**. *(Початково було 15/17 + 2 partial — див. ретести нижче.)*

---

## 📊 Pass-rate за категоріями


| Категорія                                            | ✅ Full | ⚠️ Partial | ❌ Fail | Разом  | Pass-rate* |
| ---------------------------------------------------- | ------ | ---------- | ------ | ------ | ---------- |
| Файлова система (Read/Write/Edit/Notebook)           | 4      | 0          | 0      | 4      | **100%**   |
| Shell / Bash (foreground + background)               | 2      | 0          | 0      | 2      | **100%**   |
| Пошук (Grep/Glob)                                    | 1      | 0          | 0      | 1      | **100%**   |
| Web (WebFetch + WebSearch)                           | 2      | 0          | 0      | 2      | **100%**   |
| Планування / інструкції (plan mode, AskUserQuestion) | 2      | 0          | 0      | 2      | **100%**   |
| Сcheduling (Task, Cron, ScheduleWakeup)              | 3      | 0          | 0      | 3      | **100%**   |
| Пам'ять (persistent filesystem)                      | 1      | 0          | 0      | 1      | **100%**   |
| **Агенти (Agent, Workflow)**                         | 2      | 0          | 0      | 2      | **100%** ✅ |
| **Разом**                                            | **17** | **0**      | **0**  | **17** | **100%** ✅ |


 Pass-rate рахується як `(Full + 0.5·Partial) / Разом`. Якщо лічати лише повний pass: **88.2%**; якщо частковий зараховувати як 0: **88.2%** (тут збігається, бо partial=2 дає +1).

### Візуальний розподіл

```
Файлова система   ████████████████████ 100%  (4/4)
Shell/Bash        ████████████████████ 100%  (2/2)
Пошук             ████████████████████ 100%  (1/1)
Web               ████████████████████ 100%  (2/2)
План/інструкції   ████████████████████ 100%  (2/2)
Scheduling        ████████████████████ 100%  (3/3)
Пам'ять           ████████████████████ 100%  (1/1)
Агенти            ████████████████████ 100%  (2/2) ← виправлено
─────────────────────────────────────────────
УСЬОГО            ████████████████████ 100%  (17/17)
```



### Розподіл за статусом (піра-діаграма)

```
        ✅ Full pass    ████████████████████████████████████████  17  (100%)
        ⚠️ Partial      (порожньо)                                     0   (0.0%)
        ❌ Fail         (порожньо)                                     0   (0.0%)
```

---



## Матриця можливостей


| #   | Можливість                                                                                  | Результат | Підтвердження                                                                      |
| --- | ------------------------------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------- |
| 1   | **Bash** (exec, stdout/stderr, exit codes, pipes, `$()` subst, умови, цикли, case, heredoc) | ✅ PASS    | Повний батч: `python3 3.9.6`, `git 2.39.5` (node відсутній)                        |
| 2   | **Bash background** (`run_in_background`)                                                   | ✅ PASS    | Таск `b94mu3gi0`, exit code 0, вихідний файл читається                             |
| 3   | **Read**                                                                                    | ✅ PASS    | Прочитано `probe.py` (5 рядків)                                                    |
| 4   | **Write**                                                                                   | ✅ PASS    | Створено `probe.py`, `probe.ipynb`, файли пам'яті                                  |
| 5   | **Edit** (exact-match)                                                                      | ✅ PASS    | Вставлено `EDITED_MARKER`                                                          |
| 6   | **NotebookEdit** (insert cell)                                                              | ✅ PASS    | Вставлено код-клетку `478e9c25`                                                    |
| 7   | **Grep / Glob** (пошук)                                                                     | ✅ PASS    | `grep -rn` знайшов `def add`; `find` перелічив файли; `grep -c` порахував          |
| 8   | **WebFetch**                                                                                | ✅ PASS    | `example.com` → "Example Domain"                                                   |
| 9   | **WebSearch**                                                                               | ✅ PASS*   | Виконується + повертає структуру; один запит повернув порожній результат           |
| 10  | **Agent** (запуск субагента)                                                                | ✅ PASS    | Після фіксу `input_tokens` + `e.replace`: `status: completed`, правильна відповідь |
| 11  | **Workflow** (оркестрація)                                                                  | ✅ PASS    | Після фіксу `input_tokens`: `agents_done:2, error:0`, токени повернулись           |
| 12  | **AskUserQuestion**                                                                         | ✅ PASS    | Питання відправлено, отримано відповідь                                            |
| 13  | **EnterPlanMode / ExitPlanMode**                                                            | ✅ PASS    | Чистий вхід і вихід з план-режиму                                                  |
| 14  | **Task-інструменти** (Create/Get/List/Update)                                               | ✅ PASS    | 10 тасків створено, прочитано, оновлено, перелічено                                |
| 15  | **Cron** (Create/List/Delete)                                                               | ✅ PASS    | One-shot таск `12b50975` створено, перелічено, скасовано                           |
| 16  | **ScheduleWakeup**                                                                          | ✅ PASS    | Заплановано 60-сек. прокидання, спрацювало (два рази)                              |
| 17  | **Persistent Memory** (файлова система)                                                     | ✅ PASS    | Записано `eval-probe.md` + індекс `MEMORY.md`                                      |


---



## 🚨 Finding A — Субагенти та Workflow крашаться: відсутній `usage.input_tokens`

**Обидва** — і standalone `Agent`, і leaf-агенти `Workflow` — крашаться з помилкою:

```
undefined is not an object (evaluating 'd.input_tokens')
```

Транскрипт субагента (`a8794d8b0f4e72cfe.output`) містить лише **4 рядки** і закінчується на `Bash` tool_use асистента — у відповіді гейтвея **немає полів** `usage`**,** `input_tokens`**,** `stop_reason`. Agent-runner Claude Code читає `usage.input_tokens` після кожного ходу моделі для відстеження вартості/контексту, натрапляє на `undefined` і падає — *після того, як агент уже виконав роботу*. `journal.jsonl` workflow підтверджує: обидва паралельні агенти досягли `{"type":"failed"}` (2× started, 2× failed).

**Статус (останнє підтвердження 20:36):** не змінено — транскрипт досі 4 рядки, usage-полів досі немає, журнал workflow `2 started / 2 failed`.

### ✅ Ретест після фікса (2026-09-08, ~20:45)

Після виправлення бекендом **Workflow повністю відновився**:

- Результат: `{"alpha":"ALPHA","beta":"BETA","orchestrated":true}` — обидва leaf-агенти **повернули токени** (раніше `null`).
- Usage: `agents_done: 2, agents_error: 0` (раніше `2 failed`).
- Журнал `wf_c7c57684-c8e`: `2 started / 2 result` (раніше `2 started / 2 failed`).

**Standalone Agent: частково.** У транскрипті `a66687b77ff9767da` тепер є блок `usage` з `input_tokens` (2 блоки, `stop_reason: tool_use` → `end_turn`), транскрипт вирос до **11 рядків** (було 4), і агент дав **правильну відповідь** ("2 entries: REPORT.md and docs"). Тобто **оригінальний краш** `input_tokens` **усунено**.

**🚨 Але з'явився новий краш** — `undefined is not an object (evaluating 'e.replace')`. Він:

- **не** є в транскрипті (0 збігів) → це падіння **post-processing у Claude Code** після завершення ходу агента, а не проблема відповіді бекенда.
- Через нього таск агента все одно позначається `status: failed`, попри те що відповідь агента сформовано й збережено.

**Висновок ретесту:** Фікс `usage.input_tokens` спрацював — Workflow 100% OK. Для standalone `Agent` лишається **новий latent-баг у post-processing** (`e.replace` на undefined рядку), який треба відокремити від вже виправленого Finding A. Ймовірно, гарнес десь викликає `.replace()` на полі відповіді (напр., `content`/`text`/`model`/`id`), якого бекенд не повертає.

### ✅ Ретест #2 після фікса `e.replace` (2026-09-08, ~20:5x)

Standalone `Agent` (`a6e53633427878dd2`) тепер **повністю проходимо**:

- `status: completed` (було `failed`).
- **0** збігів сигнатури крашу `undefined is not an object` (раніше був `e.replace`).
- Єдиний збіг рядка `e.replace` у транскрипті — це **текст самого тест-промпту** («re-test of the e.replace post-processing fix»), **не** помилка.
- `is_error: false` на tool_result; фінальний `stop_reason: end_turn`; 2 блоки `usage` з `input_tokens`.
- Агент повернув правильну відповідь: *«The command printed exactly 2 lines: REPORT.md and docs»*.

**Висновок:** Обидва latent-баги пост-обробки виправлено. **Agent та Workflow тепер 100% функціональні.** Загальний pass-rate оновлюється до **17/17 (100%)**.

**Вплив:** Уся функціональність, що спавнить дочірнього агента (`Agent`, `Workflow`, ймовірно background/teammate-агенти), **нефункціональна** на цьому бекенді — агент виконує, але результат втрачається, а батьку повідомляють про "failure". Це **несумісність формату відповіді бекенда**, а не проблема інтелекту моделі. Відкритий Qwen-гейтвей має видавати блок Anthropic `usage: {input_tokens, output_tokens, ...}` та `stop_reason` у **кожній** completion.

---



## ⚠️ Finding B — Класифікатор безпеки на тій самій хиткій моделі

Класифікатор безпеки (який gate-ить Bash, Write, Edit, Agent, WebSearch, Cron, Monitor, ScheduleWakeup і фонові запуски в auto-режимі) **також маршрутизується через** `qwen3.8-27b`. Під час виїзної перевірки ~5–6 хв модель була періодично недоступна, і **всі** gated-інструменти блокувались з повідомленням:

> `qwen3.8-27b is temporarily unavailable, so auto mode cannot determine the safety of [tool] right now.`

Спостерігався **~50–70% rate блокувань** gated-викликів у вікні, потім повне відновлення. Тільки **read-only** інструменти (Read, WebFetch, Task, AskUserQuestion, вхід/вихід у план-режим) залишались доступними.

**Вплив:** Тимчасова відмова `qwen3.8-27b` робить **всі write/execute дії інтерактивної агенти неможливими** — єдина точка відмови. Класифікатор краще вести на окремий, надійніший/реплікований модел.

---



## Висновок

Ядро інтерактивної агенти **працює добре** на відкритій Qwen: file I/O, shell, пошук, web, планування, scheduling, task management, пам'ять, взаємодія з користувачем — усе функціонує. Два бекенд-дефекти треба закрити перед чистим pass:

1. **(Блокер для агент-фіч)** Гейтвей має повертати `usage.input_tokens`/`output_tokens`/`stop_reason` у кожній completion — інакше субагенти та workflow крашаться.
2. **(Надійність)** Класифікатор безпеки ділить модель з агентом; його відмови заморожують усі write/execute інструменти. Потрібен окремий, надійний модел для класифікатора.

---

*Звіст сформовано під час AI-evaluation (header* `X-AI-Client: ai-evaluation`*).*