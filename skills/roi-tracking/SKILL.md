---
name: roi-tracking
description: >
  Log AI interaction ROI data to Neon Postgres, including task type, hours (measured or estimated),
  value, cost, quality, and corrections. Use this skill when building or modifying any agent
  or endpoint that records AI work sessions — including the universal tracker, cowork tracker,
  log-ai CLI, or /api/log-interaction endpoint.
---

# ROI Tracking — AI Interaction Schema & Patterns

## Table schema
```sql
CREATE TABLE IF NOT EXISTS ai_interactions (
  id            SERIAL PRIMARY KEY,
  project       TEXT    NOT NULL DEFAULT 'cpm-agent',
  provider      TEXT    NOT NULL,               -- 'claude', 'gpt-4', etc.
  tool          TEXT    NOT NULL,               -- 'cowork', 'cursor', 'api', etc.
  task_type     TEXT    NOT NULL,               -- see rate table below
  description   TEXT    NOT NULL,
  hours_estimate NUMERIC(5,2) NOT NULL DEFAULT 0,
  hours_source  TEXT    NOT NULL DEFAULT 'estimated'
                CHECK (hours_source IN ('measured','estimated')),
  value_usd     NUMERIC(8,2) NOT NULL DEFAULT 0,
  cost_usd      NUMERIC(8,2) NOT NULL DEFAULT 0,
  first_pass    BOOLEAN NOT NULL DEFAULT true,
  corrections   INTEGER NOT NULL DEFAULT 0,
  output        TEXT,
  notes         TEXT,
  cost_model    TEXT,
  session_id    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
```

## Professional rate table (value_usd = hours × rate)
| task_type | Rate/hr | Use for |
|-----------|---------|---------|
| `research` | $125 | Market research, fact-finding |
| `document` | $80 | Writing docs, reports, specs |
| `analysis` | $175 | Data analysis, architecture decisions |
| `code` | $150 | Writing, debugging, reviewing code |
| `testing` | $100 | QA, test writing, validation |
| `design` | $175 | System design, UI/UX |

## hours_source field
- `"measured"` — agent tracked actual start/end time: `hoursSource = hasStartedAt ? "measured" : "estimated"`
- `"estimated"` — agent or user estimated based on task complexity

## Insert function
```js
export async function insertAiInteraction({
  project, provider, tool, taskType, description,
  hoursEstimate, hoursSource = "estimated",
  valueUsd, firstPass = true, corrections = 0,
  output, notes, costModel, costUsd = 0, sessionId
}) {
  const sql = neon(process.env.DATABASE_URL)
  const result = await sql`
    INSERT INTO ai_interactions (
      project, provider, tool, task_type, description,
      hours_estimate, hours_source, value_usd, cost_usd,
      first_pass, corrections, output, notes, cost_model, session_id
    ) VALUES (
      ${project}, ${provider}, ${tool}, ${taskType}, ${description},
      ${hoursEstimate}, ${hoursSource}, ${valueUsd}, ${costUsd},
      ${firstPass}, ${corrections}, ${output}, ${notes}, ${costModel}, ${sessionId}
    )
    RETURNING id
  `
  return result[0].id
}
```

## log-ai CLI usage
```bash
log-ai \
  --provider claude \
  --tool cowork \
  --type code \
  --hours 1.5 \
  --value 225 \
  --desc "Refactored synthesizeInsights into shared lib" \
  --project cpm-agent \
  --no-first-pass \
  --corrections 2
```

## ROI query
```sql
SELECT
  provider,
  COUNT(*)                                    AS total_tasks,
  SUM(hours_estimate)                         AS total_hours,
  SUM(value_usd)                              AS total_value,
  SUM(cost_usd)                               AS total_cost,
  ROUND(SUM(value_usd) / NULLIF(SUM(cost_usd), 0), 0) AS roi_multiple,
  ROUND(AVG(CASE WHEN first_pass THEN 1.0 ELSE 0.0 END) * 100, 1) AS first_pass_pct
FROM ai_interactions
GROUP BY provider
ORDER BY total_value DESC
```

## API endpoints
- `POST /api/log-interaction` — write (requires `LOG_API_KEY`)
- `GET  /api/interactions?view=roi_by_provider` — read (requires `LOG_API_KEY`)
- `GET  /api/tracker-stats` — public aggregate summary (no auth)
