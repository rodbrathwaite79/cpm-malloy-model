#!/usr/bin/env node
/**
 * log-ai.mjs — Universal AI interaction logger
 *
 * Records an AI interaction from any provider into the central tracker.
 * Designed to be installed as a shell alias or used from any project directory.
 *
 * Install:
 *   echo 'alias log-ai="node ~/Documents/cpm-agent/malloy-model-git/agent/log-ai.mjs"' >> ~/.zshrc
 *   source ~/.zshrc
 *
 * Required env vars (set in ~/.zshrc or .env):
 *   LOG_API_URL   https://your-vercel-app.vercel.app/api/log-interaction
 *   LOG_API_KEY   your-secret-key-from-vercel-env
 *
 * Usage:
 *   log-ai --provider anthropic --tool cowork --type code \
 *          --hours 2.5 --value 375 --desc "Rewrote agent.ts with HITL tracking" \
 *          [--project cpm-agent] [--output "agent.ts"] [--notes "..."] \
 *          [--no-first-pass] [--corrections 1] [--cost-model subscription] [--cost 0.97]
 *
 * Flags:
 *   --provider      Required. anthropic | openai | google | cursor | github | any string
 *   --tool          Required. cowork | claude-code | chat | cursor | copilot | gemini | ...
 *   --type          Required. code | document | analysis | testing | research | design
 *   --hours         Required. Estimated human hours this interaction replaced (float, > 0)
 *   --value         Required. Dollar value of the work (hourly_rate × hours)
 *   --desc          Required. What was accomplished (quoted string)
 *   --project       Project namespace (default: reads $LOG_PROJECT or "default")
 *   --output        What was produced (file, doc, report, etc.)
 *   --notes         Any extra context
 *   --no-first-pass  Flag: the AI did NOT get it right first try
 *   --corrections   Number of correction rounds needed (default: 0)
 *   --cost-model    per-token | subscription | free (default: per-token)
 *   --cost          Actual API cost in USD (omit for subscription/free tools)
 *   --session       Session/conversation ID for grouping related interactions
 *   --dry-run       Print the payload without sending it
 *   --help          Show this help text
 */

import https from "https"
import http  from "http"
import { URL } from "url"

// ── Help ─────────────────────────────────────────────────────────────────────
const HELP = `
log-ai — Universal AI interaction logger

REQUIRED FLAGS:
  --provider <name>   AI provider (anthropic, openai, google, cursor, github, ...)
  --tool     <name>   Specific tool (cowork, claude-code, chat, cursor, copilot, ...)
  --type     <type>   Task type: code | document | analysis | testing | research | design
  --hours    <float>  Human hours this replaced (e.g. 2.5)
  --value    <float>  Dollar value at your hourly rate (e.g. 375)
  --desc     <text>   What was accomplished (use quotes)

OPTIONAL FLAGS:
  --project  <name>   Project namespace (default: $LOG_PROJECT or "default")
  --output   <text>   What was produced
  --notes    <text>   Extra context
  --no-first-pass     AI needed corrections
  --corrections <n>   Number of correction rounds
  --cost-model <m>    per-token | subscription | free (default: per-token)
  --cost     <float>  Actual API cost in USD
  --session  <id>     Session/conversation ID
  --dry-run           Print payload without sending
  --help              Show this help

ENV VARS:
  LOG_API_URL   Vercel endpoint URL (required)
  LOG_API_KEY   Auth key matching Vercel LOG_API_KEY (required)
  LOG_PROJECT   Default project name (optional)

EXAMPLES:
  # Log a Claude Cowork session (per-token, paid)
  log-ai --provider anthropic --tool cowork --type code \\
         --hours 2.5 --value 375 --desc "Rewrote agent.ts with HITL tracking" \\
         --cost 0.97 --project cpm-agent

  # Log a Cursor session (subscription, no per-token cost)
  log-ai --provider cursor --tool cursor --type code \\
         --hours 1 --value 150 --desc "Refactored auth module" \\
         --cost-model subscription --no-first-pass --corrections 2

  # Log a ChatGPT session (free tier)
  log-ai --provider openai --tool chat --type research \\
         --hours 0.5 --value 62.50 --desc "Research on CPM benchmarks" \\
         --cost-model free
`

// ── Arg parser ───────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {}
  let i = 2 // skip "node" and script path
  while (i < argv.length) {
    const raw = argv[i]
    if (raw === "--help" || raw === "-h") { args.help = true; i++; continue }
    if (raw === "--dry-run")    { args.dryRun = true; i++; continue }
    if (raw === "--no-first-pass") { args.no_first_pass = true; i++; continue }

    if (raw.startsWith("--")) {
      const key = raw.slice(2)
      const val = argv[i + 1]
      if (val === undefined || val.startsWith("--")) {
        args[key] = true
        i++
      } else {
        args[key] = val
        i += 2
      }
    } else {
      // positional — warn and skip
      console.warn(`[log-ai] Warning: unexpected positional argument "${raw}" — skipped`)
      i++
    }
  }
  return args
}

