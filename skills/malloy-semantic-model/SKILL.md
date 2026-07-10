---
name: malloy-semantic-model
description: >
  Define Malloy semantic models with sources, measures, dimensions, and named views.
  Use this skill whenever creating or modifying .malloy files for the CPM benchmarks or
  AI interactions data — including adding new views, changing aggregations, or connecting
  a source to a new database backend.
---

# Malloy Semantic Model — Patterns for This Project

## Files
- `index.malloy` — unified model: `interactions` (Neon) + `cpm_benchmarks` (Neon)
- `ai_tracker.malloy` — standalone model with 7 named queries for the AI tracker

## Connection syntax
```malloy
-- Neon Postgres (via malloy-config.json connection named "neon")
source: interactions is neon.table('public.ai_interactions') extend { ... }
source: cpm_benchmarks is neon.table('public.cpm_benchmarks') extend { ... }

-- DuckDB (local or remote parquet — avoid for live data, prefer Neon)
source: cpm_benchmarks is duckdb.table('/path/to/file.parquet') extend { ... }
```

## Source definition anatomy
```malloy
source: interactions is neon.table('public.ai_interactions') extend {

  -- Measures (aggregations)
  measure:
    total_tasks     is count()
    total_hours     is sum(hours_estimate)
    total_value_usd is sum(value_usd)
    roi_multiple    is round(sum(value_usd) / nullif(sum(cost_usd), 0), 0)
    first_pass_pct  is round(avg(pick 1.0 when first_pass else 0.0) * 100, 1)

  -- Dimensions (computed columns)
  dimension:
    month_year is concat(
      lpad!(month(created_at)::string, 2, '0'),
      '/', year(created_at)::string
    )

  -- Named views (reusable query shapes)
  view: roi_by_provider is {
    group_by: provider, tool
    aggregate: total_tasks, total_hours, total_value_usd, roi_multiple, first_pass_pct
    order_by: total_value_usd desc
  }
}
```

## Malloy syntax gotchas
| Situation | Syntax |
|-----------|--------|
| Reserved word as column name | Backtick: `` `year` ``, `` `month` `` |
| SQL function call | Bang syntax: `lpad!(str, n, pad)` |
| Conditional | `pick X when condition else Y` (not CASE/WHEN) |
| Cast | `value::string`, `value::number` |
| Null-safe division | `nullif(denominator, 0)` |

## Named query style (ai_tracker.malloy)
```malloy
query: roi_by_provider is interactions -> {
  group_by: provider, tool
  aggregate: total_tasks, total_hours, total_value_usd, roi_multiple, first_pass_pct
  order_by: total_value_usd desc
}
```
Named queries can be run directly via the Malloyyo MCP or Malloy VS Code extension.

## Quality tier dimension example
```malloy
dimension: quality_tier is
  pick 'Excellent' when first_pass_pct >= 90
  pick 'Good'      when first_pass_pct >= 75
  pick 'Fair'      when first_pass_pct >= 60
  else 'Needs Work'
```

## malloy-config.json (connection registry)
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
Always use `{ "env": "VAR_NAME" }` for secrets — never hard-code connection strings.

## Malloyyo deployment
Malloyyo is a separate Vercel project that serves the Malloy model as an MCP server.
After changing any `.malloy` file, deploy: `cd malloyyo && vercel --prod`
