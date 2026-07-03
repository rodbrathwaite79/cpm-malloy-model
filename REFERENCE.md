# CPM Agent — Reference Guide

Last updated: June 2026  
Repo: https://github.com/rodbrathwaite79/cpm-malloy-model

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    DAILY REPORT FLOW                    │
│                                                         │
│  Vercel Cron (8am EST daily)                           │
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
│  Guild Agent (optional, manual)                         │
│       │                                                 │
│       └── AI synthesis from CPM data + web findings    │
└─────────────────────────────────────────────────────────┘
```

**Primary scheduler:** Vercel serverless cron — runs whether or not either Mac is on.  
**Mac launchd:** Installed on both Macs as a backup (also runs at 8am local time).  
**Database:** Neon Postgres (cloud) — 210+ historical CPM rows, queryable from anywhere.  
**Email:** Resend REST API — free tier, 3,000 emails/month, no SMTP.

---

## Services & Dashboards

| Service | URL | What it does |
|---------|-----|--------------|
| Vercel (cpm-vercel) | https://vercel.com/brathwaite/cpm-vercel | Hosts serverless functions + cron |
| Vercel (malloyyo) | https://vercel.com/brathwaite/malloyyo | Malloy model server (MCP) |
| Neon | https://console.neon.tech → mute-thunder-42290582 | Postgres database |
| Resend | https://resend.com | Email sending |
| Brave Search | https://search.brave.com/app | Web data for CPM prices |
| GitHub | https://github.com/rodbrathwaite79/cpm-malloy-model | Source code |
| Live report URL | https://cpm-vercel-drphd5mkm-brathwaite.vercel.app/api/cpm-report | Trigger manually (needs auth header) |
| Metrics API | https://cpm-vercel-drphd5mkm-brathwaite.vercel.app/api/metrics | Read run history (public GET) |
| Log AI interaction | https://cpm-vercel-drphd5mkm-brathwaite.vercel.app/api/log-interaction | POST + LOG_API_KEY (universal tracker) |
| Malloyyo MCP | https://malloyyo-eehpbmwns-brathwaite.vercel.app | Malloy semantic model server |

---

## File Layout

### Git Repo (`~/Documents/cpm-agent/malloy-model-git/`)
```
malloy-model-git/
├── agent/                         ← Mac-side scripts (synced to GitHub)
│   ├── daily-report.mjs           ← Main report script (Resend email, DuckDB, GitHub)
│   ├── quality-agent.mjs          ← System health checker
│   ├── setup-new-mac.sh           ← One-command Mac setup
│   ├── agent.ts                   ← Guild AI agent (metrics + synthesis)
│   ├── package.json               ← Only dep: duckdb
│   └── MIGRATE.md                 ← One-time Neon migration instructions
├── cpm-vercel/                    ← Vercel serverless project
│   ├── api/
│   │   ├── cpm-report.js          ← Main cron handler
│   │   └── metrics.js             ← GET/POST run metrics
│   ├── lib/
│   │   ├── database.js            ← Neon Postgres client + schema
│   │   └── report-html.js         ← HTML email + dashboard builders
│   ├── scripts/
│   │   └── migrate-to-neon.mjs   ← One-time migration (already done)
│   ├── vercel.json                ← Cron schedule (0 13 * * * = 8am EST)
│   ├── package.json
│   └── .env.example               ← Template for required env vars
├── cpm_benchmarks.parquet         ← Historical CPM data (local backup)
├── cpm_monthly_updates.csv        ← New rows added by daily runs
├── index.malloy
└── REFERENCE.md                   ← This file
```

### Working Directory (`~/Documents/cpm-agent/agent/cpm-report-agent/`)
This is where scripts actually run on each Mac (separate from git repo).

```
agent/cpm-report-agent/
├── daily-report.mjs               ← Copy of repo version (update via git pull + cp)
├── quality-agent.mjs              ← Copy of repo version
├── setup-new-mac.sh               ← Copy of repo version
├── agent.ts                       ← Copy of repo version
├── package.json
├── node_modules/duckdb/           ← Native binary — must npm install per Mac arch
├── .env                           ← Real credentials (NOT in git)
└── com.rod.cpm-report.plist       ← launchd schedule config
```

> **Important:** After `git pull`, copy updated scripts to the working directory:
> ```bash
> cd ~/Documents/cpm-agent/malloy-model-git
> git pull
> cp agent/daily-report.mjs   ~/Documents/cpm-agent/agent/cpm-report-agent/
> cp agent/quality-agent.mjs  ~/Documents/cpm-agent/agent/cpm-report-agent/
> ```

---

## Environment Variables

### Mac `.env` (`~/Documents/cpm-agent/agent/cpm-report-agent/.env`)

| Variable | Where to get it | Required |
|----------|----------------|----------|
| `BRAVE_API_KEY` | search.brave.com/app → API | ✅ |
| `GITHUB_TOKEN` | github.com/settings/tokens → Classic → repo scope | ✅ |
| `RESEND_API_KEY` | resend.com → API Keys (starts with `re_`) | ✅ |
| `EMAIL_TO` | Your email address | ✅ |
| `MALLOYYO_URL` | Your Malloyyo Vercel URL | optional |
| `ANTHROPIC_API_KEY` | console.anthropic.com | optional (enables AI synthesis) |

### Vercel Environment Variables (set in Vercel dashboard)

| Variable | Notes |
|----------|-------|
| `DATABASE_URL` | Neon connection string — from console.neon.tech |
| `CRON_SECRET` | Any random string — used to authenticate cron trigger |
| `METRICS_API_KEY` | Any random string — used to authenticate POST /api/metrics |
| `BRAVE_API_KEY` | Same as Mac |
| `RESEND_API_KEY` | Same as Mac |
| `GITHUB_TOKEN` | Same as Mac |
| `EMAIL_TO` | Same as Mac |

> **Never commit `.env` to git.** Vercel env vars are set in the dashboard under  
> Settings → Environment Variables.

---

## Setup a New Mac

One command (takes ~5 minutes):

```bash
curl -sSL https://raw.githubusercontent.com/rodbrathwaite79/cpm-malloy-model/main/agent/setup-new-mac.sh | bash
```

This installs: Xcode tools, Homebrew, nvm, Node v22, clones the repo, installs duckdb, configures launchd, and runs QA validation.

After setup, set credentials:
```bash
nano ~/Documents/cpm-agent/agent/cpm-report-agent/.env
```

Then validate:
```bash
node ~/Documents/cpm-agent/agent/cpm-report-agent/quality-agent.mjs
```

> **Apple Silicon (M-series) note:** The setup script handles ARM64 automatically.  
> If you see a DuckDB architecture error, run:
> ```bash
> cd ~/Documents/cpm-agent/agent/cpm-report-agent && rm -rf node_modules && npm install
> ```

---

## Running the Report

### Vercel (primary — automatic)
Runs daily at 8am EST automatically via cron. No action needed.

### Trigger Vercel manually
```bash
curl -X POST https://cpm-vercel-drphd5mkm-brathwaite.vercel.app/api/cpm-report \
  -H "Authorization: Bearer YOUR_CRON_SECRET"
