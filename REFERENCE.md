# CPM Agent — Reference Guide

Last updated: July 2026  
Repo: https://github.com/rodbrathwaite79/cpm-malloy-model

> **What is this file?** A quick-lookup reference for anyone maintaining or extending the CPM Agent system. Each section has a plain-English summary followed by the technical details.

---

## What the System Does (Plain English)

Two things run automatically:

1. **Every Monday at 8am ET** — a cloud program searches the web for CPM advertising prices, saves them to a database, and emails you a report. No computer needs to be on.

2. **After every Cowork session** — Claude writes a log of what was built, estimates how long a human would have taken, and when you do a `git push`, a cloud job automatically files the log in the database.

That's it. Everything else is configuration and plumbing that makes those two things work reliably.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                   WEEKLY REPORT FLOW                    │
│                                                         │
│  Vercel Cron (8am ET every Monday = 0 13 * * 1 UTC)    │
│       │                                                 │
│       ▼                                                 │
│  /api/cpm-report.js                                     │
│       │                                                 │
│       ├── Brave Search API → fetch CPM web data        │
│       ├── Neon Postgres     → read/write CPM rows      │
│       ├── GitHub CSV        → backup cpm_monthly_updates│
│       ├── Resend            → email report to Rod       │
│       └── Neon agent_runs   → log run outcome          │
│                                                         │
│  Mac launchd (backup, also fires Monday 8am local)      │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│                AI SESSION LOGGING FLOW                   │
│                                                         │
│  Cowork session ends                                    │
│       │                                                 │
│       ▼                                                 │
│  Claude writes session-logs/pending/session-*.json      │
│       │                                                 │
│       ▼                                                 │
│  git push  (one manual step from any machine)           │
│       │                                                 │
│       ▼                                                 │
│  GitHub Action (.github/workflows/log-sessions.yml)     │
│       │                                                 │
│       ├── POST to /api/log-interaction (Vercel)         │
│       ├── Neon ai_interactions → saves record           │
│       └── Moves file: pending/ → posted/               │
└─────────────────────────────────────────────────────────┘
```

**Primary scheduler:** Vercel serverless cron — runs every Monday regardless of whether any Mac is on.  
**Mac launchd:** Backup runner on MacBook. Also fires Monday 8am local time.  
**Database:** Neon Postgres (cloud) — 210+ CPM rows + 11 AI interaction records (after removing mislabeled entries).  
**Email:** Resend REST API — free tier, no SMTP needed.  
**Session logging:** GitHub Actions — runs in cloud on push, works from any machine.

---

## Services & Dashboards

| Service | URL | What it does |
|---------|-----|--------------|
| Vercel (cpm-vercel) | https://vercel.com/brathwaite/cpm-vercel | Hosts serverless functions + cron |
| Neon | https://console.neon.tech → mute-thunder-42290582 | Postgres database |
| Resend | https://resend.com | Email sending |
| Brave Search | https://search.brave.com/app | Web data for CPM prices |
| GitHub | https://github.com/rodbrathwaite79/cpm-malloy-model | Source code + session logging pipeline |
| Guild | https://app.guild.ai | Agent hosting, sessions, usage, triggers |
| Guild Usage | https://app.guild.ai/users/rod.brathwaite/insights/usage | LLM token consumption dashboard |
| Guild Agent | https://app.guild.ai/agents/cpm-report-agent | Agent versions, runs, settings |
| ROI Stats API | https://cpm-vercel.vercel.app/api/tracker-stats | Public GET — live ROI numbers |
| Log AI Interaction | https://cpm-vercel.vercel.app/api/log-interaction | POST + LOG_API_KEY |
| CPM Metrics API | https://cpm-vercel.vercel.app/api/metrics | Public GET — CPM run history |

---

## File Layout

```
malloy-model-git/
├── .github/
│   └── workflows/
│       └── log-sessions.yml        ← GitHub Action: auto-logs sessions on push
├── agent/
│   ├── daily-report.mjs            ← Mac backup runner (Monday 8am launchd)
│   └── log-ai.mjs                  ← CLI tool to manually log a session
├── cpm-vercel/                     ← Vercel serverless project
│   ├── api/
│   │   ├── cpm-report.js           ← Weekly cron handler (PRIMARY)
│   │   ├── log-interaction.js      ← POST endpoint: logs AI sessions to Neon
│   │   ├── tracker-stats.js        ← GET endpoint: ROI summary from Neon
│   │   └── metrics.js              ← GET/POST: CPM run history
│   ├── lib/
│   │   ├── database.js             ← Neon client, schema, insert functions
│   │   ├── insights.js             ← Rule-based CPM insight engine (free, no API)
│   │   └── report-html.js          ← HTML email + dashboard builders
│   └── vercel.json                 ← Cron: "0 13 * * 1" = Monday 8am ET
├── session-logs/
│   ├── pending/                    ← Claude writes logs here; Action picks them up
│   └── posted/                     ← Moved here after successful database write
├── skills/
│   ├── CPM-Skills-Reference.html   ← Interactive 18-skill reference guide
│   └── [18 skill directories]/     ← SKILL.md files for each skill
├── CLAUDE.md                       ← Session logging instructions for Claude
├── REFERENCE.md                    ← This file
├── index.malloy                    ← Malloy model: CPM benchmarks
└── ai_tracker.malloy               ← Malloy model: AI interaction tracker

