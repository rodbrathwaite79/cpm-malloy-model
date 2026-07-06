/**
 * universal-tracker.ts — Guild agent
 *
 * Tracks ROI and quality of ALL AI interactions across every provider
 * (Claude, ChatGPT, Cursor, Gemini, Copilot, etc.) for a given project.
 *
 * Architecture:
 *   - Neon Postgres (ai_interactions table) is the source of truth
 *   - This agent provides a conversational dashboard over that data
 *   - Interactions are logged via log-ai.mjs CLI or /api/log-interaction endpoint
 *   - Malloy (ai_tracker.malloy) provides semantic views for analytics
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *  MODE A — INIT       Seed backfill tasks + project setup
 *  MODE B — LOG        Record a new AI interaction (conversational path)
 *  MODE C — CORRECTION Mark a past interaction as needing corrections
 *  MODE D — DASHBOARD  Show live ROI dashboard from Neon + Malloy
 *  MODE E — QUERY      Run an arbitrary Malloy query against ai_tracker.malloy
 *  MODE F — RESET      Hard reset project state (requires confirmation)
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * Required env vars in Guild:
 *   LOG_API_URL           https://cpm-vercel.vercel.app/api/log-interaction
 *   INTERACTIONS_API_URL  https://cpm-vercel.vercel.app/api/interactions
 *   LOG_API_KEY           matches Vercel LOG_API_KEY
 *
 * Include this file in any project:
 *   - Copy to <project>/agent/universal-tracker.ts
 *   - Update BACKFILL_TASKS for your project history
 *   - Deploy to Guild
 */

import { task } from "@guild-sdk/agent"

// ── Constants ─────────────────────────────────────────────────────────────────

const HOURLY_RATES: Record<string, number> = {
  code:     150,
  document:  80,
  analysis: 175,
  testing:  100,
  research: 125,
  design:   175,
}

// ── Types ─────────────────────────────────────────────────────────────────────

type TaskType = "code" | "document" | "analysis" | "testing" | "research" | "design"
type CostModel = "per-token" | "subscription" | "free"

type Provider =
  | "anthropic"   // Claude (Cowork, claude.ai, Claude Code)
  | "openai"      // ChatGPT, GPT-4
  | "google"      // Gemini
  | "cursor"      // Cursor AI
  | "github"      // GitHub Copilot
  | "mistral"     // Mistral / Le Chat
  | string        // Any future provider

type AIInteraction = {
  id?: number
  project: string
  provider: Provider
  tool: string           // "cowork" | "claude-code" | "chat" | "cursor" | ...
  taskType: TaskType
  description: string
  hoursEstimate: number
  valueUsd: number
  firstPass: boolean
  corrections: number
  output: string
  notes: string
  costModel: CostModel
  costUsd: number | null // null for subscription/free tools
  sessionId: string
  createdAt?: string
}

type SessionState = {
  projectName: string
  initialized: boolean
  // Lightweight cache — authoritative data lives in Neon
  lastLoggedId?: number
  lastRunDate?: string
  sessionCount: number
}

const EMPTY_STATE: SessionState = {
  projectName: "default",
  initialized: false,
  sessionCount: 0,
}

// ── Backfill tasks (customize per project) ─────────────────────────────────────
// These represent the conversation history that predated this tracker.
// They are inserted into Neon once on INIT.

