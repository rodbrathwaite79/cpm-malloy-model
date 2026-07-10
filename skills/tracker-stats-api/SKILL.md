---
name: tracker-stats-api
description: >
  Build or query the public /api/tracker-stats endpoint that returns aggregate AI interaction
  metrics without authentication. Use this skill when adding tracker stats to a dashboard,
  debugging the endpoint, or building a new public-facing metrics surface.
---

# Tracker Stats API — Public Aggregate Endpoint

## Endpoint
`GET https://cpm-vercel.vercel.app/api/tracker-stats`
No authentication required — public read.

## Response shape
```json
{
  "totals": {
    "tasks":       142,
    "hours":       87.5,
    "value_usd":   13250.00,
    "cost_usd":    18.40,
    "roi_multiple": 720
  },
  "by_provider": [
    { "provider": "claude", "tasks": 138, "hours": 85.0, "value_usd": 12900, "roi_multiple": 750 },
    { "provider": "gpt-4",  "tasks": 4,   "hours": 2.5,  "value_usd": 350,   "roi_multiple": 350 }
  ],
  "recent": [
    { "id": 142, "provider": "claude", "tool": "cowork", "task_type": "code",
      "description": "Refactored insights module", "hours_estimate": 1.5,
      "value_usd": 225, "first_pass": false, "created_at": "2026-07-10T..." }
  ],
  "first_pass_pct": 84.5
}
```

## Implementation pattern
```js
// api/tracker-stats.js
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*")
  if (req.method === "OPTIONS") return res.status(204).end()
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" })

  const sql = neon(process.env.DATABASE_URL)

  const [totalsRows, byProviderRows, recentRows] = await Promise.all([
    sql`
      SELECT COUNT(*) AS tasks, SUM(hours_estimate) AS hours,
             SUM(value_usd) AS value_usd, SUM(cost_usd) AS cost_usd,
             ROUND(SUM(value_usd) / NULLIF(SUM(cost_usd), 0), 0) AS roi_multiple,
             ROUND(AVG(CASE WHEN first_pass THEN 1.0 ELSE 0.0 END) * 100, 1) AS first_pass_pct
      FROM ai_interactions
    `,
    sql`
      SELECT provider, COUNT(*) AS tasks, SUM(hours_estimate) AS hours,
             SUM(value_usd) AS value_usd,
             ROUND(SUM(value_usd) / NULLIF(SUM(cost_usd), 0), 0) AS roi_multiple
      FROM ai_interactions
      GROUP BY provider ORDER BY value_usd DESC
    `,
    sql`
      SELECT id, provider, tool, task_type, description,
             hours_estimate, value_usd, first_pass, created_at
      FROM ai_interactions
      ORDER BY created_at DESC LIMIT 10
    `,
  ])

  const totals = totalsRows[0]
  return res.status(200).json({
    totals:         { tasks: Number(totals.tasks), hours: Number(totals.hours),
                      value_usd: Number(totals.value_usd), cost_usd: Number(totals.cost_usd),
                      roi_multiple: Number(totals.roi_multiple) },
    by_provider:    byProviderRows.map(r => ({ ...r, tasks: Number(r.tasks) })),
    recent:         recentRows,
    first_pass_pct: Number(totals.first_pass_pct),
  })
}
```

## Usage in the live web dashboard
The CPM Live Dashboard (`/api/dashboard`) fetches tracker stats on load and renders
them in the "AI ROI Tracker" section. Data is requested client-side via:
```js
const stats = await fetch("/api/tracker-stats").then(r => r.json())
```

## Related endpoints
| Endpoint | Auth | Purpose |
|----------|------|---------|
| `GET /api/tracker-stats` | None | Public aggregate summary |
| `GET /api/interactions?view=roi_by_provider` | Bearer LOG_API_KEY | Full semantic analytics |
| `POST /api/log-interaction` | Bearer LOG_API_KEY | Write new interaction |