The `agent/cpm-report-agent/` directory is intentionally gitignored — it has its own `.git` managed by Guild. Key files inside it:
- `agent.ts` — the published agent (mirrors `agent/agent.ts`)
- `guild.json` — agent ID + name (agent_id: `019f04fb-e2e0-726e-0000-4fded67253ca`)
- `package.json` — dependencies: `@guildai/agents-sdk`, `duckdb` only
```

---

## Environment Variables

### Vercel (set in Vercel dashboard → Settings → Environment Variables)

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Neon Postgres connection string |
| `CRON_SECRET` | Authenticates Vercel cron + manual triggers |
| `BRAVE_API_KEY` | Brave Search web queries |
| `RESEND_API_KEY` | Email sending |
| `GITHUB_TOKEN` | GitHub CSV backup writes |
| `EMAIL_TO` | Primary report recipient |
| `LOG_API_KEY` | Authenticates POST /api/log-interaction |

### GitHub Actions (set in repo Settings → Secrets → Actions)

| Secret | Purpose |
|--------|---------|
| `LOG_API_KEY` | Same value as Vercel LOG_API_KEY — used by log-sessions.yml |

### Mac `.env` (`~/Documents/cpm-agent/agent/cpm-report-agent/.env`)

| Variable | Required |
|----------|---------|
| `BRAVE_API_KEY` | ✅ |
| `GITHUB_TOKEN` | ✅ |
| `RESEND_API_KEY` | ✅ |
| `EMAIL_TO` | ✅ |
| `DATABASE_URL` | ✅ |
| `LOG_API_URL` | Optional — enables self-logging in agent.ts |
| `LOG_API_KEY` | Optional — pairs with LOG_API_URL |

> **Security rules (never violate):**
> - Never commit `.env` files
> - Never hard-code credentials — use `process.env.VAR_NAME`
> - `malloy-config-local.json` must stay gitignored

---

## Running the Report

### Automatic (nothing to do)
Vercel cron fires every Monday at 8am ET (`0 13 * * 1`). Mac launchd also fires as backup.

### Trigger Vercel manually
```bash
curl -X POST https://cpm-vercel.vercel.app/api/cpm-report \
  -H "Authorization: Bearer YOUR_CRON_SECRET"
