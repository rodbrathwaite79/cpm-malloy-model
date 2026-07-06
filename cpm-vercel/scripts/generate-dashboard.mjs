/**
 * generate-dashboard.mjs
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
import { buildInteractiveDashboard, CHANNEL_LABELS, MONTH_NAMES } from "../lib/report-html.js"

// ── Rule-based insight synthesis (same as cpm-report.js, no paid API) ─────────
function synthesizeInsights(rows) {
  if (!rows || rows.length < 2) return null

  const fmt$   = v => `$${Number(v).toFixed(2)}`
  const fmtPct = v => (v >= 0 ? "+" : "") + Number(v).toFixed(1) + "%"

  const byChannel = {}
  for (const r of rows) {
    if (!byChannel[r.channel]) byChannel[r.channel] = []
    byChannel[r.channel].push({ year: Number(r.year), month: Number(r.month), cpm: parseFloat(r.avg_cpm), sort: Number(r.year) * 100 + Number(r.month) })
  }
  for (const pts of Object.values(byChannel)) pts.sort((a, b) => a.sort - b.sort)

  const latestSort  = Math.max(...rows.map(r => Number(r.year) * 100 + Number(r.month)))
  const latestYear  = Math.floor(latestSort / 100)
  const latestMonth = latestSort % 100

  const stats = {}
  for (const [ch, pts] of Object.entries(byChannel)) {
    const latest   = pts[pts.length - 1]
    const prev1    = pts[pts.length - 2]
    const prevYr   = pts.find(p => p.sort === (latestYear - 1) * 100 + latestMonth)
    const last3avg = pts.slice(-3).reduce((s, p) => s + p.cpm, 0) / Math.min(pts.length, 3)
    const momPct   = prev1  ? (latest.cpm - prev1.cpm)  / prev1.cpm  * 100 : null
    const yoyPct   = prevYr ? (latest.cpm - prevYr.cpm) / prevYr.cpm * 100 : null
    stats[ch] = { label: CHANNEL_LABELS[ch] ?? ch, cpm: latest.cpm, prevCpm: prev1?.cpm ?? null, momPct, yoyPct, avg3: last3avg, aboveAvg: latest.cpm > last3avg }
  }

  const all     = Object.values(stats)
  const withMom = all.filter(s => s.momPct !== null).sort((a, b) => b.momPct - a.momPct)
  const byPrice = [...all].sort((a, b) => b.cpm - a.cpm)
  const highest = byPrice[0], lowest = byPrice[byPrice.length - 1]
  const bigUp   = withMom[0], bigDown = withMom[withMom.length - 1]
  const mn      = MONTH_NAMES[latestMonth]

  let summary = `In ${mn} ${latestYear}, ${highest.label} leads all channels at ${fmt$(highest.cpm)} CPM`
  if (bigUp?.momPct > 0)   summary += `, with ${bigUp.label} posting the largest MoM gain at ${fmtPct(bigUp.momPct)}`
  if (bigDown?.momPct < 0) summary += `. ${bigDown.label} saw the steepest decline at ${fmtPct(bigDown.momPct)} to ${fmt$(bigDown.cpm)}`
  const fallingLabels = withMom.filter(s => s.momPct < 0).map(s => s.label)
  summary += `. ${fallingLabels.length ? fallingLabels.join(" and ") + " present buy-side opportunities this period." : "All channels are trending upward — locking in rates is advisable."}`

  const insights = []
  if (bigUp) {
    const yoyStr = bigUp.yoyPct !== null ? ` (${fmtPct(bigUp.yoyPct)} YoY)` : ""
    insights.push({ title: `${bigUp.label} CPM up ${fmtPct(bigUp.momPct)} MoM`, body: `${bigUp.label} reached ${fmt$(bigUp.cpm)} in ${mn} ${latestYear}, up from ${fmt$(bigUp.prevCpm)} last month${yoyStr}. At ${bigUp.aboveAvg ? "above" : "near"} its 3-month average of ${fmt$(bigUp.avg3)}, this signals ${bigUp.aboveAvg ? "sustained upward pressure — budget for rising costs or explore alternatives." : "a potential short-term spike likely to moderate."}`, sources: [] })
  }
  if (bigDown && bigDown.momPct < 0) {
    const yoyStr = bigDown.yoyPct !== null ? ` (${fmtPct(bigDown.yoyPct)} YoY)` : ""
    insights.push({ title: `${bigDown.label} softening — ${fmtPct(bigDown.momPct)} MoM`, body: `${bigDown.label} CPMs fell to ${fmt$(bigDown.cpm)}${yoyStr}. The current rate sits ${bigDown.aboveAvg ? "above" : "below"} its 3-month average of ${fmt$(bigDown.avg3)}, indicating ${bigDown.aboveAvg ? "softening from elevated levels — favorable for incremental buys." : "below-trend pricing — an attractive entry window for buyers."}`, sources: [] })
  } else if (withMom[1]) {
    const s = withMom[1]
    insights.push({ title: `${s.label} also rising at ${fmtPct(s.momPct)} MoM`, body: `${s.label} climbed to ${fmt$(s.cpm)} — ${s.aboveAvg ? "above" : "near"} its 3-month average of ${fmt$(s.avg3)}. Broad-channel CPM inflation signals tightening supply.`, sources: [] })
  }
  const spread = highest.cpm - lowest.cpm
  const premPct = Math.round((spread / lowest.cpm) * 100)
  insights.push({ title: `${highest.label}–${lowest.label} spread: ${fmt$(spread)}`, body: `${highest.label} (${fmt$(highest.cpm)}) commands a ${premPct}% premium over ${lowest.label} (${fmt$(lowest.cpm)}). ${premPct > 200 ? "This wide gap warrants a channel mix review — lower-CPM channels may deliver similar audiences at a fraction of the cost." : "Mix efficiency gains are available by weighting toward lower-CPM channels."}`, sources: [] })

  const recommendations = []
  if (bigDown && bigDown.momPct < -3) {
    recommendations.push({ title: `Increase ${bigDown.label} spend now`, body: `With ${bigDown.label} CPMs down ${fmtPct(bigDown.momPct)} to ${fmt$(bigDown.cpm)}, shift 10–15% of budget from higher-CPM channels before rates recover.`, urgency: "immediate" })
  } else if (bigDown && bigDown.momPct < 0) {
    recommendations.push({ title: `Test incremental ${bigDown.label} budget`, body: `${bigDown.label} is softening (${fmtPct(bigDown.momPct)} MoM to ${fmt$(bigDown.cpm)}). A 5–10% budget shift captures efficiency gains while the rate is favorable.`, urgency: "this-quarter" })
  } else {
    recommendations.push({ title: `Lock in rates before further increases`, body: `All channels trending up. Consider forward commitments, especially in ${highest.label} at ${fmt$(highest.cpm)}.`, urgency: "this-quarter" })
  }
  if (bigUp && bigUp.momPct > 5) {
    recommendations.push({ title: `Cap ${bigUp.label} CPM exposure`, body: `${bigUp.label} rose ${fmtPct(bigUp.momPct)} MoM to ${fmt$(bigUp.cpm)}. Set a ceiling alert at ${fmt$(bigUp.cpm * 1.1)} — if breached, reallocate to more efficient channels.`, urgency: bigUp.momPct > 10 ? "immediate" : "this-quarter" })
  } else {
    recommendations.push({ title: `Monitor ${highest.label} efficiency vs. alternatives`, body: `${highest.label} at ${fmt$(highest.cpm)} is the highest-CPM channel. Audit whether ROAS justifies this premium relative to ${lowest.label} at ${fmt$(lowest.cpm)}.`, urgency: "monitor" })
  }
  const belowAvg = all.filter(s => !s.aboveAvg).map(s => s.label)
  recommendations.push({ title: "Rebalance mix toward below-average channels", body: `${belowAvg.length ? belowAvg.join(" and ") + " are" : lowest.label + " is"} trading below their 3-month average. Shifting weight here improves blended CPM efficiency without sacrificing reach.`, urgency: "this-quarter" })

  const opp = (bigDown && bigDown.momPct < 0) ? bigDown.label : lowest.label
  const watch = bigUp?.label ?? highest.label
  const next_steps = [
    `This week: Pull ${opp} line items and identify the lowest-performing placements — reallocate toward channels with stronger momentum while the rate differential holds.`,
    `This month: Set CPM alerts — trigger a review if ${watch} exceeds ${fmt$((bigUp?.cpm ?? highest.cpm) * 1.15)} or ${opp} falls below ${fmt$((bigDown?.cpm ?? lowest.cpm) * 0.85)}.`,
    `This quarter: Run a channel mix A/B test shifting 10–15% of ${watch} budget to ${opp} — target a 5–8% improvement in blended CPM while maintaining reach targets.`
  ]

  return { summary, insights, recommendations, next_steps, _inputTokens: 0, _outputTokens: 0 }
}

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
