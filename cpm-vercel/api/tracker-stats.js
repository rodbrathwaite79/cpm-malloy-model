/**
 * tracker-stats.js — Public GET endpoint for AI tracker dashboard
 *
 * GET /api/tracker-stats?project=cpm-agent
 *
 * Returns aggregated ROI stats from ai_interactions table.
 * No auth required (read-only, no sensitive data).
 */

import { getAiRoiSummary, queryAiInteractions } from "../lib/database.js"

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  const project = req.query.project ?? null

  try {
    const [byProvider, recent] = await Promise.all([
      getAiRoiSummary(project),
      queryAiInteractions({ project, limit: 20 }),
    ])

    const totals = byProvider.reduce(
      (acc, row) => ({
        tasks:       acc.tasks       + row.total_tasks,
        hours:       acc.hours       + parseFloat(row.total_hours  ?? 0),
        value_usd:   acc.value_usd   + parseFloat(row.total_value_usd ?? 0),
        cost_usd:    acc.cost_usd    + parseFloat(row.total_cost_usd  ?? 0),
        corrections: acc.corrections + row.total_corrections,
      }),
      { tasks: 0, hours: 0, value_usd: 0, cost_usd: 0, corrections: 0 }
    )

    const roi = totals.cost_usd > 0
      ? Math.round(totals.value_usd / totals.cost_usd)
      : null

    const firstPassCount = recent.filter(r => r.first_pass).length
    const firstPassPct   = recent.length > 0
      ? Math.round((firstPassCount / recent.length) * 100)
      : null

    res.setHeader("Access-Control-Allow-Origin", "*")
    return res.status(200).json({
      project:    project ?? "all",
      totals:     { ...totals, roi_multiple: roi },
      first_pass_pct: firstPassPct,
      by_provider: byProvider,
      recent:      recent.slice(0, 10),
    })
  } catch (err) {
    console.error("[tracker-stats]", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}
