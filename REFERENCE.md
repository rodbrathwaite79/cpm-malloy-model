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
**Database:** Neon Postgres (cloud) — 210+ CPM rows + 23 AI interaction records.  
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

-- AI interaction tracker (23 records as of July 2026)
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
| launchd not firing | Wrong Node path in plist | Check plist `ProgramArguments` |

---

## Key Design Decisions

- **Vercel over Mac launchd (primary):** Mac must be on for launchd. Vercel runs in cloud regardless.
- **Neon over local JSON:** Cloud-hosted, queryable from anywhere, survives hardware failure.
- **Rule-based insights over LLM:** Eliminated per-run API cost. Insights are deterministic and free.
- **GitHub Actions over git hooks:** Git hooks live in `.git/` and don't sync. GitHub Actions run in the cloud and work from any machine.
- **Weekly over daily report:** CPM prices change monthly, not daily. Weekly reduces noise and API calls.
