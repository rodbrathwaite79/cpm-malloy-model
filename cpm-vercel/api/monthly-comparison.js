/**
 * /api/monthly-comparison — Monthly CPM variance analysis (Vercel serverless cron)
 *
 * Triggered: 1st of each month at 8am ET (0 13 1 * *)
 *
 * What it does:
 *   1. Queries Neon for the two most recent complete months of CPM data
 *   2. Calculates MoM variance per channel
 *   3. Flags any channel with >10% variance
 *   4. For each flagged channel: searches Brave for market reasons
 *   5. Rates source confidence — only includes findings with ≥80% confidence
 *   6. Emails a variance report (or "all stable" notice if nothing triggered)
 *
 * No hallucination policy: if confidence < 80%, the reason field is omitted
 * and the email states "No verified market explanation found."
 *
 * Manual test:
 *   curl -X GET "https://cpm-vercel.vercel.app/api/monthly-comparison" \
 *     -H "Authorization: Bearer YOUR_CRON_SECRET"
 *
 * Dry run with specific month (for testing):
 *   curl "...?month=11&year=2025" -H "Authorization: Bearer ..."
 */

import https from "https"
import http  from "http"
import { URL } from "url"
import { initSchema, queryBenchmarks } from "../lib/database.js"
import { CHANNEL_LABELS, MONTH_NAMES } from "../lib/report-html.js"

// ── Constants ─────────────────────────────────────────────────────────────────
const VARIANCE_THRESHOLD   = 0.10  // 10% MoM change triggers research
const CONFIDENCE_THRESHOLD = 0.80  // 80% source confidence required to report a cause

const CREDIBLE_SOURCES = [
  "emarketer.com", "insiderintelligence.com", "adsposure.com", "wordstream.com",
  "statista.com", "iab.com", "comscore.com", "mediaradar.com", "adweek.com",
  "searchengineland.com", "semrush.com", "hubspot.com", "marketingdive.com",
  "digiday.com", "wsj.com", "reuters.com", "bloomberg.com",
]

let schemaReady = false

// ── HTTP helper ───────────────────────────────────────────────────────────────
function request(method, url, headers = {}, body = null, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url)
    const lib     = parsed.protocol === "https:" ? https : http
    const bodyBuf = body ? Buffer.from(typeof body === "string" ? body : JSON.stringify(body)) : null
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method,
      headers:  {
        "User-Agent": "cpm-report-agent/2.0-vercel",
        ...headers,
        ...(bodyBuf ? { "Content-Length": bodyBuf.length } : {}),
      },
    }
    const req = lib.request(options, res2 => {
      const chunks = []
      res2.on("data", c => chunks.push(c))
      res2.on("end",  () => resolve({
        status:      res2.statusCode,
        body:        Buffer.concat(chunks).toString("utf-8"),
        contentType: res2.headers["content-type"] ?? "",
      }))
    })
    req.on("error", reject)
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timeout after ${timeoutMs}ms`)))
    if (bodyBuf) req.write(bodyBuf)
    req.end()
  })
}
const get  = (url, h)    => request("GET",  url, h)
const post = (url, h, b) => request("POST", url, h, b)

// ── Config ────────────────────────────────────────────────────────────────────
function cfg() {
  return {
    braveApiKey:  process.env.BRAVE_API_KEY  ?? "",
    resendApiKey: process.env.RESEND_API_KEY ?? "",
    emailTo:      process.env.EMAIL_TO       ?? "rod.brathwaite@gmail.com",
  }
}

// ── Brave search ──────────────────────────────────────────────────────────────
async function braveSearch(query, count = 5) {
  const { braveApiKey } = cfg()
  if (!braveApiKey) return []
  try {
    const res = await get(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`,
      { Accept: "application/json", "X-Subscription-Token": braveApiKey }
    )
    if (res.status !== 200) return []
    return JSON.parse(res.body)?.web?.results ?? []
  } catch { return [] }
}

