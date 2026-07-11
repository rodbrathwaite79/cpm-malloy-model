"use agent"
/**
 * cpm-report-agent — Guild.ai Agent (v2)
 *
 * Tracks every dimension of ROI a Guild customer cares about:
 *
 *   1. AUTOMATION RATE      — % of pipeline runs that needed zero human help
 *   2. COST PER OUTPUT      — LLM token cost per report (from Guild API)
 *   3. HUMAN TIME RECOVERED — autonomous runs × estimated analyst minutes saved
 *   4. CHANGE REQUEST RATE  — how often humans had to ask for modifications
 *   5. IMPROVEMENT SIGNAL   — are change requests declining? (trust earning over time)
 *   6. IMPLEMENTATION RATE  — % of change requests the agent actually fulfilled
 *   7. ERROR RATE           — pipeline failures / total runs
 *   8. DATA COVERAGE        — verified CPM data points per run (output quality)
 *
 * ── Input modes ───────────────────────────────────────────────────────────────
 *
 *  MODE A — Automated pipeline run (called by Vercel cron / daily-report.mjs):
 *    { rows, webFindings, outcome: "autonomous"|"hitl"|"error", dataPoints: N }
 *
 *  MODE B — User change request (called when a human asks to modify the agent):
 *    { changeRequest: { type: "format"|"content"|"channels"|"frequency"|"recipients"|"other",
 *                       description: "change the email to include a bar chart" } }
 *
 *  MODE C — Mark a change as implemented (called after completing a change):
 *    { markImplemented: { sessionId: "abc123", notes: "added bar chart" } }
 *
 *  MODE D — Custom CPM query via Malloy semantic model:
 *    { rows, webFindings, question: "What is the YoY trend for CTV?" }
 *    (same as Mode A but question overrides the default executive summary prompt)
 *
 *  MODE E — Read-only metrics dashboard (no input data → test run):
 *    {}  or  { rows: [], webFindings: [], dataPoints: 0 }
 *
 *  MODE F — Reset all state:
 *    { reset: true }
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

// ── Pricing constants ─────────────────────────────────────────────────────────
const COST_PER_INPUT_TOKEN  = 3  / 1_000_000   // $3.00 / MTok (Claude Sonnet)
const COST_PER_OUTPUT_TOKEN = 15 / 1_000_000   // $15.00 / MTok

// ROI value assumptions — adjust to match your actual analyst costs
const ANALYST_RATE_USD_PER_HOUR   = 100   // hourly rate of the person this replaces
const ANALYST_MIN_PER_REPORT_RUN  = 15    // minutes to manually pull data + write + send
const ANALYST_MIN_PER_CHANGE_REQ  = 30    // minutes to scope + implement a change request
const SAVED_PER_AUTONOMOUS_RUN    = (ANALYST_RATE_USD_PER_HOUR / 60) * ANALYST_MIN_PER_REPORT_RUN
const COST_PER_CHANGE_REQUEST     = (ANALYST_RATE_USD_PER_HOUR / 60) * ANALYST_MIN_PER_CHANGE_REQ

// ── Neon metrics write (non-fatal) ────────────────────────────────────────────
async function postRunToNeon(record: {
  runDate: string; source: string; outcome: string;
  inputTokens: number; outputTokens: number; dataPointsFound: number
}): Promise<void> {
  const url = process.env.METRICS_API_URL
  const key = process.env.METRICS_API_KEY
  if (!url || !key) return
  try {
    await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body:    JSON.stringify(record),
    })
  } catch { /* non-fatal */ }
}

