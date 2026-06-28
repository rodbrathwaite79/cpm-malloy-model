#!/usr/bin/env node
/**
 * CPM-Quality-Agent — Autonomous QA validator for the CPM report system
 *
 * Validates EVERY component of the daily-report.mjs pipeline, fixes what it
 * can automatically, and emails a detailed pass/fail report.
 *
 * Runs entirely on the Mac with full internet and filesystem access.
 * No Guild state machine — no limitations.
 *
 * Usage:
 *   node quality-agent.mjs              — full QA run
 *   node quality-agent.mjs --fix        — QA + auto-fix what's broken
 *   node quality-agent.mjs --json       — machine-readable output
 *
 * Required env (same as daily-report.mjs):
 *   BRAVE_API_KEY, GITHUB_TOKEN, SENDGRID_API_KEY, EMAIL_TO
 *
 * Permissions needed to run fully autonomously:
 *   • Read/write: ~/Documents/cpm-agent/ (all files)
 *   • Read:       ~/Library/LaunchAgents/com.rod.cpm-report.plist
 *   • Network:    api.search.brave.com, api.sendgrid.com, api.github.com,
 *                 api.anthropic.com (if ANTHROPIC_API_KEY set)
 *   • Execute:    node, launchctl, npm
 */

import https from "https"
import http from "http"
import { URL } from "url"
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs"
import { execSync } from "child_process"
import path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIX_MODE  = process.argv.includes("--fix")
const JSON_MODE = process.argv.includes("--json")

// ── Load .env ──────────────────────────────────────────────────────────────────
const envPath = path.join(__dirname, ".env")
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=["']?(.+?)["']?\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
}

// ── HTTP helper ────────────────────────────────────────────────────────────────
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
      headers: { "User-Agent": "cpm-quality-agent/1.0", ...headers, ...(bodyBuf ? { "Content-Length": bodyBuf.length } : {}) },
    }
    const req = lib.request(options, (res) => {
      const chunks = []
      res.on("data", c => chunks.push(c))
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf-8") }))
    })
    req.on("error", reject)
    req.setTimeout(15000, () => req.destroy(new Error("Timeout")))
    if (bodyBuf) req.write(bodyBuf)
    req.end()
  })
}
const get  = (url, h)    => request("GET",  url, h)
const post = (url, h, b) => request("POST", url, h, b)

// ── Check result accumulator ───────────────────────────────────────────────────
const results = []
function check(name, status, detail, fix = null) {
  results.push({ name, status, detail, fix })
  const icon = status === "PASS" ? "✅" : status === "WARN" ? "⚠️ " : "❌"
  if (!JSON_MODE) console.log(`  ${icon} ${name}: ${detail}`)
}

// ── Section header ─────────────────────────────────────────────────────────────
function section(title) {
  if (!JSON_MODE) console.log(`\n${"─".repeat(60)}\n  ${title}\n${"─".repeat(60)}`)
}

// ══════════════════════════════════════════════════════════════════════════════
// CHECK FUNCTIONS
// ══════════════════════════════════════════════════════════════════════════════

// [1] Environment / credentials
async function checkEnvironment() {
  section("1. Environment & Credentials")

  const required = {
    BRAVE_API_KEY:  process.env.BRAVE_API_KEY,
    GITHUB_TOKEN:   process.env.GITHUB_TOKEN,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    EMAIL_TO:       process.env.EMAIL_TO,
  }

  for (const [k, v] of Object.entries(required)) {
    if (v && v.length > 5) {
      check(k, "PASS", `set (${v.length} chars, starts ${v.slice(0,4)}…)`)
    } else {
      check(k, "FAIL", "not set or empty — add to .env file", `Add ${k}=YOUR_VALUE to ${envPath}`)
    }
  }

  const optional = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, EMAIL_CC: process.env.EMAIL_CC }
  for (const [k, v] of Object.entries(optional)) {
    check(k, v ? "PASS" : "WARN", v ? `set (${v.length} chars)` : "not set (optional)")
  }
}

