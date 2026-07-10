---
name: malloyyo-neon-backend
description: >
  Configure and deploy Malloyyo — the Vercel-hosted Malloy MCP server — with a Neon Postgres
  backend for both the AI interactions source and the CPM benchmarks source. Use this skill
  when setting up Malloyyo on a new Vercel project, changing the database backend, or
  troubleshooting Malloy query failures.
---

# Malloyyo — Neon-Backed Malloy MCP Server

## What Malloyyo is
A separate Vercel project that serves the Malloy semantic model (`index.malloy`) as an
MCP server. Guild.ai agents and Claude can query it via tool calls to run named Malloy
views and get structured results back.

## Deployments
- Malloyyo: https://malloyyo-eehpbmwns-brathwaite.vercel.app
- Source: https://github.com/rodbrathwaite79/cpm-malloy-model (same repo, different Vercel project)

## Data sources (both on Neon)
```malloy
-- AI Interactions — read from Neon
source: interactions is neon.table('public.ai_interactions') extend { ... }

-- CPM Benchmarks — read from Neon (switched from GitHub Parquet in July 2026)
source: cpm_benchmarks is neon.table('public.cpm_benchmarks') extend { ... }
```

Both sources use the `neon` connection defined in `malloy-config.json`.

## malloy-config.json
```json
{
  "includeDefaultConnections": true,
  "connections": {
    "neon": {
      "is": "postgres",
      "connectionString": { "env": "DATABASE_URL" }
    },
    "duckdb": { "is": "duckdb" }
  }
}
```
`DATABASE_URL` must be set in Malloyyo's Vercel environment (same Neon project as cpm-vercel).

## Required Vercel env vars for Malloyyo
| Var | Value |
|-----|-------|
| `DATABASE_URL` | Neon connection string (same as cpm-vercel) |
| `MALLOYYO_TOKEN` | Auth token for MCP access (optional, for private deployments) |

## Deploy after model changes
```bash
cd ~/Documents/cpm-agent/malloy-model-git
# Edit index.malloy or ai_tracker.malloy, then:
vercel --prod   # deploys the malloyyo project
```

## Querying via MCP (Guild agent / Claude tool call)
```json
{
  "tool": "malloyyo_query",
  "args": {
    "source": "interactions",
    "view":   "roi_by_provider"
  }
}
```

## Common queries
| Source | View | Returns |
|--------|------|---------|
| `interactions` | `roi_by_provider` | ROI by AI provider |
| `interactions` | `quality_by_task_type` | First-pass rate by task type |
| `interactions` | `value_trend` | Monthly value over time |
| `interactions` | `summary` | Overall totals |
| `cpm_benchmarks` | `by_channel_month` | CPM by channel and month |
| `cpm_benchmarks` | `channel_ranking` | Channels ranked by avg CPM |
| `cpm_benchmarks` | `seasonal_pattern` | Avg CPM by calendar month |
| `cpm_benchmarks` | `yoy_comparison` | Year-over-year by channel |

## Why Neon over GitHub Parquet
The original `cpm_benchmarks` source read from a static Parquet file on GitHub.
This meant Malloyyo showed data frozen at the migration date (June 2026) — new monthly
data added by the Vercel cron was invisible to Malloy queries. Switching to
`neon.table('public.cpm_benchmarks')` gives Malloyyo real-time access to all new data.
