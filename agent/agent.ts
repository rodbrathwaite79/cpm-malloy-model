"use agent"
/**
 * cpm-report-agent — Guild.ai Agent
 *
 * Handles LLM synthesis AND tracks real metrics via the Guild SDK:
 *   • LLM token cost          — task.tools.guild_get_daily_llm_usage()
 *   • HITL utilization rate   — task.save() / task.restore() across runs
 *   • Per-agent ROI score     — derived from autonomous vs. HITL run history
 *   • Run history             — persisted in Guild agent state
 *
 * Input JSON fields:
 *   rows          — historical CPM data points from DuckDB
 *   webFindings   — Brave search results
 *   question      — optional custom question (defaults to executive summary)
 *   outcome       — "autonomous" | "hitl" | "error" (set by daily-report.mjs)
 *   dataPoints    — number of new verified data points found this run
 *
 * For daily automated reports, daily-report.mjs calls this agent
 * and passes the outcome + dataPoints so metrics stay accurate.
 */

import {
  agent,
  userInterfaceTools,
  guildTools,
  textPromptNotifyEvent,
  progressLogNotifyEvent,
  type Task,
} from "@guildai/agents-sdk"
import { z } from "zod"

// ── Approximate Claude Sonnet pricing ─────────────────────────────────────────
const COST_PER_INPUT_TOKEN  = 3  / 1_000_000   // $3.00 / MTok
const COST_PER_OUTPUT_TOKEN = 15 / 1_000_000   // $15.00 / MTok

// ── Persisted state (survives across Guild sessions) ──────────────────────────
type RunRecord = {
  date:              string
  sessionId:         string
  outcome:           "autonomous" | "hitl" | "error"
  inputTokens:       number
  outputTokens:      number
  dataPointsFound:   number
  estimatedCostUsd:  number
}

type AgentState = {
  totalRuns:              number
  autonomousRuns:         number   // agent completed without human help
  hitlRuns:               number   // agent emailed human — couldn't find data
  totalInputTokens:       number
  totalOutputTokens:      number
  totalEstimatedCostUsd:  number
  runHistory:             RunRecord[]
}

const EMPTY_STATE: AgentState = {
  totalRuns: 0, autonomousRuns: 0, hitlRuns: 0,
  totalInputTokens: 0, totalOutputTokens: 0, totalEstimatedCostUsd: 0,
  runHistory: [],
}

// ── Tools ─────────────────────────────────────────────────────────────────────
const tools = { ...userInterfaceTools, ...guildTools }
type Tools = typeof tools

// ── Input ─────────────────────────────────────────────────────────────────────
const inputSchema = z.object({
  type: z.literal("text"),
  text: z.string().describe(
    'JSON: { rows, webFindings, question?, outcome?: "autonomous"|"hitl"|"error", dataPoints?: number }'
  ),
})
type Input = z.infer<typeof inputSchema>

// ── Output ────────────────────────────────────────────────────────────────────
const outputSchema = z.object({
  type: z.literal("text"),
  text: z.string().describe("AI analysis + metrics dashboard"),
})
type Output = z.infer<typeof outputSchema>

// ── Channel labels ─────────────────────────────────────────────────────────────
const CHANNEL_LABELS: Record<string, string> = {
  paid_social:           "Paid Social",
  paid_search:           "Paid Search",
  programmatic_display:  "Programmatic Display",
  video_ctv:             "Video / CTV",
  streaming_audio:       "Streaming Audio",
}

