/**
 * log-interaction.js — Vercel serverless endpoint
 *
 * POST /api/log-interaction
 *
 * Records one AI interaction from any provider (Claude, ChatGPT, Cursor, etc.)
 * into the Neon ai_interactions table.
 *
 * Auth: Authorization: Bearer LOG_API_KEY  (set in Vercel env vars)
 *
 * Body (JSON):
 *   provider*       string   "anthropic" | "openai" | "google" | "cursor" | any
 *   tool*           string   "cowork" | "claude-code" | "chat" | "cursor" | ...
 *   task_type*      string   "code" | "document" | "analysis" | "testing" | "research" | "design"
 *   description*    string   What was done
 *   hours_estimate* number   Estimated human hours this replaced (must be > 0)
 *   value_usd*      number   Dollar value at hourly rate
 *   project         string   Project namespace (default: "default")
 *   first_pass      boolean  Did AI get it right first try? (default: true)
 *   corrections     number   Number of correction rounds needed (default: 0)
 *   output          string   Output artifact description
 *   notes           string   Any extra notes
 *   cost_model      string   "per-token" | "subscription" | "free" (default: "per-token")
 *   cost_usd        number?  Actual API cost in USD; null for subscription/free tools
 *   session_id      string   Conversation/session identifier
 *
 * Returns:
 *   200  { ok: true, id: number }
 *   400  { error: "Missing required field: X" | validation message }
 *   401  { error: "Unauthorized" }
 *   405  { error: "Method not allowed" }
 *   500  { error: "Internal server error" }
 */

import { insertAiInteraction, initAiInteractionsSchema } from "../lib/database.js"

const VALID_TASK_TYPES = new Set(["code", "document", "analysis", "testing", "research", "design"])
const VALID_COST_MODELS = new Set(["per-token", "subscription", "free"])
const REQUIRED_FIELDS   = ["provider", "tool", "task_type", "description", "hours_estimate", "value_usd"]

let schemaReady = false

export default async function handler(req, res) {
  // ── Method guard ─────────────────────────────────────────────────────────────
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  // ── Auth ─────────────────────────────────────────────────────────────────────
  const expectedKey = process.env.LOG_API_KEY
  const authHeader  = req.headers["authorization"] ?? ""
  const providedKey = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : ""

  if (!expectedKey || providedKey !== expectedKey) {
    return res.status(401).json({ error: "Unauthorized" })
  }

  // ── Parse body ───────────────────────────────────────────────────────────────
  let body
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body
  } catch {
    return res.status(400).json({ error: "Invalid JSON body" })
  }

  // ── Required field validation ─────────────────────────────────────────────────
  for (const field of REQUIRED_FIELDS) {
    if (body[field] === undefined || body[field] === null || body[field] === "") {
      return res.status(400).json({ error: `Missing required field: ${field}` })
    }
  }

  // ── Type validation ───────────────────────────────────────────────────────────
  const hoursEstimate = Number(body.hours_estimate)
  if (isNaN(hoursEstimate) || hoursEstimate <= 0) {
    return res.status(400).json({ error: "hours_estimate must be a positive number" })
  }

  const valueUsd = Number(body.value_usd)
  if (isNaN(valueUsd) || valueUsd < 0) {
    return res.status(400).json({ error: "value_usd must be a non-negative number" })
  }

  const taskType = String(body.task_type)
  if (!VALID_TASK_TYPES.has(taskType)) {
    return res.status(400).json({
      error: `Invalid task_type "${taskType}". Must be one of: ${[...VALID_TASK_TYPES].join(", ")}`,
    })
  }

  const costModel = body.cost_model ? String(body.cost_model) : "per-token"
  if (!VALID_COST_MODELS.has(costModel)) {
    return res.status(400).json({
      error: `Invalid cost_model "${costModel}". Must be one of: ${[...VALID_COST_MODELS].join(", ")}`,
    })
  }

  const corrections = Number(body.corrections ?? 0)
  if (isNaN(corrections) || corrections < 0 || !Number.isInteger(corrections)) {
    return res.status(400).json({ error: "corrections must be a non-negative integer" })
  }

  // ── Ensure schema exists (idempotent, skipped after first call in process) ────
  if (!schemaReady) {
    await initAiInteractionsSchema()
    schemaReady = true
  }

  // ── Insert ───────────────────────────────────────────────────────────────────
  try {
    const id = await insertAiInteraction({
      project:       body.project       ?? "default",
      provider:      String(body.provider),
      tool:          String(body.tool),
      taskType,
      description:   String(body.description),
      hoursEstimate,
      valueUsd,
      firstPass:     body.first_pass !== undefined ? Boolean(body.first_pass) : true,
      corrections,
      output:        body.output     ?? "",
      notes:         body.notes      ?? "",
      costModel,
      costUsd:       body.cost_usd !== undefined && body.cost_usd !== null
                       ? Number(body.cost_usd)
                       : null,
      sessionId:     body.session_id ?? "",
    })

    return res.status(200).json({ ok: true, id })
  } catch (err) {
    console.error("[log-interaction] DB error:", err)
    return res.status(500).json({ error: "Internal server error" })
  }
}