```

### Run locally on Mac
```bash
node ~/Documents/cpm-agent/agent/cpm-report-agent/daily-report.mjs
```

### Force update (bypass once-per-month guard)
```bash
FORCE_UPDATE=true node ~/Documents/cpm-agent/agent/cpm-report-agent/daily-report.mjs
```

---

## Session Logging

> **Plain English:** Claude writes its own time sheet. You `git push`. A cloud job files it automatically.

### How it works
1. Session start → Claude creates `session-logs/pending/session-YYYY-MM-DD-HHmm.json`
2. After each task → Claude updates the JSON with description, hours, value
3. Session end → Say "log this." Claude commits the file
4. `git push` from any machine → GitHub Action fires
5. Action POSTs to `/api/log-interaction` → 200 OK → file moves to `posted/`

### Session JSON schema
```json
{
  "session_id": "2026-07-10-1400",
  "session_start": "2026-07-10T14:00:00Z",
  "session_end": "2026-07-10T16:30:00Z",
  "provider": "claude",
  "tool": "cowork",
  "project": "cpm-agent",
  "tasks": [
    {
      "type": "code",
      "description": "What was built",
      "start": "...", "end": "...",
      "human_equivalent_hours": 5.0,
      "value_usd": 750,
      "first_pass": true,
      "output": "path/to/output"
    }
  ],
  "summary": {
    "primary_task_type": "code",
    "total_human_equivalent_hours": 7.5,
    "total_value_usd": 1175,
    "first_pass": true,
    "corrections": 0
  }
}
```

### Rate table
| Task type | Rate/hr |
|-----------|---------|
| code | $150 |
| analysis | $175 |
| research | $125 |
| document | $125 |

---

## Guild Agent (`cpm-report-agent`)

> **Plain English:** Guild is where the CPM report agent lives and runs. Think of it as a cloud runtime that hosts your TypeScript agent, tracks every run, and manages LLM token consumption. You publish new versions from the CLI; Guild handles execution, state, and observability.

Current published version: **1.0.12**  
Agent ID: `019f04fb-e2e0-726e-0000-4fded67253ca`

---

### How the Agent Runtime Works

The agent uses Guild's **AutomaticallyManagedStateAgent** pattern — you write a plain `async run()` function and Guild's Babel compiler transforms it into a resumable state machine behind the scenes. This lets the agent pause mid-execution (e.g., waiting for user input or a long tool call) and resume without losing state.

**Execution flow:**
```
guild agent save --publish
      │
      ▼
Babel compiler transforms agent.ts → state machine
      │
      ▼
Runtime executes run() step-by-step, serializing state at each await
      │
      ▼
Session record created in Guild (visible in UI + CLI)
      │
      ▼
agent.ts POSTs self-log to /api/log-interaction (non-fatal)
```

---

### Babel Compiler Constraints (Critical for Maintenance)

The `"use agent"` directive tells the Babel compiler to transform that function. These constraints apply **only inside the `run()` body** — regular TypeScript is fine everywhere else.

**The directive must be inside `run()`, not at module level:**
```typescript
async function run(input, task) {
  "use agent"   // ✅ correct — compiler scopes to this function only
  ...
}
// "use agent"  // ❌ wrong — causes entire module to be compiled
```

**Constructs that fail at build time (will break `guild agent save --publish`):**

| Pattern | Error | Fix |
|---------|-------|-----|
| `{ ...importedVar }` | `NotImplemented: SpreadElement` on non-local label | `Object.assign({}, importedVar, {...})` |
| `[...arr, item]` | Same SpreadElement error | `arr.concat([item])` |
| `async function* gen()` | NotImplemented: async generator | Restructure to return batch |
| `outer: for(...) { break outer }` | NotImplemented: labeled break | Use boolean flag instead |
| `for (const { x } in obj)` | NotImplemented | Destructure inside body |

**Constructs that compile but fail at runtime (silent failures):**

| Pattern | Problem | Fix |
|---------|---------|-----|
| `Promise.all([a(), b()])` | Promises can't survive state serialization | `await a()` then `await b()` sequentially |
| `const f = importedFn; await ...; f()` | External functions don't survive serialization | Wrap: `const f = (x) => importedFn(x)` |
| `obj.asyncMethod()` | Member-expression call of compiled async throws | `const fn = obj.method; await fn()` |
| `for await (const x of iter)` | `await` silently dropped | Pre-fetch to array, then `for-of` |
| `import { helper } from './file'` if `helper` crosses an `await` | Frame lost on resume | Keep all awaited logic in `agent.ts` |

**What always works:**
- Sequential `await` calls
- `Object.assign()` instead of object spread
- `.concat()` instead of array spread  
- Inline arrow functions defined in the same file
- Plain objects, arrays, primitives, Map, Set, Date across `await`

---

### Version Lifecycle

```
guild agent save --message "..."        → SAVED (code uploaded)
      + validation (automatic)          → VALIDATED (build passed) or FAILED
guild agent save ... --publish          → PUBLISHED (available to run)
```

```bash
# Check version history
guild agent versions

# Save, wait for validation, and publish in one step
guild agent save --message "Fix: ..." --wait --publish