// ── Confidence rating ─────────────────────────────────────────────────────────
/**
 * Rates how confident we are in a research finding based on source credibility
 * and corroboration count. Returns 0.0–1.0.
 *
 * Thresholds:
 *   ≥3 credible sources → 0.92
 *   2  credible sources → 0.86
 *   1  credible source  → 0.74  (below CONFIDENCE_THRESHOLD — not reported)
 *   0  credible, ≥3 any → 0.55  (not reported)
 *   otherwise           → 0.35  (not reported)
 */
function rateConfidence(results) {
  const credibleCount = results.filter(r =>
    CREDIBLE_SOURCES.some(s => (r.url ?? "").includes(s)) && (r.excerpt ?? "").length > 40
  ).length
  if (credibleCount >= 3) return 0.92
  if (credibleCount === 2) return 0.86
  if (credibleCount === 1) return 0.74
  if (results.length >= 3) return 0.55
  return 0.35
}

// ── Variance research ─────────────────────────────────────────────────────────
/**
 * Searches for market explanations for a channel's CPM variance.
 * Returns { confidence, summary, sources } or null if confidence < threshold.
 *
 * Three targeted queries per channel — we use the UNION of results to rate confidence.
 * We never invent a reason; if sources don't support it, we return null.
 */
async function researchVariance(label, curMonth, curYear, directionPct) {
  const monthName  = MONTH_NAMES[curMonth]
  const prevMonth  = curMonth === 1 ? 12 : curMonth - 1
  const prevYear   = curMonth === 1 ? curYear - 1 : curYear
  const prevName   = MONTH_NAMES[prevMonth]
  const dirWord    = directionPct > 0 ? "increase spike" : "drop decline"

  const queries = [
    `"${label}" CPM ${dirWord} ${monthName} ${curYear} advertising market`,
    `digital advertising ${monthName} ${curYear} ${label.toLowerCase()} CPM rates trend`,
    `${label.toLowerCase()} ad market ${prevName} ${monthName} ${curYear} budget spend`,
  ]

  const allResults = []
  const seenUrls   = new Set()
  for (const q of queries) {
    const results = await braveSearch(q, 5)
    for (const r of results) {
      if (!seenUrls.has(r.url)) {
        seenUrls.add(r.url)
        allResults.push(r)
      }
    }
  }

  const confidence = rateConfidence(allResults)
  if (confidence < CONFIDENCE_THRESHOLD) return null

  const credibleSources = allResults
    .filter(r => CREDIBLE_SOURCES.some(s => (r.url ?? "").includes(s)))
    .slice(0, 3)
    .map(r => ({ title: r.title ?? "", url: r.url ?? "", excerpt: (r.description ?? "").slice(0, 200) }))

  return { confidence, sources: credibleSources }
}

