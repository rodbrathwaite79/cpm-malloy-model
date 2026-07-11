/**
 * report-html.js — HTML email + dashboard builders for CPM Vercel project
 *
 * Extracted and adapted from daily-report.mjs.
 * buildEmailMetricsSection() updated to accept Neon Postgres data shapes.
 */

// ── Constants ─────────────────────────────────────────────────────────────────
export const CHANNELS = [
  { key: "paid_social",          label: "Paid Social" },
  { key: "paid_search",          label: "Paid Search" },
  { key: "programmatic_display", label: "Programmatic Display" },
  { key: "video_ctv",            label: "Video / CTV" },
  { key: "streaming_audio",      label: "Streaming Audio" },
]

export const CHANNEL_LABELS = {
  paid_social:          "Paid Social",
  paid_search:          "Paid Search",
  programmatic_display: "Programmatic Display",
  video_ctv:            "Video / CTV",
  streaming_audio:      "Streaming Audio",
}

export const MONTH_NAMES = {
  1: "January", 2: "February", 3: "March",    4: "April",
  5: "May",     6: "June",     7: "July",      8: "August",
  9: "September", 10: "October", 11: "November", 12: "December",
}

// ── Helpers ───────────────────────────────────────────────────────────────────
export function computeChanges(rows) {
  const byKey = {}
  for (const r of rows) byKey[`${r.channel}|${r.year}|${r.month}`] = r.avg_cpm

  return rows.map(r => {
    const prevMo  = r.month === 1 ? 12 : r.month - 1
    const prevYr  = r.month === 1 ? r.year - 1 : r.year
    const prevCpm = byKey[`${r.channel}|${prevYr}|${prevMo}`]
    const mom     = prevCpm != null ? (r.avg_cpm - prevCpm) / prevCpm * 100 : null

    const yoyCpm  = byKey[`${r.channel}|${r.year - 1}|${r.month}`]
    const yoy     = yoyCpm != null ? (r.avg_cpm - yoyCpm) / yoyCpm * 100 : null

    return { ...r, mom, yoy }
  })
}

function fmtPct(v) {
  if (v === null) return '<span style="color:#475569">—</span>'
  const sign  = v >= 0 ? "+" : ""
  const arrow = v > 0.5 ? "↑" : v < -0.5 ? "↓" : "→"
  const color = v > 0.5 ? "#22c55e" : v < -0.5 ? "#ef4444" : "#f59e0b"
  return `<span style="color:${color};font-weight:600;">${arrow} ${sign}${v.toFixed(1)}%</span>`
}

// ── Email bar chart ───────────────────────────────────────────────────────────
export function buildEmailBarChart(enriched) {
  const latestByChannel = {}
  for (const r of enriched) {
    const cur = latestByChannel[r.channel]
    if (!cur || r.period_sort > cur.period_sort) latestByChannel[r.channel] = r
  }
  const points = CHANNELS.map(({ key }) => latestByChannel[key]).filter(Boolean)
  if (points.length === 0) return ""
  const maxCpm = Math.max(...points.map(r => r.avg_cpm))

  const tableRows = points.map(r => {
    const pct      = Math.max(1, Math.round((r.avg_cpm / maxCpm) * 100))
    const empty    = 100 - pct
    const momColor = r.mom === null ? "#475569" : r.mom > 0.5 ? "#22c55e" : r.mom < -0.5 ? "#ef4444" : "#f59e0b"
    const momText  = r.mom === null ? "—" : `${r.mom >= 0 ? "+" : ""}${r.mom.toFixed(1)}%`
    const arrow    = r.mom === null ? "" : r.mom > 0.5 ? "↑ " : r.mom < -0.5 ? "↓ " : "→ "
    const chLabel  = CHANNEL_LABELS[r.channel] ?? r.channel
    const period   = `${(MONTH_NAMES[r.month] ?? "").slice(0, 3)} ${r.year}`
    return `
    <tr>
      <td valign="middle" style="padding:5px 8px 5px 0;color:#94a3b8;font-size:11px;white-space:nowrap;width:145px;">
        ${chLabel}<br><span style="color:#475569;font-size:10px;">${period}</span>
      </td>
      <td valign="middle" style="padding:5px 0;">
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
          <tr>
            <td width="${pct}%" style="background:#3b82f6;height:20px;font-size:1px;">&nbsp;</td>
            <td width="${empty}%" style="background:#0f172a;height:20px;font-size:1px;">&nbsp;</td>
          </tr>
        </table>
      </td>
      <td valign="middle" style="padding:5px 0 5px 8px;color:#f1f5f9;font-size:13px;font-weight:700;white-space:nowrap;width:52px;">$${r.avg_cpm.toFixed(2)}</td>
      <td valign="middle" style="padding:5px 0;color:${momColor};font-size:11px;font-weight:600;white-space:nowrap;width:64px;">${arrow}${momText}&nbsp;MoM</td>
    </tr>`
  }).join("")

  return `
  <div style="background:#1e293b;border-radius:8px;padding:18px;margin-bottom:20px;">
    <div style="color:#f1f5f9;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;">CPM by Channel — Latest Period</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${tableRows}</table>
    <div style="color:#475569;font-size:10px;margin-top:8px;">Bar length ∝ CPM&nbsp;&nbsp;·&nbsp;&nbsp;<span style="color:#22c55e;">Green ↑</span> = higher MoM&nbsp;&nbsp;<span style="color:#ef4444;">Red ↓</span> = lower&nbsp;&nbsp;<span style="color:#f59e0b;">Amber →</span> = flat</div>
  </div>`
}

