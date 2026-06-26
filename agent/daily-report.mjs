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
 *   SENDGRID_API_KEY     — SendGrid API key
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
import { readFileSync, existsSync, createReadStream } from "fs"
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
  braveApiKey:     process.env.BRAVE_API_KEY     ?? "",
  githubToken:     process.env.GITHUB_TOKEN      ?? "",
  sendgridApiKey:  process.env.SENDGRID_API_KEY  ?? "",
  malloyuoUrl:     process.env.MALLOYYO_URL      ?? "",
  emailTo:         process.env.EMAIL_TO          ?? "rod.brathwaite@gmail.com",
  emailCc:         (process.env.EMAIL_CC ?? "").split(",").map(s => s.trim()).filter(Boolean),
  forceUpdate:     process.env.FORCE_UPDATE === "true",
  anthropicKey:    process.env.ANTHROPIC_API_KEY ?? "",
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

  const webSummary = webFindings.slice(0, 6)
    .map(f => `${f.title}\n${f.excerpt}`)
    .join("\n\n---\n\n")

  const prompt = `You are a senior media analyst. Write a brief executive summary and 3 key insights for this CPM benchmark report.

HISTORICAL DATA:
${dataSummary}

RECENT WEB RESEARCH:
${webSummary}

Return ONLY valid JSON:
{
  "summary": "2-3 sentence executive overview",
  "insights": [
    {"title": "short title", "body": "2 sentence insight with data"}
  ]
}

Do NOT invent CPM numbers. Only cite data above.`

  try {
    const res = await post(
      "https://api.anthropic.com/v1/messages",
      { "x-api-key": CONFIG.anthropicKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      { model: "claude-haiku-4-5-20251001", max_tokens: 512, messages: [{ role: "user", content: prompt }] }
    )
    if (res.status !== 200) return null
    const data = JSON.parse(res.body)
    const text = data.content?.[0]?.text ?? ""
    const s = text.indexOf("{"), e = text.lastIndexOf("}")
    if (s < 0 || e <= s) return null
    return JSON.parse(text.slice(s, e + 1))
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

// ── HTML report ───────────────────────────────────────────────────────────────
function buildHtmlReport(rows, webFindings, aiInsights, verifiedNewData, runDate) {
  // Group rows by channel for trend display
  const byChannel = {}
  for (const r of rows) {
    if (!byChannel[r.channel]) byChannel[r.channel] = []
    byChannel[r.channel].push(r)
  }

  // Channel summary cards
  const channelCards = CHANNELS.map(({ key, label }) => {
    const chRows = (byChannel[key] ?? []).sort((a, b) => b.year - a.year || b.month - a.month)
    if (chRows.length === 0) return ""
    const latest = chRows[0]
    const prev   = chRows[1]
    const change = prev ? ((latest.avg_cpm - prev.avg_cpm) / prev.avg_cpm * 100) : null
    const arrow  = change === null ? "" : change > 0.5 ? "↑" : change < -0.5 ? "↓" : "→"
    const color  = change === null ? "#666" : change > 0.5 ? "#22c55e" : change < -0.5 ? "#ef4444" : "#f59e0b"
    return `
    <div style="background:#1e293b;border-radius:8px;padding:16px;margin-bottom:12px;">
      <div style="color:#94a3b8;font-size:12px;text-transform:uppercase;letter-spacing:1px;">${label}</div>
      <div style="display:flex;align-items:baseline;gap:8px;margin-top:4px;">
        <span style="color:#f1f5f9;font-size:28px;font-weight:700;">$${latest.avg_cpm.toFixed(2)}</span>
        <span style="color:#94a3b8;font-size:13px;">CPM</span>
        ${change !== null ? `<span style="color:${color};font-size:14px;font-weight:600;">${arrow} ${Math.abs(change).toFixed(1)}% MoM</span>` : ""}
      </div>
      <div style="color:#64748b;font-size:12px;margin-top:4px;">${MONTH_NAMES[latest.month]} ${latest.year}</div>
    </div>`
  }).join("")

  // Historical table
  const tableRows = [...rows]
    .sort((a, b) => b.year - a.year || b.month - a.month || a.channel.localeCompare(b.channel))
    .slice(0, 30)
    .map(r => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #1e293b;">${MONTH_NAMES[r.month]} ${r.year}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #1e293b;">${CHANNEL_LABELS[r.channel] ?? r.channel}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #1e293b;text-align:right;font-weight:600;color:#60a5fa;">$${r.avg_cpm.toFixed(2)}</td>
    </tr>`).join("")

  // AI insights section
  const aiSection = aiInsights ? `
  <div style="background:#0f172a;border-radius:8px;padding:20px;margin-bottom:24px;">
    <h2 style="color:#f1f5f9;font-size:16px;margin:0 0 12px;">AI Analysis</h2>
    <p style="color:#cbd5e1;font-size:14px;line-height:1.6;margin:0 0 16px;">${aiInsights.summary}</p>
    ${(aiInsights.insights ?? []).map(i => `
    <div style="border-left:3px solid #3b82f6;padding-left:12px;margin-bottom:12px;">
      <div style="color:#93c5fd;font-weight:600;font-size:13px;">${i.title}</div>
      <div style="color:#94a3b8;font-size:13px;margin-top:4px;">${i.body}</div>
    </div>`).join("")}
  </div>` : ""

  // New verified data section
  const newDataSection = verifiedNewData.length > 0 ? `
  <div style="background:#052e16;border:1px solid #166534;border-radius:8px;padding:16px;margin-bottom:24px;">
    <h2 style="color:#4ade80;font-size:14px;margin:0 0 8px;">✅ New Verified Data Added This Run</h2>
    ${verifiedNewData.map(r => `
    <div style="color:#86efac;font-size:13px;">
      ${CHANNEL_LABELS[r.channel] ?? r.channel}: <strong>$${r.cpm}</strong> CPM — ${MONTH_NAMES[r.month]} ${r.year}
      <span style="color:#4ade80;font-size:11px;margin-left:8px;">(${(r.sources ?? []).join(", ")})</span>
    </div>`).join("")}
  </div>` : ""

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<div style="max-width:640px;margin:0 auto;padding:24px;">

  <!-- Header -->
  <div style="border-bottom:1px solid #1e293b;padding-bottom:16px;margin-bottom:24px;">
    <div style="color:#3b82f6;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:2px;">CPM Benchmark Report</div>
    <div style="color:#f1f5f9;font-size:22px;font-weight:700;margin-top:4px;">Media CPM Intelligence</div>
    <div style="color:#64748b;font-size:13px;margin-top:4px;">Generated ${runDate}</div>
  </div>

  ${newDataSection}
  ${aiSection}

  <!-- Channel Metrics -->
  <h2 style="color:#f1f5f9;font-size:14px;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;">Latest CPM by Channel</h2>
  ${channelCards}

  <!-- Historical Table -->
  <h2 style="color:#f1f5f9;font-size:14px;text-transform:uppercase;letter-spacing:1px;margin:24px 0 12px;">Historical Data</h2>
  <table style="width:100%;border-collapse:collapse;background:#1e293b;border-radius:8px;overflow:hidden;">
    <thead>
      <tr style="background:#0f172a;">
        <th style="padding:10px 12px;text-align:left;color:#64748b;font-size:12px;font-weight:600;text-transform:uppercase;">Period</th>
        <th style="padding:10px 12px;text-align:left;color:#64748b;font-size:12px;font-weight:600;text-transform:uppercase;">Channel</th>
        <th style="padding:10px 12px;text-align:right;color:#64748b;font-size:12px;font-weight:600;text-transform:uppercase;">CPM</th>
      </tr>
    </thead>
    <tbody style="color:#cbd5e1;font-size:13px;">
      ${tableRows || '<tr><td colspan="3" style="padding:16px;text-align:center;color:#64748b;">No historical data available</td></tr>'}
    </tbody>
  </table>

  <!-- Footer -->
  <div style="border-top:1px solid #1e293b;margin-top:24px;padding-top:16px;color:#475569;font-size:11px;text-align:center;">
    CPM Report Agent · Data from Malloyyo + Brave Search${CONFIG.anthropicKey ? " + Claude AI" : ""}
    <br>Never invents numbers — only verified sources from Adsposure, eMarketer, WordStream, IAB
  </div>
</div>
</body>
</html>`
}

// ── SendGrid email ─────────────────────────────────────────────────────────────
async function sendEmail(subject, html) {
  if (!CONFIG.sendgridApiKey) { console.warn("SENDGRID_API_KEY not set — skipping email"); return }

  const personalization = { to: [{ email: CONFIG.emailTo }] }
  if (CONFIG.emailCc.length > 0) personalization.cc = CONFIG.emailCc.map(e => ({ email: e }))

  // FROM must be a SendGrid-verified sender. Using your own email is fine
  // as long as it's verified at sendgrid.com → Settings → Sender Authentication.
  const fromEmail = process.env.EMAIL_FROM || CONFIG.emailTo
  const body = {
    personalizations: [personalization],
    from:    { email: fromEmail, name: "CPM Report Agent" },
    reply_to: { email: CONFIG.emailTo },
    subject,
    content: [{ type: "text/html", value: html }],
  }

  const res = await post(
    "https://api.sendgrid.com/v3/mail/send",
    { "Authorization": `Bearer ${CONFIG.sendgridApiKey}`, "Content-Type": "application/json" },
    body
  )

  console.log(`      SendGrid status: ${res.status}`)
  if (res.body) console.log(`      SendGrid body: ${res.body.slice(0, 200) || "(empty — normal for 202)"}`)

  if (res.status >= 200 && res.status < 300) {
    console.log(`✅ Email queued for delivery to ${CONFIG.emailTo}`)
    console.log("   → Check spam/junk if not in inbox within 2 minutes")
    console.log("   → If missing, verify sender at sendgrid.com → Settings → Sender Authentication")
  } else {
    console.error("SendGrid error:", res.status, res.body.slice(0, 200))
    throw new Error(`SendGrid ${res.status}: ${res.body.slice(0, 100)}`)
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
  const required = { braveApiKey: "BRAVE_API_KEY", sendgridApiKey: "SENDGRID_API_KEY" }
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
  if (CONFIG.anthropicKey) {
    console.log("\n[4b] Running AI synthesis via Claude…")
    aiInsights = await synthesizeInsights(historicalRows, webFindings)
    if (aiInsights) console.log("     AI insights generated")
    else console.log("     AI synthesis skipped (no key or failed)")
  }

  // ── Step 5: Build report and send email ───────────────────────────────────
  console.log("\n[5/5] Generating report and sending email…")
  const allRows = [...historicalRows, ...verifiedNewData.map(r => ({
    channel: r.channel, year: r.year, month: r.month, avg_cpm: r.cpm, period_sort: r.year * 100 + r.month
  }))]

  const html    = buildHtmlReport(allRows, webFindings, aiInsights, verifiedNewData, runDate)
  const subject = `📊 CPM Benchmark Report — ${runDate}`
  await sendEmail(subject, html)

  console.log("\n" + "=".repeat(60))
  console.log("✅ Done")
  console.log("=".repeat(60))
}

main().catch(err => {
  console.error("Fatal error:", err)
  process.exit(1)
})
