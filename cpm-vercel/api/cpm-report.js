/**
 * /api/cpm-report — Daily CPM report (Vercel serverless cron)
 *
 * Triggered automatically by Vercel cron at 0 13 * * * (8am EST / 9am EDT).
 * Replaces Mac launchd + daily-report.mjs.
 *
 * What it does:
 *   1. Queries Neon Postgres for historical CPM data
 *   2. On 1st of month: searches Brave for new CPM data, stores to Neon
 *   3. Researches market conditions via Brave
 *   4. (Optional) Synthesizes insights via Anthropic
 *   5. Sends HTML email via Resend (with dashboard attachment)
 *   6. Writes run record to Neon Postgres
 *
 * Auth: Vercel sends Authorization: Bearer {CRON_SECRET} for cron invocations.
 * Manual test: curl -X GET https://your-deployment.vercel.app/api/cpm-report \
 *   -H "Authorization: Bearer YOUR_CRON_SECRET"
 */

import https from "https"
import http  from "http"
import { URL } from "url"
import {
  initSchema, queryBenchmarks, upsertBenchmarks,
  getRunStats, getRecentRuns, insertRun,
} from "../lib/database.js"
import {
  CHANNELS, CHANNEL_LABELS, MONTH_NAMES,
  computeChanges, buildHtmlReport, buildEmailMetricsSection, buildInteractiveDashboard,
} from "../lib/report-html.js"

const CREDIBLE_SOURCES = [
  "emarketer.com", "adsposure.com", "wordstream.com", "statista.com",
  "iab.com", "comscore.com", "mediaradar.com", "adweek.com",
  "searchengineland.com", "semrush.com", "hubspot.com",
]

const GITHUB_OWNER = "rodbrathwaite79"
const GITHUB_REPO  = "cpm-malloy-model"
const UPDATES_PATH = "cpm_monthly_updates.csv"
const CSV_HEADER   = "year,month,month_name,channel,channel_label,cpm,source_note,report_date\n"

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
      headers:  { "User-Agent": "cpm-report-agent/2.0-vercel", ...headers, ...(bodyBuf ? { "Content-Length": bodyBuf.length } : {}) },
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
    githubToken:  process.env.GITHUB_TOKEN   ?? "",
    resendApiKey: process.env.RESEND_API_KEY ?? "",
    emailTo:      process.env.EMAIL_TO       ?? "rod.brathwaite@gmail.com",
    emailCc:      (process.env.EMAIL_CC ?? "").split(",").map(s => s.trim()).filter(Boolean),
    anthropicKey: process.env.ANTHROPIC_API_KEY ?? "",
    geminiKey:    process.env.GEMINI_API_KEY    ?? "",
    forceUpdate:  process.env.FORCE_UPDATE === "true",
  }
}