// ── 6-month SVG trend chart (by channel) ─────────────────────────────────────
const CHANNEL_COLORS = {
  paid_social:          '#3b82f6',
  paid_search:          '#22c55e',
  programmatic_display: '#f59e0b',
  video_ctv:            '#a855f7',
  streaming_audio:      '#ec4899',
}

export function buildEmailTrendChart(enriched) {
  const periods = [...new Set(enriched.map(r => r.period_sort))]
    .sort((a, b) => a - b)
    .slice(-6)
  if (periods.length < 2) return ""

  const byKey = {}
  for (const r of enriched) byKey[`${r.channel}|${r.period_sort}`] = r

  const allCpms = []
  for (const ch of CHANNELS)
    for (const ps of periods) { const r = byKey[`${ch.key}|${ps}`]; if (r) allCpms.push(r.avg_cpm) }
  if (allCpms.length === 0) return ""

  const minCpm  = Math.max(0, Math.floor(Math.min(...allCpms) * 0.88))
  const maxCpm  = Math.ceil(Math.max(...allCpms) * 1.06)
  const range   = maxCpm - minCpm || 1

  // Layout
  const W = 560, H = 210
  const mL = 50, mR = 14, mT = 18, mB = 38
  const pW = W - mL - mR
  const pH = H - mT - mB

  const toX = i   => mL + (i / (periods.length - 1)) * pW
  const toY = cpm => mT + pH - ((cpm - minCpm) / range) * pH

  // Grid lines + y labels (5 ticks)
  const ticks = 4
  let grid = ''
  for (let i = 0; i <= ticks; i++) {
    const val = minCpm + (range / ticks) * i
    const y   = toY(val).toFixed(1)
    grid += `<line x1="${mL}" y1="${y}" x2="${W - mR}" y2="${y}" stroke="#1e293b" stroke-width="1"/>`
    grid += `<text x="${mL - 5}" y="${(+y + 3.5).toFixed(1)}" text-anchor="end" fill="#475569" font-size="9" font-family="-apple-system,sans-serif">$${Math.round(val)}</text>`
  }

  // X labels
  const xLabels = periods.map((ps, i) => {
    const mo  = ps % 100
    const yr  = Math.floor(ps / 100)
    const lbl = `${(MONTH_NAMES[mo] ?? '').slice(0, 3)} '${String(yr).slice(2)}`
    return `<text x="${toX(i).toFixed(1)}" y="${(mT + pH + 15).toFixed(1)}" text-anchor="middle" fill="#64748b" font-size="9" font-family="-apple-system,sans-serif">${lbl}</text>`
  }).join('')

  // One polyline per channel
  let lines = ''
  for (const ch of CHANNELS) {
    const color = CHANNEL_COLORS[ch.key] ?? '#94a3b8'
    const pts   = periods.map((ps, i) => {
      const r = byKey[`${ch.key}|${ps}`]
      return r ? { x: toX(i), y: toY(r.avg_cpm) } : null
    })
    // Build path segments (skip gaps)
    let d = '', inSeg = false
    for (const pt of pts) {
      if (pt) {
        d += `${inSeg ? 'L' : 'M'}${pt.x.toFixed(1)},${pt.y.toFixed(1)} `
        inSeg = true
      } else { inSeg = false }
    }
    if (d) lines += `<path d="${d.trim()}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`
    // Dots
    for (const pt of pts.filter(Boolean))
      lines += `<circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="3.2" fill="${color}"/>`
  }

  // Legend (HTML, not SVG — easier to wrap)
  const legendItems = CHANNELS.map(ch => {
    const color = CHANNEL_COLORS[ch.key] ?? '#94a3b8'
    return `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:12px;white-space:nowrap;">
      <span style="display:inline-block;width:12px;height:3px;background:${color};border-radius:2px;"></span>
      <span style="color:#94a3b8;font-size:10px;">${ch.label}</span>
    </span>`
  }).join('')

  return `
  <div style="margin-bottom:24px;">
    <div style="color:#f1f5f9;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;">6-Month CPM Trend by Channel</div>
    <div style="background:#1e293b;border-radius:8px;padding:16px 14px 12px;">
      <svg width="100%" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="display:block;overflow:visible;">
        ${grid}${lines}${xLabels}
      </svg>
      <div style="margin-top:10px;display:flex;flex-wrap:wrap;">${legendItems}</div>
    </div>
  </div>`
}

