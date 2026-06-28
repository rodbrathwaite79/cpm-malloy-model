#!/usr/bin/env node
/**
 * daily-report.mjs — Standalone CPM Report Script
 *
 * Runs directly on your Mac with full internet access.
 * No Guild state machine involved — all HTTP calls work normally.
 *
 * Usage (one-off):
 *   node daily-report.mjs
 *
 * Scheduling (via launchd — see com.rod.cpm-report.plist):
 *   Runs daily at 8am automatically.
 *
 * Required environment variables (set in .env or the launchd plist):
 *   BRAVE_API_KEY        — Brave Search API key
 *   GITHUB_TOKEN         — GitHub PAT with repo scope
 *   RESEND_API_KEY       — Resend API key (free at resend.com — 3,000 emails/month)
 *   MALLOYYO_URL         — Malloyyo base URL (e.g. https://malloyyo-c7i3hmkly-brathwaite.vercel.app)
 *   EMAIL_TO             — Primary recipient (default: rod.brathwaite@gmail.com)
 *
 * Optional:
 *   ANTHROPIC_API_KEY    — If set, adds AI-generated insights to the report
 *   EMAIL_CC             — Comma-separated CC list
 *   FORCE_UPDATE         — Set to "true" to force DB refresh on any day (not just 1st)
 */

import https from "https"
import http from "http"
import { URL } from "url"
import { readFileSync, writeFileSync, existsSync, createReadStream } from "fs"
import { createInterface } from "readline"
import path from "path"
import { fileURLToPath } from "url"
const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── Load .env if present ──────────────────────────────────────────────────────
const envPath = new URL(".env", import.meta.url).pathname
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=["']?(.+?)["']?\s*$/)
    if (m) process.env[m[1]] = m[2]
  }
}

// ── Config ────────────────────────────────────────────────────────────────────
const CONFIG = {
  braveApiKey:       process.env.BRAVE_API_KEY       ?? "",
  githubToken:       process.env.GITHUB_TOKEN        ?? "",
  resendApiKey:      process.env.RESEND_API_KEY      ?? "",
  malloyuoUrl:       process.env.MALLOYYO_URL        ?? "",
  emailTo:           process.env.EMAIL_TO            ?? "rod.brathwaite@gmail.com",
  emailCc:           (process.env.EMAIL_CC ?? "").split(",").map(s => s.trim()).filter(Boolean),
  forceUpdate:       process.env.FORCE_UPDATE === "true",
  anthropicKey:      process.env.ANTHROPIC_API_KEY   ?? "",
}

const GITHUB_OWNER = "rodbrathwaite79"
const GITHUB_REPO  = "cpm-malloy-model"
const UPDATES_PATH = "cpm_monthly_updates.csv"
const CSV_HEADER   = "year,month,month_name,channel,channel_label,cpm,source_note,report_date\n"

const CHANNEL_LABELS = {
  paid_social:           "Paid Social",
  paid_search:           "Paid Search",
  programmatic_display:  "Programmatic Display",
  video_ctv:             "Video / CTV",
  streaming_audio:       "Streaming Audio",
}

const MONTH_NAMES = {
  1: "January", 2: "February", 3: "March",     4: "April",
  5: "May",     6: "June",     7: "July",       8: "August",
  9: "September", 10: "October", 11: "November", 12: "December",
}

const CHANNELS = [
  { key: "paid_social",          label: "Paid Social" },
  { key: "paid_search",          label: "Paid Search" },
  { key: "programmatic_display", label: "Programmatic Display" },
  { key: "video_ctv",            label: "Video / CTV" },
  { key: "streaming_audio",      label: "Streaming Audio" },
]

const CREDIBLE_SOURCES = [
  "emarketer.com", "adsposure.com", "wordstream.com", "statista.com",
  "iab.com", "comscore.com", "mediaradar.com", "adweek.com",
  "searchengineland.com", "semrush.com", "hubspot.com",
]

// ── HTTP helper (pure Node — no fetch) ───────────────────────────────────────
function request(method, url, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const lib = parsed.protocol === "https:" ? https : http
    const bodyBuf = body ? Buffer.from(typeof body === "string" ? body : JSON.stringify(body)) : null
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method,
      headers: {
        "User-Agent": "cpm-report-agent/1.0",
        ...headers,
        ...(bodyBuf ? { "Content-Length": bodyBuf.length } : {}),
      },
    }
    const req = lib.request(options, (res) => {
      const chunks = []
      res.on("data", c => chunks.push(c))
      res.on("end", () => resolve({
        status:      res.statusCode,
        body:        Buffer.concat(chunks).toString("utf-8"),
        contentType: res.headers["content-type"] ?? "",
      }))
    })
    req.on("error", reject)
    req.setTimeout(20000, () => req.destroy(new Error("Timeout")))
    if (bodyBuf) req.write(bodyBuf)
    req.end()
  })
}

const get  = (url, headers)       => request("GET",  url, headers)
const post = (url, headers, body) => request("POST", url, headers, body)

// ── Local DuckDB parquet query (replaces Malloyyo MCP — no auth needed) ────────
async function queryLocalData(years = [], months = [], channels = []) {
  const parquetPath = path.resolve(__dirname, "../../malloy-model-git/cpm_benchmarks.parquet")
  const csvPath     = path.resolve(__dirname, "../../malloy-model-git/cpm_monthly_updates.csv")

  // Try DuckDB first (the `duckdb` npm package — CJS, callback-based)
  try {
    const { createRequire } = await import("module")
    const require = createRequire(import.meta.url)
    const duckdb = require("duckdb")

    const queryDuck = (db, sql) => new Promise((resolve, reject) => {
      db.all(sql, (err, rows) => err ? reject(err) : resolve(rows))
    })

    const db = new duckdb.Database(":memory:")

    // Build WHERE clause
    const whereParts = []
    if (years.length)    whereParts.push(`year IN (${years.join(",")})`)
    if (months.length)   whereParts.push(`month IN (${months.join(",")})`)
    if (channels.length) whereParts.push(`channel IN (${channels.map(c => `'${c}'`).join(",")})`)
    const where = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : ""

    const toRow = r => ({
      year: Number(r.year), month: Number(r.month), month_name: r.month_name,
      channel: r.channel, channel_label: r.channel_label, avg_cpm: Number(r.avg_cpm),
      period_sort: Number(r.year) * 100 + Number(r.month)
    })

    let parquetRows = []
    if (existsSync(parquetPath)) {
      const raw = await queryDuck(db, `SELECT year, month, month_name, channel, channel_label, cpm AS avg_cpm FROM read_parquet('${parquetPath}') ${where} ORDER BY year, month, channel`)
      parquetRows = raw.map(toRow)
    }

    let csvRows = []
    if (existsSync(csvPath)) {
      const raw = await queryDuck(db, `SELECT year, month, month_name, channel, channel_label, cpm AS avg_cpm FROM read_csv_auto('${csvPath}') ${where} ORDER BY year, month, channel`)
      csvRows = raw.map(toRow)
    }

    db.close()
    console.log(`      DuckDB: ${parquetRows.length} parquet rows + ${csvRows.length} CSV rows`)
    return [...parquetRows, ...csvRows]
  } catch (e) {
    console.warn("      DuckDB unavailable:", e.message.slice(0, 80))
  }

  // Fallback: plain CSV read (only gets update rows, not the parquet base data)
  if (existsSync(csvPath)) {
    const rows = []
    const lines = readFileSync(csvPath, "utf-8").trim().split("\n")
    for (const line of lines.slice(1)) {
      const [year, month, month_name, channel, channel_label, cpm] = line.split(",")
      if (!year || !cpm) continue
      rows.push({
        year: Number(year), month: Number(month), month_name,
        channel: channel.trim(), channel_label: channel_label?.replace(/^"|"$/g, ""),
        avg_cpm: Number(cpm), period_sort: Number(year) * 100 + Number(month)
      })
    }
    console.log(`      CSV fallback: ${rows.length} rows (parquet base data unavailable without DuckDB)`)
    return rows
  }

  console.warn("      No local data available")
  return []
}