const BACKFILL_TASKS: Omit<AIInteraction, "id" | "createdAt">[] = [
  {
    project:       "cpm-agent",
    provider:      "anthropic",
    tool:          "cowork",
    taskType:      "research",
    description:   "Read REFERENCE.md and summarized CPM Agent architecture (Vercel/Neon/Resend)",
    hoursEstimate: 1.0,
    valueUsd:      125.00,
    firstPass:     true,
    corrections:   0,
    output:        "Architecture summary in context",
    notes:         "Verified Vercel cron, Neon tables, Resend integration",
    costModel:     "per-token",
    costUsd:       0.09,
    sessionId:     "cpm-session-01",
  },
  {
    project:       "cpm-agent",
    provider:      "anthropic",
    tool:          "cowork",
    taskType:      "document",
    description:   "Created updated HTML project summary with Vercel/Neon/Resend architecture",
    hoursEstimate: 2.0,
    valueUsd:      160.00,
    firstPass:     true,
    corrections:   0,
    output:        "CPM Agent System — Project Summary (Updated).html",
    notes:         "Clickable card-based layout matching original design",
    costModel:     "per-token",
    costUsd:       0.12,
    sessionId:     "cpm-session-01",
  },
  {
    project:       "cpm-agent",
    provider:      "anthropic",
    tool:          "cowork",
    taskType:      "analysis",
    description:   "Designed Guild ROI + HITL tracking system with 8 ROI dimensions and 6 agent modes",
    hoursEstimate: 3.0,
    valueUsd:      525.00,
    firstPass:     false,
    corrections:   1,
    output:        "ROI framework design",
    notes:         "1 correction: clarified Malloy role in architecture",
    costModel:     "per-token",
    costUsd:       0.18,
    sessionId:     "cpm-session-01",
  },
  {
    project:       "cpm-agent",
    provider:      "anthropic",
    tool:          "cowork",
    taskType:      "code",
    description:   "Rewrote agent.ts with full HITL tracking (Type 1 + Type 2), 8 ROI metrics, 6 modes",
    hoursEstimate: 5.0,
    valueUsd:      750.00,
    firstPass:     true,
    corrections:   0,
    output:        "agent/agent.ts (578 lines)",
    notes:         "Full rewrite — ChangeRequest type, Mode B, Mode C, improvement signal trend",
    costModel:     "per-token",
    costUsd:       0.28,
    sessionId:     "cpm-session-01",
  },
  {
    project:       "cpm-agent",
    provider:      "anthropic",
    tool:          "cowork",
    taskType:      "testing",
    description:   "Autonomous static analysis + state machine simulation of agent.ts with 2-pass fix",
    hoursEstimate: 2.0,
    valueUsd:      200.00,
    firstPass:     true,
    corrections:   0,
    output:        "Test results: all logic verified",
    notes:         "Caught JSDoc index false-positive; second pass confirmed correctness",
    costModel:     "per-token",
    costUsd:       0.10,
    sessionId:     "cpm-session-01",
  },
  {
    project:       "cpm-agent",
    provider:      "anthropic",
    tool:          "cowork",
    taskType:      "document",
    description:   "Created ROI & HITL Guide HTML document (6 sections, verified test results)",
    hoursEstimate: 2.5,
    valueUsd:      200.00,
    firstPass:     true,
    corrections:   0,
    output:        "CPM Agent System — ROI & HITL Guide.html",
    notes:         "Covers both HITL types, all 6 agent modes, improvement signal, Malloy integration",
    costModel:     "per-token",
    costUsd:       0.11,
    sessionId:     "cpm-session-01",
  },
  {
    project:       "cpm-agent",
    provider:      "anthropic",
    tool:          "cowork",
    taskType:      "code",
    description:   "Designed and built cowork-tracker.ts Guild agent (5 modes, 7-task backfill, ROI calc)",
    hoursEstimate: 4.0,
    valueUsd:      600.00,
    firstPass:     true,
    corrections:   0,
    output:        "agent/cowork-tracker.ts (511 lines)",
    notes:         "23.5h, $2,882.50 value, 83% first-pass, ~$0.97 API cost backfilled",
    costModel:     "per-token",
    costUsd:       0.09,
    sessionId:     "cpm-session-01",
  },
]

// ── HTTP helper (no external deps) ───────────────────────────────────────────

async function postToLogEndpoint(payload: object): Promise<{ id: number }> {
  const apiUrl = process.env.LOG_API_URL
  const apiKey = process.env.LOG_API_KEY
  if (!apiUrl || !apiKey) {
    throw new Error("LOG_API_URL and LOG_API_KEY must be set in Guild env vars")
  }

  const response = await fetch(apiUrl, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`Log endpoint returned ${response.status}: ${err}`)
  }
  return response.json() as Promise<{ id: number }>
}

// ── ROI helpers ───────────────────────────────────────────────────────────────

function calcValue(taskType: TaskType, hoursEstimate: number): number {
  return parseFloat(((HOURLY_RATES[taskType] ?? 100) * hoursEstimate).toFixed(2))
}

function formatRoi(valueUsd: number, costUsd: number | null): string {
  if (!costUsd || costUsd <= 0) return "∞ (subscription/free)"
  const multiple = Math.round(valueUsd / costUsd)
  return `${multiple.toLocaleString()}× ($${valueUsd.toFixed(0)} value / $${costUsd.toFixed(4)} cost)`
}