// ── 6-month trend table ───────────────────────────────────────────────────────
export function buildEmailTrendTable(enriched) {
  const periods = [...new Set(enriched.map(r => r.period_sort))]
    .sort((a, b) => b - a)
    .slice(0, 6)
  if (periods.length === 0) return ""

  const byKey = {}
  for (const r of enriched) byKey[`${r.channel}|${r.period_sort}`] = r

  const headerCells = CHANNELS.map(c => {
    const parts = c.label.split(" ")
    return `<th style="padding:6px 5px;text-align:right;color:#475569;font-size:10px;font-weight:700;text-transform:uppercase;white-space:nowrap;">${parts[0]}<br>${parts.slice(1).join(" ") || "&nbsp;"}</th>`
  }).join("")

  const tableRows = periods.map(ps => {
    const year        = Math.floor(ps / 100)
    const month       = ps % 100
    const periodLabel = `${(MONTH_NAMES[month] ?? "").slice(0, 3)} ${year}`
    const cells = CHANNELS.map(c => {
      const r = byKey[`${c.key}|${ps}`]
      if (!r) return `<td style="padding:6px 5px;text-align:right;color:#334155;font-size:11px;border-bottom:1px solid #0f172a;">—</td>`
      const color = r.mom === null ? "#f1f5f9" : r.mom > 0.5 ? "#22c55e" : r.mom < -0.5 ? "#ef4444" : "#f59e0b"
      return `<td style="padding:6px 5px;text-align:right;color:${color};font-weight:600;font-size:11px;border-bottom:1px solid #0f172a;">$${r.avg_cpm.toFixed(2)}</td>`
    }).join("")
    return `<tr><td style="padding:6px 5px;color:#94a3b8;font-size:11px;white-space:nowrap;border-bottom:1px solid #0f172a;">${periodLabel}</td>${cells}</tr>`
  }).join("")

  return `
  <div style="margin-bottom:24px;">
    <div style="color:#f1f5f9;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;">6-Month CPM Trend</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#1e293b;border-radius:6px;overflow:hidden;">
      <thead>
        <tr style="background:#0f172a;">
          <th style="padding:6px 5px;text-align:left;color:#475569;font-size:10px;font-weight:700;text-transform:uppercase;">Period</th>
          ${headerCells}
        </tr>
      </thead>
      <tbody>${tableRows}</tbody>
    </table>
    <div style="color:#475569;font-size:10px;margin-top:6px;"><span style="color:#22c55e;">Green</span> = CPM up vs prior month &nbsp;·&nbsp; <span style="color:#ef4444;">Red</span> = down &nbsp;·&nbsp; <span style="color:#f59e0b;">Amber</span> = flat (±0.5%)</div>
  </div>`
}

