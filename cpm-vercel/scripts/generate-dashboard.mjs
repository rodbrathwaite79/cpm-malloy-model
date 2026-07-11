/**
 * generate-dashboard.mjs
 *
 * LOCAL PREVIEW TOOL — not part of the production pipeline.
 * Use this to inspect the interactive dashboard without sending an email.
 * The production dashboard is generated and emailed automatically by cpm-report.js
 * every Monday via Vercel cron.
 *
 * Generates CPM-Dashboard.html locally without triggering an email.
 * Uses real Neon data if DATABASE_URL is set; falls back to demo data otherwise.
 *
 * Usage:
 *   node scripts/generate-dashboard.mjs
 *
 * Output: ./CPM-Dashboard-local.html
 */

import { writeFileSync } from "fs"
import { buildInteractiveDashboard } from "../lib/report-html.js"
import { synthesizeInsights } from "../lib/insights.js"

// ── Data source: real Neon or demo ────────────────────────────────────────────
async function getBenchmarkRows() {
  const dbUrl = process.env.DATABASE_URL
  if (dbUrl && !dbUrl.includes("...")) {
    // Real Neon DB
    const { neon } = await import("@neondatabase/serverless")
    const sql = neon(dbUrl)
    const rows = await sql`
      SELECT channel, year, month, AVG(cpm) as avg_cpm,
             year * 100 + month as period_sort
      FROM cpm_benchmarks
      GROUP BY channel, year, month
      ORDER BY period_sort
    `
    console.log(`✅ Loaded ${rows.length} rows from Neon Postgres`)
    return rows
  }

  // Demo data — realistic CPM benchmarks 2023–2026 (5 channels × 42 months)
  console.log("ℹ️  DATABASE_URL not set — using demo data")
  const rows = []
  const baseCpms = { paid_social: 9.50, paid_search: 18.00, programmatic_display: 3.20, video_ctv: 22.00, streaming_audio: 7.50 }
  const seasonality = [0.92, 0.88, 0.94, 0.97, 1.00, 1.02, 0.99, 1.01, 1.04, 1.08, 1.12, 1.18]
  const drift = { paid_social: 0.008, paid_search: 0.005, programmatic_display: -0.003, video_ctv: 0.012, streaming_audio: 0.006 }

  for (const [channel, baseCpm] of Object.entries(baseCpms)) {
    let cpm = baseCpm
    let mo = 0
    for (let year = 2023; year <= 2026; year++) {
      const endMonth = (year === 2026) ? 6 : 12
      for (let month = 1; month <= endMonth; month++) {
        const noise = 1 + (Math.sin(mo * 7.3) * 0.03)
        const adjusted = cpm * seasonality[month - 1] * noise
        rows.push({ channel, year, month, avg_cpm: Math.round(adjusted * 100) / 100, period_sort: year * 100 + month })
        cpm *= (1 + drift[channel])
        mo++
      }
    }
  }
  return rows
}

// ── Main ──────────────────────────────────────────────────────────────────────
const rows = await getBenchmarkRows()
const aiInsights = synthesizeInsights(rows)
const runDate = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })
const html = buildInteractiveDashboard(rows, runDate, aiInsights)

const outPath = new URL("../CPM-Dashboard-local.html", import.meta.url).pathname
writeFileSync(outPath, html, "utf-8")
console.log(`✅ Dashboard written to: ${outPath}`)
if (aiInsights) {
  console.log(`\n📊 Summary: ${aiInsights.summary.slice(0, 120)}...`)
  console.log(`\n💡 Insights (${aiInsights.insights.length}):`)
  aiInsights.insights.forEach((ins, i) => console.log(`   ${i + 1}. ${ins.title}`))
  console.log(`\n📋 Recommendations (${aiInsights.recommendations.length}):`)
  aiInsights.recommendations.forEach((rec, i) => console.log(`   ${i + 1}. [${rec.urgency}] ${rec.title}`))
}
