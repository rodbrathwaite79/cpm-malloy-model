/**
 * /api/metrics — Read and write agent run records in Neon Postgres
 *
 * GET  /api/metrics          → returns last 30 runs + aggregate stats
 *                               (used by Guild agent to display history)
 *
 * POST /api/metrics          → inserts a run record
 *                               (called by Guild agent after each synthesis run)
 *                               Requires:  Authorization: Bearer {METRICS_API_KEY}
 *
 * Body for POST:
 *   { runDate, source, outcome, inputTokens, outputTokens, dataPointsFound }
 */

import { getRunStats, getRecentRuns, insertRun } from "../lib/database.js"

export default async function handler(req, res) {
  // CORS — allows dashboard to load from file:// or any origin
  res.setHeader("Access-Control-Allow-Origin",  "*")
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")
  if (req.method === "OPTIONS") return res.status(204).end()

  // ── GET — public read of recent runs and aggregate stats ─────────────────
  if (req.method === "GET") {
    try {
      const [stats, runHistory] = await Promise.all([getRunStats(), getRecentRuns(30)])
      return res.status(200).json({ stats, runHistory })
    } catch (e) {
      return res.status(500).json({ error: "Query failed", detail: e.message })
    }
  }

  // ── POST — authenticated write ──────────────────────────────────────────
  if (req.method === "POST") {
    const apiKey = process.env.METRICS_API_KEY
    const auth   = req.headers.authorization ?? ""
    if (!apiKey || auth !== `Bearer ${apiKey}`) {
      return res.status(401).json({ error: "Unauthorized — METRICS_API_KEY mismatch" })
    }

    const {
      runDate,
      source         = "guild",
      outcome,
      inputTokens    = 0,
      outputTokens   = 0,
      dataPointsFound = 0,
    } = typeof req.body === "string" ? JSON.parse(req.body) : req.body ?? {}

    if (!runDate || !outcome) {
      return res.status(400).json({ error: "runDate and outcome are required" })
    }

    try {
      await insertRun({ runDate, source, outcome, inputTokens, outputTokens, dataPointsFound })
      return res.status(201).json({ ok: true })
    } catch (e) {
      return res.status(500).json({ error: "Insert failed", detail: e.message })
    }
  }

  return res.status(405).json({ error: "Method not allowed" })
}