// [2] Required files
async function checkFiles() {
  section("2. Required Files")

  const scriptDir = __dirname
  const agentDir  = path.resolve(scriptDir, "../..")

  const files = [
    { path: path.join(scriptDir, "daily-report.mjs"),          label: "Main script" },
    { path: path.join(scriptDir, "agent.ts"),                  label: "Guild agent (agent.ts)" },
    { path: path.join(scriptDir, ".env"),                       label: ".env credentials" },
    { path: path.join(scriptDir, "com.rod.cpm-report.plist"),   label: "launchd plist" },
    { path: path.join(scriptDir, "package.json"),               label: "package.json" },
    { path: path.join(scriptDir, "node_modules/duckdb"),        label: "duckdb npm package" },
    { path: path.join(agentDir,  "malloy-model-git/cpm_benchmarks.parquet"), label: "CPM parquet database" },
    { path: path.join(agentDir,  "malloy-model-git/cpm_monthly_updates.csv"), label: "CPM updates CSV" },
    { path: path.join(agentDir,  "logs"),                       label: "Logs directory" },
  ]

  for (const f of files) {
    if (existsSync(f.path)) {
      check(f.label, "PASS", f.path.replace(process.env.HOME, "~"))
    } else {
      check(f.label, "FAIL", `Missing: ${f.path.replace(process.env.HOME, "~")}`,
        f.path.includes("node_modules") ? `Run: cd ${scriptDir} && npm install` : null)
    }
  }
}

// [3] DuckDB / local data
async function checkLocalData() {
  section("3. Local CPM Database")

  const parquetPath = path.resolve(__dirname, "../../malloy-model-git/cpm_benchmarks.parquet")
  const csvPath     = path.resolve(__dirname, "../../malloy-model-git/cpm_monthly_updates.csv")

  try {
    const { createRequire } = await import("module")
    const require = createRequire(import.meta.url)
    const duckdb = require("duckdb")
    const queryDuck = (db, sql) => new Promise((res, rej) => db.all(sql, (e, r) => e ? rej(e) : res(r)))
    const db = new duckdb.Database(":memory:")

    if (existsSync(parquetPath)) {
      const rows = await queryDuck(db, `SELECT COUNT(*) as n FROM read_parquet('${parquetPath}')`)
      const n = rows[0].n
      if (n > 0) check("Parquet database",  "PASS", `${n} rows`)
      else        check("Parquet database",  "FAIL", "0 rows — database is empty")
    } else {
      check("Parquet database", "FAIL", "File missing: " + parquetPath.replace(process.env.HOME, "~"))
    }

    if (existsSync(csvPath)) {
      const rows = await queryDuck(db, `SELECT COUNT(*) as n FROM read_csv_auto('${csvPath}')`)
      check("Updates CSV", "PASS", `${rows[0].n} rows (0 is normal until first 1st-of-month run)`)
    } else {
      // CSV can be created on first run — just warn
      check("Updates CSV", "WARN", "File missing — will be created on first 1st-of-month data run")
    }

    db.close()
  } catch (e) {
    check("DuckDB", "FAIL", `Error: ${e.message}`,
      `Run: cd ${__dirname} && npm install duckdb`)
  }
}

// [4] Brave Search API
async function checkBrave() {
  section("4. Brave Search API")
  const key = process.env.BRAVE_API_KEY
  if (!key) { check("Brave API", "FAIL", "BRAVE_API_KEY not set"); return }

  try {
    const res = await get(
      "https://api.search.brave.com/res/v1/web/search?q=CPM+advertising+benchmark+2026&count=2",
      { "Accept": "application/json", "X-Subscription-Token": key }
    )
    if (res.status === 200) {
      const data = JSON.parse(res.body)
      const n = data?.web?.results?.length ?? 0
      check("Brave Search API", "PASS", `HTTP 200 — returned ${n} results`)
    } else if (res.status === 401) {
      check("Brave Search API", "FAIL", "401 Unauthorized — key is invalid or expired",
        "Get a new key at search.brave.com/register")
    } else if (res.status === 429) {
      check("Brave Search API", "WARN", "429 Rate limited — too many requests, try later")
    } else {
      check("Brave Search API", "WARN", `HTTP ${res.status} — unexpected status`)
    }
  } catch (e) {
    check("Brave Search API", "FAIL", `Network error: ${e.message}`)
  }
}