// ── Validation ───────────────────────────────────────────────────────────────
const VALID_TYPES       = new Set(["code", "document", "analysis", "testing", "research", "design"])
const VALID_COST_MODELS = new Set(["per-token", "subscription", "free"])

function validate(args) {
  const errs = []
  const req = ["provider", "tool", "type", "hours", "value", "desc"]
  for (const f of req) {
    if (!args[f]) errs.push(`Missing required flag: --${f}`)
  }
  if (args.type && !VALID_TYPES.has(args.type)) {
    errs.push(`--type must be one of: ${[...VALID_TYPES].join(", ")}`)
  }
  const costModel = args["cost-model"] ?? "per-token"
  if (!VALID_COST_MODELS.has(costModel)) {
    errs.push(`--cost-model must be one of: ${[...VALID_COST_MODELS].join(", ")}`)
  }
  const hours = parseFloat(args.hours)
  if (!isNaN(args.hours) && (isNaN(hours) || hours <= 0)) {
    errs.push("--hours must be a positive number (e.g. 2.5)")
  }
  const corrections = parseInt(args.corrections ?? "0", 10)
  if (isNaN(corrections) || corrections < 0) {
    errs.push("--corrections must be a non-negative integer")
  }
  return errs
}

// ── HTTP POST (no external deps) ─────────────────────────────────────────────
function post(apiUrl, apiKey, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload)
    const url  = new URL(apiUrl)
    const opts = {
      hostname: url.hostname,
      port:     url.port || (url.protocol === "https:" ? 443 : 80),
      path:     url.pathname + url.search,
      method:   "POST",
      headers:  {
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Authorization":  `Bearer ${apiKey}`,
      },
    }
    const lib = url.protocol === "https:" ? https : http
    const req = lib.request(opts, (res) => {
      let data = ""
      res.on("data", chunk => { data += chunk })
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }) }
        catch { resolve({ status: res.statusCode, body: data }) }
      })
    })
    req.on("error", reject)
    req.write(body)
    req.end()
  })
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv)

  if (args.help) {
    console.log(HELP)
    process.exit(0)
  }

  const errs = validate(args)
  if (errs.length > 0) {
    console.error("[log-ai] Validation errors:")
    errs.forEach(e => console.error("  •", e))
    console.error('\nRun with --help for usage.')
    process.exit(1)
  }

  const apiUrl = process.env.LOG_API_URL
  const apiKey = process.env.LOG_API_KEY

  if (!apiUrl) {
    console.error("[log-ai] Error: LOG_API_URL not set.")
    console.error("  Add to ~/.zshrc: export LOG_API_URL=https://your-app.vercel.app/api/log-interaction")
    process.exit(1)
  }
  if (!apiKey) {
    console.error("[log-ai] Error: LOG_API_KEY not set.")
    console.error("  Add to ~/.zshrc: export LOG_API_KEY=your-key")
    process.exit(1)
  }

  const firstPass   = args.no_first_pass ? false : true
  const corrections = parseInt(args.corrections ?? "0", 10)
  const costModel   = args["cost-model"] ?? "per-token"
  const costUsd     = args.cost !== undefined ? parseFloat(args.cost) : null

  const payload = {
    project:       args.project  ?? process.env.LOG_PROJECT ?? "default",
    provider:      args.provider,
    tool:          args.tool,
    task_type:     args.type,
    description:   args.desc,
    hours_estimate: parseFloat(args.hours),
    value_usd:     parseFloat(args.value),
    first_pass:    firstPass,
    corrections,
    output:        args.output   ?? "",
    notes:         args.notes    ?? "",
    cost_model:    costModel,
    cost_usd:      costUsd,
    session_id:    args.session  ?? "",
  }

  if (args.dryRun) {
    console.log("[log-ai] Dry run — payload:")
    console.log(JSON.stringify(payload, null, 2))
    process.exit(0)
  }

  try {
    const result = await post(apiUrl, apiKey, payload)
    if (result.status === 200) {
      const roi = payload.cost_usd && payload.cost_usd > 0
        ? ` (ROI: ${(payload.value_usd / payload.cost_usd).toFixed(0)}×)`
        : ""
      console.log(`✓ Logged interaction #${result.body.id} — ${payload.provider}/${payload.tool}`)
      console.log(`  ${payload.task_type} | ${payload.hours_estimate}h | $${payload.value_usd} value${roi}`)
      if (!firstPass) console.log(`  ⚠  Needed ${corrections} correction(s)`)
    } else {
      console.error(`[log-ai] Server error ${result.status}:`, result.body)
      process.exit(1)
    }
  } catch (err) {
    console.error("[log-ai] Network error:", err.message)
    console.error("  Is LOG_API_URL reachable? Try --dry-run to validate the payload.")
    process.exit(1)
  }
}

main()