// ── Agent metrics section (Neon data shape) ───────────────────────────────────
// stats:      { totalRuns, autonomousRuns, hitlRuns, totalInputTokens, totalOutputTokens }
// runHistory: [{ run_date, source, outcome, input_tokens, output_tokens, data_points_found }] (from Neon)
// thisRun:    { date, outcome, inputTokens, outputTokens, dataPointsFound }
export function buildEmailMetricsSection(stats, runHistory, thisRun) {
  const hitlRate     = stats.totalRuns > 0 ? (stats.hitlRuns     / stats.totalRuns * 100).toFixed(1) : "0.0"
  const autonomyRate = stats.totalRuns > 0 ? (stats.autonomousRuns / stats.totalRuns * 100).toFixed(1) : "0.0"

  const totalTok      = stats.totalInputTokens + stats.totalOutputTokens
  const thisTok       = thisRun.inputTokens + thisRun.outputTokens
  const humanSavedMin = stats.autonomousRuns * 15

  const outcomeIcon  = thisRun.outcome === "autonomous" ? "✅" : thisRun.outcome === "hitl" ? "⚠️" : "❌"
  const outcomeLabel = thisRun.outcome === "autonomous" ? "Autonomous — no human needed"
                     : thisRun.outcome === "hitl"       ? "HITL triggered — emailed for help"
                     : "Error"

  const roiLabel = stats.autonomousRuns === 0 ? "No autonomous runs yet"
    : `~${humanSavedMin} min analyst time saved (${stats.autonomousRuns} runs × 15 min)`

  const sparkRows = [...runHistory].slice(0, 10).map(r => {
    const color = r.outcome === "autonomous" ? "#22c55e" : r.outcome === "hitl" ? "#f59e0b" : "#ef4444"
    const icon  = r.outcome === "autonomous" ? "✅" : r.outcome === "hitl" ? "⚠️" : "❌"
    const src   = r.source ? `<span style="color:#334155;font-size:9px;">[${r.source}]</span> ` : ""
    const date  = typeof r.run_date === "string" ? r.run_date.slice(0, 10) : new Date(r.run_date).toISOString().slice(0, 10)
    return `
    <tr>
      <td style="padding:4px 8px;color:#64748b;font-size:10px;white-space:nowrap;">${date}</td>
      <td style="padding:4px 8px;color:${color};font-size:10px;">${icon} ${r.outcome} ${src}</td>
      <td style="padding:4px 8px;text-align:right;color:#94a3b8;font-size:10px;">${(r.input_tokens + r.output_tokens).toLocaleString()} tok</td>
      <td style="padding:4px 8px;text-align:right;color:#94a3b8;font-size:10px;">${r.data_points_found} pts</td>
    </tr>`
  }).join("")

  return `
  <div style="background:#0f172a;border:1px solid #1e293b;border-radius:8px;padding:18px;margin-bottom:20px;">
    <div style="color:#f1f5f9;font-size:13px;font-weight:700;margin-bottom:14px;">🤖 Agent Metrics Dashboard <span style="color:#334155;font-size:10px;font-weight:400;">· Powered by Neon Postgres</span></div>

    <div style="background:#1e293b;border-radius:6px;padding:12px;margin-bottom:12px;">
      <div style="color:#64748b;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">This Run — ${thisRun.date}</div>
      <div style="display:flex;gap:16px;flex-wrap:wrap;">
        <div><div style="color:#94a3b8;font-size:10px;">Outcome</div><div style="color:#f1f5f9;font-size:13px;font-weight:600;">${outcomeIcon} ${outcomeLabel}</div></div>
        <div><div style="color:#94a3b8;font-size:10px;">Tokens Used</div><div style="color:#60a5fa;font-size:13px;font-weight:600;">${thisTok.toLocaleString()}</div></div>
        <div><div style="color:#94a3b8;font-size:10px;">Data Points Found</div><div style="color:#f1f5f9;font-size:13px;font-weight:600;">${thisRun.dataPointsFound}</div></div>
      </div>
    </div>

    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:12px;">
      <tr>
        <td style="padding:8px;background:#1e293b;border-radius:6px;text-align:center;width:25%;">
          <div style="color:#64748b;font-size:10px;text-transform:uppercase;">Total Runs</div>
          <div style="color:#f1f5f9;font-size:20px;font-weight:700;">${stats.totalRuns}</div>
        </td>
        <td style="width:4px;"></td>
        <td style="padding:8px;background:#052e16;border-radius:6px;text-align:center;width:25%;">
          <div style="color:#64748b;font-size:10px;text-transform:uppercase;">Autonomous</div>
          <div style="color:#22c55e;font-size:20px;font-weight:700;">${autonomyRate}%</div>
          <div style="color:#4ade80;font-size:10px;">${stats.autonomousRuns} runs</div>
        </td>
        <td style="width:4px;"></td>
        <td style="padding:8px;background:#1e293b;border-radius:6px;text-align:center;width:25%;">
          <div style="color:#64748b;font-size:10px;text-transform:uppercase;">HITL Rate</div>
          <div style="color:#f59e0b;font-size:20px;font-weight:700;">${hitlRate}%</div>
          <div style="color:#fbbf24;font-size:10px;">${stats.hitlRuns} runs</div>
        </td>
        <td style="width:4px;"></td>
        <td style="padding:8px;background:#1e293b;border-radius:6px;text-align:center;width:25%;">
          <div style="color:#64748b;font-size:10px;text-transform:uppercase;">Total Tokens</div>
          <div style="color:#60a5fa;font-size:20px;font-weight:700;">${(totalTok / 1000).toFixed(1)}k</div>
          <div style="color:#93c5fd;font-size:10px;">${stats.totalInputTokens.toLocaleString()} in / ${stats.totalOutputTokens.toLocaleString()} out</div>
        </td>
      </tr>
    </table>

    <div style="background:#1e293b;border-radius:6px;padding:10px 12px;margin-bottom:12px;">
      <span style="color:#64748b;font-size:10px;text-transform:uppercase;font-weight:700;">Estimated Time Saved&nbsp;&nbsp;</span>
      <span style="color:#a3e635;font-size:12px;font-weight:600;">${roiLabel}</span>
      <span style="color:#475569;font-size:10px;">&nbsp;·&nbsp;check token costs at <a href="https://console.anthropic.com" style="color:#60a5fa;">console.anthropic.com</a></span>
    </div>

    ${sparkRows ? `
    <div style="color:#475569;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Recent Runs (Vercel + Guild)</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#1e293b;border-radius:6px;overflow:hidden;">
      <thead><tr style="background:#0f172a;">
        <th style="padding:4px 8px;text-align:left;color:#334155;font-size:9px;text-transform:uppercase;">Date</th>
        <th style="padding:4px 8px;text-align:left;color:#334155;font-size:9px;text-transform:uppercase;">Outcome</th>
        <th style="padding:4px 8px;text-align:right;color:#334155;font-size:9px;text-transform:uppercase;">Tokens</th>
        <th style="padding:4px 8px;text-align:right;color:#334155;font-size:9px;text-transform:uppercase;">Data Pts</th>
      </tr></thead>
      <tbody>${sparkRows}</tbody>
    </table>` : ""}
  </div>`
}

