/**
 * interactions.js — Semantic analytics over ai_interactions (live Neon)
 *
 * GET  /api/interactions?view=<view>[&project=<project>]
 * POST /api/interactions  { view, project }
 *
 * Views (mirror the Malloy semantic model in ai_tracker.malloy):
 *   summary             — single-row dashboard totals
 *   roi_by_provider     — ROI per provider+tool, ordered by value
 *   quality_by_task_type — first-pass rate and corrections per task category
 *   value_trend         — monthly value/cost/hours trend
 *   raw                 — full interaction log (latest 200)
 *
 * Auth: Authorization: Bearer <LOG_API_KEY>
 */

import { neon } from "@neondatabase/serverless"

function db() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set")
  return neon(process.env.DATABASE_URL)
}

const VIEWS = ["summary", "roi_by_provider", "quality_by_task_type", "value_trend", "raw"]

// ── Query implementations ──────────────────────────────────────────────────────

async function summary(sql, project) {
  const rows = project
    ? await sql`
        SELECT
          COUNT(*)::int                                                    AS total_tasks,
          ROUND(SUM(hours_estimate)::numeric, 2)                          AS total_hours,
          ROUND(SUM(value_usd)::numeric, 2)                               AS total_value_usd,
          ROUND(COALESCE(SUM(cost_usd), 0)::numeric, 4)                  AS total_cost_usd,
          ROUND(SUM(value_usd) / NULLIF(SUM(cost_usd), 0), 0)           AS roi_multiple,
          ROUND(AVG(CASE WHEN first_pass THEN 1.0 ELSE 0.0 END) * 100, 1) AS first_pass_pct
        FROM ai_interactions
        WHERE project = ${project}
      `
    : await sql`
        SELECT
          COUNT(*)::int                                                    AS total_tasks,
          ROUND(SUM(hours_estimate)::numeric, 2)                          AS total_hours,
          ROUND(SUM(value_usd)::numeric, 2)                               AS total_value_usd,
          ROUND(COALESCE(SUM(cost_usd), 0)::numeric, 4)                  AS total_cost_usd,
          ROUND(SUM(value_usd) / NULLIF(SUM(cost_usd), 0), 0)           AS roi_multiple,
          ROUND(AVG(CASE WHEN first_pass THEN 1.0 ELSE 0.0 END) * 100, 1) AS first_pass_pct
        FROM ai_interactions
      `
  return rows
}

async function roiByProvider(sql, project) {
  const rows = project
    ? await sql`
        SELECT
          provider,
          tool,
          COUNT(*)::int                                                    AS total_tasks,
          ROUND(SUM(hours_estimate)::numeric, 2)                          AS total_hours,
          ROUND(SUM(value_usd)::numeric, 2)                               AS total_value_usd,
          ROUND(COALESCE(SUM(cost_usd), 0)::numeric, 4)                  AS total_cost_usd,
          ROUND(SUM(value_usd) / NULLIF(SUM(cost_usd), 0), 0)           AS roi_multiple,
          ROUND(AVG(CASE WHEN first_pass THEN 1.0 ELSE 0.0 END) * 100, 1) AS first_pass_pct
        FROM ai_interactions
        WHERE project = ${project}
        GROUP BY provider, tool
        ORDER BY total_value_usd DESC
      `
    : await sql`
        SELECT
          provider,
          tool,
          COUNT(*)::int                                                    AS total_tasks,
          ROUND(SUM(hours_estimate)::numeric, 2)                          AS total_hours,
          ROUND(SUM(value_usd)::numeric, 2)                               AS total_value_usd,
          ROUND(COALESCE(SUM(cost_usd), 0)::numeric, 4)                  AS total_cost_usd,
          ROUND(SUM(value_usd) / NULLIF(SUM(cost_usd), 0), 0)           AS roi_multiple,
          ROUND(AVG(CASE WHEN first_pass THEN 1.0 ELSE 0.0 END) * 100, 1) AS first_pass_pct
        FROM ai_interactions
        GROUP BY provider, tool
        ORDER BY total_value_usd DESC
      `
  return rows
}