// ── Self-log interaction to Neon (non-fatal) ─────────────────────────────────
// Silently skipped when LOG_API_KEY is not set (e.g. in Guild sandbox).
// Works when running locally via daily-report.mjs with .env populated.
async function logInteractionToNeon(record: {
  project: string; provider: string; tool: string; task_type: string
  description: string; hours_estimate: number; hours_source?: string
  value_usd: number; first_pass?: boolean; corrections?: number
  session_id?: string; cost_model?: string; cost_usd?: number | null
  output?: string; notes?: string
}): Promise<void> {
  const url = process.env.LOG_API_URL ?? "https://cpm-vercel.vercel.app/api/log-interaction"
  const key = process.env.LOG_API_KEY
  if (!key) return
  try {
    await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body:    JSON.stringify(record),
    })
  } catch { /* non-fatal */ }
}

// ── Types ──────────────────────────────────────────────────────────────────────

type ChangeRequestType = "format" | "content" | "channels" | "frequency" | "recipients" | "other"

type ChangeRequest = {
  date:           string
  sessionId:      string
  type:           ChangeRequestType
  description:    string
  implemented:    boolean
  implementedAt?: string
  implementationNotes?: string
}

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
  // Pipeline run metrics
  totalRuns:              number
  autonomousRuns:         number
  hitlRuns:               number
  errorRuns:              number
  totalInputTokens:       number
  totalOutputTokens:      number
  totalEstimatedCostUsd:  number
  runHistory:             RunRecord[]        // last 30

  // Change request metrics (HITL interaction tracking)
  changeRequests:         ChangeRequest[]    // all-time log
  totalChangeRequests:    number
  implementedChanges:     number

  // Metadata
  firstRunDate?:          string
  lastRunDate?:           string
}

const EMPTY_STATE: AgentState = {
  totalRuns: 0, autonomousRuns: 0, hitlRuns: 0, errorRuns: 0,
  totalInputTokens: 0, totalOutputTokens: 0, totalEstimatedCostUsd: 0,
  runHistory: [],
  changeRequests: [], totalChangeRequests: 0, implementedChanges: 0,
}

// ── Tools ──────────────────────────────────────────────────────────────────────
const tools = { ...userInterfaceTools, ...guildTools }
type Tools = typeof tools

// ── Input / Output ─────────────────────────────────────────────────────────────
const inputSchema = z.object({
  type: z.literal("text"),
  text: z.string().describe(
    'JSON for one of 6 modes. See top-of-file comments for full schema.'
  ),
})
type Input = z.infer<typeof inputSchema>