// ── Main email report ─────────────────────────────────────────────────────────
export function buildHtmlReport(rows, webFindings, aiInsights, verifiedNewData, runDate, metricsSection, hasAnthropicKey) {
  const enriched = computeChanges(rows)

  const latestByChannel = {}
  for (const r of enriched) {
    const cur = latestByChannel[r.channel]
    if (!cur || r.period_sort > cur.period_sort) latestByChannel[r.channel] = r
  }

  const channelCards = CHANNELS.map(({ key, label }) => {
    const r = latestByChannel[key]
    if (!r) return ""
    return `
    <div style="background:#1e293b;border-radius:8px;padding:16px;margin-bottom:10px;">
      <div style="color:#94a3b8;font-size:11px;text-transform:uppercase;letter-spacing:1px;">${label}</div>
      <div style="display:flex;align-items:baseline;gap:8px;margin-top:4px;">
        <span style="color:#f1f5f9;font-size:26px;font-weight:700;">$${r.avg_cpm.toFixed(2)}</span>
        <span style="color:#94a3b8;font-size:12px;">CPM</span>
        <span style="font-size:13px;">${fmtPct(r.mom)}&nbsp;MoM</span>
        <span style="font-size:12px;color:#64748b;">&nbsp;${fmtPct(r.yoy)}&nbsp;YoY</span>
      </div>
      <div style="color:#64748b;font-size:11px;margin-top:3px;">${MONTH_NAMES[r.month]} ${r.year}</div>
    </div>`
  }).join("")

  const newDataSection = verifiedNewData.length > 0 ? `
  <div style="background:#052e16;border:1px solid #166534;border-radius:8px;padding:14px;margin-bottom:20px;">
    <div style="color:#4ade80;font-size:13px;font-weight:700;margin-bottom:6px;">✅ New Verified Data Added This Run</div>
    ${verifiedNewData.map(r => `
    <div style="color:#86efac;font-size:12px;padding:2px 0;">
      ${CHANNEL_LABELS[r.channel] ?? r.channel}: <strong>$${r.cpm}</strong> CPM — ${MONTH_NAMES[r.month]} ${r.year}
      <span style="color:#4ade80;font-size:11px;"> · ${(r.sources ?? []).join(", ")}</span>
    </div>`).join("")}
  </div>` : ""

  const aiSection = aiInsights ? `
  <div style="background:#0f172a;border-radius:8px;padding:18px;margin-bottom:20px;">
    <div style="color:#f1f5f9;font-size:14px;font-weight:700;margin-bottom:10px;">📊 AI Analysis</div>
    <p style="color:#cbd5e1;font-size:13px;line-height:1.6;margin:0 0 14px;">${aiInsights.summary ?? ""}</p>

    ${(aiInsights.insights ?? []).length > 0 ? `<div style="color:#93c5fd;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Key Insights</div>` : ""}
    ${(aiInsights.insights ?? []).map(i => {
      const srcLinks = (i.sources ?? [])
        .map(s => `<a href="${s.url}" style="color:#60a5fa;font-size:10px;text-decoration:none;">${s.title ?? s.url}</a>`)
        .join(" &nbsp;·&nbsp; ")
      return `
    <div style="border-left:3px solid #3b82f6;padding-left:10px;margin-bottom:12px;">
      <div style="color:#93c5fd;font-weight:600;font-size:12px;">${i.title}</div>
      <div style="color:#94a3b8;font-size:12px;margin-top:3px;line-height:1.5;">${i.body}</div>
      ${srcLinks ? `<div style="margin-top:5px;">🔗 ${srcLinks}</div>` : ""}
    </div>`
    }).join("")}

    ${(aiInsights.recommendations ?? []).length > 0 ? `
    <div style="color:#fbbf24;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-top:16px;margin-bottom:8px;">💡 Considerations</div>
    ${(aiInsights.recommendations ?? []).map(r => {
      const urgencyColor = r.urgency === "immediate" ? "#ef4444" : r.urgency === "this-quarter" ? "#f59e0b" : "#64748b"
      const urgencyLabel = r.urgency === "immediate" ? "Immediate" : r.urgency === "this-quarter" ? "This Quarter" : "Monitor"
      return `
    <div style="border-left:3px solid #f59e0b;padding-left:10px;margin-bottom:12px;">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <div style="color:#fcd34d;font-weight:600;font-size:12px;">${r.title}</div>
        <span style="background:${urgencyColor};color:#fff;font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;text-transform:uppercase;">${urgencyLabel}</span>
      </div>
      <div style="color:#94a3b8;font-size:12px;margin-top:3px;line-height:1.5;">${r.body}</div>
    </div>`
    }).join("")}` : ""}

    ${(aiInsights.next_steps ?? []).length > 0 ? `
    <div style="color:#34d399;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-top:16px;margin-bottom:8px;">✅ Next Steps</div>
    <ol style="margin:0;padding-left:18px;">
      ${(aiInsights.next_steps ?? []).map(step => `
      <li style="color:#94a3b8;font-size:12px;line-height:1.6;margin-bottom:6px;">${step}</li>`).join("")}
    </ol>` : ""}
  </div>` : ""

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<div style="max-width:680px;margin:0 auto;padding:24px;">

  <div style="border-bottom:1px solid #1e293b;padding-bottom:14px;margin-bottom:20px;">
    <div style="color:#3b82f6;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:2px;">CPM Benchmark Report</div>
    <div style="color:#f1f5f9;font-size:22px;font-weight:700;margin-top:4px;">Media CPM Month over Month</div>
    <div style="color:#64748b;font-size:12px;margin-top:3px;">2023–2026 · Generated ${runDate} · <span style="color:#4ade80;">Vercel Serverless</span></div>
  </div>

  ${newDataSection}

  <div style="color:#f1f5f9;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;">Latest CPM by Channel</div>
  ${channelCards}

  ${aiSection}
  ${buildEmailTrendChart(enriched)}
  ${buildEmailTrendTable(enriched)}
  ${metricsSection}

  <div style="border-top:1px solid #1e293b;margin-top:16px;padding-top:14px;color:#475569;font-size:11px;text-align:center;">
    CPM Report Agent · Vercel + Neon · Brave Search${hasAnthropicKey ? " + Claude AI" : ""}
    <br>Never invents numbers — sources: Adsposure, eMarketer, WordStream, IAB
  </div>
</div>
</body>
</html>`
}