async function qualityByTaskType(sql, project) {
  const rows = project
    ? await sql`
        SELECT
          task_type,
          COUNT(*)::int                                                    AS total_tasks,
          ROUND(SUM(hours_estimate)::numeric, 2)                          AS total_hours,
          ROUND(SUM(value_usd)::numeric, 2)                               AS total_value_usd,
          ROUND(AVG(CASE WHEN first_pass THEN 1.0 ELSE 0.0 END) * 100, 1) AS first_pass_pct,
          SUM(corrections)::int                                           AS total_corrections
        FROM ai_interactions
        WHERE project = ${project}
        GROUP BY task_type
        ORDER BY total_value_usd DESC
      `
    : await sql`
        SELECT
          task_type,
          COUNT(*)::int                                                    AS total_tasks,
          ROUND(SUM(hours_estimate)::numeric, 2)                          AS total_hours,
          ROUND(SUM(value_usd)::numeric, 2)                               AS total_value_usd,
          ROUND(AVG(CASE WHEN first_pass THEN 1.0 ELSE 0.0 END) * 100, 1) AS first_pass_pct,
          SUM(corrections)::int                                           AS total_corrections
        FROM ai_interactions
        GROUP BY task_type
        ORDER BY total_value_usd DESC
      `
  return rows
}

async function valueTrend(sql, project) {
  const rows = project
    ? await sql`
        SELECT
          TO_CHAR(DATE_TRUNC('month', created_at), 'MM/YYYY')            AS month_year,
          COUNT(*)::int                                                    AS total_tasks,
          ROUND(SUM(value_usd)::numeric, 2)                               AS total_value_usd,
          ROUND(COALESCE(SUM(cost_usd), 0)::numeric, 4)                  AS total_cost_usd,
          ROUND(SUM(hours_estimate)::numeric, 2)                          AS total_hours
        FROM ai_interactions
        WHERE project = ${project}
        GROUP BY DATE_TRUNC('month', created_at),
                 TO_CHAR(DATE_TRUNC('month', created_at), 'MM/YYYY')
        ORDER BY DATE_TRUNC('month', created_at) ASC
      `
    : await sql`
        SELECT
          TO_CHAR(DATE_TRUNC('month', created_at), 'MM/YYYY')            AS month_year,
          COUNT(*)::int                                                    AS total_tasks,
          ROUND(SUM(value_usd)::numeric, 2)                               AS total_value_usd,
          ROUND(COALESCE(SUM(cost_usd), 0)::numeric, 4)                  AS total_cost_usd,
          ROUND(SUM(hours_estimate)::numeric, 2)                          AS total_hours
        FROM ai_interactions
        GROUP BY DATE_TRUNC('month', created_at),
                 TO_CHAR(DATE_TRUNC('month', created_at), 'MM/YYYY')
        ORDER BY DATE_TRUNC('month', created_at) ASC
      `
  return rows
}

async function raw(sql, project) {
  return project
    ? sql`
        SELECT id, project, provider, tool, task_type, description,
               hours_estimate, value_usd, first_pass, corrections,
               cost_model, cost_usd, session_id, created_at
        FROM ai_interactions
        WHERE project = ${project}
        ORDER BY created_at DESC
        LIMIT 200
      `
    : sql`
        SELECT id, project, provider, tool, task_type, description,
               hours_estimate, value_usd, first_pass, corrections,
               cost_model, cost_usd, session_id, created_at
        FROM ai_interactions
        ORDER BY created_at DESC
        LIMIT 200
      `
}

// ── Handler ────────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type")

  if (req.method === "OPTIONS") return res.status(200).end()

  // Auth
  const apiKey = process.env.LOG_API_KEY
  const auth   = req.headers.authorization ?? ""
  if (apiKey && auth !== `Bearer ${apiKey}`) {
    return res.status(401).json({ error: "Unauthorized" })
  }

  // Parse params
  const body    = req.method === "POST" ? req.body : {}
  const view    = (req.query.view    ?? body.view    ?? "summary").toLowerCase()
  const project = (req.query.project ?? body.project ?? null) || null

  if (!VIEWS.includes(view)) {
    return res.status(400).json({
      error: `Unknown view '${view}'. Valid views: ${VIEWS.join(", ")}`,
    })
  }

  try {
    const sql = db()
    let rows

    switch (view) {
      case "summary":              rows = await summary(sql, project);           break
      case "roi_by_provider":      rows = await roiByProvider(sql, project);     break
      case "quality_by_task_type": rows = await qualityByTaskType(sql, project); break
      case "value_trend":          rows = await valueTrend(sql, project);        break
      case "raw":                  rows = await raw(sql, project);               break
    }

    return res.status(200).json({
      view,
      project: project ?? "all",
      row_count: rows.length,
      rows,
    })
  } catch (err) {
    console.error("[interactions]", err)
    return res.status(500).json({ error: "Internal server error", detail: err.message })
  }
}
