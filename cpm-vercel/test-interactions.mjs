import { neon } from "@neondatabase/serverless"

const DATABASE_URL = process.env.DATABASE_URL
const sql = neon(DATABASE_URL)

const summary = await sql`
  SELECT
    COUNT(*)::int AS total_tasks,
    ROUND(SUM(hours_estimate)::numeric, 2) AS total_hours,
    ROUND(SUM(value_usd)::numeric, 2) AS total_value_usd,
    ROUND(COALESCE(SUM(cost_usd), 0)::numeric, 4) AS total_cost_usd,
    ROUND(SUM(value_usd) / NULLIF(SUM(cost_usd), 0), 0) AS roi_multiple,
    ROUND(AVG(CASE WHEN first_pass THEN 1.0 ELSE 0.0 END) * 100, 1) AS first_pass_pct
  FROM ai_interactions
`
console.log("✅ summary:", JSON.stringify(summary[0]))

const byProvider = await sql`
  SELECT provider, tool, COUNT(*)::int AS total_tasks,
    ROUND(SUM(value_usd)::numeric,2) AS total_value_usd,
    ROUND(SUM(value_usd)/NULLIF(SUM(cost_usd),0),0) AS roi_multiple
  FROM ai_interactions GROUP BY provider, tool ORDER BY total_value_usd DESC
`
console.log("✅ roi_by_provider:", JSON.stringify(byProvider))

const byTaskType = await sql`
  SELECT task_type, COUNT(*)::int AS total_tasks,
    ROUND(SUM(value_usd)::numeric,2) AS total_value_usd,
    ROUND(AVG(CASE WHEN first_pass THEN 1.0 ELSE 0.0 END) * 100, 1) AS first_pass_pct,
    SUM(corrections)::int AS total_corrections
  FROM ai_interactions GROUP BY task_type ORDER BY total_value_usd DESC
`
console.log("✅ quality_by_task_type:", JSON.stringify(byTaskType))

const trend = await sql`
  SELECT TO_CHAR(DATE_TRUNC('month',created_at),'MM/YYYY') AS month_year,
    COUNT(*)::int AS total_tasks, ROUND(SUM(value_usd)::numeric,2) AS total_value_usd
  FROM ai_interactions
  GROUP BY DATE_TRUNC('month',created_at), TO_CHAR(DATE_TRUNC('month',created_at),'MM/YYYY')
  ORDER BY DATE_TRUNC('month',created_at) ASC
`
console.log("✅ value_trend:", JSON.stringify(trend))

console.log("ALL VIEWS PASSED")