// ── Interactive dashboard (attached to email) ─────────────────────────────────
// Full interactive dashboard: sidebar filters, Chart.js trend chart, sortable
// table — PLUS the preview-style AI analysis panel (insights, recommendations,
// next steps) rendered above the chart when aiInsights data is available.
export function buildInteractiveDashboard(rows, runDate, aiInsights = null) {
  const enriched = computeChanges(rows)
  const dataJson = JSON.stringify(enriched.map(r => ({
    year: r.year, month: r.month, channel: r.channel,
    label: CHANNEL_LABELS[r.channel] ?? r.channel,
    cpm: r.avg_cpm, mom: r.mom, yoy: r.yoy,
    period: `${MONTH_NAMES[r.month]} ${r.year}`
  })))

  const channelCheckboxes = CHANNELS.map(c =>
    `<label class="cb-label"><input type="checkbox" class="ch-cb" value="${c.key}" checked><span>${c.label}</span></label>`
  ).join("")

  const yearCheckboxes = [2023, 2024, 2025, 2026].map(y =>
    `<label class="cb-label"><input type="checkbox" class="yr-cb" value="${y}" checked><span>${y}</span></label>`
  ).join("")

  const monthCheckboxes = Object.entries(MONTH_NAMES).map(([m, name]) =>
    `<label class="cb-label"><input type="checkbox" class="mo-cb" value="${m}" checked><span>${name.slice(0,3)}</span></label>`
  ).join("")

  // AI insights panel — preview-style with dark border, source links, urgency badges
  const insightsHtml = aiInsights ? `
  <div class="ai-panel">
    <div class="ai-title">AI Analysis</div>
    <p class="ai-summary">${aiInsights.summary ?? ""}</p>

    ${(aiInsights.insights ?? []).length > 0 ? `<div class="sub-label sl-blue">Key Insights</div>` : ""}
    ${(aiInsights.insights ?? []).map(i => {
      const srcLinks = (i.sources ?? [])
        .map(s => `<a href="${s.url}" target="_blank" rel="noopener" class="src-link">${s.title ?? s.url}</a>`)
        .join(" &nbsp;·&nbsp; ")
      return `
    <div class="insight-item">
      <div class="insight-ttl">${i.title}</div>
      <div class="insight-body">${i.body}</div>
      ${srcLinks ? `<div class="insight-src">🔗 ${srcLinks}</div>` : ""}
    </div>`
    }).join("")}

    ${(aiInsights.recommendations ?? []).length > 0 ? `
    <div class="sub-label sl-amber" style="margin-top:16px">Considerations</div>
    ${(aiInsights.recommendations ?? []).map(r => {
      const urgencyBg    = r.urgency === "immediate" ? "#ef4444" : r.urgency === "this-quarter" ? "#f59e0b" : "#475569"
      const urgencyLabel = r.urgency === "immediate" ? "Immediate" : r.urgency === "this-quarter" ? "This Quarter" : "Monitor"
      return `
    <div class="rec-item">
      <div class="rec-hdr">
        <div class="rec-ttl">${r.title}</div>
        <span class="badge" style="background:${urgencyBg}">${urgencyLabel}</span>
      </div>
      <div class="rec-body">${r.body}</div>
    </div>`
    }).join("")}` : ""}

    ${(aiInsights.next_steps ?? []).length > 0 ? `
    <div class="sub-label sl-green" style="margin-top:16px">Next Steps</div>
    <ol class="next-ol">
      ${(aiInsights.next_steps ?? []).map(step => `<li>${step}</li>`).join("")}
    </ol>` : ""}
  </div>` : ""

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CPM Dashboard — Media CPM Month over Month 2023–2026</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0f172a;color:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh}
  .header{background:#1e293b;padding:20px 28px;border-bottom:1px solid #334155}
  .header h1{font-size:22px;font-weight:700;color:#f1f5f9}
  .header p{font-size:13px;color:#64748b;margin-top:4px}
  .layout{display:flex;min-height:calc(100vh - 74px)}
  .sidebar{width:220px;flex-shrink:0;background:#1e293b;padding:20px;border-right:1px solid #334155}
  .main{flex:1;padding:24px;overflow-x:auto}
  .filter-section{margin-bottom:20px}
  .filter-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#64748b;margin-bottom:8px}
  .cb-label{display:flex;align-items:center;gap:6px;font-size:13px;color:#cbd5e1;padding:3px 0;cursor:pointer;user-select:none}
  .cb-label input{accent-color:#3b82f6;width:14px;height:14px;cursor:pointer}
  .btn{background:#3b82f6;color:#fff;border:none;border-radius:6px;padding:8px 14px;font-size:12px;font-weight:600;cursor:pointer;width:100%;margin-bottom:6px}
  .btn-outline{background:transparent;border:1px solid #334155;color:#94a3b8}
  .stats{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:20px}
  .stat-card{background:#1e293b;border-radius:8px;padding:14px 16px;min-width:160px;flex:1}
  .stat-ch{font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:1px}
  .stat-cpm{font-size:24px;font-weight:700;color:#f1f5f9;margin-top:3px}
  .stat-chg{font-size:12px;margin-top:2px}
  .stat-period{font-size:11px;color:#475569;margin-top:2px}
  table{width:100%;border-collapse:collapse;background:#1e293b;border-radius:8px;overflow:hidden;font-size:13px}
  th{background:#0f172a;padding:9px 12px;text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#475569}
  th.right{text-align:right}
  td{padding:8px 12px;border-bottom:1px solid #0f172a;color:#cbd5e1}
  td.right{text-align:right}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:#243147}
  .up{color:#22c55e;font-weight:600}.dn{color:#ef4444;font-weight:600}.fl{color:#f59e0b;font-weight:600}.na{color:#475569}
  .tag{display:inline-block;background:#1e3a5f;color:#60a5fa;border-radius:4px;padding:2px 6px;font-size:11px}
  #count{font-size:12px;color:#64748b;margin-bottom:8px}
  .chart-section{background:#1e293b;border-radius:10px;padding:20px;margin-bottom:20px}
  .chart-title{font-size:13px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;margin-bottom:14px}
  .chart-wrap{position:relative;height:280px}
  /* AI analysis panel — matches preview exactly */
  .ai-panel{background:#0a0f1e;border:1px solid #1e3a5f;border-radius:8px;padding:18px;margin-bottom:20px}
  .ai-title{color:#f1f5f9;font-size:14px;font-weight:700;margin-bottom:10px}
  .ai-summary{color:#cbd5e1;font-size:13px;line-height:1.6;margin:0 0 16px}
  .sub-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px}
  .sl-blue{color:#93c5fd}.sl-amber{color:#fbbf24}.sl-green{color:#34d399}
  .insight-item{border-left:3px solid #3b82f6;padding-left:10px;margin-bottom:12px}
  .insight-ttl{color:#93c5fd;font-weight:600;font-size:12px}
  .insight-body{color:#94a3b8;font-size:12px;margin-top:3px;line-height:1.5}
  .insight-src{margin-top:5px;font-size:10px;color:#60a5fa}
  .src-link{color:#60a5fa;text-decoration:none}
  .src-link:hover{text-decoration:underline}
  .rec-item{border-left:3px solid #f59e0b;padding-left:10px;margin-bottom:12px}
  .rec-hdr{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .rec-ttl{color:#fcd34d;font-weight:600;font-size:12px}
  .badge{font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;text-transform:uppercase;color:#fff}
  .rec-body{color:#94a3b8;font-size:12px;margin-top:3px;line-height:1.5}
  .next-ol{margin:0;padding-left:18px}
  .next-ol li{color:#94a3b8;font-size:12px;line-height:1.6;margin-bottom:6px}
</style>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js"></script>
</head>
<body>
<div class="header">
  <h1>📊 Media CPM Month over Month</h1>
  <p>2023–2026 · Interactive Dashboard · ${runDate} · <span style="color:#4ade80;">Vercel + Neon</span></p>
</div>
<div class="layout">
  <div class="sidebar">
    <div class="filter-section"><div class="filter-title">Year</div>${yearCheckboxes}</div>
    <div class="filter-section"><div class="filter-title">Month</div>${monthCheckboxes}</div>
    <div class="filter-section"><div class="filter-title">Channel</div>${channelCheckboxes}</div>
    <button class="btn" onclick="selectAll()">Select All</button>
    <button class="btn btn-outline" onclick="clearAll()">Clear All</button>
    <div style="margin-top:16px;font-size:11px;color:#475569">Click column headers to sort</div>
  </div>
  <div class="main">
    ${insightsHtml}
    <div class="chart-section">
      <div class="chart-title">CPM Trends Over Time</div>
      <div class="chart-wrap"><canvas id="cpmChart"></canvas></div>
    </div>
    <div class="stats" id="stats"></div>
    <div id="count"></div>
    <table>
      <thead>
        <tr>
          <th onclick="sortBy('year','month')" style="cursor:pointer">Period</th>
          <th onclick="sortBy('channel')" style="cursor:pointer">Channel</th>
          <th class="right" onclick="sortBy('cpm')" style="cursor:pointer">CPM</th>
          <th class="right" onclick="sortBy('mom')" style="cursor:pointer">MoM Δ</th>
          <th class="right" onclick="sortBy('yoy')" style="cursor:pointer">YoY Δ</th>
        </tr>
      </thead>
      <tbody id="tbody"></tbody>
    </table>
  </div>
</div>
<script>
const ALL = ${dataJson};
const MONTHS = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const COLORS = { paid_social:'#3b82f6', paid_search:'#22c55e', programmatic_display:'#f59e0b', video_ctv:'#a855f7', streaming_audio:'#ec4899' };
let sortKey='year', sortKey2='month', sortDir=-1, cpmChart=null;

function pctHtml(v) {
  if (v==null) return '<span class="na">—</span>';
  const s=v>=0?'+':'', a=v>0.5?'↑':v<-0.5?'↓':'→', c=v>0.5?'up':v<-0.5?'dn':'fl';
  return \`<span class="\${c}">\${a} \${s}\${v.toFixed(1)}%</span>\`;
}
function getFilters() {
  const yrs=[...document.querySelectorAll('.yr-cb:checked')].map(e=>+e.value);
  const mos=[...document.querySelectorAll('.mo-cb:checked')].map(e=>+e.value);
  const chs=[...document.querySelectorAll('.ch-cb:checked')].map(e=>e.value);
  return {yrs,mos,chs};
}
function render() {
  const {yrs,mos,chs}=getFilters();
  let data=ALL.filter(r=>yrs.includes(r.year)&&mos.includes(r.month)&&chs.includes(r.channel));
  if(typeof updateChart==='function') updateChart(data);
  data.sort((a,b)=>{
    let va=a[sortKey],vb=b[sortKey];
    if(va==null)va=sortDir>0?Infinity:-Infinity;
    if(vb==null)vb=sortDir>0?Infinity:-Infinity;
    const p=(va>vb?1:va<vb?-1:0)*sortDir;
    if(p!==0)return p;
    if(sortKey2){const va2=a[sortKey2],vb2=b[sortKey2];return(va2>vb2?1:va2<vb2?-1:0)*sortDir;}
    return 0;
  });
  const latest={};
  for(const r of data){const c=latest[r.channel];if(!c||r.year*100+r.month>c.year*100+c.month)latest[r.channel]=r;}
  document.getElementById('stats').innerHTML=Object.values(latest).map(r=>\`
    <div class="stat-card"><div class="stat-ch">\${r.label}</div><div class="stat-cpm">$\${r.cpm.toFixed(2)}</div>
    <div class="stat-chg">\${pctHtml(r.mom)} MoM &nbsp;\${pctHtml(r.yoy)} YoY</div><div class="stat-period">\${r.period}</div></div>
  \`).join('');
  document.getElementById('count').textContent=\`Showing \${data.length} data points\`;
  document.getElementById('tbody').innerHTML=data.map(r=>\`
    <tr><td>\${r.period}</td><td><span class="tag">\${r.label}</span></td>
    <td class="right" style="font-weight:600;color:#60a5fa;">$\${r.cpm.toFixed(2)}</td>
    <td class="right">\${pctHtml(r.mom)}</td><td class="right">\${pctHtml(r.yoy)}</td></tr>
  \`).join('')||'<tr><td colspan="5" style="text-align:center;color:#475569;padding:20px;">No data matches filters</td></tr>';
}
function sortBy(k,k2){if(sortKey===k)sortDir*=-1;else{sortKey=k;sortKey2=k2??null;sortDir=k==='year'?-1:1;}render();}
function selectAll(){document.querySelectorAll('.yr-cb,.mo-cb,.ch-cb').forEach(e=>e.checked=true);render();}
function clearAll(){document.querySelectorAll('.yr-cb,.mo-cb,.ch-cb').forEach(e=>e.checked=false);render();}
document.querySelectorAll('.yr-cb,.mo-cb,.ch-cb').forEach(e=>e.addEventListener('change',render));
function buildChartData(data) {
  const periods=[...new Set(data.map(r=>r.year*100+r.month))].sort((a,b)=>a-b);
  const labels=periods.map(ps=>\`\${MONTHS[ps%100]} \${Math.floor(ps/100)}\`);
  const chs=[...document.querySelectorAll('.ch-cb:checked')].map(e=>e.value);
  const datasets=chs.map(ch=>{
    const byP={};for(const r of data)if(r.channel===ch)byP[r.year*100+r.month]=r.cpm;
    const lbl=data.find(r=>r.channel===ch)?.label??ch;
    return{label:lbl,data:periods.map(ps=>byP[ps]??null),borderColor:COLORS[ch]??'#94a3b8',
      backgroundColor:(COLORS[ch]??'#94a3b8')+'22',tension:0.3,spanGaps:true,fill:false,pointRadius:3,pointHoverRadius:6};
  });
  return{labels,datasets};
}
function updateChart(data) {
  const{labels,datasets}=buildChartData(data);
  const ctx=document.getElementById('cpmChart').getContext('2d');
  if(cpmChart){cpmChart.data.labels=labels;cpmChart.data.datasets=datasets;cpmChart.update();return;}
  cpmChart=new Chart(ctx,{type:'line',data:{labels,datasets},options:{
    responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},
    plugins:{legend:{labels:{color:'#94a3b8',font:{size:11},boxWidth:12,padding:14}},
      tooltip:{backgroundColor:'#1e293b',titleColor:'#f1f5f9',bodyColor:'#cbd5e1',
        borderColor:'#334155',borderWidth:1,callbacks:{label:ctx=>\` \${ctx.dataset.label}: $\${ctx.parsed.y?.toFixed(2)??'—'} CPM\`}}},
    scales:{x:{ticks:{color:'#64748b',font:{size:10},maxRotation:45},grid:{color:'#1e293b'}},
      y:{ticks:{color:'#64748b',font:{size:10},callback:v=>\`$\${v.toFixed(0)}\`},grid:{color:'#1e293b'},
        title:{display:true,text:'CPM (USD)',color:'#475569',font:{size:11}}}}
  }});
}
render();
</script>
</body>
</html>`
}
