/**
 * insights.js — Rule-based CPM insight synthesis
 *
 * Pure JavaScript math on historical CPM rows — no paid API, no external calls.
 * Used by both /api/cpm-report.js (Vercel cron) and scripts/generate-dashboard.mjs (local preview).
 *
 * @param {Array} rows - CPM benchmark rows: { channel, year, month, avg_cpm }
 * @returns {{ summary, insights, recommendations, next_steps, _inputTokens, _outputTokens } | null}
 */

import { CHANNEL_LABELS, MONTH_NAMES } from "./report-html.js"

export function synthesizeInsights(rows) {
  if (!rows || rows.length < 2) return null

  const fmt$   = v => `$${Number(v).toFixed(2)}`
  const fmtPct = v => (v >= 0 ? "+" : "") + Number(v).toFixed(1) + "%"

  // Group and sort by channel
  const byChannel = {}
  for (const r of rows) {
    if (!byChannel[r.channel]) byChannel[r.channel] = []
    byChannel[r.channel].push({ year: Number(r.year), month: Number(r.month), cpm: parseFloat(r.avg_cpm), sort: Number(r.year) * 100 + Number(r.month) })
  }
  for (const pts of Object.values(byChannel)) pts.sort((a, b) => a.sort - b.sort)

  // Find latest period in data
  const latestSort  = Math.max(...rows.map(r => Number(r.year) * 100 + Number(r.month)))
  const latestYear  = Math.floor(latestSort / 100)
  const latestMonth = latestSort % 100

  // Per-channel stats
  const stats = {}
  for (const [ch, pts] of Object.entries(byChannel)) {
    const latest   = pts[pts.length - 1]
    const prev1    = pts[pts.length - 2]
    const prevYr   = pts.find(p => p.sort === (latestYear - 1) * 100 + latestMonth)
    const last3avg = pts.slice(-3).reduce((s, p) => s + p.cpm, 0) / Math.min(pts.length, 3)
    const momPct   = prev1  ? (latest.cpm - prev1.cpm)  / prev1.cpm  * 100 : null
    const yoyPct   = prevYr ? (latest.cpm - prevYr.cpm) / prevYr.cpm * 100 : null
    stats[ch] = {
      label:    CHANNEL_LABELS[ch] ?? ch,
      cpm:      latest.cpm,
      prevCpm:  prev1?.cpm ?? null,
      momPct,
      yoyPct,
      avg3:     last3avg,
      aboveAvg: latest.cpm > last3avg,
    }
  }

  const all     = Object.values(stats)
  const withMom = all.filter(s => s.momPct !== null).sort((a, b) => b.momPct - a.momPct)
  const byPrice = [...all].sort((a, b) => b.cpm - a.cpm)
  const highest = byPrice[0], lowest = byPrice[byPrice.length - 1]
  const bigUp   = withMom[0], bigDown = withMom[withMom.length - 1]
  const mn      = MONTH_NAMES[latestMonth]

  // ── Summary ───────────────────────────────────────────────────────────────────
  const fallingLabels = withMom.filter(s => s.momPct < 0).map(s => s.label)
  let summary = `In ${mn} ${latestYear}, ${highest.label} leads all channels at ${fmt$(highest.cpm)} CPM`
  if (bigUp?.momPct > 0)   summary += `, with ${bigUp.label} posting the largest MoM gain at ${fmtPct(bigUp.momPct)}`
  if (bigDown?.momPct < 0) summary += `. ${bigDown.label} saw the steepest decline at ${fmtPct(bigDown.momPct)} to ${fmt$(bigDown.cpm)}`
  summary += `. ${fallingLabels.length ? fallingLabels.join(" and ") + " present buy-side opportunities this period." : "All channels are trending upward — locking in rates is advisable."}`

  // ── Insights (3) ─────────────────────────────────────────────────────────────
  const insights = []

  // Insight 1: biggest mover up
  if (bigUp) {
    const yoyStr = bigUp.yoyPct !== null ? ` (${fmtPct(bigUp.yoyPct)} YoY)` : ""
    insights.push({
      title: `${bigUp.label} CPM up ${fmtPct(bigUp.momPct)} MoM`,
      body:  `${bigUp.label} reached ${fmt$(bigUp.cpm)} in ${mn} ${latestYear}, up from ${fmt$(bigUp.prevCpm)} last month${yoyStr}. At ${bigUp.aboveAvg ? "above" : "near"} its 3-month average of ${fmt$(bigUp.avg3)}, this signals ${bigUp.aboveAvg ? "sustained upward pressure — budget for rising costs or explore alternatives." : "a potential short-term spike likely to moderate."}`,
      sources: []
    })
  }

  // Insight 2: biggest mover down (or second-biggest up if all rising)
  if (bigDown && bigDown.momPct < 0) {
    const yoyStr = bigDown.yoyPct !== null ? ` (${fmtPct(bigDown.yoyPct)} YoY)` : ""
    insights.push({
      title: `${bigDown.label} softening — ${fmtPct(bigDown.momPct)} MoM`,
      body:  `${bigDown.label} CPMs fell to ${fmt$(bigDown.cpm)}${yoyStr}. The current rate sits ${bigDown.aboveAvg ? "above" : "below"} its 3-month average of ${fmt$(bigDown.avg3)}, indicating ${bigDown.aboveAvg ? "softening from elevated levels — favorable for incremental buys." : "below-trend pricing — an attractive entry window for buyers."}`,
      sources: []
    })
  } else {
    const second = withMom[1]
    if (second) insights.push({
      title: `${second.label} also rising at ${fmtPct(second.momPct)} MoM`,
      body:  `${second.label} climbed to ${fmt$(second.cpm)} — ${second.aboveAvg ? "above" : "near"} its 3-month average of ${fmt$(second.avg3)}. Broad-channel CPM inflation signals tightening supply across the market.`,
      sources: []
    })
  }

  // Insight 3: premium spread between highest and lowest channel
  const spread     = highest.cpm - lowest.cpm
  const premiumPct = Math.round((spread / lowest.cpm) * 100)
  insights.push({
    title: `${highest.label}–${lowest.label} spread: ${fmt$(spread)}`,
    body:  `${highest.label} (${fmt$(highest.cpm)}) commands a ${premiumPct}% premium over ${lowest.label} (${fmt$(lowest.cpm)}). ${premiumPct > 200 ? "This historically wide gap warrants a channel mix review — the lower-CPM channel may deliver similar audiences at a fraction of the cost." : "The spread is within normal range, but mix efficiency gains are still available by weighting toward lower-CPM channels."}`,
    sources: []
  })

  // ── Recommendations (3) ──────────────────────────────────────────────────────
  const recommendations = []

  if (bigDown && bigDown.momPct < -3) {
    recommendations.push({
      title:   `Increase ${bigDown.label} spend now`,
      body:    `With ${bigDown.label} CPMs down ${fmtPct(bigDown.momPct)} to ${fmt$(bigDown.cpm)}, this is a favorable window to increase impression volume at lower cost. Shift 10–15% of budget from higher-CPM channels before rates recover.`,
      urgency: "immediate"
    })
  } else if (bigDown && bigDown.momPct < 0) {
    recommendations.push({
      title:   `Test incremental ${bigDown.label} budget`,
      body:    `${bigDown.label} is softening (${fmtPct(bigDown.momPct)} MoM to ${fmt$(bigDown.cpm)}). A modest 5–10% budget shift captures efficiency gains while the rate is favorable, with limited downside.`,
      urgency: "this-quarter"
    })
  } else {
    recommendations.push({
      title:   `Lock in rates before further increases`,
      body:    `All channels are trending up. Consider forward commitments or preferred deals, especially in ${highest.label} at ${fmt$(highest.cpm)} — the highest-risk channel for further CPM inflation.`,
      urgency: "this-quarter"
    })
  }

  if (bigUp && bigUp.momPct > 5) {
    recommendations.push({
      title:   `Cap ${bigUp.label} CPM exposure`,
      body:    `${bigUp.label} rose ${fmtPct(bigUp.momPct)} MoM to ${fmt$(bigUp.cpm)}. Set a ceiling alert at ${fmt$(bigUp.cpm * 1.1)} — if breached, reallocate that budget to more efficient channels. Avoid over-indexing here without a direct response metric to justify the premium.`,
      urgency: bigUp.momPct > 10 ? "immediate" : "this-quarter"
    })
  } else {
    recommendations.push({
      title:   `Monitor ${highest.label} efficiency vs. alternatives`,
      body:    `${highest.label} remains the highest-CPM channel at ${fmt$(highest.cpm)}. Audit whether ROAS or conversion metrics justify this premium relative to ${lowest.label} at ${fmt$(lowest.cpm)}.`,
      urgency: "monitor"
    })
  }

  const belowAvg = all.filter(s => !s.aboveAvg).map(s => s.label)
  recommendations.push({
    title:   "Rebalance mix toward below-average channels",
    body:    `${belowAvg.length ? belowAvg.join(" and ") + " are" : lowest.label + " is"} trading below their 3-month average. Shifting weight here improves blended CPM efficiency without sacrificing total reach.`,
    urgency: "this-quarter"
  })

  // ── Next steps (3) ───────────────────────────────────────────────────────────
  const opp   = (bigDown && bigDown.momPct < 0) ? bigDown.label : lowest.label
  const watch = bigUp?.label ?? highest.label
  const next_steps = [
    `This week: Pull ${opp} line items and identify the lowest-performing placements — reallocate that budget toward channels with stronger momentum while the rate differential holds.`,
    `This month: Set CPM alerts — trigger a portfolio review if ${watch} exceeds ${fmt$((bigUp?.cpm ?? highest.cpm) * 1.15)} or ${opp} falls below ${fmt$((bigDown?.cpm ?? lowest.cpm) * 0.85)} to stay ahead of rate swings.`,
    `This quarter: Run a channel mix A/B test shifting 10–15% of ${watch} budget to ${opp} — target a 5–8% improvement in blended CPM while maintaining reach targets.`
  ]

  return { summary, insights, recommendations, next_steps, _inputTokens: 0, _outputTokens: 0 }
}