// ── Brave search ──────────────────────────────────────────────────────────────
async function braveSearch(query, count = 5) {
  const { braveApiKey } = cfg()
  if (!braveApiKey) { console.warn("BRAVE_API_KEY not set"); return [] }
  try {
    const res = await get(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`,
      { Accept: "application/json", "X-Subscription-Token": braveApiKey }
    )
    if (res.status !== 200) { console.warn("Brave HTTP", res.status); return [] }
    return JSON.parse(res.body)?.web?.results ?? []
  } catch (e) { console.warn("Brave error:", e.message); return [] }
}

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
      .slice(0, 3000)
  } catch { return "" }
}

async function findVerifiedCpm(channelLabel, month, year) {
  const monthName = MONTH_NAMES[month]
  const q = Math.ceil(month / 3)
  const query = `"${channelLabel}" CPM benchmark "${monthName} ${year}" OR "Q${q} ${year}" site:emarketer.com OR site:adsposure.com OR site:wordstream.com OR site:statista.com OR site:iab.com`
  const results = await braveSearch(query, 5)
  const findings = []
  for (const r of results.slice(0, 3)) {
    const text = r.url ? await fetchPageText(r.url) : ""
    findings.push({ title: r.title ?? "", url: r.url ?? "", excerpt: r.description ?? "", text })
  }
  return findings
}

// ── CPM extraction ────────────────────────────────────────────────────────────
function extractCpmWithRegex(channelLabel, findings) {
  const cpmPatterns = [
    /\$\s*([\d]+\.[\d]{1,2})\s*(?:CPM|cpm)/gi,
    /CPM[^$\d]{0,20}\$\s*([\d]+\.[\d]{1,2})/gi,
    /cost[- ]per[- ](?:thousand|mille)[^$\d]{0,30}\$\s*([\d]+\.[\d]{1,2})/gi,
    /average\s+CPM[^$\d]{0,20}\$\s*([\d]+\.[\d]{1,2})/gi,
    /\$\s*([\d]+\.[\d]{1,2})\s+(?:average\s+)?CPM/gi,
  ]
  const candidates = []
  for (const f of findings) {
    const isCredible = CREDIBLE_SOURCES.some(s => (f.url ?? "").includes(s))
    const haystack   = `${f.excerpt} ${f.text ?? ""}`.slice(0, 5000)
    for (const pat of cpmPatterns) {
      pat.lastIndex = 0
      let m
      while ((m = pat.exec(haystack)) !== null) {
        const val = parseFloat(m[1])
        if (val > 0.5 && val < 500) candidates.push({ cpm: val, credible: isCredible, source: f.title ?? f.url ?? "" })
      }
    }
  }
  if (candidates.length === 0) return null
  const preferred = candidates.filter(c => c.credible).length > 0 ? candidates.filter(c => c.credible) : candidates
  preferred.sort((a, b) => a.cpm - b.cpm)
  const median = preferred[Math.floor(preferred.length / 2)]
  return { cpm: Math.round(median.cpm * 100) / 100, sources: [...new Set(preferred.map(c => c.source))].slice(0, 3), note: "Extracted via regex from web sources" }
}

// ── Gemini helper ─────────────────────────────────────────────────────────────
async function callGemini(prompt, maxTokens = 1024, timeoutMs = 20000) {
  const { geminiKey } = cfg()
  if (!geminiKey) return null
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`
  try {
    const res = await request("POST", url, { "Content-Type": "application/json" }, {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.5, maxOutputTokens: maxTokens }
    }, timeoutMs)
    if (res.status !== 200) { console.warn("Gemini error:", res.status, res.body.slice(0, 200)); return null }
    const data = JSON.parse(res.body)
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? ""
    return { text, inputTokens: data.usageMetadata?.promptTokenCount ?? 0, outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0 }
  } catch (e) { console.warn("Gemini call failed:", e.message); return null }
}

async function extractCpmWithLlm(channelLabel, month, year, findings) {
  if (findings.length === 0) return null
  const { geminiKey, anthropicKey } = cfg()
  if (geminiKey || anthropicKey) {
    const context = findings.map(f => `SOURCE: ${f.title} (${f.url})\nEXCERPT: ${f.excerpt}${f.text ? "\nFULL TEXT: " + f.text.slice(0, 1500) : ""}`).join("\n\n---\n\n")
    const prompt  = `Extract the verified CPM for ${channelLabel} advertising in ${MONTH_NAMES[month]} ${year}.\n\nSOURCES:\n${context}\n\nReturn ONLY valid JSON: {"cpm": 12.50, "sources": ["Title 1"], "note": "brief quote"} OR {"cpm": null, "reason": "why not found"}\n\nRules: only accept explicit dollar figures from ${CREDIBLE_SOURCES.join(", ")}. Do NOT invent numbers.`
    try {
      let text = ""
      if (geminiKey) {
        const result = await callGemini(prompt, 256)
        text = result?.text ?? ""
      } else {
        const res = await post("https://api.anthropic.com/v1/messages",
          { "x-api-key": anthropicKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
          { model: "claude-haiku-4-5-20251001", max_tokens: 256, messages: [{ role: "user", content: prompt }] }
        )
        if (res.status === 200) text = JSON.parse(res.body).content?.[0]?.text ?? ""
      }
      const s = text.indexOf("{"), e = text.lastIndexOf("}")
      if (s >= 0 && e > s) {
        const parsed = JSON.parse(text.slice(s, e + 1))
        if (parsed.cpm && typeof parsed.cpm === "number" && parsed.cpm > 0 && parsed.cpm < 500) {
          return { cpm: Math.round(parsed.cpm * 100) / 100, sources: parsed.sources ?? [], note: parsed.note ?? "" }
        }
      }
    } catch (e) { console.warn("LLM extraction failed:", e.message) }
  }
  const regexResult = extractCpmWithRegex(channelLabel, findings)
  if (regexResult) { console.log("   (regex fallback used)"); return regexResult }
  return null
}

// ── AI synthesis (Gemini 2.5 Flash, falls back to Claude if no Gemini key) ────
async function synthesizeInsights(rows, webFindings) {
  const { geminiKey, anthropicKey } = cfg()
  if (!geminiKey && !anthropicKey) return null

  const channelData = {}
  for (const r of rows) {
    if (!channelData[r.channel]) channelData[r.channel] = []
    channelData[r.channel].push({ year: r.year, month: r.month, avg: r.avg_cpm })
  }
  const dataSummary = Object.entries(channelData)
    .map(([ch, pts]) => `${CHANNEL_LABELS[ch] ?? ch}: ${pts.map(p => `${MONTH_NAMES[p.month]} ${p.year} $${p.avg.toFixed(2)}`).join(", ")}`)
    .join("\n")
  const webSummary = webFindings.slice(0, 8).map((f, i) => `[${i+1}] ${f.title}\nURL: ${f.url}\nEXCERPT: ${f.excerpt}`).join("\n\n---\n\n")

  const prompt = `You are a senior media buying strategist. Analyze this CPM benchmark data and produce actionable intelligence for a media planner.

HISTORICAL CPM DATA (monthly, by channel):
${dataSummary}

RECENT MARKET RESEARCH:
${webSummary}

Return ONLY valid JSON with this exact structure:
{
  "summary": "2-3 sentences covering the most important trend, which channels are moving and why, and the overall market direction. Be specific — cite channel names and percentage changes.",
  "insights": [
    {
      "title": "Insight headline (5-8 words)",
      "body": "2-3 sentences explaining what the data shows. Reference specific CPM numbers and MoM or YoY changes.",
      "sources": [{"title": "source title", "url": "source url"}]
    }
  ],
  "recommendations": [
    {
      "title": "Action headline (5-8 words)",
      "body": "Specific recommendation: which channel, what budget shift, why now, and what outcome to expect. Tie directly to the data.",
      "urgency": "immediate"
    }
  ],
  "next_steps": [
    "Specific, timed action a media planner can execute this week or this quarter. Include channel, direction, and timeframe."
  ]
}

Rules:
- Return exactly 3 insights, 3 recommendations, 3 next_steps
- Recommendations must be directly actionable by a media buyer (channel shifts, budget reallocation, timing changes)
- Next steps must name a specific action with a timeframe (e.g. "Before Q3 begins, shift 10% of Social budget to Video/CTV")
- Urgency is one of: "immediate", "this-quarter", "monitor"
- Do NOT invent CPM numbers — every figure must come from the data above
- Each insight must cite at least one URL from the research above`

  try {
    let text = "", inputTokens = 0, outputTokens = 0
    if (geminiKey) {
      const result = await callGemini(prompt, 2048, 50000)
      if (!result) return null
      text = result.text; inputTokens = result.inputTokens; outputTokens = result.outputTokens
    } else {
      const res = await post("https://api.anthropic.com/v1/messages",
        { "x-api-key": anthropicKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
        { model: "claude-haiku-4-5-20251001", max_tokens: 2048, messages: [{ role: "user", content: prompt }] }
      )
      if (res.status !== 200) return null
      const data = JSON.parse(res.body)
      text = data.content?.[0]?.text ?? ""
      inputTokens = data.usage?.input_tokens ?? 0; outputTokens = data.usage?.output_tokens ?? 0
    }
    const s = text.indexOf("{"), e = text.lastIndexOf("}")
    if (s < 0 || e <= s) return null
    const parsed = JSON.parse(text.slice(s, e + 1))
    parsed._inputTokens  = inputTokens
    parsed._outputTokens = outputTokens
    return parsed
  } catch { return null }
}

// ── GitHub CSV backup (belt-and-suspenders alongside Neon) ───────────────────
async function updateGitHubCsv(newRows) {
  const { githubToken } = cfg()
  if (!githubToken || newRows.length === 0) return
  const apiBase = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${UPDATES_PATH}`
  const headers = {
    Authorization: `token ${githubToken}`,
    Accept: "application/vnd.github.v3+json",
    "Content-Type": "application/json",
    "User-Agent": "cpm-report-agent/2.0-vercel",
  }

  let currentContent = CSV_HEADER, sha
  const getRes = await get(apiBase, headers)
  if (getRes.status === 200) {
    const fileData = JSON.parse(getRes.body)
    sha = fileData.sha
    currentContent = Buffer.from(fileData.content.replace(/\n/g, ""), "base64").toString("utf-8")
    if (!currentContent.startsWith("year,")) currentContent = CSV_HEADER
  } else if (getRes.status === 401 || getRes.status === 403) {
    console.warn("GitHub:", getRes.status, "— token issue. Skipping CSV backup.")
    return
  }

  const existingKeys = new Set()
  for (const line of currentContent.split("\n").slice(1)) {
    const [yr, mo, , ch] = line.split(",")
    if (yr && mo && ch) existingKeys.add(`${yr}-${mo}-${ch}`)
  }

  let updated = currentContent, added = 0
  for (const row of newRows) {
    const key = `${row.year}-${row.month}-${row.channel}`
    if (existingKeys.has(key)) continue
    const note = `"${(row.note ?? "").replace(/"/g, '""').replace(/\n/g, " ")} (Sources: ${(row.sources ?? []).join("; ")})"`
    updated += `${row.year},${row.month},${MONTH_NAMES[row.month]},${row.channel},"${CHANNEL_LABELS[row.channel] ?? row.channel}",${row.cpm},${note},${row.year}-${String(row.month).padStart(2,"0")}-01\n`
    added++
  }

  if (added === 0) { console.log("GitHub CSV: no new rows"); return }
  const body = {
    message: `chore: verified CPM data [${added} channels] — ${new Date().toISOString().slice(0,10)}`,
    content: Buffer.from(updated, "utf-8").toString("base64"),
    committer: { name: "CPM Report Agent", email: "agent@cpm-reports.internal" },
    ...(sha ? { sha } : {}),
  }
  const putRes = await post(apiBase, headers, body)
  if (putRes.status.toString().startsWith("2")) {
    console.log(`GitHub CSV: committed ${added} rows`)
  } else {
    console.warn("GitHub CSV PUT failed:", putRes.status)
  }
}