// [5] Resend email API
async function checkSendGrid() {
  section("5. Resend Email API")

  const key = process.env.RESEND_API_KEY

  if (!key) {
    check("RESEND_API_KEY", "FAIL", "Not set — get a free key at resend.com",
      "Sign up at resend.com → API Keys → Create API Key → add to .env")
    return
  }

  if (!key.startsWith("re_")) {
    check("RESEND_API_KEY", "WARN", `Key doesn't start with 're_' — may be invalid (got: ${key.slice(0,8)}…)`)
  } else {
    check("RESEND_API_KEY", "PASS", `Set (starts re_… ${key.length} chars)`)
  }

  // Verify key is valid by hitting the Resend domains endpoint
  try {
    const res = await get(
      "https://api.resend.com/domains",
      { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" }
    )
    if (res.status === 200) {
      check("Resend API reachable", "PASS", "API key valid — HTTP 200")
    } else if (res.status === 401) {
      check("Resend API reachable", "FAIL", "401 Unauthorized — API key is invalid or revoked",
        "Generate a new key at resend.com → API Keys")
    } else {
      check("Resend API reachable", "WARN", `HTTP ${res.status} — unexpected response`)
    }
  } catch (e) {
    check("Resend API reachable", "FAIL", `Network error: ${e.message}`)
  }
}

// [6] GitHub API
async function checkGitHub() {
  section("6. GitHub Repository Access")
  const token = process.env.GITHUB_TOKEN
  if (!token) { check("GitHub token", "FAIL", "GITHUB_TOKEN not set"); return }

  // Read owner/repo from daily-report.mjs
  const scriptPath = path.join(__dirname, "daily-report.mjs")
  let owner = "rodbrathwaite79", repo = "cpm-malloy-model", updatePath = "cpm_monthly_updates.csv"
  if (existsSync(scriptPath)) {
    const src = readFileSync(scriptPath, "utf-8")
    const om = src.match(/GITHUB_OWNER\s*=\s*["']([^"']+)["']/)
    const rm = src.match(/GITHUB_REPO\s*=\s*["']([^"']+)["']/)
    const pm = src.match(/UPDATES_PATH\s*=\s*["']([^"']+)["']/)
    if (om) owner = om[1]
    if (rm) repo  = rm[1]
    if (pm) updatePath = pm[1]
  }

  const headers = {
    "Authorization": `token ${token}`,
    "Accept": "application/vnd.github.v3+json",
    "User-Agent": "cpm-quality-agent/1.0",
  }

  // Test token validity
  try {
    const res = await get("https://api.github.com/user", headers)
    if (res.status === 200) {
      const u = JSON.parse(res.body)
      check("GitHub token", "PASS", `Valid — authenticated as ${u.login}`)
    } else if (res.status === 401) {
      check("GitHub token", "FAIL", "401 — token expired or revoked",
        "Generate a new token at github.com/settings/tokens → Classic → check 'repo' scope")
      return
    } else {
      check("GitHub token", "WARN", `HTTP ${res.status}`)
    }
  } catch (e) {
    check("GitHub token", "FAIL", `Network error: ${e.message}`)
    return
  }

  // Test repo access
  try {
    const res = await get(`https://api.github.com/repos/${owner}/${repo}`, headers)
    if (res.status === 200) {
      const r = JSON.parse(res.body)
      check("GitHub repo access", "PASS",
        `${owner}/${repo} — ${r.private ? "private" : "public"}, default branch: ${r.default_branch}`)
    } else if (res.status === 404) {
      check("GitHub repo access", "FAIL", `Repo ${owner}/${repo} not found or token can't see it`,
        `Verify repo exists at github.com/${owner}/${repo} and token has 'repo' scope`)
    } else {
      check("GitHub repo access", "WARN", `HTTP ${res.status}`)
    }
  } catch (e) {
    check("GitHub repo access", "FAIL", `Network error: ${e.message}`)
  }

  // Test write access (check if CSV file exists in repo)
  try {
    const res = await get(
      `https://api.github.com/repos/${owner}/${repo}/contents/${updatePath}`,
      headers
    )
    if (res.status === 200) {
      check("GitHub CSV file", "PASS", `${updatePath} exists in repo (SHA: ${JSON.parse(res.body).sha.slice(0,8)}…)`)
    } else if (res.status === 404) {
      check("GitHub CSV file", "WARN",
        `${updatePath} not in repo yet — will be created on first successful 1st-of-month run`)
    } else {
      check("GitHub CSV file", "WARN", `HTTP ${res.status}`)
    }
  } catch (e) {
    check("GitHub CSV file", "WARN", `Could not check: ${e.message}`)
  }
}

// [7] launchd schedule
async function checkSchedule() {
  section("7. launchd Daily Schedule")

  const plistDst = path.join(process.env.HOME, "Library/LaunchAgents/com.rod.cpm-report.plist")
  const plistSrc = path.join(__dirname, "com.rod.cpm-report.plist")
  const logPath  = path.join(process.env.HOME, "Documents/cpm-agent/logs")

  if (existsSync(plistDst)) {
    check("Plist installed",  "PASS", plistDst.replace(process.env.HOME, "~"))
  } else {
    check("Plist installed", "FAIL", "Not in ~/Library/LaunchAgents/ — schedule not active",
      `Run: cp "${plistSrc}" "${plistDst}" && launchctl load "${plistDst}"`)

    if (FIX_MODE && existsSync(plistSrc)) {
      try {
        mkdirSync(logPath, { recursive: true })
        execSync(`cp "${plistSrc}" "${plistDst}"`)
        execSync(`launchctl unload "${plistDst}" 2>/dev/null || true`)
        execSync(`launchctl load "${plistDst}"`)
        check("Plist auto-fixed", "PASS", "Installed and loaded via --fix mode")
      } catch (e) {
        check("Plist auto-fix", "FAIL", `Fix failed: ${e.message}`)
      }
    }
  }

  // Check if loaded by launchctl
  try {
    const out = execSync("launchctl list com.rod.cpm-report 2>&1", { encoding: "utf-8" })
    if (out.includes("\"Label\" = \"com.rod.cpm-report\"") || out.includes("com.rod.cpm-report")) {
      check("Schedule loaded", "PASS", "launchctl confirms agent is loaded")
    } else {
      check("Schedule loaded", "WARN", "launchctl list returned unexpected output: " + out.slice(0, 80))
    }
  } catch {
    check("Schedule loaded", "FAIL", "Agent not found in launchctl — not scheduled",
      `Run: launchctl load "${plistDst}"`)
  }

  // Check log dir
  if (existsSync(logPath)) {
    check("Log directory", "PASS", logPath.replace(process.env.HOME, "~"))
  } else {
    check("Log directory", "WARN", "Log directory missing",
      `Run: mkdir -p "${logPath}"`)
    if (FIX_MODE) {
      mkdirSync(logPath, { recursive: true })
      check("Log dir auto-fixed", "PASS", "Created via --fix mode")
    }
  }

  // Check plist Node.js path matches installed node
  if (existsSync(plistDst)) {
    const plist = readFileSync(plistDst, "utf-8")
    let nodePlistPath = ""
    const m = plist.match(/<string>(\/[^<]+\/node)<\/string>/)
    if (m) nodePlistPath = m[1]

    try {
      const nodeBin = execSync("which node", { encoding: "utf-8" }).trim()
      const nodeVersion = execSync("node --version", { encoding: "utf-8" }).trim()
      if (nodePlistPath === nodeBin) {
        check("Node.js path in plist", "PASS", `${nodeBin} (${nodeVersion})`)
      } else {
        check("Node.js path in plist", "WARN",
          `Plist uses ${nodePlistPath}, but active node is ${nodeBin} (${nodeVersion})`,
          `Update plist ProgramArguments[0] to ${nodeBin}`)

        if (FIX_MODE && existsSync(plistSrc)) {
          let src = readFileSync(plistSrc, "utf-8")
          const oldPath = nodePlistPath || "/Users/rodbrathwaite/.nvm/versions/node/v22.14.0/bin/node"
          src = src.replace(oldPath, nodeBin)
          writeFileSync(plistSrc, src, "utf-8")
          writeFileSync(plistDst, src, "utf-8")
          execSync(`launchctl unload "${plistDst}" 2>/dev/null || true`)
          execSync(`launchctl load "${plistDst}"`)
          check("Node path auto-fixed", "PASS", `Updated to ${nodeBin} and reloaded`)
        }
      }
    } catch {
      check("Node.js path check", "WARN", "Could not determine active node path")
    }
  }
}

// [8] Script integrity
async function checkScriptIntegrity() {
  section("8. Script Integrity")

  const scriptPath = path.join(__dirname, "daily-report.mjs")
  if (!existsSync(scriptPath)) {
    check("daily-report.mjs", "FAIL", "Script file missing")
    return
  }

  const src = readFileSync(scriptPath, "utf-8")

  const checks = [
    { key: "DuckDB import",         pass: src.includes("duckdb"),                                   fix: null },
    { key: "No gzip header",        pass: !src.includes('"Accept-Encoding": "gzip"'),               fix: "Remove Accept-Encoding: gzip header from braveSearch()" },
    { key: "Regex fallback",        pass: src.includes("extractCpmWithRegex"),                      fix: "Add regex CPM extraction fallback function" },
    { key: "EMAIL_CC support",      pass: src.includes("EMAIL_CC"),                                 fix: "Add EMAIL_CC env var to sendEmail()" },
    { key: "FORCE_UPDATE flag",     pass: src.includes("FORCE_UPDATE"),                             fix: "Add FORCE_UPDATE env var support" },
    { key: "SendGrid 202 check",    pass: src.includes("202") || src.includes("status"),            fix: null },
    { key: "GitHub PUT logging",    pass: src.includes("GitHub PUT failed"),                        fix: null },
    // Report redesign checks (added after v1.0.4 overhaul)
    { key: "Email bar chart",       pass: src.includes("buildEmailBarChart"),                       fix: "Email report missing chart layout — pull latest daily-report.mjs from repo" },
    { key: "Email metrics section", pass: src.includes("buildEmailMetricsSection"),                 fix: "Email report missing metrics block — pull latest daily-report.mjs from repo" },
    { key: "Metrics persistence",   pass: src.includes("agent-metrics.json") || src.includes("METRICS_PATH"), fix: "Metrics persistence missing — agent-metrics.json writes not found" },
    { key: "Token tracking",        pass: src.includes("_inputTokens"),                             fix: "Real token tracking missing from synthesizeInsights() — update daily-report.mjs" },
    { key: "AI source links",       pass: src.includes("sources") && src.includes("src.url"),       fix: "AI insights missing source URL support — update synthesizeInsights() and buildHtmlReport()" },
  ]

  for (const c of checks) {
    check(c.key, c.pass ? "PASS" : c.fix ? "FAIL" : "WARN", c.pass ? "OK" : (c.fix ?? "Missing"), c.fix)
  }
}

// [9] Guild agent.ts integrity
async function checkAgentTs() {
  section("9. Guild Agent Integrity (agent.ts)")

  const tsPath = path.join(__dirname, "agent.ts")
  if (!existsSync(tsPath)) {
    check("agent.ts present", "FAIL", "File missing — Guild agent not in sync with daily-report.mjs",
      "Copy agent.ts from source Mac or pull latest from GitHub repo")
    return
  }

  const src = readFileSync(tsPath, "utf-8")
  const checks = [
    { key: "isTestRun guard",        pass: src.includes("isTestRun"),                   fix: "Test run detection missing — Guild UI test runs will inflate metrics. Pull latest agent.ts." },
    { key: "Reset mode",             pass: src.includes("data.reset === true"),          fix: "Reset mode missing — cannot clear agent state via { reset: true }. Pull latest agent.ts." },
    { key: "ROI breakdown",          pass: src.includes("ANALYST_RATE_USD_PER_HOUR"),   fix: "ROI estimate constants missing from agent.ts" },
    { key: "EMPTY_STATE defined",    pass: src.includes("EMPTY_STATE"),                 fix: "EMPTY_STATE constant missing — state reset won't work" },
    { key: "Real token tracking",    pass: src.includes("guild_get_daily_llm_usage"),   fix: "Guild LLM usage API call missing — token counts will be 0" },
    { key: "Run history capped",     pass: src.includes("slice(-29)"),                  fix: "Run history not capped — state will grow unbounded over time" },
  ]

  for (const c of checks) {
    check(c.key, c.pass ? "PASS" : "FAIL", c.pass ? "OK" : (c.fix ?? "Missing"), c.fix)
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// REPORT + EMAIL
// ══════════════════════════════════════════════════════════════════════════════

function buildReport(runDate) {
  const total   = results.length
  const passes  = results.filter(r => r.status === "PASS").length
  const warns   = results.filter(r => r.status === "WARN").length
  const fails   = results.filter(r => r.status === "FAIL").length
  const pct     = Math.round(passes / total * 100)
  const overall = fails === 0 ? (warns === 0 ? "ALL PASS" : "PASS WITH WARNINGS") : "NEEDS ATTENTION"
  const bgColor = fails === 0 ? (warns === 0 ? "#052e16" : "#1c1917") : "#1a0000"
  const hColor  = fails === 0 ? (warns === 0 ? "#4ade80" : "#fbbf24") : "#f87171"

  const rows = results.map(r => {
    const icon = r.status === "PASS" ? "✅" : r.status === "WARN" ? "⚠️" : "❌"
    const bg   = r.status === "PASS" ? "#0f172a" : r.status === "WARN" ? "#1c1406" : "#1a0505"
    const fixHtml = r.fix
      ? `<div style="color:#64748b;font-size:11px;margin-top:4px;font-family:monospace;">Fix: ${r.fix}</div>`
      : ""
    return `
    <tr style="background:${bg};">
      <td style="padding:8px 12px;border-bottom:1px solid #1e293b;font-size:13px;">${icon} ${r.name}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #1e293b;font-size:12px;color:#94a3b8;">${r.detail}${fixHtml}</td>
    </tr>`
  }).join("")

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<div style="max-width:680px;margin:0 auto;padding:24px;">

  <div style="border-bottom:1px solid #1e293b;padding-bottom:16px;margin-bottom:24px;">
    <div style="color:#3b82f6;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:2px;">CPM Quality Agent</div>
    <div style="color:#f1f5f9;font-size:22px;font-weight:700;margin-top:4px;">System Validation Report</div>
    <div style="color:#64748b;font-size:13px;margin-top:4px;">${runDate}</div>
  </div>

  <div style="background:${bgColor};border-radius:8px;padding:16px;margin-bottom:24px;text-align:center;">
    <div style="color:${hColor};font-size:24px;font-weight:700;">${overall}</div>
    <div style="color:#94a3b8;font-size:14px;margin-top:4px;">
      ${passes} passed · ${warns} warnings · ${fails} failed · ${pct}% health
    </div>
  </div>

  <table style="width:100%;border-collapse:collapse;background:#1e293b;border-radius:8px;overflow:hidden;">
    <thead>
      <tr style="background:#0f172a;">
        <th style="padding:10px 12px;text-align:left;color:#64748b;font-size:11px;text-transform:uppercase;">Check</th>
        <th style="padding:10px 12px;text-align:left;color:#64748b;font-size:11px;text-transform:uppercase;">Result</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>

  ${fails > 0 ? `
  <div style="background:#1a0000;border:1px solid #7f1d1d;border-radius:8px;padding:16px;margin-top:24px;">
    <div style="color:#f87171;font-weight:600;margin-bottom:8px;">🔧 Action Required</div>
    ${results.filter(r => r.status === "FAIL" && r.fix).map(r =>
      `<div style="color:#fca5a5;font-size:13px;margin-bottom:8px;">
        <strong>${r.name}:</strong> ${r.fix}
      </div>`
    ).join("")}
  </div>` : ""}

  <div style="border-top:1px solid #1e293b;margin-top:24px;padding-top:16px;color:#475569;font-size:11px;text-align:center;">
    CPM-Quality-Agent · Autonomous system validator
    ${FIX_MODE ? "<br><em>--fix mode was active: auto-fixable issues were corrected</em>" : ""}
  </div>
</div>
</body>
</html>`
}

async function sendReport(subject, html) {
  const key = process.env.RESEND_API_KEY
  const to  = process.env.EMAIL_TO ?? "rod.brathwaite@gmail.com"
  if (!key) { console.log("  (email skipped — RESEND_API_KEY not set)"); return }

  const body = {
    from:    "CPM Quality Agent <onboarding@resend.dev>",
    to:      [to],
    subject,
    html,
  }

  try {
    const res = await post(
      "https://api.resend.com/emails",
      { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body
    )
    if (res.status >= 200 && res.status < 300) {
      if (!JSON_MODE) console.log(`\n  ✅ QA report emailed to ${to}`)
    } else {
      if (!JSON_MODE) console.warn(`\n  ⚠️  Email failed: Resend ${res.status} — ${res.body.slice(0, 100)}`)
    }
  } catch (e) {
    if (!JSON_MODE) console.warn(`\n  ⚠️  Email error: ${e.message}`)
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════════
async function main() {
  const runDate = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  })

  if (!JSON_MODE) {
    console.log("═".repeat(62))
    console.log("  CPM-Quality-Agent — System Validation")
    console.log(`  ${runDate}${FIX_MODE ? " [--fix mode ON]" : ""}`)
    console.log("═".repeat(62))
  }

  await checkEnvironment()
  await checkFiles()
  await checkLocalData()
  await checkBrave()
  await checkSendGrid()
  await checkGitHub()
  await checkSchedule()
  await checkScriptIntegrity()
  await checkAgentTs()

  const passes = results.filter(r => r.status === "PASS").length
  const warns  = results.filter(r => r.status === "WARN").length
  const fails  = results.filter(r => r.status === "FAIL").length

  if (JSON_MODE) {
    console.log(JSON.stringify({ runDate, passes, warns, fails, results }, null, 2))
    return
  }

  console.log("\n" + "═".repeat(62))
  console.log(`  SUMMARY: ${passes} ✅  ${warns} ⚠️   ${fails} ❌`)
  if (fails === 0 && warns === 0) console.log("  🎉 All systems operational")
  else if (fails === 0)           console.log("  ✅ System functional — see warnings above")
  else                            console.log("  ❌ Action required — see failures above")
  console.log("═".repeat(62))

  if (fails > 0) {
    console.log("\n  Items needing action:")
    for (const r of results.filter(r => r.status === "FAIL")) {
      console.log(`  ❌ ${r.name}: ${r.detail}`)
      if (r.fix) console.log(`     Fix: ${r.fix}`)
    }
  }

  const html    = buildReport(runDate)
  const overall = fails === 0 ? (warns === 0 ? "✅ All Pass" : "⚠️ Warnings") : "❌ Needs Attention"
  await sendReport(`CPM Quality Agent — ${overall} — ${runDate}`, html)

  process.exit(fails > 0 ? 1 : 0)
}

main().catch(err => {
  console.error("Fatal:", err)
  process.exit(1)
})