// ── Run ───────────────────────────────────────────────────────────────────────
async function run(input: Input, task: Task<Tools, AgentState>): Promise<Output> {

  // ── 1. Parse input ──────────────────────────────────────────────────────────
  let data: {
    rows?: unknown[]
    webFindings?: unknown[]
    question?: string
    outcome?: "autonomous" | "hitl" | "error"
    dataPoints?: number
    reset?: boolean
  }
  try {
    data = JSON.parse(extractJson(input.text))
  } catch {
    data = { question: input.text }
  }

  // ── Reset mode: wipe saved state and exit early ─────────────────────────────
  if (data.reset === true) {
    await task.save(EMPTY_STATE)
    const msg = "✅ Agent metrics state has been reset to zero. All cumulative run history cleared."
    await task.tools.ui_notify(textPromptNotifyEvent({ type: "text", text: msg }))
    return { type: "text", text: msg }
  }

  const rows        = (data.rows        ?? []) as Array<{ channel: string; year: number; month: number; avg_cpm: number }>
  const webFindings = (data.webFindings ?? []) as Array<{ title: string; excerpt: string; url: string }>
  const question    = data.question    ?? "Provide an executive summary of CPM trends and 3-4 key insights."
  const outcome     = data.outcome     ?? "autonomous"
  const dataPoints  = data.dataPoints  ?? 0

  // Detect test / manual invocations — no real data means this isn't a production run
  const isTestRun = rows.length === 0 && webFindings.length === 0 && dataPoints === 0

  await task.tools.ui_notify(progressLogNotifyEvent("Restoring run history…"))

  // ── 2. Restore previous state ───────────────────────────────────────────────
  const prevState: AgentState = (await task.restore()) ?? EMPTY_STATE

  // ── 3. Get today's LLM usage from Guild API ─────────────────────────────────
  await task.tools.ui_notify(progressLogNotifyEvent("Fetching LLM usage from Guild…"))

  const today = new Date().toISOString().slice(0, 10)
  let todayInputTokens  = 0
  let todayOutputTokens = 0

  try {
    // Get current user ID first
    const me = await task.tools.guild_get_me({})
    const usageRes = await task.tools.guild_get_daily_llm_usage({
      account_id: me.id,
      start_date: today,
      end_date:   today,
    })
    if (usageRes.items?.length > 0) {
      const todayUsage = usageRes.items[0]
      todayInputTokens  = todayUsage.input_tokens
      todayOutputTokens = todayUsage.output_tokens
    }
  } catch {
    // Non-fatal — Guild API unavailable (e.g. local test run)
  }

  const todayCost = todayInputTokens  * COST_PER_INPUT_TOKEN
                  + todayOutputTokens * COST_PER_OUTPUT_TOKEN

  // ── 4. Build data summary for LLM ───────────────────────────────────────────
  await task.tools.ui_notify(progressLogNotifyEvent("Analyzing CPM data…"))

  const byChannel: Record<string, { year: number; month: number; avg: number }[]> = {}
  for (const r of rows) {
    if (!byChannel[r.channel]) byChannel[r.channel] = []
    byChannel[r.channel].push({ year: r.year, month: r.month, avg: r.avg_cpm })
  }

  const dataSummary = Object.entries(byChannel)
    .map(([ch, pts]) => {
      const sorted = pts.sort((a, b) => b.year - a.year || b.month - a.month)
      return `${CHANNEL_LABELS[ch] ?? ch}: ${sorted.slice(0, 6).map(p => `$${p.avg.toFixed(2)} (${p.year}-${p.month})`).join(", ")}`
    })
    .join("\n")

  const webSummary = webFindings.slice(0, 8)
    .map(f => `• ${f.title} — ${f.excerpt}`)
    .join("\n")

  // ── 5. Generate AI insights ─────────────────────────────────────────────────
  await task.tools.ui_notify(progressLogNotifyEvent("Generating insights…"))

  const prompt = `You are a senior media analyst writing a brief for a client.
Answer based ONLY on the data provided — do not invent CPM numbers.

QUESTION: ${question}

HISTORICAL CPM DATA:
${dataSummary || "(no historical data provided)"}

RECENT WEB RESEARCH:
${webSummary || "(no web research provided)"}

Rules:
1. Cite only figures present in the data above
2. Executive tone — specific, no filler
3. If data is insufficient to answer confidently, say so clearly
4. Keep response under 400 words`

  const result = await task.llm.generateText({ prompt })

  // ── 6. Update and save metrics (skipped for test runs) ─────────────────────
  let displayState: AgentState

  if (isTestRun) {
    // Don't persist — read-only view of existing state
    displayState = prevState
  } else {
    const thisRun: RunRecord = {
      date:             today,
      sessionId:        task.sessionId,
      outcome,
      inputTokens:      todayInputTokens,
      outputTokens:     todayOutputTokens,
      dataPointsFound:  dataPoints,
      estimatedCostUsd: todayCost,
    }

    displayState = {
      totalRuns:             prevState.totalRuns + 1,
      autonomousRuns:        prevState.autonomousRuns + (outcome === "autonomous" ? 1 : 0),
      hitlRuns:              prevState.hitlRuns      + (outcome === "hitl"       ? 1 : 0),
      totalInputTokens:      prevState.totalInputTokens  + todayInputTokens,
      totalOutputTokens:     prevState.totalOutputTokens + todayOutputTokens,
      totalEstimatedCostUsd: prevState.totalEstimatedCostUsd + todayCost,
      runHistory:            [...prevState.runHistory.slice(-29), thisRun],
    }

    await task.save(displayState)
  }

  // ── 7. Compute derived metrics ──────────────────────────────────────────────
  const hitlRate     = displayState.totalRuns > 0
    ? (displayState.hitlRuns / displayState.totalRuns * 100).toFixed(1)
    : "0.0"

  const autonomyRate = displayState.totalRuns > 0
    ? (displayState.autonomousRuns / displayState.totalRuns * 100).toFixed(1)
    : "0.0"

  // ROI estimate — each autonomous run saves ~15 min of analyst time:
  //   • 5 min pulling CPM data from sources (eMarketer, WordStream, IAB)
  //   • 5 min writing the executive summary
  //   • 5 min formatting and sending the report
  // Rate assumption: $100/hr ($1.67/min) × 15 min = $25.00/run (est.)
  // Adjust ANALYST_RATE_USD_PER_HOUR or ANALYST_MIN_PER_RUN to match your actual rate.
  const ANALYST_RATE_USD_PER_HOUR = 100   // ← your hourly analyst rate
  const ANALYST_MIN_PER_RUN       = 15    // ← estimated minutes saved per autonomous run
  const savedPerRun       = (ANALYST_RATE_USD_PER_HOUR / 60) * ANALYST_MIN_PER_RUN
  const humanTimeSavedUsd = displayState.autonomousRuns * savedPerRun
  const roiScore = displayState.totalEstimatedCostUsd > 0
    ? (humanTimeSavedUsd / displayState.totalEstimatedCostUsd).toFixed(1)
    : "∞"

  const avgCostPerRun = displayState.totalRuns > 0
    ? (displayState.totalEstimatedCostUsd / displayState.totalRuns * 100).toFixed(3)
    : "0.000"

  // ── 8. Build full output ────────────────────────────────────────────────────
  const testRunNotice = isTestRun ? `
⚠️  TEST RUN — no input data provided. Metrics not recorded.
    Pass { rows, webFindings, dataPoints } to log a real run.
` : ""

  const metricsBlock = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 AGENT METRICS DASHBOARD${isTestRun ? " (read-only — test run)" : ""}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${testRunNotice}
COST PER TASK (Today — from Guild LLM API)
  Input tokens:   ${todayInputTokens.toLocaleString()} tokens
  Output tokens:  ${todayOutputTokens.toLocaleString()} tokens
  Estimated cost: $${(todayCost).toFixed(4)}
  Avg cost/run:   $${avgCostPerRun} (all-time, production runs only)

HITL UTILIZATION RATE (${displayState.totalRuns} production runs)
  Autonomous:  ${displayState.autonomousRuns} runs (${autonomyRate}%) — no human needed
  HITL:        ${displayState.hitlRuns} runs (${hitlRate}%) — emailed human for help
  Errors:      ${displayState.totalRuns - displayState.autonomousRuns - displayState.hitlRuns} runs

PER-AGENT ROI SCORE (estimated)
  LLM cost to date:     $${displayState.totalEstimatedCostUsd.toFixed(4)}
  Human time saved:     $${humanTimeSavedUsd.toFixed(2)} (${displayState.autonomousRuns} runs × ${ANALYST_MIN_PER_RUN} min × $${(ANALYST_RATE_USD_PER_HOUR/60).toFixed(2)}/min)
  Time breakdown:       5 min data pull + 5 min summary + 5 min format/send
  Rate assumption:      $${ANALYST_RATE_USD_PER_HOUR}/hr — update ANALYST_RATE_USD_PER_HOUR in agent.ts to adjust
  ROI score:            ${roiScore}x  ${Number(roiScore) > 10 ? "🟢 Excellent" : Number(roiScore) > 3 ? "🟡 Good" : "🔴 Needs improvement"}

THIS RUN
  Session ID:     ${task.sessionId}
  Type:           ${isTestRun ? "🧪 Test (not recorded)" : outcome === "autonomous" ? "✅ Autonomous" : outcome === "hitl" ? "⚠️ HITL triggered" : "❌ Error"}
  Data points:    ${dataPoints} new verified CPM data points
  Date:           ${today}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`

  const fullOutput = `${result.text}\n\n${metricsBlock}`

  await task.tools.ui_notify(textPromptNotifyEvent({ type: "text", text: fullOutput }))

  return { type: "text", text: fullOutput }
}

// ── Agent export ───────────────────────────────────────────────────────────────
export default agent({
  description:
    "CPM benchmark analyst with Guild metrics instrumentation. " +
    "Synthesizes AI insights from CPM data and tracks cost-per-task, " +
    "HITL utilization rate, and per-agent ROI score across all runs.",
  inputSchema,
  outputSchema,
  tools,
  run,
})

// ── Utilities ──────────────────────────────────────────────────────────────────
function extractJson(text: string): string {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (m) return m[1].trim()
  const s = text.indexOf("{"), e = text.lastIndexOf("}")
  if (s >= 0 && e > s) return text.slice(s, e + 1)
  return text
}