const outputSchema = z.object({
  type: z.literal("text"),
  text: z.string().describe("AI analysis + ROI metrics dashboard"),
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

// ── Main run ───────────────────────────────────────────────────────────────────
async function run(input: Input, task: Task<Tools, AgentState>): Promise<Output> {

  // ── Parse input ─────────────────────────────────────────────────────────────
  let data: {
    rows?:           unknown[]
    webFindings?:    unknown[]
    question?:       string
    outcome?:        "autonomous" | "hitl" | "error"
    dataPoints?:     number
    reset?:          boolean
    changeRequest?:  { type: ChangeRequestType; description: string }
    markImplemented?: { sessionId: string; notes?: string }
  }
  try {
    data = JSON.parse(extractJson(input.text))
  } catch {
    // Plain-text question — treat as a custom CPM query
    data = { question: input.text }
  }

  const today = new Date().toISOString().slice(0, 10)
  await task.tools.ui_notify(progressLogNotifyEvent("Restoring agent state…"))
  const state: AgentState = (await task.restore()) ?? { ...EMPTY_STATE }

  // ════════════════════════════════════════════════════════════════════════════
  // MODE F — Reset
  // ════════════════════════════════════════════════════════════════════════════
  if (data.reset === true) {
    await task.save({ ...EMPTY_STATE })
    const msg = "✅ Agent state reset. All run history and change requests cleared."
    await task.tools.ui_notify(textPromptNotifyEvent({ type: "text", text: msg }))
    return { type: "text", text: msg }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // MODE B — Change request (human asking to modify the agent / report)
  // ════════════════════════════════════════════════════════════════════════════
  if (data.changeRequest) {
    const cr = data.changeRequest
    const record: ChangeRequest = {
      date:        today,
      sessionId:   task.sessionId,
      type:        cr.type,
      description: cr.description,
      implemented: false,
    }

    const updatedState: AgentState = {
      ...state,
      changeRequests:      [...(state.changeRequests ?? []), record],
      totalChangeRequests: (state.totalChangeRequests ?? 0) + 1,
    }
    await task.save(updatedState)

    const changeRateMsg = buildChangeRateSummary(updatedState)
    const msg = `
📋 CHANGE REQUEST LOGGED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Session:     ${task.sessionId}
Date:        ${today}
Type:        ${cr.type}
Description: ${cr.description}
Status:      ⏳ Pending implementation

This is recorded as a HITL interaction. Once the change is implemented,
call this agent with { "markImplemented": { "sessionId": "${task.sessionId}", "notes": "what was changed" } }
to close the loop and track your implementation rate.

${changeRateMsg}
`.trim()

    await task.tools.ui_notify(textPromptNotifyEvent({ type: "text", text: msg }))
    return { type: "text", text: msg }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // MODE C — Mark a change request as implemented
  // ════════════════════════════════════════════════════════════════════════════
  if (data.markImplemented) {
    const { sessionId, notes } = data.markImplemented
    const updatedRequests = (state.changeRequests ?? []).map(cr =>
      cr.sessionId === sessionId
        ? { ...cr, implemented: true, implementedAt: today, implementationNotes: notes ?? "" }
        : cr
    )
    const implementedCount = updatedRequests.filter(cr => cr.implemented).length

    const updatedState: AgentState = {
      ...state,
      changeRequests:   updatedRequests,
      implementedChanges: implementedCount,
    }
    await task.save(updatedState)

    const implementationRate = updatedState.totalChangeRequests > 0
      ? ((implementedCount / updatedState.totalChangeRequests) * 100).toFixed(1)
      : "0.0"

    const msg = `
✅ CHANGE REQUEST MARKED IMPLEMENTED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Session:             ${sessionId}
Implemented on:      ${today}
Notes:               ${notes ?? "(none)"}

Implementation rate: ${implementedCount} / ${updatedState.totalChangeRequests} (${implementationRate}%)

ROI note: Each implemented change represents ~${ANALYST_MIN_PER_CHANGE_REQ} min of analyst time
($${COST_PER_CHANGE_REQUEST.toFixed(2)}) spent improving the agent's output quality.
A declining change-request rate over time is the clearest signal that
the agent is earning more trust and requiring less human correction.
`.trim()

    await task.tools.ui_notify(textPromptNotifyEvent({ type: "text", text: msg }))
    return { type: "text", text: msg }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // MODES A, D, E — Pipeline run, custom query, or test (read-only dashboard)
  // ════════════════════════════════════════════════════════════════════════════

  const rows        = (data.rows        ?? []) as Array<{ channel: string; year: number; month: number; avg_cpm: number }>
  const webFindings = (data.webFindings ?? []) as Array<{ title: string; excerpt: string; url: string }>
  const question    = data.question     ?? "Provide an executive summary of CPM trends and 3-4 key insights."
  const outcome     = data.outcome      ?? "autonomous"
  const dataPoints  = data.dataPoints   ?? 0

  // No data at all = test/read-only mode — show dashboard without saving
  const isTestRun = rows.length === 0 && webFindings.length === 0 && dataPoints === 0 && !data.outcome

  // ── Fetch today's LLM usage from Guild ──────────────────────────────────────
  await task.tools.ui_notify(progressLogNotifyEvent("Fetching LLM usage from Guild…"))
  let todayInputTokens = 0, todayOutputTokens = 0
  try {
    const me = await task.tools.guild_get_me({})
    const usageRes = await task.tools.guild_get_daily_llm_usage({
      account_id: me.id,
      start_date: today,
      end_date:   today,
    })
    if (usageRes.items?.length > 0) {
      todayInputTokens  = usageRes.items[0].input_tokens
      todayOutputTokens = usageRes.items[0].output_tokens
    }
  } catch { /* non-fatal */ }

  const todayCost = todayInputTokens  * COST_PER_INPUT_TOKEN
                  + todayOutputTokens * COST_PER_OUTPUT_TOKEN

  // ── Generate AI insights ────────────────────────────────────────────────────
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

  // ── Update and persist state (skipped for test runs) ────────────────────────
  let displayState: AgentState

  if (isTestRun) {
    displayState = state
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
      ...state,
      totalRuns:             (state.totalRuns ?? 0) + 1,
      autonomousRuns:        (state.autonomousRuns ?? 0) + (outcome === "autonomous" ? 1 : 0),
      hitlRuns:              (state.hitlRuns      ?? 0) + (outcome === "hitl"       ? 1 : 0),
      errorRuns:             (state.errorRuns     ?? 0) + (outcome === "error"      ? 1 : 0),
      totalInputTokens:      (state.totalInputTokens  ?? 0) + todayInputTokens,
      totalOutputTokens:     (state.totalOutputTokens ?? 0) + todayOutputTokens,
      totalEstimatedCostUsd: (state.totalEstimatedCostUsd ?? 0) + todayCost,
      runHistory:            [...(state.runHistory ?? []).slice(-29), thisRun],
      firstRunDate:          state.firstRunDate ?? today,
      lastRunDate:           today,
    }

    await task.save(displayState)

    await postRunToNeon({
      runDate:         today,
      source:          "guild",
      outcome,
      inputTokens:     todayInputTokens,
      outputTokens:    todayOutputTokens,
      dataPointsFound: dataPoints,
    })

    // Self-log this run to Neon (non-fatal; silently skipped if LOG_API_KEY not set)
    await logInteractionToNeon({
      project:        "cpm-agent",
      provider:       "anthropic",
      tool:           "guild",
      task_type:      "analysis",
      description:    `CPM benchmark analysis — ${dataPoints} data points — ${outcome} run. ${question.slice(0, 120)}`,
      hours_estimate: ANALYST_MIN_PER_REPORT_RUN / 60,
      hours_source:   "estimated",
      value_usd:      outcome === "autonomous" ? SAVED_PER_AUTONOMOUS_RUN : 0,
      first_pass:     outcome === "autonomous",
      corrections:    outcome !== "autonomous" ? 1 : 0,
      session_id:     task.sessionId,
      cost_model:     "per-token",
      cost_usd:       todayCost > 0 ? todayCost : null,
      output:         `CPM report: ${dataPoints} data points`,
      notes:          `${displayState.autonomousRuns}/${displayState.totalRuns} runs autonomous`,
    })
  }

  // ── Build metrics dashboard ──────────────────────────────────────────────────
  const dashboard = buildMetricsDashboard(displayState, {
    todayInputTokens, todayOutputTokens, todayCost,
    dataPoints, outcome, sessionId: task.sessionId,
    isTestRun, today,
  })

  const fullOutput = `${result.text}\n\n${dashboard}`
  await task.tools.ui_notify(textPromptNotifyEvent({ type: "text", text: fullOutput }))
  return { type: "text", text: fullOutput }
}

// ── Metrics dashboard builder ─────────────────────────────────────────────────
function buildMetricsDashboard(
  s: AgentState,
  run: {
    todayInputTokens: number; todayOutputTokens: number; todayCost: number
    dataPoints: number; outcome: string; sessionId: string
    isTestRun: boolean; today: string
  }
): string {

  const totalRuns    = s.totalRuns     ?? 0
  const autoRuns     = s.autonomousRuns ?? 0
  const hitlRuns     = s.hitlRuns      ?? 0
  const errorRuns    = s.errorRuns     ?? 0
  const totalCost    = s.totalEstimatedCostUsd ?? 0

  // 1. Automation rate
  const automationRate = totalRuns > 0 ? (autoRuns / totalRuns * 100).toFixed(1) : "0.0"
  const hitlRate       = totalRuns > 0 ? (hitlRuns / totalRuns * 100).toFixed(1) : "0.0"
  const errorRate      = totalRuns > 0 ? (errorRuns / totalRuns * 100).toFixed(1) : "0.0"

  // 2. Cost per output
  const avgCostPerRun = totalRuns > 0 ? (totalCost / totalRuns * 100).toFixed(3) : "0.000"

  // 3. Human time recovered
  const humanTimeSavedUsd = autoRuns * SAVED_PER_AUTONOMOUS_RUN
  const humanMinSaved     = autoRuns * ANALYST_MIN_PER_REPORT_RUN

  // 4. ROI score (automation savings / LLM cost)
  const roiScore = totalCost > 0
    ? (humanTimeSavedUsd / totalCost).toFixed(1)
    : "∞"
  const roiLabel = Number(roiScore) > 10 ? "🟢 Excellent" : Number(roiScore) > 3 ? "🟡 Good" : "🔴 Needs improvement"

  // 5. Change request metrics
  const totalCR   = s.totalChangeRequests  ?? 0
  const implCR    = s.implementedChanges   ?? 0
  const pendingCR = totalCR - implCR
  const implRate  = totalCR > 0 ? (implCR / totalCR * 100).toFixed(1) : "N/A"
  const crPerRun  = totalRuns > 0 ? (totalCR / totalRuns).toFixed(2) : "0.00"

  // 6. Change request trend (last 10 runs vs previous 10 — declining = good)
  const crTrend = buildChangeRequestTrend(s)

  // 7. Average data coverage per run
  const avgDataPts = totalRuns > 0
    ? ((s.runHistory ?? []).reduce((acc, r) => acc + r.dataPointsFound, 0) / totalRuns).toFixed(1)
    : "0.0"

  // 8. Recent change requests list
  const recentCRs = (s.changeRequests ?? []).slice(-5).reverse()
  const crList = recentCRs.length > 0
    ? recentCRs.map(cr =>
        `  [${cr.implemented ? "✅" : "⏳"}] ${cr.date} · ${cr.type} · "${cr.description.slice(0, 60)}${cr.description.length > 60 ? "…" : ""}"`
      ).join("\n")
    : "  (none logged yet)"

  return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 GUILD AGENT ROI DASHBOARD${run.isTestRun ? " (read-only — test run)" : ""}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${run.isTestRun ? "⚠️  No input data — showing current state without recording.\n" : ""}
[1] AUTOMATION RATE  (${totalRuns} production runs${s.firstRunDate ? " since " + s.firstRunDate : ""})
    Autonomous:  ${autoRuns} runs  (${automationRate}%)  — completed with zero human intervention
    HITL:        ${hitlRuns} runs  (${hitlRate}%)         — pipeline needed human help
    Errors:      ${errorRuns} runs  (${errorRate}%)        — pipeline failed

[2] COST PER OUTPUT
    Today's tokens:    ${run.todayInputTokens.toLocaleString()} in / ${run.todayOutputTokens.toLocaleString()} out
    Today's LLM cost:  $${run.todayCost.toFixed(4)}
    Avg cost per run:  $${avgCostPerRun}¢   (all-time, production runs only)
    Total LLM spend:   $${totalCost.toFixed(4)}

[3] HUMAN TIME RECOVERED
    Minutes saved:     ${humanMinSaved} min  (${autoRuns} runs × ${ANALYST_MIN_PER_REPORT_RUN} min)
    Dollar equivalent: $${humanTimeSavedUsd.toFixed(2)}  (@ $${ANALYST_RATE_USD_PER_HOUR}/hr)
    Time breakdown:    5 min data pull + 5 min summary + 5 min format/send

[4] ROI SCORE
    Human value saved: $${humanTimeSavedUsd.toFixed(2)}
    LLM cost to date:  $${totalCost.toFixed(4)}
    ROI multiple:      ${roiScore}x  ${roiLabel}

[5] CHANGE REQUEST TRACKING (HITL interactions — user-initiated)
    Total requests:    ${totalCR}
    Implemented:       ${implCR}  (${implRate}% implementation rate)
    Pending:           ${pendingCR}
    Requests per run:  ${crPerRun}  ${crTrend}
    Human cost/CR:     ~$${COST_PER_CHANGE_REQUEST.toFixed(2)} (${ANALYST_MIN_PER_CHANGE_REQ} min @ $${ANALYST_RATE_USD_PER_HOUR}/hr)

    Recent change requests:
${crList}

[6] OUTPUT QUALITY
    Avg data points per run:  ${avgDataPts} verified CPM data points
    This run:                 ${run.dataPoints} new verified CPM data points

[7] THIS RUN
    Session ID:  ${run.sessionId}
    Date:        ${run.today}
    Type:        ${run.isTestRun ? "🧪 Test (not recorded)" : run.outcome === "autonomous" ? "✅ Autonomous" : run.outcome === "hitl" ? "⚠️  Pipeline HITL" : "❌ Error"}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HOW TO LOG A CHANGE REQUEST:
  { "changeRequest": { "type": "format", "description": "add bar chart to email" } }
  Types: format · content · channels · frequency · recipients · other

HOW TO MARK ONE IMPLEMENTED:
  { "markImplemented": { "sessionId": "<session-id>", "notes": "added bar chart" } }
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`.trim()
}

// ── Change request trend helper ───────────────────────────────────────────────
// Compares change request rate in the last 10 runs vs. prior 10 runs.
// A declining rate means the agent is earning trust over time.
function buildChangeRequestTrend(s: AgentState): string {
  const history = s.runHistory ?? []
  const crs     = s.changeRequests ?? []
  if (history.length < 5 || crs.length === 0) return "(not enough data yet)"

  // Build a date-indexed set of change requests
  const crDates = new Set(crs.map(cr => cr.date))

  // Last 10 run dates vs prior 10
  const recent10 = history.slice(-10).map(r => r.date)
  const prior10  = history.slice(-20, -10).map(r => r.date)

  const recentCRCount = recent10.filter(d => crDates.has(d)).length
  const priorCRCount  = prior10.filter(d => crDates.has(d)).length

  if (prior10.length === 0) return "(need 20+ runs for trend)"

  const recentRate = recentCRCount / recent10.length
  const priorRate  = priorCRCount  / prior10.length

  if (recentRate < priorRate)  return "📉 Declining — agent earning more trust"
  if (recentRate > priorRate)  return "📈 Rising — agent may need tuning"
  return "➡️  Stable"
}

// ── Change rate summary (used in Mode B output) ───────────────────────────────
function buildChangeRateSummary(s: AgentState): string {
  const total = s.totalChangeRequests ?? 0
  const impl  = s.implementedChanges  ?? 0
  const runs  = s.totalRuns           ?? 0
  return `
CHANGE REQUEST HISTORY
  Total logged:      ${total}
  Implemented:       ${impl}
  Pending:           ${total - impl}
  Requests per run:  ${runs > 0 ? (total / runs).toFixed(2) : "N/A"}
  ${buildChangeRequestTrend(s)}`.trim()
}

// ── Agent export ───────────────────────────────────────────────────────────────
export default agent({
  description:
    "CPM benchmark analyst with comprehensive Guild ROI instrumentation. " +
    "Tracks automation rate, cost per output, human time recovered, change request rate, " +
    "implementation rate, improvement signal, error rate, and data coverage across all runs. " +
    "Supports automated pipeline runs, user change request logging, implementation tracking, " +
    "custom CPM queries via Malloy semantic model, and read-only metrics dashboard mode.",
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