// ── Brave search ──────────────────────────────────────────────────────────────
async function braveSearch(query, count = 5) {
  if (!CONFIG.braveApiKey) { console.warn("BRAVE_API_KEY not set — skipping web search"); return [] }
  try {
    const res = await get(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`,
      { "Accept": "application/json", "X-Subscription-Token": CONFIG.braveApiKey }
    )
    if (res.status !== 200) { console.warn("Brave search HTTP", res.status); return [] }
    const data = JSON.parse(res.body)
    return data?.web?.results ?? []
  } catch (e) { console.warn("Brave search error:", e.message); return [] }
}

// Fetch page text (best-effort)
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

// ── Search for verified CPM data per channel ──────────────────────────────────
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

// ── Regex CPM extraction fallback (no API key needed) ────────────────────────
function extractCpmWithRegex(channelLabel, findings) {
  // Patterns: $12.34 CPM, CPM of $12.34, average CPM: $12, CPM rate $12.50, etc.
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
    const haystack = `${f.excerpt} ${f.text ?? ""}`.slice(0, 5000)

    for (const pat of cpmPatterns) {
      pat.lastIndex = 0
      let m
      while ((m = pat.exec(haystack)) !== null) {
        const val = parseFloat(m[1])
        if (val > 0.5 && val < 500) {
          candidates.push({ cpm: val, credible: isCredible, source: f.title ?? f.url ?? "" })
        }
      }
    }
  }

  if (candidates.length === 0) return null

  // Prefer credible sources; among ties take median
  const preferred = candidates.filter(c => c.credible).length > 0
    ? candidates.filter(c => c.credible)
    : candidates

  preferred.sort((a, b) => a.cpm - b.cpm)
  const median = preferred[Math.floor(preferred.length / 2)]

  return {
    cpm: Math.round(median.cpm * 100) / 100,
    sources: [...new Set(preferred.map(c => c.source))].slice(0, 3),
    note: `Extracted via regex from web sources (no AI key set)`,
  }
}

// ── LLM extraction via Anthropic API (preferred) ─────────────────────────────
async function extractCpmWithLlm(channelLabel, month, year, findings) {
  if (findings.length === 0) return null

  // Try LLM first if key is available
  if (CONFIG.anthropicKey) {
    const context = findings
      .map(f => `SOURCE: ${f.title} (${f.url})\nEXCERPT: ${f.excerpt}${f.text ? "\nFULL TEXT: " + f.text.slice(0, 1500) : ""}`)
      .join("\n\n---\n\n")

    const prompt = `Extract the verified CPM for ${channelLabel} advertising in ${MONTH_NAMES[month]} ${year}.

SOURCES:
${context}

Return ONLY valid JSON (no markdown):
{"cpm": 12.50, "sources": ["Title 1"], "note": "brief quote"}
OR {"cpm": null, "reason": "why not found"}

Rules: only accept explicit dollar figures from ${CREDIBLE_SOURCES.join(", ")}. Do NOT invent numbers.`

    try {
      const res = await post(
        "https://api.anthropic.com/v1/messages",
        { "x-api-key": CONFIG.anthropicKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
        { model: "claude-haiku-4-5-20251001", max_tokens: 256, messages: [{ role: "user", content: prompt }] }
      )
      if (res.status === 200) {
        const data = JSON.parse(res.body)
        const text = data.content?.[0]?.text ?? ""
        const s = text.indexOf("{"), e = text.lastIndexOf("}")
        if (s >= 0 && e > s) {
          const parsed = JSON.parse(text.slice(s, e + 1))
          if (parsed.cpm && typeof parsed.cpm === "number" && parsed.cpm > 0 && parsed.cpm < 500) {
            return { cpm: Math.round(parsed.cpm * 100) / 100, sources: parsed.sources ?? [], note: parsed.note ?? "" }
          }
        }
      } else {
        console.warn("      Anthropic API error:", res.status, "— falling back to regex")
      }
    } catch (e) {
      console.warn("      LLM extraction failed:", e.message, "— falling back to regex")
    }
  }

  // Fallback: regex extraction from page text
  const regexResult = extractCpmWithRegex(channelLabel, findings)
  if (regexResult) {
    console.log(`      (regex fallback used — set ANTHROPIC_API_KEY for smarter extraction)`)
    return regexResult
  }

  return null
}

// ── Anthropic LLM synthesis for report insights ───────────────────────────────
async function synthesizeInsights(rows, webFindings) {
  if (!CONFIG.anthropicKey) return null

  const channelData = {}
  for (const r of rows) {
    if (!channelData[r.channel]) channelData[r.channel] = []
    channelData[r.channel].push({ year: r.year, month: r.month, avg: r.avg_cpm })
  }
  const dataSummary = Object.entries(channelData)
    .map(([ch, pts]) => `${CHANNEL_LABELS[ch] ?? ch}: ${pts.map(p => `${MONTH_NAMES[p.month]} ${p.year} $${p.avg.toFixed(2)}`).join(", ")}`)
    .join("\n")

  const webSummary = webFindings.slice(0, 8)
    .map((f, i) => `[${i + 1}] TITLE: ${f.title}\nURL: ${f.url}\nEXCERPT: ${f.excerpt}`)
    .join("\n\n---\n\n")

  const prompt = `You are a senior media analyst. Write a brief executive summary and 3 key insights for this CPM benchmark report.

HISTORICAL DATA:
${dataSummary}

RECENT WEB RESEARCH (use these exact URLs when citing sources):
${webSummary}

Return ONLY valid JSON (no markdown, no code fences):
{
  "summary": "2-3 sentence executive overview citing specific CPM figures from the historical data",
  "insights": [
    {
      "title": "short title (4-6 words)",
      "body": "2 sentence insight citing a specific number from the data above",
      "sources": [{"title": "Source Name", "url": "https://exact-url-from-web-research-above"}]
    }
  ]
}

Rules:
- Do NOT invent CPM numbers. Only cite data above.
- Each insight MUST cite at least one URL from the RECENT WEB RESEARCH section above.
- Use the exact URLs provided — do not modify or guess URLs.
- Return exactly 3 insights.`

  try {
    const res = await post(
      "https://api.anthropic.com/v1/messages",
      { "x-api-key": CONFIG.anthropicKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      { model: "claude-haiku-4-5-20251001", max_tokens: 1024, messages: [{ role: "user", content: prompt }] }
    )
    if (res.status !== 200) return null
    const data = JSON.parse(res.body)
    const text = data.content?.[0]?.text ?? ""
    const s = text.indexOf("{"), e = text.lastIndexOf("}")
    if (s < 0 || e <= s) return null
    const parsed = JSON.parse(text.slice(s, e + 1))
    // Attach real token counts from the API response
    parsed._inputTokens  = data.usage?.input_tokens  ?? 0
    parsed._outputTokens = data.usage?.output_tokens ?? 0
    return parsed
  } catch { return null }
}

// ── GitHub CSV update ─────────────────────────────────────────────────────────
async function updateGitHubCsv(newRows) {
  if (!CONFIG.githubToken || newRows.length === 0) return
  const apiBase = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${UPDATES_PATH}`
  const headers = {
    "Authorization": `token ${CONFIG.githubToken}`,
    "Accept":        "application/vnd.github.v3+json",
    "Content-Type":  "application/json",
    "User-Agent":    "cpm-report-agent/1.0",
  }

  let currentContent = CSV_HEADER
  let sha

  const getRes = await get(apiBase, headers)
  console.log(`      GitHub GET status: ${getRes.status}`)
  if (getRes.status === 200) {
    const fileData = JSON.parse(getRes.body)
    sha = fileData.sha
    currentContent = Buffer.from(fileData.content.replace(/\n/g, ""), "base64").toString("utf-8")
    if (!currentContent.startsWith("year,")) currentContent = CSV_HEADER
    console.log(`      File exists in repo (SHA: ${sha.slice(0, 8)}…)`)
  } else if (getRes.status === 401) {
    console.warn("      GitHub GET 401 — token is invalid or expired. Update GITHUB_TOKEN in .env and the plist.")
    return
  } else if (getRes.status === 403) {
    console.warn("      GitHub GET 403 — token lacks 'repo' scope. Regenerate at github.com/settings/tokens.")
    return
  } else if (getRes.status === 404) {
    // Could be: file doesn't exist yet (normal), OR repo is private + token can't access it
    // We'll try the PUT anyway; if it fails with 404 the repo/token is the issue
    console.log("      File not found in repo — will create it (or token issue if PUT also fails)")
  } else {
    console.warn("      GitHub GET unexpected status:", getRes.status, getRes.body.slice(0, 100))
    return
  }

  const existingKeys = new Set()
  for (const line of currentContent.split("\n").slice(1)) {
    const [yr, mo, , ch] = line.split(",")
    if (yr && mo && ch) existingKeys.add(`${yr}-${mo}-${ch}`)
  }

  let updated = currentContent
  let added = 0
  for (const row of newRows) {
    const key = `${row.year}-${row.month}-${row.channel}`
    if (existingKeys.has(key)) continue
    const date = `${row.year}-${String(row.month).padStart(2, "0")}-01`
    const note = `"${(row.note ?? "").replace(/"/g, '""').replace(/\n/g, " ")} (Sources: ${(row.sources ?? []).join("; ")})"`
    updated += `${row.year},${row.month},${MONTH_NAMES[row.month]},${row.channel},"${CHANNEL_LABELS[row.channel] ?? row.channel}",${row.cpm},${note},${date}\n`
    added++
  }

  if (added === 0) { console.log("GitHub: no new rows to add"); return }

  const encoded = Buffer.from(updated, "utf-8").toString("base64")
  const body = {
    message: `chore: verified CPM data [${added} channels] — ${new Date().toISOString().slice(0, 10)}`,
    content: encoded,
    committer: { name: "CPM Report Agent", email: "agent@cpm-reports.internal" },
    ...(sha ? { sha } : {}),
  }

  const putRes = await post(apiBase, headers, body)
  if (!putRes.status.toString().startsWith("2")) {
    console.warn(`      GitHub PUT failed: ${putRes.status}`, putRes.body.slice(0, 200))
    if (putRes.status === 401) console.warn("      → Token invalid/expired. Update GITHUB_TOKEN in .env and the plist.")
    if (putRes.status === 403) console.warn("      → Token lacks 'repo' write scope. Regenerate at github.com/settings/tokens.")
    if (putRes.status === 404) console.warn("      → Repo not found or token can't see it. Check GITHUB_OWNER/REPO in script and token scopes.")
    if (putRes.status === 422) console.warn("      → SHA conflict — file changed since last read. Will self-correct next run.")
  } else {
    console.log(`      ✅ GitHub: committed ${added} new rows to ${GITHUB_OWNER}/${GITHUB_REPO}`)
  }
}

// ── MoM / YoY change computation ─────────────────────────────────────────────
function computeChanges(rows) {
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

// ── Agent metrics persistence ─────────────────────────────────────────────────
const METRICS_PATH = path.resolve(__dirname, "../../logs/agent-metrics.json")

const EMPTY_METRICS = {
  totalRuns: 0, autonomousRuns: 0, hitlRuns: 0, errorRuns: 0,
  totalInputTokens: 0, totalOutputTokens: 0,
  runHistory: [],  // last 30 runs
}

function loadMetrics() {
  try {
    if (existsSync(METRICS_PATH)) return { ...EMPTY_METRICS, ...JSON.parse(readFileSync(METRICS_PATH, "utf-8")) }
  } catch { /* ignore */ }
  return { ...EMPTY_METRICS }
}

function saveMetrics(metrics) {
  try {
    writeFileSync(METRICS_PATH, JSON.stringify(metrics, null, 2), "utf-8")
  } catch (e) { console.warn("Could not save metrics:", e.message) }
}

async function saveMetricsAsync(metrics) {
  try {
    const { mkdirSync } = await import("fs")
    mkdirSync(path.dirname(METRICS_PATH), { recursive: true })
    writeFileSync(METRICS_PATH, JSON.stringify(metrics, null, 2), "utf-8")
  } catch (e) { console.warn("Could not save metrics:", e.message) }
}

// ── Email metrics section ─────────────────────────────────────────────────────
function buildEmailMetricsSection(metrics, thisRun) {
  const hitlRate     = metrics.totalRuns > 0 ? (metrics.hitlRuns / metrics.totalRuns * 100).toFixed(1) : "0.0"
  const autonomyRate = metrics.totalRuns > 0 ? (metrics.autonomousRuns / metrics.totalRuns * 100).toFixed(1) : "0.0"

  // ROI: each autonomous run saves ~15 min of analyst time @ $100/hr = $25
  // Token cost shown as raw counts (no made-up $/token — check console.anthropic.com for actuals)
  const totalTok      = metrics.totalInputTokens + metrics.totalOutputTokens
  const thisTok       = thisRun.inputTokens + thisRun.outputTokens
  const humanSavedMin = metrics.autonomousRuns * 15

  const outcomeIcon  = thisRun.outcome === "autonomous" ? "✅" : thisRun.outcome === "hitl" ? "⚠️" : "❌"
  const outcomeLabel = thisRun.outcome === "autonomous" ? "Autonomous — no human needed"
                     : thisRun.outcome === "hitl"       ? "HITL triggered — emailed for help"
                     : "Error"

  const roiLabel = metrics.autonomousRuns === 0 ? "No autonomous runs yet"
    : `~${humanSavedMin} min analyst time saved (${metrics.autonomousRuns} runs × 15 min)`

  const sparkRows = [...metrics.runHistory].reverse().slice(0, 10).map(r => {
    const color = r.outcome === "autonomous" ? "#22c55e" : r.outcome === "hitl" ? "#f59e0b" : "#ef4444"
    const icon  = r.outcome === "autonomous" ? "✅" : r.outcome === "hitl" ? "⚠️" : "❌"
    return `
    <tr>
      <td style="padding:4px 8px;color:#64748b;font-size:10px;white-space:nowrap;">${r.date}</td>
      <td style="padding:4px 8px;color:${color};font-size:10px;">${icon} ${r.outcome}</td>
      <td style="padding:4px 8px;text-align:right;color:#94a3b8;font-size:10px;">${(r.inputTokens + r.outputTokens).toLocaleString()} tok</td>
      <td style="padding:4px 8px;text-align:right;color:#94a3b8;font-size:10px;">${r.dataPointsFound} pts</td>
    </tr>`
  }).join("")

  return `
  <div style="background:#0f172a;border:1px solid #1e293b;border-radius:8px;padding:18px;margin-bottom:20px;">
    <div style="color:#f1f5f9;font-size:13px;font-weight:700;margin-bottom:14px;">🤖 Agent Metrics Dashboard</div>

    <!-- This run -->
    <div style="background:#1e293b;border-radius:6px;padding:12px;margin-bottom:12px;">
      <div style="color:#64748b;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">This Run — ${thisRun.date}</div>
      <div style="display:flex;gap:16px;flex-wrap:wrap;">
        <div><div style="color:#94a3b8;font-size:10px;">Outcome</div><div style="color:#f1f5f9;font-size:13px;font-weight:600;">${outcomeIcon} ${outcomeLabel}</div></div>
        <div><div style="color:#94a3b8;font-size:10px;">Tokens Used</div><div style="color:#60a5fa;font-size:13px;font-weight:600;">${thisTok.toLocaleString()}</div></div>
        <div><div style="color:#94a3b8;font-size:10px;">Input / Output</div><div style="color:#94a3b8;font-size:12px;">${thisRun.inputTokens.toLocaleString()} / ${thisRun.outputTokens.toLocaleString()}</div></div>
        <div><div style="color:#94a3b8;font-size:10px;">Data Points Found</div><div style="color:#f1f5f9;font-size:13px;font-weight:600;">${thisRun.dataPointsFound}</div></div>
      </div>
    </div>

    <!-- Cumulative stats -->
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:12px;">
      <tr>
        <td style="padding:8px;background:#1e293b;border-radius:6px;text-align:center;width:25%;">
          <div style="color:#64748b;font-size:10px;text-transform:uppercase;">Total Runs</div>
          <div style="color:#f1f5f9;font-size:20px;font-weight:700;">${metrics.totalRuns}</div>
        </td>
        <td style="width:4px;"></td>
        <td style="padding:8px;background:#052e16;border-radius:6px;text-align:center;width:25%;">
          <div style="color:#64748b;font-size:10px;text-transform:uppercase;">Autonomous</div>
          <div style="color:#22c55e;font-size:20px;font-weight:700;">${autonomyRate}%</div>
          <div style="color:#4ade80;font-size:10px;">${metrics.autonomousRuns} runs</div>
        </td>
        <td style="width:4px;"></td>
        <td style="padding:8px;background:#1e293b;border-radius:6px;text-align:center;width:25%;">
          <div style="color:#64748b;font-size:10px;text-transform:uppercase;">HITL Rate</div>
          <div style="color:#f59e0b;font-size:20px;font-weight:700;">${hitlRate}%</div>
          <div style="color:#fbbf24;font-size:10px;">${metrics.hitlRuns} runs</div>
        </td>
        <td style="width:4px;"></td>
        <td style="padding:8px;background:#1e293b;border-radius:6px;text-align:center;width:25%;">
          <div style="color:#64748b;font-size:10px;text-transform:uppercase;">Total Tokens</div>
          <div style="color:#60a5fa;font-size:20px;font-weight:700;">${(totalTok / 1000).toFixed(1)}k</div>
          <div style="color:#93c5fd;font-size:10px;">${metrics.totalInputTokens.toLocaleString()} in / ${metrics.totalOutputTokens.toLocaleString()} out</div>
        </td>
      </tr>
    </table>

    <!-- ROI -->
    <div style="background:#1e293b;border-radius:6px;padding:10px 12px;margin-bottom:12px;">
      <span style="color:#64748b;font-size:10px;text-transform:uppercase;font-weight:700;">Estimated Time Saved&nbsp;&nbsp;</span>
      <span style="color:#a3e635;font-size:12px;font-weight:600;">${roiLabel}</span>
      <span style="color:#475569;font-size:10px;">&nbsp;·&nbsp;check actual token costs at <a href="https://console.anthropic.com" style="color:#60a5fa;">console.anthropic.com</a></span>
    </div>

    ${sparkRows ? `
    <!-- Recent run history -->
    <div style="color:#475569;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Recent Runs</div>
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

// ── Email bar chart (pure HTML tables — works in Gmail, Apple Mail, Outlook) ──
function buildEmailBarChart(enriched) {
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

// ── Compact 6-month cross-channel trend table (email-safe) ───────────────────
function buildEmailTrendTable(enriched) {
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
    const year         = Math.floor(ps / 100)
    const month        = ps % 100
    const periodLabel  = `${(MONTH_NAMES[month] ?? "").slice(0, 3)} ${year}`
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

// ── Email report (static HTML — no JavaScript, all email clients) ─────────────
function buildHtmlReport(rows, webFindings, aiInsights, verifiedNewData, runDate, dashboardPath, metricsSection = "") {
  const enriched = computeChanges(rows)

  // Latest per channel (for summary cards)
  const latestByChannel = {}
  for (const r of enriched) {
    const cur = latestByChannel[r.channel]
    if (!cur || r.period_sort > cur.period_sort) latestByChannel[r.channel] = r
  }

  // Channel summary cards
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

  // Charts and compact trend table (replace long per-channel tables)
  const emailBarChart   = buildEmailBarChart(enriched)
  const emailTrendTable = buildEmailTrendTable(enriched)

  // New verified data section
  const newDataSection = verifiedNewData.length > 0 ? `
  <div style="background:#052e16;border:1px solid #166534;border-radius:8px;padding:14px;margin-bottom:20px;">
    <div style="color:#4ade80;font-size:13px;font-weight:700;margin-bottom:6px;">✅ New Verified Data Added This Run</div>
    ${verifiedNewData.map(r => `
    <div style="color:#86efac;font-size:12px;padding:2px 0;">
      ${CHANNEL_LABELS[r.channel] ?? r.channel}: <strong>$${r.cpm}</strong> CPM — ${MONTH_NAMES[r.month]} ${r.year}
      <span style="color:#4ade80;font-size:11px;"> · ${(r.sources ?? []).join(", ")}</span>
    </div>`).join("")}
  </div>` : ""

  // AI insights section (with source links)
  const aiSection = aiInsights ? `
  <div style="background:#0f172a;border-radius:8px;padding:18px;margin-bottom:20px;">
    <div style="color:#f1f5f9;font-size:14px;font-weight:700;margin-bottom:10px;">📊 AI Analysis</div>
    <p style="color:#cbd5e1;font-size:13px;line-height:1.6;margin:0 0 14px;">${aiInsights.summary ?? ""}</p>
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
  </div>` : ""

  const dashboardLink = dashboardPath
    ? `<div style="margin-bottom:20px;text-align:center;">
        <a href="file://${dashboardPath}" style="background:#3b82f6;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600;">
          Open Interactive Dashboard (with Filters) →
        </a>
        <div style="color:#475569;font-size:11px;margin-top:6px;">Filter by year, month, or channel — click the button above or open:<br>${dashboardPath}</div>
       </div>` : ""

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<div style="max-width:680px;margin:0 auto;padding:24px;">

  <!-- Header -->
  <div style="border-bottom:1px solid #1e293b;padding-bottom:14px;margin-bottom:20px;">
    <div style="color:#3b82f6;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:2px;">CPM Benchmark Report</div>
    <div style="color:#f1f5f9;font-size:22px;font-weight:700;margin-top:4px;">Media CPM Increases Month over Month</div>
    <div style="color:#64748b;font-size:12px;margin-top:3px;">2023–2026 · Generated ${runDate}</div>
  </div>

  ${newDataSection}
  ${dashboardLink}

  <!-- Channel Summary -->
  <div style="color:#f1f5f9;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;">Latest CPM by Channel</div>
  ${channelCards}

  ${aiSection}

  <!-- CPM by Channel Bar Chart -->
  ${emailBarChart}

  <!-- 6-Month Trend Table -->
  ${emailTrendTable}

  <!-- Agent Metrics -->
  ${metricsSection}

  <!-- Footer -->
  <div style="border-top:1px solid #1e293b;margin-top:16px;padding-top:14px;color:#475569;font-size:11px;text-align:center;">
    CPM Report Agent · Data from Malloyyo + Brave Search${CONFIG.anthropicKey ? " + Claude AI" : ""}
    <br>Never invents numbers — sources: Adsposure, eMarketer, WordStream, IAB
  </div>
</div>
</body>
</html>`
}

// ── Interactive dashboard (saved to disk) ─────────────────────────────────────
function buildInteractiveDashboard(rows, runDate, aiInsights = null) {
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

  const insightsHtml = aiInsights ? `
  <div class="insights-panel">
    <div class="insights-title">📊 AI Analysis</div>
    <div class="insights-summary">${aiInsights.summary ?? ""}</div>
    ${(aiInsights.insights ?? []).map(i => {
      const srcLinks = (i.sources ?? [])
        .map(s => `<a href="${s.url}" target="_blank" rel="noopener" class="src-link">${s.title ?? s.url}</a>`)
        .join(" · ")
      return `
    <div class="insight-item">
      <div class="insight-title">${i.title}</div>
      <div class="insight-body">${i.body}</div>
      ${srcLinks ? `<div class="insight-sources">🔗 ${srcLinks}</div>` : ""}
    </div>`
    }).join("")}
  </div>` : ""

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CPM Dashboard — Media CPM Month over Month 2023–2026</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0f172a;color:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh}
  .header{background:#1e293b;padding:20px 28px;border-bottom:1px solid #334155}
  .header h1{font-size:22px;font-weight:700;color:#f1f5f9}
  .header p{font-size:13px;color:#64748b;margin-top:4px}
  .layout{display:flex;gap:0;min-height:calc(100vh - 74px)}
  .sidebar{width:220px;flex-shrink:0;background:#1e293b;padding:20px;border-right:1px solid #334155}
  .main{flex:1;padding:24px;overflow-x:auto}
  .filter-section{margin-bottom:20px}
  .filter-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#64748b;margin-bottom:8px}
  .cb-label{display:flex;align-items:center;gap:6px;font-size:13px;color:#cbd5e1;padding:3px 0;cursor:pointer;user-select:none}
  .cb-label input{accent-color:#3b82f6;width:14px;height:14px;cursor:pointer}
  .cb-label span{flex:1}
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
  .up{color:#22c55e;font-weight:600}
  .dn{color:#ef4444;font-weight:600}
  .fl{color:#f59e0b;font-weight:600}
  .na{color:#475569}
  .tag{display:inline-block;background:#1e3a5f;color:#60a5fa;border-radius:4px;padding:2px 6px;font-size:11px}
  #count{font-size:12px;color:#64748b;margin-bottom:8px}
  .sort-indicator{color:#3b82f6;margin-left:4px}
  /* Chart section */
  .chart-section{background:#1e293b;border-radius:10px;padding:20px;margin-bottom:20px}
  .chart-title{font-size:13px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;margin-bottom:14px}
  .chart-wrap{position:relative;height:280px}
  /* Insights panel */
  .insights-panel{background:#0f172a;border-radius:10px;padding:20px;margin-bottom:20px}
  .insights-title{font-size:14px;font-weight:700;color:#f1f5f9;margin-bottom:10px}
  .insights-summary{color:#cbd5e1;font-size:13px;line-height:1.6;margin-bottom:14px}
  .insight-item{border-left:3px solid #3b82f6;padding-left:10px;margin-bottom:12px}
  .insight-title{color:#93c5fd;font-weight:600;font-size:13px}
  .insight-body{color:#94a3b8;font-size:12px;margin-top:3px;line-height:1.5}
  .insight-sources{margin-top:5px;font-size:11px}
  .src-link{color:#60a5fa;text-decoration:none}
  .src-link:hover{text-decoration:underline}
  @media(max-width:640px){
    .layout{flex-direction:column}
    .sidebar{width:100%;border-right:none;border-bottom:1px solid #334155}
    .stats{flex-direction:column}
  }
</style>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js"></script>
</head>
<body>
<div class="header">
  <h1>📊 Media CPM Increases Month over Month</h1>
  <p>2023–2026 · Interactive Dashboard · Generated ${runDate}</p>
</div>
<div class="layout">
  <div class="sidebar">
    <div class="filter-section">
      <div class="filter-title">Year</div>
      ${yearCheckboxes}
    </div>
    <div class="filter-section">
      <div class="filter-title">Month</div>
      ${monthCheckboxes}
    </div>
    <div class="filter-section">
      <div class="filter-title">Channel</div>
      ${channelCheckboxes}
    </div>
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
          <th onclick="sortBy('year','month')" style="cursor:pointer">Period <span id="s-period" class="sort-indicator"></span></th>
          <th onclick="sortBy('channel')" style="cursor:pointer">Channel <span id="s-channel" class="sort-indicator"></span></th>
          <th class="right" onclick="sortBy('cpm')" style="cursor:pointer">CPM <span id="s-cpm" class="sort-indicator"></span></th>
          <th class="right" onclick="sortBy('mom')" style="cursor:pointer">MoM Δ <span id="s-mom" class="sort-indicator"></span></th>
          <th class="right" onclick="sortBy('yoy')" style="cursor:pointer">YoY Δ <span id="s-yoy" class="sort-indicator"></span></th>
        </tr>
      </thead>
      <tbody id="tbody"></tbody>
    </table>
  </div>
</div>
<script>
const ALL = ${dataJson};

let sortKey = 'year', sortKey2 = 'month', sortDir = -1;

function pctHtml(v) {
  if (v === null || v === undefined) return '<span class="na">—</span>';
  const sign = v >= 0 ? '+' : '';
  const arrow = v > 0.5 ? '↑' : v < -0.5 ? '↓' : '→';
  const cls = v > 0.5 ? 'up' : v < -0.5 ? 'dn' : 'fl';
  return \`<span class="\${cls}">\${arrow} \${sign}\${v.toFixed(1)}%</span>\`;
}

function getFilters() {
  const yrs = [...document.querySelectorAll('.yr-cb:checked')].map(e => +e.value);
  const mos = [...document.querySelectorAll('.mo-cb:checked')].map(e => +e.value);
  const chs = [...document.querySelectorAll('.ch-cb:checked')].map(e => e.value);
  return { yrs, mos, chs };
}

function render() {
  const { yrs, mos, chs } = getFilters();
  let data = ALL.filter(r =>
    yrs.includes(r.year) && mos.includes(r.month) && chs.includes(r.channel)
  );

  // Update chart with filtered data (function is declared below; hoisting makes this safe)
  if (typeof updateChart === 'function') updateChart(data);

  // Sort
  data.sort((a, b) => {
    let va = a[sortKey], vb = b[sortKey];
    if (va === null) va = sortDir > 0 ? Infinity : -Infinity;
    if (vb === null) vb = sortDir > 0 ? Infinity : -Infinity;
    const primary = (va > vb ? 1 : va < vb ? -1 : 0) * sortDir;
    if (primary !== 0) return primary;
    if (sortKey2) {
      const va2 = a[sortKey2], vb2 = b[sortKey2];
      return ((va2 > vb2 ? 1 : va2 < vb2 ? -1 : 0)) * sortDir;
    }
    return 0;
  });

  // Stats cards
  const latestByChannel = {};
  for (const r of data) {
    const cur = latestByChannel[r.channel];
    if (!cur || r.year * 100 + r.month > cur.year * 100 + cur.month) latestByChannel[r.channel] = r;
  }
  const statsEl = document.getElementById('stats');
  statsEl.innerHTML = Object.values(latestByChannel).map(r => \`
    <div class="stat-card">
      <div class="stat-ch">\${r.label}</div>
      <div class="stat-cpm">$\${r.cpm.toFixed(2)}</div>
      <div class="stat-chg">\${pctHtml(r.mom)} MoM &nbsp;\${pctHtml(r.yoy)} YoY</div>
      <div class="stat-period">\${r.period}</div>
    </div>
  \`).join('');

  // Table
  document.getElementById('count').textContent = \`Showing \${data.length} data points\`;
  document.getElementById('tbody').innerHTML = data.map(r => \`
    <tr>
      <td>\${r.period}</td>
      <td><span class="tag">\${r.label}</span></td>
      <td class="right" style="font-weight:600;color:#60a5fa;">$\${r.cpm.toFixed(2)}</td>
      <td class="right">\${pctHtml(r.mom)}</td>
      <td class="right">\${pctHtml(r.yoy)}</td>
    </tr>
  \`).join('') || '<tr><td colspan="5" style="text-align:center;color:#475569;padding:20px;">No data matches the selected filters</td></tr>';

  // Sort indicators
  ['period','channel','cpm','mom','yoy'].forEach(k => {
    const el = document.getElementById('s-' + k);
    if (el) el.textContent = '';
  });
  const skName = sortKey === 'year' ? 'period' : sortKey;
  const ind = document.getElementById('s-' + skName);
  if (ind) ind.textContent = sortDir > 0 ? ' ▲' : ' ▼';
}

function sortBy(key, key2) {
  if (sortKey === key) { sortDir *= -1; }
  else { sortKey = key; sortKey2 = key2 ?? null; sortDir = key === 'year' ? -1 : 1; }
  render();
}

function selectAll() {
  document.querySelectorAll('.yr-cb,.mo-cb,.ch-cb').forEach(e => e.checked = true);
  render();
}
function clearAll() {
  document.querySelectorAll('.yr-cb,.mo-cb,.ch-cb').forEach(e => e.checked = false);
  render();
}

document.querySelectorAll('.yr-cb,.mo-cb,.ch-cb').forEach(e => e.addEventListener('change', render));

// ── Chart.js line chart ───────────────────────────────────────────────────────
const CHART_COLORS = {
  paid_social:           '#3b82f6',
  paid_search:           '#22c55e',
  programmatic_display:  '#f59e0b',
  video_ctv:             '#a855f7',
  streaming_audio:       '#ec4899',
};

let cpmChart = null;

function buildChartData(data) {
  // All unique periods, sorted chronologically
  const allPeriods = [...new Set(data.map(r => r.year * 100 + r.month))]
    .sort((a, b) => a - b);
  const labels = allPeriods.map(ps => {
    const mo = ps % 100, yr = Math.floor(ps / 100);
    const months = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return \`\${months[mo]} \${yr}\`;
  });

  // One dataset per channel (in filter)
  const activeChs = [...document.querySelectorAll('.ch-cb:checked')].map(e => e.value);
  const datasets = activeChs.map(ch => {
    const byPeriod = {};
    for (const r of data) {
      if (r.channel === ch) byPeriod[r.year * 100 + r.month] = r.cpm;
    }
    const chLabel = data.find(r => r.channel === ch)?.label ?? ch;
    return {
      label: chLabel,
      data: allPeriods.map(ps => byPeriod[ps] ?? null),
      borderColor: CHART_COLORS[ch] ?? '#94a3b8',
      backgroundColor: (CHART_COLORS[ch] ?? '#94a3b8') + '22',
      tension: 0.3,
      spanGaps: true,
      fill: false,
      pointRadius: 3,
      pointHoverRadius: 6,
    };
  });
  return { labels, datasets };
}

function updateChart(data) {
  const { labels, datasets } = buildChartData(data);
  const ctx = document.getElementById('cpmChart').getContext('2d');
  if (cpmChart) {
    cpmChart.data.labels = labels;
    cpmChart.data.datasets = datasets;
    cpmChart.update();
    return;
  }
  cpmChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          labels: { color: '#94a3b8', font: { size: 11 }, boxWidth: 12, padding: 14 }
        },
        tooltip: {
          backgroundColor: '#1e293b',
          titleColor: '#f1f5f9',
          bodyColor: '#cbd5e1',
          borderColor: '#334155',
          borderWidth: 1,
          callbacks: {
            label: ctx => \` \${ctx.dataset.label}: \$\${ctx.parsed.y?.toFixed(2) ?? '—'} CPM\`
          }
        }
      },
      scales: {
        x: {
          ticks: { color: '#64748b', font: { size: 10 }, maxRotation: 45 },
          grid:  { color: '#1e293b' }
        },
        y: {
          ticks: {
            color: '#64748b',
            font: { size: 10 },
            callback: v => \`\$\${v.toFixed(0)}\`
          },
          grid: { color: '#1e293b' },
          title: { display: true, text: 'CPM (USD)', color: '#475569', font: { size: 11 } }
        }
      }
    }
  });
}

// Initial chart render (also called by render() below via the getFilters + filter step)
render();
</script>
</body>
</html>`
}

// ── Resend email (free REST API — no SMTP, no OAuth, works with passkeys) ────────
async function sendEmail(subject, html, attachments = []) {
  if (!CONFIG.resendApiKey) {
    console.warn("RESEND_API_KEY not set — skipping email")
    console.warn("Get a free key at: resend.com → sign up → API Keys → Create API Key")
    return
  }

  const body = {
    from:    "CPM Report Agent <onboarding@resend.dev>",
    to:      [CONFIG.emailTo],
    subject,
    html,
  }
  if (CONFIG.emailCc.length > 0) body.cc = CONFIG.emailCc

  if (attachments.length > 0) {
    body.attachments = attachments.map(a => ({
      filename: a.filename,
      content:  a.content,   // base64 string — Resend accepts it directly
    }))
  }

  const res = await post(
    "https://api.resend.com/emails",
    { "Authorization": `Bearer ${CONFIG.resendApiKey}`, "Content-Type": "application/json" },
    body
  )

  if (res.status >= 200 && res.status < 300) {
    const data = JSON.parse(res.body)
    console.log(`✅ Email sent to ${CONFIG.emailTo} (Resend ID: ${data.id})`)
  } else {
    console.warn(`❌ Resend error ${res.status}: ${res.body.slice(0, 200)}`)
    if (res.status === 401) console.warn("   → API key invalid — check RESEND_API_KEY in .env")
    if (res.status === 422) console.warn("   → Unprocessable — verify EMAIL_TO address is correct")
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const now = new Date()
  const runDate = now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })
  const isFirstOfMonth = now.getDate() === 1 || CONFIG.forceUpdate

  console.log("=".repeat(60))
  console.log("CPM Report Agent —", runDate)
  console.log("=".repeat(60))

  // Validate required config
  const required = { braveApiKey: "BRAVE_API_KEY", resendApiKey: "RESEND_API_KEY" }
  const missing = Object.entries(required).filter(([k]) => !CONFIG[k]).map(([, v]) => v)
  if (missing.length > 0) {
    console.error("Missing required env vars:", missing.join(", "))
    console.error("Add them to .env in the script directory or set them in your shell.")
    process.exit(1)
  }

  // ── Step 1: Query historical CPM data ────────────────────────────────────
  console.log("\n[1/5] Querying local CPM database…")
  const historicalRows = await queryLocalData()
  console.log(`      Found ${historicalRows.length} historical data points`)

  // ── Step 2: Search for new verified CPM data (1st of month only) ─────────
  const verifiedNewData = []
  if (isFirstOfMonth) {
    const prevMonth = now.getMonth() === 0 ? 12 : now.getMonth()
    const prevYear  = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear()
    console.log(`\n[2/5] Searching for verified ${MONTH_NAMES[prevMonth]} ${prevYear} CPM data…`)

    for (const { key: channel, label } of CHANNELS) {
      console.log(`      Searching: ${label}…`)
      const findings = await findVerifiedCpm(label, prevMonth, prevYear)
      const extracted = await extractCpmWithLlm(label, prevMonth, prevYear, findings)
      if (extracted) {
        verifiedNewData.push({ channel, month: prevMonth, year: prevYear, ...extracted })
        console.log(`      ✅ ${label}: $${extracted.cpm} CPM`)
      } else {
        console.log(`      ⚠️  ${label}: no verifiable data found`)
      }
    }

    // Update GitHub CSV
    if (verifiedNewData.length > 0) {
      console.log(`\n[3/5] Committing ${verifiedNewData.length} verified rows to GitHub…`)
      await updateGitHubCsv(verifiedNewData)
    } else {
      console.log("\n[3/5] No verified data to commit — sending notification email…")
      await sendEmail(
        `⚠️ CPM Agent — No verified data found for ${MONTH_NAMES[prevMonth]} ${prevYear}`,
        `<p>The CPM Report Agent could not find independently verified CPM data for <strong>${MONTH_NAMES[prevMonth]} ${prevYear}</strong>.</p>
         <p>No data was committed to the database. Check manually at:</p>
         <ul><li><a href="https://www.adsposure.com">adsposure.com</a></li>
             <li><a href="https://www.emarketer.com">emarketer.com</a></li>
             <li><a href="https://wordstream.com">wordstream.com</a></li></ul>`
      )
      return
    }
  } else {
    console.log("\n[2/5] Not the 1st of month — skipping new data search")
    console.log("[3/5] Skipping GitHub update")
  }

  // ── Step 3: Web research for market context ───────────────────────────────
  console.log("\n[4/5] Researching current market conditions…")
  const webFindings = []
  const queries = [
    "digital advertising CPM benchmarks 2025 2026 trends",
    "paid social CPM Meta Facebook Instagram 2026",
    "CTV streaming advertising CPM rates 2026",
  ]
  for (const q of queries) {
    const results = await braveSearch(q, 3)
    for (const r of results.slice(0, 2)) {
      const text = r.url ? await fetchPageText(r.url) : ""
      webFindings.push({ title: r.title ?? "", url: r.url ?? "", excerpt: r.description ?? "", text })
    }
  }
  console.log(`      Found ${webFindings.length} web sources`)

  // ── Step 4: AI synthesis (optional) ──────────────────────────────────────
  let aiInsights = null
  let synthesisInputTokens  = 0
  let synthesisOutputTokens = 0
  if (CONFIG.anthropicKey) {
    console.log("\n[4b] Running AI synthesis via Claude…")
    aiInsights = await synthesizeInsights(historicalRows, webFindings)
    if (aiInsights) {
      synthesisInputTokens  = aiInsights._inputTokens  ?? 0
      synthesisOutputTokens = aiInsights._outputTokens ?? 0
      console.log(`     AI insights generated (${synthesisInputTokens} in / ${synthesisOutputTokens} out tokens)`)
    } else {
      console.log("     AI synthesis skipped (no key or failed)")
    }
  }

  // ── Step 5: Build report and send email ───────────────────────────────────
  console.log("\n[5/5] Generating report and sending email…")
  const allRows = [...historicalRows, ...verifiedNewData.map(r => ({
    channel: r.channel, year: r.year, month: r.month, avg_cpm: r.cpm, period_sort: r.year * 100 + r.month
  }))]

  // ── Update agent metrics ──────────────────────────────────────────────────
  const runOutcome = verifiedNewData.length > 0 ? "autonomous"
                   : isFirstOfMonth              ? "hitl"
                   : "autonomous"  // non-1st runs are always autonomous (reporting only)
  const prevMetrics = loadMetrics()
  const thisRunRecord = {
    date:           now.toISOString().slice(0, 10),
    outcome:        runOutcome,
    inputTokens:    synthesisInputTokens,
    outputTokens:   synthesisOutputTokens,
    dataPointsFound: verifiedNewData.length,
  }
  const updatedMetrics = {
    totalRuns:          prevMetrics.totalRuns + 1,
    autonomousRuns:     prevMetrics.autonomousRuns + (runOutcome === "autonomous" ? 1 : 0),
    hitlRuns:           prevMetrics.hitlRuns       + (runOutcome === "hitl"       ? 1 : 0),
    errorRuns:          prevMetrics.errorRuns,
    totalInputTokens:   prevMetrics.totalInputTokens  + synthesisInputTokens,
    totalOutputTokens:  prevMetrics.totalOutputTokens + synthesisOutputTokens,
    runHistory:         [...(prevMetrics.runHistory ?? []).slice(-29), thisRunRecord],
  }
  const logDir = path.resolve(__dirname, "../../logs")
  const dashboardPath = path.join(logDir, "cpm-dashboard.html")
  try {
    const { mkdirSync } = await import("fs")
    mkdirSync(logDir, { recursive: true })
    await saveMetricsAsync(updatedMetrics)
    console.log(`      Metrics saved: ${METRICS_PATH}`)
  } catch (e) {
    console.warn("      Could not save metrics:", e.message)
  }
  const metricsSection = buildEmailMetricsSection(updatedMetrics, thisRunRecord)

  // Save interactive dashboard to disk
  try {
    const { mkdirSync } = await import("fs")
    mkdirSync(logDir, { recursive: true })
    writeFileSync(dashboardPath, buildInteractiveDashboard(allRows, runDate, aiInsights), "utf-8")
    console.log(`      Dashboard saved: ${dashboardPath}`)
  } catch (e) {
    console.warn("      Could not save dashboard:", e.message)
  }

  const html    = buildHtmlReport(allRows, webFindings, aiInsights, verifiedNewData, runDate, dashboardPath, metricsSection)
  const subject = `📊 CPM Month-over-Month Report — ${runDate}`

  // Attach the interactive dashboard HTML
  const attachments = []
  if (existsSync(dashboardPath)) {
    const dashContent = readFileSync(dashboardPath, "utf-8")
    attachments.push({
      content:     Buffer.from(dashContent, "utf-8").toString("base64"),
      type:        "text/html",
      filename:    "CPM-Dashboard.html",
      disposition: "attachment",
    })
    console.log("      Dashboard attached to email")
  }

  await sendEmail(subject, html, attachments)

  console.log("\n" + "=".repeat(60))
  console.log("✅ Done")
  console.log("=".repeat(60))
}

main().catch(err => {
  console.error("Fatal error:", err)
  process.exit(1)
})