// ── Resend email ──────────────────────────────────────────────────────────────
async function sendEmail(subject, html, attachments = []) {
  const { resendApiKey, emailTo, emailCc } = cfg()
  if (!resendApiKey) { console.warn("RESEND_API_KEY not set — skipping email"); return }

  const body = {
    from:    "CPM Report Agent <onboarding@resend.dev>",
    to:      [emailTo],
    subject,
    html,
  }
  if (emailCc.length > 0) body.cc = emailCc
  if (attachments.length > 0) {
    body.attachments = attachments.map(a => ({ filename: a.filename, content: a.content }))
  }

  const res = await post("https://api.resend.com/emails",
    { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
    body
  )
  if (res.status >= 200 && res.status < 300) {
    console.log(`✅ Email sent to ${emailTo} (Resend ID: ${JSON.parse(res.body).id})`)
  } else {
    console.warn(`❌ Resend ${res.status}:`, res.body.slice(0, 200))
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {

  // Verify cron or manual auth
  const cronSecret = process.env.CRON_SECRET
  const auth       = req.headers.authorization ?? ""
  if (cronSecret && auth !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: "Unauthorized" })
  }

  const now            = new Date()
  const runDate        = now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })
  const isFirstOfMonth = now.getDate() === 1 || cfg().forceUpdate

  console.log("=".repeat(60))
  console.log("CPM Report Agent (Vercel) —", runDate)
  console.log("=".repeat(60))

  // Validate env
  const missing = ["BRAVE_API_KEY", "RESEND_API_KEY"].filter(k => !process.env[k])
  if (missing.length > 0) {
    console.error("Missing env vars:", missing.join(", "))
    return res.status(500).json({ error: "Missing env vars", missing })
  }

  // Ensure schema
  if (!schemaReady) {
    try { await initSchema(); schemaReady = true }
    catch (e) { return res.status(500).json({ error: "DB init failed", detail: e.message }) }
  }

  // ── Step 1: Query Neon for historical data ────────────────────────────────
  console.log("\n[1/5] Querying Neon Postgres for historical CPM data…")
  const historicalRows = await queryBenchmarks()
  console.log(`      Found ${historicalRows.length} historical data points`)

  // ── Step 2: Search for new verified data (1st of month only) ─────────────
  const verifiedNewData = []
  if (isFirstOfMonth) {
    const prevMonth = now.getMonth() === 0 ? 12 : now.getMonth()
    const prevYear  = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear()
    console.log(`\n[2/5] Searching for ${MONTH_NAMES[prevMonth]} ${prevYear} CPM data…`)

    for (const { key: channel, label } of CHANNELS) {
      console.log(`      Searching: ${label}…`)
      const findings  = await findVerifiedCpm(label, prevMonth, prevYear)
      const extracted = await extractCpmWithLlm(label, prevMonth, prevYear, findings)
      if (extracted) {
        verifiedNewData.push({ channel, month: prevMonth, year: prevYear, ...extracted })
        console.log(`      ✅ ${label}: $${extracted.cpm} CPM`)
      } else {
        console.log(`      ⚠️  ${label}: no verifiable data found`)
      }
    }

    // Write to Neon (primary) + GitHub CSV (backup)
    if (verifiedNewData.length > 0) {
      console.log(`\n[3/5] Storing ${verifiedNewData.length} verified rows to Neon + GitHub…`)
      await upsertBenchmarks(verifiedNewData)
      await updateGitHubCsv(verifiedNewData)
    } else {
      console.log("\n[3/5] No verified data — sending HITL notification…")
      await sendEmail(
        `⚠️ CPM Agent — No verified data found for ${MONTH_NAMES[prevMonth]} ${prevYear}`,
        `<p>No verifiable CPM data found for <strong>${MONTH_NAMES[prevMonth]} ${prevYear}</strong>.</p>
         <p>Please check manually at <a href="https://www.adsposure.com">adsposure.com</a>, <a href="https://www.emarketer.com">emarketer.com</a>, or <a href="https://wordstream.com">wordstream.com</a>.</p>`
      )
      const today = now.toISOString().slice(0, 10)
      await insertRun({ runDate: today, source: "vercel", outcome: "hitl", dataPointsFound: 0 })
      return res.status(200).json({ ok: true, outcome: "hitl", dataPoints: 0 })
    }
  } else {
    console.log("\n[2/5] Not 1st of month — skipping new data search")
    console.log("[3/5] Skipping Neon/GitHub update")
  }

  // ── Step 4: Brave research ────────────────────────────────────────────────
  console.log("\n[4/5] Researching market conditions…")
  const webFindings = []
  for (const q of [
    "digital advertising CPM benchmarks 2025 2026 trends",
    "paid social CPM Meta Facebook Instagram 2026",
    "CTV streaming advertising CPM rates 2026",
  ]) {
    const results = await braveSearch(q, 3)
    for (const r of results.slice(0, 2)) {
      const text = r.url ? await fetchPageText(r.url) : ""
      webFindings.push({ title: r.title ?? "", url: r.url ?? "", excerpt: r.description ?? "", text })
    }
  }
  console.log(`      Found ${webFindings.length} web sources`)

  // ── Step 4b: AI synthesis ─────────────────────────────────────────────────
  let aiInsights = null, synthIn = 0, synthOut = 0
  if (cfg().geminiKey || cfg().anthropicKey) {
    console.log("\n[4b] AI synthesis via", cfg().geminiKey ? "Gemini 2.5 Flash" : "Claude Haiku", "…")
    aiInsights = await synthesizeInsights(historicalRows, webFindings)
    if (aiInsights) {
      synthIn  = aiInsights._inputTokens  ?? 0
      synthOut = aiInsights._outputTokens ?? 0
      console.log(`     AI insights generated (${synthIn} in / ${synthOut} out tokens)`)
    }
  }

  // ── Step 5: Build report and send ─────────────────────────────────────────
  console.log("\n[5/5] Generating report and sending email…")
  const allRows = [
    ...historicalRows,
    ...verifiedNewData.map(r => ({ channel: r.channel, year: r.year, month: r.month, avg_cpm: r.cpm, period_sort: r.year * 100 + r.month })),
  ]

  const runOutcome = verifiedNewData.length > 0 ? "autonomous" : isFirstOfMonth ? "hitl" : "autonomous"
  const today      = now.toISOString().slice(0, 10)
  const thisRun    = { date: today, outcome: runOutcome, inputTokens: synthIn, outputTokens: synthOut, dataPointsFound: verifiedNewData.length }

  // Write run to Neon
  await insertRun({ runDate: today, source: "vercel", outcome: runOutcome, inputTokens: synthIn, outputTokens: synthOut, dataPointsFound: verifiedNewData.length })

  // Fetch updated stats + history for the email
  const [stats, runHistory] = await Promise.all([getRunStats(), getRecentRuns(30)])
  const metricsSection      = buildEmailMetricsSection(stats, runHistory, thisRun)

  // Build dashboard and attach
  const dashHtml   = buildInteractiveDashboard(allRows, runDate, aiInsights)
  const dashBase64 = Buffer.from(dashHtml, "utf-8").toString("base64")
  const attachments = [{ filename: "CPM-Dashboard.html", content: dashBase64 }]

  const html    = buildHtmlReport(allRows, webFindings, aiInsights, verifiedNewData, runDate, metricsSection, !!(cfg().geminiKey || cfg().anthropicKey))
  const subject = `📊 CPM Month-over-Month Report — ${runDate}`

  await sendEmail(subject, html, attachments)

  console.log("\n" + "=".repeat(60))
  console.log("✅ Done")
  console.log("=".repeat(60))

  return res.status(200).json({ ok: true, outcome: runOutcome, dataPoints: verifiedNewData.length, historicalRows: historicalRows.length })
}