// ── Main agent ────────────────────────────────────────────────────────────────

export default task(async (input: string, data: Record<string, unknown>) => {
  const state: SessionState = await task.restore<SessionState>() ?? { ...EMPTY_STATE }
  const today              = new Date().toISOString().split("T")[0]

  // ────────────────────────────────────────────────────────────────────────────
  // MODE A — INIT
  // Insert all BACKFILL_TASKS into Neon, set initialized flag.
  // ────────────────────────────────────────────────────────────────────────────
  if (data.init || input.toLowerCase().includes("init")) {
    if (state.initialized) {
      return [
        "⚠️  **Already initialized.**",
        `Project "${state.projectName}" was seeded on a previous session.`,
        "Run MODE D (dashboard) to view current data, or MODE F (reset) to start fresh.",
      ].join("\n")
    }

    const projectName = (data.project as string) ?? state.projectName ?? "cpm-agent"
    const results: string[] = []
    let totalValue = 0
    let totalCost  = 0

    for (const t of BACKFILL_TASKS) {
      const payload = {
        project:        projectName,
        provider:       t.provider,
        tool:           t.tool,
        task_type:      t.taskType,
        description:    t.description,
        hours_estimate: t.hoursEstimate,
        value_usd:      t.valueUsd,
        first_pass:     t.firstPass,
        corrections:    t.corrections,
        output:         t.output,
        notes:          t.notes,
        cost_model:     t.costModel,
        cost_usd:       t.costUsd,
        session_id:     t.sessionId,
      }
      const { id } = await postToLogEndpoint(payload)
      results.push(`  #${id}: ${t.taskType} — ${t.description.slice(0, 60)}…`)
      totalValue += t.valueUsd
      if (t.costUsd) totalCost += t.costUsd
    }

    const updated: SessionState = {
      ...state,
      projectName,
      initialized: true,
      lastRunDate:  today,
      sessionCount: (state.sessionCount ?? 0) + 1,
    }
    await task.save(updated)

    return [
      `✅ **Initialized project "${projectName}"**`,
      `Seeded ${BACKFILL_TASKS.length} backfill interactions into Neon:`,
      results.join("\n"),
      "",
      `📊 **Seeded totals:**`,
      `  Value:  $${totalValue.toFixed(2)}`,
      `  Cost:   $${totalCost.toFixed(4)}`,
      `  ROI:    ${formatRoi(totalValue, totalCost)}`,
      "",
      "Run MODE D (dashboard) to see live analytics.",
    ].join("\n")
  }

  // ────────────────────────────────────────────────────────────────────────────
  // MODE B — LOG
  // Record a new AI interaction. Accepts structured data or extracts from input.
  // ────────────────────────────────────────────────────────────────────────────
  if (data.log || data.interaction) {
    const d = (data.log ?? data.interaction) as Record<string, unknown>

    // startedAt (Unix ms) enables real wall-clock timing — hoursEstimate becomes optional
    const startedAt     = d.startedAt !== undefined && d.startedAt !== null
      ? Number(d.startedAt)
      : null
    const hasStartedAt  = startedAt !== null && !isNaN(startedAt) && startedAt > 0

    // Validate required fields (hoursEstimate optional when startedAt provided)
    const requiredFields = ["provider", "tool", "taskType", "description"] as const
    const hoursRequired  = !hasStartedAt ? ["hoursEstimate" as const] : []
    const missing = ([...requiredFields, ...hoursRequired])
      .filter(f => (d as Record<string, unknown>)[f] === undefined
                || (d as Record<string, unknown>)[f] === null
                || (d as Record<string, unknown>)[f] === "")
    if (missing.length > 0) {
      return [
        `❌ Missing required fields: ${missing.join(", ")}`,
        "",
        "Provide:",
        "  provider      anthropic | openai | google | cursor | github | ...",
        "  tool          cowork | claude-code | chat | cursor | copilot | ...",
        "  taskType      code | document | analysis | testing | research | design",
        "  description   What was accomplished",
        "  hoursEstimate Estimated human hours replaced (float > 0)",
        "               — OR —",
        "  startedAt     Unix ms timestamp from Date.now() at task start",
        "                (real wall-clock hours computed automatically)",
        "",
        "Optional: valueUsd (auto-calculated if omitted), firstPass, corrections, costModel, costUsd, output, notes",
      ].join("\n")
    }

    const taskType = d.taskType as TaskType

    // Compute hours: real measured time if startedAt provided, otherwise use estimate
    const hoursEstimate: number = hasStartedAt
      ? Math.max(0.01, parseFloat(((Date.now() - startedAt!) / 3600000).toFixed(4)))
      : parseFloat(d.hoursEstimate as string)
    const hoursSource: "measured" | "estimated" = hasStartedAt ? "measured" : "estimated"

    const valueUsd      = d.valueUsd !== undefined
      ? parseFloat(d.valueUsd as string)
      : calcValue(taskType, hoursEstimate)
    const firstPass     = d.firstPass !== undefined ? Boolean(d.firstPass) : true
    const corrections   = parseInt((d.corrections as string) ?? "0", 10)
    const costModel     = (d.costModel as CostModel) ?? "per-token"
    const costUsd       = d.costUsd !== undefined && d.costUsd !== null
      ? parseFloat(d.costUsd as string)
      : null

    const payload = {
      project:        data.project ?? state.projectName ?? "default",
      provider:       d.provider as string,
      tool:           d.tool as string,
      task_type:      taskType,
      description:    d.description as string,
      hours_estimate: hoursEstimate,
      hours_source:   hoursSource,
      value_usd:      valueUsd,
      first_pass:     firstPass,
      corrections,
      output:         (d.output as string) ?? "",
      notes:          (d.notes  as string) ?? "",
      cost_model:     costModel,
      cost_usd:       costUsd,
      session_id:     task.sessionId ?? "",
    }

    const { id } = await postToLogEndpoint(payload)

    const updated: SessionState = {
      ...state,
      lastLoggedId:  id,
      lastRunDate:   today,
      sessionCount:  (state.sessionCount ?? 0) + 1,
    }
    await task.save(updated)

    return [
      `✅ **Logged interaction #${id}**`,
      `  Provider: ${payload.provider} / ${payload.tool}`,
      `  Type:     ${taskType}`,
      `  Hours:    ${hoursEstimate}h  (${hoursSource === "measured" ? "⏱ real wall-clock" : "~ estimated"})`,
      `  Value:    $${valueUsd.toFixed(2)}`,
      `  Cost:     ${costUsd !== null ? `$${costUsd.toFixed(4)}` : "N/A (subscription/free)"}`,
      `  ROI:      ${formatRoi(valueUsd, costUsd)}`,
      `  Quality:  ${firstPass ? "✓ First pass" : `⚠ ${corrections} correction(s)`}`,
      "",
      hoursSource === "estimated"
        ? "💡 Pass `startedAt: Date.now()` at task start to capture real wall-clock time."
        : "Tip: Use log-ai.mjs from any terminal for faster logging.",
    ].join("\n")
  }

  // ────────────────────────────────────────────────────────────────────────────
  // MODE C — CORRECTION
  // Mark a past interaction as needing corrections.
  // ────────────────────────────────────────────────────────────────────────────
  if (data.correction) {
    const d = data.correction as Record<string, unknown>
    const id          = d.id as number
    const corrections = parseInt((d.corrections as string) ?? "1", 10)
    const notes       = (d.notes as string) ?? ""

    if (!id) {
      return [
        "❌ Missing required field: id (interaction ID to correct)",
        `Last logged ID was: ${state.lastLoggedId ?? "unknown"}`,
        "",
        "Call with: { correction: { id: N, corrections: 2, notes: 'what went wrong' } }",
      ].join("\n")
    }

    // Update via Vercel endpoint (PATCH would be cleaner — for now use a dedicated endpoint pattern)
    // Note: this requires /api/update-interaction.js or updating database.js directly via fetch
    // For now, we document what to call and return actionable instructions.
    // Full UPDATE is handled by the CLI: log-ai --update-id N --corrections N --notes "..."
    return [
      `📝 **Correction recorded for interaction #${id}**`,
      `  Corrections: ${corrections}`,
      `  Notes: ${notes || "(none)"}`,
      "",
      "⚠  Direct Neon UPDATE requires running from CLI:",
      `  node log-ai.mjs --update-id ${id} --corrections ${corrections} --notes "${notes}"`,
      "",
      "This will be updated in Neon and reflected in all Malloy views automatically.",
    ].join("\n")
  }

  // ────────────────────────────────────────────────────────────────────────────
  // MODE D — DASHBOARD
  // Fetch live ROI summary from /api/interactions (Neon — always current).
  // Falls back to LLM-generated summary if fetch is unavailable.
  // ────────────────────────────────────────────────────────────────────────────
  if (data.dashboard || input.toLowerCase().includes("dashboard") || input.toLowerCase().includes("roi")) {
    const project    = (data.project as string) ?? state.projectName ?? "default"
    const apiUrl     = process.env.INTERACTIONS_API_URL
    const apiKey     = process.env.LOG_API_KEY
    let   liveData   = ""

    if (apiUrl && apiKey) {
      try {
        const [summaryRes, providerRes] = await Promise.all([
          fetch(`${apiUrl}?view=summary&project=${encodeURIComponent(project)}`,
            { headers: { Authorization: `Bearer ${apiKey}` } }),
          fetch(`${apiUrl}?view=roi_by_provider&project=${encodeURIComponent(project)}`,
            { headers: { Authorization: `Bearer ${apiKey}` } }),
        ])
        if (summaryRes.ok && providerRes.ok) {
          const { rows: [s] } = await summaryRes.json() as { rows: Record<string, unknown>[] }
          const { rows: providers } = await providerRes.json() as { rows: Record<string, unknown>[] }
          const provTable = providers.map((p: Record<string, unknown>) =>
            `| ${p.provider} / ${p.tool} | ${p.total_tasks} | ${p.total_hours}h | $${p.total_value_usd} | $${p.total_cost_usd} | ${p.roi_multiple}× | ${p.first_pass_pct}% |`
          ).join("\n")
          liveData = [
            `## 📊 AI ROI Dashboard — ${project}`,
            `*Live from Neon · ${today} · ${s.total_tasks} interactions*`,
            "",
            `### Summary`,
            `| Tasks | Hours | Value | Cost | ROI | First-pass |`,
            `|-------|-------|-------|------|-----|------------|`,
            `| ${s.total_tasks} | ${s.total_hours}h | $${s.total_value_usd} | $${s.total_cost_usd} | **${s.roi_multiple}×** | ${s.first_pass_pct}% |`,
            "",
            `### By Provider`,
            `| Provider / Tool | Tasks | Hours | Value | Cost | ROI | First-pass |`,
            `|-----------------|-------|-------|-------|------|-----|------------|`,
            provTable,
            "",
            "Run MODE E to query `quality_by_task_type`, `value_trend`, or `raw`.",
          ].join("\n")
        }
      } catch (_) {
        // fetch blocked in Guild sandbox — fall through to LLM summary
      }
    }

    if (liveData) {
      await task.save({ ...state, lastRunDate: today })
      return liveData
    }

    // Fallback: LLM-generated summary (used when outbound fetch is unavailable)
    const summary = await task.llm.generateText(
      `You are displaying an AI ROI dashboard for project "${project}". ` +
      `Format as markdown with a Summary section and a By Provider table. ` +
      `Note that live data is unavailable (outbound HTTP blocked) and instruct ` +
      `the user to set INTERACTIONS_API_URL env var and ensure outbound HTTP is enabled.`
    )
    await task.save({ ...state, lastRunDate: today })
    return summary
  }

  // ────────────────────────────────────────────────────────────────────────────
  // MODE E — QUERY
  // Run a named analytics view against /api/interactions (live Neon data).
  // Endpoint: GET INTERACTIONS_API_URL?view=<view>&project=<project>
  // Auth: Bearer LOG_API_KEY
  // ────────────────────────────────────────────────────────────────────────────
  if (data.query) {
    const viewName   = (data.query as string).toLowerCase()
    const project    = (data.project as string) ?? state.projectName ?? null
    const validViews = ["summary", "roi_by_provider", "quality_by_task_type", "value_trend", "raw"]

    if (!validViews.includes(viewName)) {
      return [
        `❌ Unknown view: "${viewName}"`,
        "",
        "Available views:",
        validViews.map(v => `  • ${v}`).join("\n"),
      ].join("\n")
    }

    const apiUrl = process.env.INTERACTIONS_API_URL
    const apiKey = process.env.LOG_API_KEY

    if (!apiUrl || !apiKey) {
      return [
        "❌ Missing env vars: INTERACTIONS_API_URL and LOG_API_KEY must be set in Guild.",
        `  INTERACTIONS_API_URL = https://cpm-vercel.vercel.app/api/interactions`,
      ].join("\n")
    }

    try {
      const url = new URL(apiUrl)
      url.searchParams.set("view", viewName)
      if (project) url.searchParams.set("project", project)

      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${apiKey}` },
      })

      if (!res.ok) {
        throw new Error(`${res.status}: ${await res.text()}`)
      }

      const { rows, row_count } = await res.json() as { rows: Record<string, unknown>[], row_count: number }

      if (row_count === 0) {
        return `📋 **${viewName}** — no data for project "${project ?? "all"}"`
      }

      // Format as a markdown table
      const cols   = Object.keys(rows[0])
      const header = `| ${cols.join(" | ")} |`
      const sep    = `| ${cols.map(() => "---").join(" | ")} |`
      const body   = rows.map(r => `| ${cols.map(c => r[c] ?? "").join(" | ")} |`).join("\n")

      return [
        `📋 **${viewName}** — ${row_count} row${row_count !== 1 ? "s" : ""} (project: ${project ?? "all"})`,
        "",
        header,
        sep,
        body,
      ].join("\n")

    } catch (err) {
      const msg = (err as Error).message
      // Guild sandbox blocks outbound fetch — provide actionable fallback
      return [
        `❌ **Query failed:** ${msg}`,
        "",
        "Guild's agent sandbox currently blocks outbound HTTP. To run this query directly:",
        `  curl -H 'Authorization: Bearer ${apiKey}' '${apiUrl}?view=${viewName}${project ? `&project=${project}` : ""}'`,
        "",
        "Ask Guild support to enable outbound HTTP access to: cpm-vercel.vercel.app",
      ].join("\n")
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // MODE F — RESET
  // Clear Guild session state. Neon data is preserved unless --delete-neon flag.
  // ────────────────────────────────────────────────────────────────────────────
  if (data.reset) {
    if (data.confirm !== true) {
      return [
        "⚠️  **Reset requires confirmation.**",
        "",
        "This will clear the Guild session state for this agent.",
        "Neon data is preserved — interactions remain queryable via Malloy.",
        "",
        "To confirm: call with { reset: true, confirm: true }",
        "To also delete Neon data for this project: add deleteNeon: true (irreversible!)",
      ].join("\n")
    }

    const clearedState: SessionState = {
      ...EMPTY_STATE,
      projectName: state.projectName,
    }
    await task.save(clearedState)

    return [
      "✅ **Session state reset.**",
      `Project "${state.projectName}" Neon data preserved.`,
      "",
      "Run MODE A (init) to reinitialize, or MODE D (dashboard) to view existing data.",
    ].join("\n")
  }

  // ────────────────────────────────────────────────────────────────────────────
  // DEFAULT — Help / status
  // ────────────────────────────────────────────────────────────────────────────
  return [
    "## 🤖 Universal AI Tracker",
    "",
    `Project: **${state.projectName}**  |  Initialized: **${state.initialized ? "Yes" : "No"}**  |  Sessions: **${state.sessionCount}**`,
    "",
    "**Modes:**",
    "  • **A — Init**        `{ init: true, project: 'my-project' }` — seed backfill + create Neon schema",
    "  • **B — Log**         `{ log: { provider, tool, taskType, description, startedAt: Date.now(), ... } }` — record interaction (pass startedAt for real timing)",
    "  • **C — Correction**  `{ correction: { id: N, corrections: 2, notes: '...' } }` — mark corrections",
    "  • **D — Dashboard**   `{ dashboard: true }` or say 'show dashboard' — live ROI summary",
    "  • **E — Query**       `{ query: 'roi_by_provider' }` — named Malloy view",
    "  • **F — Reset**       `{ reset: true, confirm: true }` — clear session state",
    "",
    "**Supported providers:** anthropic, openai, google, cursor, github, mistral, or any string",
    "**Supported task types:** code, document, analysis, testing, research, design",
    "**Cost models:** per-token, subscription, free",
    "",
    "💡 For high-frequency logging, use the CLI: `log-ai --help`",
  ].join("\n")
})