```
Returns: `{"ok":true,"outcome":"autonomous","dataPoints":N,"historicalRows":210}`

### Run locally on Mac (backup)
```bash
node ~/Documents/cpm-agent/agent/cpm-report-agent/daily-report.mjs
```

### Force update (bypass the once-per-month guard)
```bash
FORCE_UPDATE=true node ~/Documents/cpm-agent/agent/cpm-report-agent/daily-report.mjs
```

---

## Vercel Deployment

### Deploy from any Mac

```bash
# Install Vercel CLI (once per Mac)
npm i -g vercel
vercel login   # uses your Vercel account

# Deploy
cd ~/Documents/cpm-agent/malloy-model-git/cpm-vercel
npm install
vercel --prod
```

> **Env vars are in the Vercel dashboard** — you don't need a local `.env` to deploy.  
> After deploying, env vars carry over automatically.

### After changing Vercel source files
1. Edit files in `~/Documents/cpm-agent/malloy-model-git/cpm-vercel/`
2. `vercel --prod` from that directory
3. Commit changes back to git: `git add cpm-vercel/ && git commit -m "..." && git push`

---

## Database (Neon Postgres)

**Project:** mute-thunder-42290582  
**Dashboard:** https://console.neon.tech

### Tables
```sql
-- Historical CPM benchmarks (210 rows migrated June 2026)
cpm_benchmarks (id, year, month, month_name, channel, channel_label, cpm, source_note, report_date)
UNIQUE: (year, month, channel)