// ── Email ─────────────────────────────────────────────────────────────────────
async function sendEmail(subject, html) {
  const { resendApiKey, emailTo } = cfg()
  if (!resendApiKey) { console.warn("RESEND_API_KEY not set — skipping email"); return }
  const res = await post(
    "https://api.resend.com/emails",
    { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
    { from: "CPM Report Agent <onboarding@resend.dev>", to: [emailTo], subject, html }
  )
  if (res.status >= 200 && res.status < 300) {
    console.log(`✅ Email sent (Resend ID: ${JSON.parse(res.body).id})`)
  } else {
    console.warn(`❌ Resend ${res.status}:`, res.body.slice(0, 200))
  }
}

// ── HTML report builder ───────────────────────────────────────────────────────
function buildEmailHtml(curMonth, curYear, prevMonth, prevYear, variances, flagged) {
  const fmt$ = v => `$${Number(v).toFixed(2)}`
  const fmtPct = v => (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%"
  const curName  = MONTH_NAMES[curMonth]
  const prevName = MONTH_NAMES[prevMonth]

  const flaggedRows = flagged.map(f => {
    const dir    = f.variancePct > 0 ? "▲" : "▼"
    const color  = f.variancePct > 0 ? "#e74c3c" : "#27ae60"
    const researchHtml = f.research
      ? `<div style="margin-top:10px;padding:10px;background:#f8f9fa;border-left:3px solid #3498db;border-radius:4px">
           <strong>Market context (confidence: ${Math.round(f.research.confidence * 100)}%):</strong><br>
           ${f.research.sources.map(s =>
             `<a href="${s.url}" style="color:#3498db">${s.title}</a><br>
              <span style="color:#666;font-size:12px">${s.excerpt}</span>`
           ).join("<br><br>")}
         </div>`
      : `<div style="margin-top:10px;padding:10px;background:#fff3cd;border-left:3px solid #ffc107;border-radius:4px">
           <strong>No verified market explanation found</strong> — variance detected but insufficient credible sources identified (confidence &lt;80%). Manual review recommended.
         </div>`

    return `
      <div style="border:1px solid #dee2e6;border-radius:8px;padding:16px;margin-bottom:16px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <strong style="font-size:16px">${f.label}</strong>
          <span style="color:${color};font-size:20px;font-weight:bold">${dir} ${fmtPct(f.variancePct)}</span>
        </div>
        <div style="color:#666;margin-top:4px">
          ${prevName}: ${fmt$(f.prevCpm)} → ${curName}: ${fmt$(f.curCpm)}
        </div>
        ${researchHtml}
      </div>`
  }).join("")

  const stableRows = variances.filter(v => !v.isSignificant).map(v =>
    `<tr>
       <td style="padding:8px 12px">${v.label}</td>
       <td style="padding:8px 12px;text-align:right">${fmt$(v.prevCpm)}</td>
       <td style="padding:8px 12px;text-align:right">${fmt$(v.curCpm)}</td>
       <td style="padding:8px 12px;text-align:right;color:#27ae60">${fmtPct(v.variancePct)}</td>
     </tr>`
  ).join("")

  const headline = flagged.length > 0
    ? `<span style="color:#e74c3c">⚠️ ${flagged.length} channel${flagged.length > 1 ? "s" : ""} with significant variance (>10%)</span>`
    : `<span style="color:#27ae60">✅ All channels within normal range</span>`

  return `
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"></head>
    <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:680px;margin:0 auto;padding:24px;color:#212529">
      <div style="background:linear-gradient(135deg,#1a1a2e,#16213e);color:white;padding:24px;border-radius:12px;margin-bottom:24px">
        <div style="font-size:12px;opacity:.7;margin-bottom:4px">CPM AGENT — MONTHLY COMPARISON</div>
        <h1 style="margin:0;font-size:22px">${curName} ${curYear} vs ${prevName} ${prevYear}</h1>
        <div style="margin-top:8px;font-size:15px">${headline}</div>
      </div>

      ${flagged.length > 0 ? `
      <h2 style="color:#e74c3c;border-bottom:2px solid #e74c3c;padding-bottom:8px">Significant Variances</h2>
      ${flaggedRows}
      ` : `
      <div style="background:#d4edda;border:1px solid #c3e6cb;border-radius:8px;padding:16px;margin-bottom:24px;color:#155724">
        <strong>No significant variances detected.</strong> All channels moved less than 10% month-over-month. No research required.
      </div>
      `}

      <h2 style="color:#495057;border-bottom:1px solid #dee2e6;padding-bottom:8px">Stable Channels</h2>
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr style="background:#f8f9fa">
            <th style="padding:8px 12px;text-align:left">Channel</th>
            <th style="padding:8px 12px;text-align:right">${prevName}</th>
            <th style="padding:8px 12px;text-align:right">${curName}</th>
            <th style="padding:8px 12px;text-align:right">Change</th>
          </tr>
        </thead>
        <tbody>${stableRows}</tbody>
      </table>

      <div style="margin-top:32px;padding-top:16px;border-top:1px solid #dee2e6;font-size:12px;color:#6c757d">
        CPM Agent · Automated variance analysis · Confidence threshold: 80% · Variance threshold: 10%<br>
        <em>Research findings sourced from: eMarketer, IAB, Digiday, AdWeek, MarketingDive, and other credible industry sources.</em>
      </div>
    </body>
    </html>`
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // Auth
  const cronSecret = process.env.CRON_SECRET
  const auth       = req.headers.authorization ?? ""
  if (cronSecret && auth !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: "Unauthorized" })
  }

  // Init DB
  if (!schemaReady) {
    try { await initSchema(); schemaReady = true }
    catch (e) { return res.status(500).json({ error: "DB init failed", detail: e.message }) }
  }

  // ── Determine comparison months ───────────────────────────────────────────
  // Runs on the 1st of the month — compares the month that just ended vs the one before it.
  // Query params ?month=11&year=2025 allow manual / dry-run testing.
  const now = new Date()
  const forceMonth = req.query?.month ? parseInt(req.query.month) : null
  const forceYear  = req.query?.year  ? parseInt(req.query.year)  : null

  const curMonth = forceMonth ?? (now.getMonth() === 0 ? 12 : now.getMonth())
  const curYear  = forceYear  ?? (now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear())
  const prevMonth = curMonth === 1 ? 12 : curMonth - 1
  const prevYear  = curMonth === 1 ? curYear - 1 : curYear

  console.log(`\nMonthly Comparison: ${MONTH_NAMES[curMonth]} ${curYear} vs ${MONTH_NAMES[prevMonth]} ${prevYear}`)

  // ── Query Neon ────────────────────────────────────────────────────────────
  const rows = await queryBenchmarks()

  // Index: "channel-year-month" → avg_cpm
  const index = {}
  for (const r of rows) {
    index[`${r.channel}-${r.year}-${r.month}`] = parseFloat(r.avg_cpm)
  }

  // ── Calculate variances ───────────────────────────────────────────────────
  console.log("\nCalculating variances…")
  const variances = []
  for (const [ch, label] of Object.entries(CHANNEL_LABELS)) {
    const curCpm  = index[`${ch}-${curYear}-${curMonth}`]
    const prevCpm = index[`${ch}-${prevYear}-${prevMonth}`]
    if (curCpm == null || prevCpm == null) {
      console.log(`  ⚠️  ${label}: missing data for one or both months — skipping`)
      continue
    }
    const variancePct  = (curCpm - prevCpm) / prevCpm
    const isSignificant = Math.abs(variancePct) > VARIANCE_THRESHOLD
    console.log(`  ${isSignificant ? "🔴" : "✅"} ${label}: ${(variancePct * 100).toFixed(1)}%`)
    variances.push({ channel: ch, label, curCpm, prevCpm, variancePct, isSignificant, research: null })
  }

  const flagged = variances.filter(v => v.isSignificant)
  console.log(`\n${flagged.length} channel(s) flagged for >10% variance`)

  // ── Research flagged channels ─────────────────────────────────────────────
  if (flagged.length > 0) {
    console.log("\nResearching variance causes via Brave Search…")
    for (const entry of flagged) {
      console.log(`  Searching: ${entry.label} (${(entry.variancePct * 100).toFixed(1)}%)…`)
      const research = await researchVariance(entry.label, curMonth, curYear, entry.variancePct)
      entry.research = research
      if (research) {
        console.log(`    ✅ Confidence: ${Math.round(research.confidence * 100)}% — ${research.sources.length} credible source(s)`)
      } else {
        console.log(`    ⚠️  Confidence below 80% — reason will NOT be reported`)
      }
    }
  }

  // ── Build and send email ──────────────────────────────────────────────────
  const subjectEmoji = flagged.length > 0 ? "⚠️" : "✅"
  const subject = `${subjectEmoji} CPM Monthly Comparison — ${MONTH_NAMES[curMonth]} ${curYear} vs ${MONTH_NAMES[prevMonth]} ${prevYear}`
  const html    = buildEmailHtml(curMonth, curYear, prevMonth, prevYear, variances, flagged)
  await sendEmail(subject, html)

  return res.status(200).json({
    ok:                true,
    period:            `${MONTH_NAMES[curMonth]} ${curYear} vs ${MONTH_NAMES[prevMonth]} ${prevYear}`,
    channelsAnalyzed:  variances.length,
    flagged:           flagged.length,
    varianceThreshold: "10%",
    confidenceThreshold: "80%",
    results: variances.map(v => ({
      channel:     v.label,
      prevCpm:     v.prevCpm,
      curCpm:      v.curCpm,
      variancePct: `${(v.variancePct * 100).toFixed(1)}%`,
      flagged:     v.isSignificant,
      research:    v.research ? {
        confidence: `${Math.round(v.research.confidence * 100)}%`,
        sources:    v.research.sources.length,
      } : null,
    })),
  })
}
