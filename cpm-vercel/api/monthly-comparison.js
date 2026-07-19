/**
 * /api/monthly-comparison — Monthly CPM variance analysis (Vercel serverless cron)
 *
 * Triggered: 1st of each month at 8am ET (0 13 1 * *)
 *
 * What it does:
 *   1. Queries Neon for the two most recent complete months of CPM data
 *   2. Calculates MoM variance per channel
 *   3. Flags any channel with >2.0% variance
 *   4. For each flagged channel: searches Brave, fetches page text, synthesizes
 *      a factual explanation via Claude Haiku grounded only in source material
 *   5. Rates source confidence — only reports explanation if ≥80% confidence
 *   6. Emails a variance report (or "all stable" notice if nothing triggered)
 *
 * No hallucination policy:
 *   - Claude Haiku is explicitly instructed: only use information from the provided
 *     sources. If sources don't explain the variance, say so explicitly.
 *   - If confidence < 80%, the explanation is suppressed entirely.
 *   - Sources are always cited alongside the explanation.
 *
 * Manual test:
 *   curl -X GET "https://cpm-vercel.vercel.app/api/monthly-comparison" \
 *     -H "Authorization: Bearer YOUR_CRON_SECRET"
 *
 * Dry run with specific month:
 *   curl "...?month=6&year=2026" -H "Authorization: Bearer ..."
 */

import https from "https"
import http  from "http"
import { URL } from "url"
import { initSchema, queryBenchmarks } from "../lib/database.js"
import { CHANNEL_LABELS, MONTH_NAMES } from "../lib/report-html.js"

// ── Constants ─────────────────────────────────────────────────────────────────
const VARIANCE_THRESHOLD   = 0.020 // 2.0% MoM change triggers research
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
    braveApiKey:  process.env.BRAVE_API_KEY   ?? "",
    resendApiKey: process.env.RESEND_API_KEY  ?? "",
    anthropicKey: process.env.ANTHROPIC_API_KEY ?? "",
    emailTo:      process.env.EMAIL_TO        ?? "rod.brathwaite@gmail.com",
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

// ── Page text fetcher ─────────────────────────────────────────────────────────
async function fetchPageText(url) {
  try {
    const res = await get(url, { "User-Agent": "Mozilla/5.0 (compatible; research-bot/1.0)" })
    if (res.status !== 200) return ""
    return res.body
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 2500)
  } catch { return "" }
}

// ── Confidence rating ─────────────────────────────────────────────────────────
/**
 * Rates confidence in research findings based on source credibility + corroboration.
 *   ≥3 credible sources → 0.92
 *   2  credible sources → 0.86
 *   1  credible source  → 0.74  (below threshold — explanation suppressed)
 *   0  credible, ≥3 any → 0.55  (below threshold)
 *   otherwise           → 0.35  (below threshold)
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

// ── Explanation synthesis via Claude Haiku ────────────────────────────────────
/**
 * Uses Claude Haiku to synthesize a 2-3 sentence factual explanation of the
 * variance, grounded only in the provided source text.
 *
 * Explicit no-hallucination instruction: Haiku is told to say "The reviewed
 * sources do not provide a specific explanation" if the content doesn't
 * directly support a conclusion.
 */