-- Agent run log
agent_runs (id, run_date, source, outcome, input_tokens, output_tokens, data_points_found, created_at)
```

### Query via API (no credentials needed)
```bash
curl https://cpm-vercel.vercel.app/api/metrics
# Returns: { stats: {...}, runHistory: [...] }
```

### Re-run migration (if needed)
```bash
cd ~/Documents/cpm-agent/malloy-model-git/cpm-vercel
DATABASE_URL="postgresql://..." node scripts/migrate-to-neon.mjs
```
Migration is idempotent — duplicate rows are skipped via `ON CONFLICT DO NOTHING`.

---

## QA / Health Check

```bash
# Full validation
node ~/Documents/cpm-agent/agent/cpm-report-agent/quality-agent.mjs

# Validate + auto-fix Node path in launchd plist
node ~/Documents/cpm-agent/agent/cpm-report-agent/quality-agent.mjs --fix
```

**What it checks:**
1. All required env vars present
2. Required files exist (scripts, parquet, plist, node_modules)
3. DuckDB can read parquet (210 rows)
4. Brave Search API responds
5. Resend API key format valid
6. GitHub token valid + repo accessible
7. launchd schedule loaded with correct Node path
8. Script integrity (key code patterns in daily-report.mjs)
9. Guild agent integrity (agent.ts)

Sends a QA report email to `EMAIL_TO` at the end of each run.

---

## Updating Scripts After Git Changes

When you edit scripts on one Mac and push, update the other Mac:

```bash
# Pull latest
cd ~/Documents/cpm-agent/malloy-model-git && git pull

# Copy to working directory
cp agent/daily-report.mjs  ~/Documents/cpm-agent/agent/cpm-report-agent/
cp agent/quality-agent.mjs ~/Documents/cpm-agent/agent/cpm-report-agent/

# Verify
node ~/Documents/cpm-agent/agent/cpm-report-agent/quality-agent.mjs
```

---

## GitHub Token Rotation

Tokens expire or need rotation periodically.

1. Go to github.com/settings/tokens → Classic tokens
2. Generate new token with `repo` scope
3. Update `.env` on each Mac: replace `GITHUB_TOKEN=` value
4. Update Vercel: Settings → Environment Variables → `GITHUB_TOKEN` → Edit → Redeploy
5. Revoke old token on GitHub

---

## Logs

| Location | Contents |
|----------|----------|
| `~/Documents/cpm-agent/logs/cpm-report.log` | stdout from launchd runs |
| `~/Documents/cpm-agent/logs/cpm-report-error.log` | stderr from launchd runs |
| Vercel dashboard → Functions → Logs | Vercel cron run logs |
| `https://cpm-vercel.vercel.app/api/metrics` | Run history from Neon |

View latest Mac log:
```bash
tail -50 ~/Documents/cpm-agent/logs/cpm-report.log
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| DuckDB architecture error | ARM64 Mac with x86 binary | `rm -rf node_modules && npm install` |
| GitHub 401 | Token expired or wrong | Rotate token (see above) |
| Resend email not arriving | Wrong API key | Check resend.com dashboard → API Keys |
| Vercel cron not firing | Cron only runs on Vercel Pro/Hobby paid plans | Check Vercel billing |
| `git pull` fails with 401 | Old token cached in git credential | `git remote set-url origin https://TOKEN@github.com/rodbrathwaite79/cpm-malloy-model.git` |
| launchd not triggering | Wrong Node path in plist | `node quality-agent.mjs --fix` |
| `dataPoints: 0` in Vercel response | No new CPM data found (normal mid-month) | Normal — historical data still in email |
| Neon connection error | DATABASE_URL missing or expired | Re-copy from Neon console |

---

## Key Decisions Log

- **Resend over SendGrid/Gmail:** Gmail App Passwords blocked by Passkey login. Resend uses REST API, no SMTP/OAuth needed.
- **Vercel over Mac launchd:** Mac must be on for launchd. Vercel runs regardless.
- **Neon over local JSON:** Cloud-hosted, queryable from Vercel and any Mac, survives hardware failure.
- **Option A for Guild→Neon writes:** Guild agents don't support `process.env` — Vercel handles all Neon writes instead.
- **One git repo:** `cpm-malloy-model` holds both the Mac agent scripts (`agent/`) and the Vercel project (`cpm-vercel/`).