# Publish the latest validated draft without re-saving
guild agent publish
```

Failed drafts remain in history with `DRAFT` status — useful for diagnosing build errors.

---

### Self-Logging

Both Guild agents automatically POST to `/api/log-interaction` on success, so their runs appear in the ROI dashboard alongside Cowork sessions.

| Agent | When logged | Task type | Hours estimate |
|-------|------------|-----------|----------------|
| `agent.ts` | Every production run (MODE A/D/E) | analysis | 0.25h |
| `universal-tracker.ts` | MODE A INIT only | code | 0.1h |

MODE B (LOG) is excluded — it IS the log mechanism; self-logging it would be circular.

Self-logging is implemented as `logInteractionToNeon()` using raw `fetch()` — no external SDK dependency. Non-fatal: if env vars are missing, the agent continues normally.

**Required env vars (set in Guild dashboard → agent settings → Environment):**

| Variable | Value |
|----------|-------|
| `LOG_API_URL` | `https://cpm-vercel.vercel.app/api/log-interaction` |
| `LOG_API_KEY` | Same value as Vercel `LOG_API_KEY` |

---

### Guild Governance & Observability

Guild's platform gives you three layers of visibility into how agents are running.

#### 1. Usage Insights (LLM token consumption)

**Web UI:** https://app.guild.ai/users/rod.brathwaite/insights/usage

This is your primary cost-governance view. It shows:
- Token consumption over time (input + output tokens per session)
- LLM tier: **Managed** (draws from Guild token balance) or **BYOK** (uses your Anthropic key directly)
- Daily token limits — set under Settings → LLM Settings to cap runaway costs

**To switch to BYOK** (use your own Anthropic key, bypasses Guild token billing):  
Settings → LLM Settings → Add API key → Select Anthropic → paste key → Save  
First key added automatically becomes default and flips account to BYOK mode.

**To set a daily cap:**  
Settings → LLM Settings → Daily token limit field (resets at midnight UTC)

#### 2. Session Inspection (run-by-run audit trail)

Every agent run creates a session. Sessions are the audit log — they record what ran, what tools were called, what the agent returned, and whether it succeeded or failed.

```bash
# List recent sessions
guild session list

# Filter by type
guild session list --type time      # scheduled runs only
guild session list --type chat      # interactive runs only
guild session list --type agent_test  # test runs (not in history)

# Inspect a specific session
guild session get <session-id>

# Full event stream — every tool call, LLM response, state transition
guild session events <session-id>

# List tasks (tool calls) within a session
guild session tasks <session-id>
```

Sessions have three states: `Active` (running or waiting for input), `Completed`, `Failed`. Failed sessions are the first place to look when a run produces no output or self-log.

#### 3. Trigger Management (scheduled + webhook runs)

The CPM report agent runs via a Guild **time trigger** (weekly Monday 8am). Triggers are the scheduled-automation layer.

```bash
# List all triggers
guild trigger list

# See sessions spawned by the Monday trigger
guild trigger sessions <trigger-id>

# Pause a trigger without deleting it
guild trigger deactivate <trigger-id>

# Resume
guild trigger activate <trigger-id>
```

In the web UI: Workspace → Triggers → select trigger → see run history and status.

#### 4. Version Audit

Version history is the code-governance record — what was deployed, when, and whether it passed validation.

```bash
guild agent versions
```

Columns: ID, VERSION number (only published builds get one), STATUS (PUBLISHED/DRAFT), VALIDATION (PASSED/FAILED), summary message, created timestamp.

**Reading the table:** A `DRAFT` + `FAILED` row means a build was attempted but the Babel compiler rejected it (or runtime validation failed). The message column shows the commit message, which is how you trace which code change caused a failure.

#### 5. Quick Governance Checklist

| Question | Where to look |
|----------|--------------|
| How many tokens did last week's run consume? | Usage Insights → filter by 7 days |
| Did Monday's scheduled run succeed? | `guild trigger sessions <id>` or Triggers in UI |
| What did the agent actually do step by step? | `guild session events <session-id>` |
| Which code version is currently live? | `guild agent versions` → topmost PUBLISHED row |
| Why did a build fail? | `guild agent versions` → FAILED row message + check agent.ts for spread syntax |
| Is self-logging working? | Check `/api/tracker-stats` — last session's record should appear |

---

## Vercel Deployment

> **Always deploy from the repo root, not from inside `cpm-vercel/`.**

```bash
cd ~/Documents/cpm-agent/malloy-model-git
vercel --prod
```