async function synthesizeExplanation(label, curMonth, curYear, variancePct, sources) {
  const { anthropicKey } = cfg()
  if (!anthropicKey) return null

  const monthName = MONTH_NAMES[curMonth]
  const prevMonth = curMonth === 1 ? 12 : curMonth - 1
  const prevYear  = curMonth === 1 ? curYear - 1 : curYear
  const prevName  = MONTH_NAMES[prevMonth]
  const direction = variancePct > 0 ? `increased ${(variancePct * 100).toFixed(1)}%` : `decreased ${Math.abs(variancePct * 100).toFixed(1)}%`

  const sourceContext = sources
    .map((s, i) => `SOURCE ${i + 1}: ${s.title}\nURL: ${s.url}\nEXCERPT: ${s.excerpt}\n${s.pageText ? "FULL TEXT: " + s.pageText.slice(0, 1200) : ""}`)
    .join("\n\n---\n\n")

  const prompt = `<context>
You are analyzing why ${label} advertising CPM ${direction} from ${prevName} ${prevYear} to ${monthName} ${curYear}.

Sources retrieved from Brave Search:

${sourceContext}
</context>

<rules>
- Write 2-3 sentences explaining the most likely reason for this CPM change.
- Base your explanation ONLY on information explicitly stated in the sources above.
- Do NOT speculate, infer, or add context not in the sources.
- Do NOT use phrases like "likely", "probably", or "may have" — only state what the sources say.
- If the sources do not directly explain this specific variance, respond with exactly: "The reviewed sources do not provide a specific explanation for this variance."
- Be direct and factual. Name specific forces: platform policies, demand shifts, inventory changes, seasonal effects — only if stated in sources.
</rules>

<output_format>
Plain text only. 2-3 sentences. No bullet points, no headers, no markdown.
</output_format>`

  try {
    const res = await post(
      "https://api.anthropic.com/v1/messages",
      {
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      {
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 300,
        messages:   [{ role: "user", content: prompt }],
      }
    )
    if (res.status === 200) {
      return JSON.parse(res.body).content?.[0]?.text?.trim() ?? null
    }
  } catch (e) {
    console.warn("Haiku synthesis failed:", e.message)
  }
  return null
}

// ── Variance research ─────────────────────────────────────────────────────────
/**
 * Searches Brave for market explanations for a channel's CPM variance.
 * Fetches page text from credible sources.
 * Synthesizes a grounded explanation via Claude Haiku.
 * Returns { confidence, explanation, sources } or null if confidence < threshold.
 */
async function researchVariance(label, curMonth, curYear, variancePct) {
  const monthName = MONTH_NAMES[curMonth]
  const prevMonth = curMonth === 1 ? 12 : curMonth - 1
  const prevYear  = curMonth === 1 ? curYear - 1 : curYear
  const prevName  = MONTH_NAMES[prevMonth]
  const dirWord   = variancePct > 0 ? "increase" : "decline"

  const queries = [
    `"${label}" CPM ${dirWord} ${monthName} ${curYear} advertising market`,
    `digital advertising ${monthName} ${curYear} ${label.toLowerCase()} CPM rates trend`,
    `${label.toLowerCase()} ad market ${prevName} ${monthName} ${curYear} CPM spend`,
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

  // Fetch page text from top credible sources for richer synthesis
  const credibleResults = allResults
    .filter(r => CREDIBLE_SOURCES.some(s => (r.url ?? "").includes(s)))
    .slice(0, 3)

  const sourcesWithText = await Promise.all(
    credibleResults.map(async r => ({
      title:    r.title    ?? "",
      url:      r.url      ?? "",
      excerpt:  (r.description ?? "").slice(0, 250),
      pageText: await fetchPageText(r.url),
    }))
  )

  // Synthesize a grounded explanation
  const explanation = await synthesizeExplanation(label, curMonth, curYear, variancePct, sourcesWithText)

  return {
    confidence,
    explanation,
    sources: sourcesWithText.map(s => ({ title: s.title, url: s.url, excerpt: s.excerpt })),
  }
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
  const fmt$   = v => `$${Number(v).toFixed(2)}`
  const fmtPct = v => (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%"
  const curName  = MONTH_NAMES[curMonth]
  const prevName = MONTH_NAMES[prevMonth]

  const flaggedRows = flagged.map(f => {
    const dir   = f.variancePct > 0 ? "▲" : "▼"
    const color = f.variancePct > 0 ? "#c0392b" : "#27ae60"

    let researchHtml
    if (f.research) {
      const { explanation, confidence, sources } = f.research
      const explanationHtml = explanation && !explanation.startsWith("The reviewed sources do not")
        ? `<div style="font-size:14px;line-height:1.6;color:#212529;margin-bottom:12px;padding:12px;background:#eaf4ff;border-radius:6px">
             ${explanation}
           </div>`
        : `<div style="font-size:13px;color:#856404;background:#fff3cd;padding:10px;border-radius:6px;margin-bottom:12px">
             Sources found but did not provide a specific explanation for this variance. Manual review recommended.
           </div>`

      const sourceList = sources
        .map(s => `<div style="margin-bottom:8px">
          <a href="${s.url}" style="color:#2980b9;font-size:13px;font-weight:500">${s.title}</a><br>
          <span style="color:#666;font-size:12px">${s.excerpt}</span>
        </div>`)
        .join("")

      researchHtml = `
        <div style="margin-top:12px;padding:14px;background:#f8f9fa;border-left:4px solid #3498db;border-radius:0 6px 6px 0">
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:#6c757d;margin-bottom:10px">
            Research findings — confidence: ${Math.round(confidence * 100)}%
          </div>
          ${explanationHtml}
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:#6c757d;margin-bottom:8px">Sources</div>
          ${sourceList}
        </div>`
    } else {
      researchHtml = `
        <div style="margin-top:12px;padding:12px;background:#fff3cd;border-left:4px solid #ffc107;border-radius:0 6px 6px 0">
          <strong style="color:#856404">No verified market explanation found.</strong>
          <span style="color:#856404;font-size:13px"> Brave Search returned insufficient credible sources (confidence &lt;80%). Manual review recommended.</span>
        </div>`
    }

    return `
      <div style="border:1px solid #dee2e6;border-radius:8px;padding:16px;margin-bottom:16px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <strong style="font-size:16px">${f.label}</strong>
          <span style="color:${color};font-size:20px;font-weight:bold">${dir} ${fmtPct(f.variancePct)}</span>
        </div>
        <div style="color:#6c757d;margin-top:4px;font-size:13px">
          ${prevName} ${prevYear}: ${fmt$(f.prevCpm)} → ${curName} ${curYear}: ${fmt$(f.curCpm)}
        </div>
        ${researchHtml}
      </div>`
  }).join("")

  const stableRows = variances.filter(v => !v.isSignificant).map(v =>
    `<tr>
       <td style="padding:8px 12px;border-bottom:1px solid #f1f3f5">${v.label}</td>
       <td style="padding:8px 12px;text-align:right;border-bottom:1px solid #f1f3f5;color:#6c757d">${fmt$(v.prevCpm)}</td>
       <td style="padding:8px 12px;text-align:right;border-bottom:1px solid #f1f3f5;color:#6c757d">${fmt$(v.curCpm)}</td>
       <td style="padding:8px 12px;text-align:right;border-bottom:1px solid #f1f3f5;color:${v.variancePct >= 0 ? "#495057" : "#6c757d"}">${fmtPct(v.variancePct)}</td>
     </tr>`
  ).join("")

  const headline = flagged.length > 0
    ? `⚠️ ${flagged.length} channel${flagged.length > 1 ? "s" : ""} with variance &gt;2.0%`
    : `✅ All channels within normal range (&lt;2.0%)`

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:680px;margin:0 auto;padding:24px;color:#212529">
  <div style="background:#1a1a2e;color:white;padding:24px;border-radius:12px;margin-bottom:24px">
    <div style="font-size:11px;opacity:.6;letter-spacing:.08em;text-transform:uppercase;margin-bottom:4px">CPM Agent — Monthly Comparison</div>
    <h1 style="margin:0;font-size:22px;font-weight:500">${curName} ${curYear} vs ${prevName} ${prevYear}</h1>
    <div style="margin-top:10px;font-size:15px">${headline}</div>
  </div>

  ${flagged.length > 0 ? `
  <h2 style="font-size:16px;font-weight:600;color:#c0392b;border-bottom:2px solid #c0392b;padding-bottom:8px;margin-bottom:16px">
    Significant Variances (&gt;2.0% MoM)
  </h2>
  ${flaggedRows}
  ` : `
  <div style="background:#d4edda;border:1px solid #c3e6cb;border-radius:8px;padding:16px;margin-bottom:24px;color:#155724">
    <strong>No significant variances detected.</strong> All channels moved less than 2.0% month-over-month. No research required.
  </div>
  `}

  ${stableRows ? `
  <h2 style="font-size:15px;font-weight:500;color:#495057;border-bottom:1px solid #dee2e6;padding-bottom:8px;margin-bottom:0">
    Stable channels
  </h2>
  <table style="width:100%;border-collapse:collapse;font-size:13px">
    <thead>
      <tr style="background:#f8f9fa">
        <th style="padding:8px 12px;text-align:left;font-weight:500;color:#6c757d">Channel</th>
        <th style="padding:8px 12px;text-align:right;font-weight:500;color:#6c757d">${prevName}</th>
        <th style="padding:8px 12px;text-align:right;font-weight:500;color:#6c757d">${curName}</th>
        <th style="padding:8px 12px;text-align:right;font-weight:500;color:#6c757d">Change</th>
      </tr>
    </thead>
    <tbody>${stableRows}</tbody>
  </table>
  ` : ""}

  <div style="margin-top:32px;padding-top:16px;border-top:1px solid #dee2e6;font-size:11px;color:#adb5bd">
    CPM Agent · Monthly variance analysis · Threshold: 2.0% · Confidence requirement: 80%<br>
    Explanations synthesized by Claude Haiku from verified industry sources only. No speculation included.
  </div>
</body>
</html>`
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET
  const auth       = req.headers.authorization ?? ""
  if (cronSecret && auth !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: "Unauthorized" })
  }

  if (!schemaReady) {
    try { await initSchema(); schemaReady = true }
    catch (e) { return res.status(500).json({ error: "DB init failed", detail: e.message }) }
  }

  // Determine comparison months
  // Cron runs on the 1st — compares the month that just ended vs the one before it.
  // ?month=6&year=2026 overrides for dry-run / backfill testing.
  const now = new Date()
  const forceMonth = req.query?.month ? parseInt(req.query.month) : null
  const forceYear  = req.query?.year  ? parseInt(req.query.year)  : null

  const curMonth  = forceMonth ?? (now.getMonth() === 0 ? 12 : now.getMonth())
  const curYear   = forceYear  ?? (now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear())
  const prevMonth = curMonth === 1 ? 12 : curMonth - 1
  const prevYear  = curMonth === 1 ? curYear - 1 : curYear

  // Only run comparisons where both months are in 2026
  if (curYear < 2026 || prevYear < 2026) {
    console.log(`Skipping: both months must be in 2026 (got ${MONTH_NAMES[curMonth]} ${curYear} vs ${MONTH_NAMES[prevMonth]} ${prevYear})`)
    return res.status(200).json({ ok: true, skipped: true, reason: "Both comparison months must be in 2026" })
  }

  console.log(`\nMonthly Comparison: ${MONTH_NAMES[curMonth]} ${curYear} vs ${MONTH_NAMES[prevMonth]} ${prevYear}`)
  console.log(`Variance threshold: ${VARIANCE_THRESHOLD * 100}% | Confidence threshold: ${CONFIDENCE_THRESHOLD * 100}%`)

  // Query Neon
  const rows = await queryBenchmarks()
  const index = {}
  for (const r of rows) {
    index[`${r.channel}-${r.year}-${r.month}`] = parseFloat(r.avg_cpm)
  }

  // Calculate variances
  console.log("\nCalculating variances…")
  const variances = []
  for (const [ch, label] of Object.entries(CHANNEL_LABELS)) {
    const curCpm  = index[`${ch}-${curYear}-${curMonth}`]
    const prevCpm = index[`${ch}-${prevYear}-${prevMonth}`]
    if (curCpm == null || prevCpm == null) {
      console.log(`  ⚠️  ${label}: missing data — skipping`)
      continue
    }
    const variancePct   = (curCpm - prevCpm) / prevCpm
    const isSignificant = Math.abs(variancePct) > VARIANCE_THRESHOLD
    const flag = isSignificant ? (variancePct > 0 ? "🔴▲" : "🔴▼") : "✅"
    console.log(`  ${flag} ${label}: ${(variancePct * 100).toFixed(1)}%  ($${prevCpm} → $${curCpm})`)
    variances.push({ channel: ch, label, curCpm, prevCpm, variancePct, isSignificant, research: null })
  }

  const flagged = variances.filter(v => v.isSignificant)
  console.log(`\n${flagged.length} channel(s) flagged`)

  // Research and synthesize explanations for flagged channels
  if (flagged.length > 0) {
    console.log("\nResearching + synthesizing explanations…")
    for (const entry of flagged) {
      console.log(`  → ${entry.label} (${(entry.variancePct * 100).toFixed(1)}%)`)
      const research = await researchVariance(entry.label, curMonth, curYear, entry.variancePct)
      entry.research = research
      if (research) {
        console.log(`    ✅ Confidence: ${Math.round(research.confidence * 100)}%`)
        console.log(`    Explanation: ${research.explanation?.slice(0, 100) ?? "(none)"}…`)
      } else {
        console.log(`    ⚠️  Confidence <80% — explanation suppressed`)
      }
    }
  }

  // Build and send email
  const emoji   = flagged.length > 0 ? "⚠️" : "✅"
  const subject = `${emoji} CPM Monthly Comparison — ${MONTH_NAMES[curMonth]} ${curYear} vs ${MONTH_NAMES[prevMonth]} ${prevYear}`
  const html    = buildEmailHtml(curMonth, curYear, prevMonth, prevYear, variances, flagged)
  await sendEmail(subject, html)

  return res.status(200).json({
    ok:                  true,
    period:              `${MONTH_NAMES[curMonth]} ${curYear} vs ${MONTH_NAMES[prevMonth]} ${prevYear}`,
    varianceThreshold:   `${VARIANCE_THRESHOLD * 100}%`,
    confidenceThreshold: `${CONFIDENCE_THRESHOLD * 100}%`,
    channelsAnalyzed:    variances.length,
    flagged:             flagged.length,
    results: variances.map(v => ({
      channel:     v.label,
      prevCpm:     v.prevCpm,
      curCpm:      v.curCpm,
      variancePct: `${(v.variancePct * 100).toFixed(1)}%`,
      flagged:     v.isSignificant,
      research:    v.research ? {
        confidence:  `${Math.round(v.research.confidence * 100)}%`,
        explanation: v.research.explanation,
        sources:     v.research.sources.length,
      } : null,
    })),
  })
}