Env vars carry over from the Vercel dashboard automatically. No local `.env` needed.

---

## Database (Neon Postgres)

**Project:** mute-thunder-42290582  
**Dashboard:** https://console.neon.tech

### Tables
```sql
-- CPM benchmarks (210+ rows)
cpm_benchmarks (id, year, month, month_name, channel, channel_label, cpm, source_note, report_date)
UNIQUE: (year, month, channel)

-- CPM report run log
agent_runs (id, run_date, source, outcome, input_tokens, output_tokens, data_points_found, created_at)

-- AI interaction tracker (11 records as of July 2026; 12 mislabeled git-hook entries removed)
ai_interactions (
  id, project, provider, tool, task_type, description,
  hours_estimate, hours_source, value_usd, first_pass, corrections,
  output, notes, cost_model, cost_usd, session_id, created_at
)
```

### Query via public API
```bash
curl https://cpm-vercel.vercel.app/api/tracker-stats   # ROI summary
curl https://cpm-vercel.vercel.app/api/metrics          # CPM run history
```

---

## GitHub Token Scope Requirements

The GitHub Personal Access Token needs **both**:
- `repo` — for pushing files and CSV backup
- `workflow` — for pushing to `.github/workflows/`

> **⚠️ Token rotation needed:** Token `g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` was exposed in a conversation. Generate a new one at github.com/settings/tokens and update it in Vercel env vars and local `.env`.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| GitHub Action gets 401 | LOG_API_KEY not set as GitHub Secret | Add at repo → Settings → Secrets → Actions |
| GitHub Action gets 400 | Payload field name mismatch | Fields must be snake_case: `task_type`, `hours_estimate`, `value_usd` |
| `git push` rejected (workflow scope) | Token missing `workflow` scope | Edit token at github.com/settings/tokens |
| Vercel cron not firing | Wrong schedule or plan | Verify vercel.json cron = `0 13 * * 1`; check Vercel billing tier |
| Report email not arriving | Wrong RESEND_API_KEY | Check resend.com → API Keys |
| `vercel --prod` path error | Running from inside `cpm-vercel/` | Run from `malloy-model-git/` root |
| `dataPoints: 0` | No new CPM data (normal mid-month) | Normal — history still in email |
| Neon connection error | DATABASE_URL missing/expired | Re-copy from Neon console |
| Mislabeled `provider=cursor` entries with `session_id=git-*` | Old `setup-auto-logging.sh` git hook hardcoded `provider:"cursor"` on every git commit | Run `node agent/cleanup-cursor-entries.mjs` (requires DATABASE_URL in env) |
| launchd not firing | Wrong Node path in plist | Check plist `ProgramArguments` |
| `guild agent save --publish` → `NotImplemented: SpreadElement` | Babel compiler hit `{ ...importedVar }` or `[...arr]` inside `"use agent"` function | Replace all spreads with `Object.assign()` and `.concat()` — check `agent.ts` for any `...` |
| Build error moves line number after adding comments | Babel compiles the generated JS, not TypeScript source — line numbers track JS output | Use column position (col 16 = start of spread) to locate the failing expression |
| Guild session shows `Failed` | Agent threw unhandled exception or Babel compile error at runtime | `guild session events <session-id>` for full trace |
| Self-log not appearing in ROI dashboard after Guild run | `LOG_API_KEY` or `LOG_API_URL` not set in Guild agent environment | Guild dashboard → agent → Settings → Environment — add both vars |
| `guild agent versions` shows only DRAFT, no published version | `--publish` flag was not passed, or validation failed | Re-run `guild agent save --message "..." --publish`; check FAILED rows for error |
| Usage insights page blank | Client-rendered — use Chrome, not a web fetcher | Open https://app.guild.ai/users/rod.brathwaite/insights/usage directly in browser |

---

## Key Design Decisions

- **Vercel over Mac launchd (primary):** Mac must be on for launchd. Vercel runs in cloud regardless.
- **Neon over local JSON:** Cloud-hosted, queryable from anywhere, survives hardware failure.
- **Rule-based insights over LLM:** Eliminated per-run API cost. Insights are deterministic and free.
- **GitHub Actions over git hooks:** Git hooks live in `.git/` and don't sync. GitHub Actions run in the cloud and work from any machine.
- **Weekly over daily report:** CPM prices change monthly, not daily. Weekly reduces noise and API calls.
