/**
 * fix-quality.js — ONE-SHOT quality correction endpoint
 *
 * POST /api/fix-quality  { "key": "<LOG_API_KEY>" }
 *
 * Updates first_pass/corrections for records where values were logged
 * incorrectly (task was incomplete but logged as first_pass: true).
 *
 * REMOVE THIS FILE after running once.
 */

import { neon } from "@neondatabase/serverless"

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end()

  const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body
  const key = process.env.LOG_API_KEY
  if (!key || body.key !== key) return res.status(401).json({ error: "Unauthorized" })

  const sql = neon(process.env.DATABASE_URL)

  // id=63 (session-2026-07-13-1736): doc audit — claimed "all 4 docs updated" but
  // continuation session found 6 more files needing correction (Live Dashboard,
  // ROI & HITL Guide, CPM-Skills-Reference, plus 3 re-audited files).
  await sql`
    UPDATE ai_interactions
    SET first_pass = false, corrections = 6
    WHERE id = 63
  `

  // id=28 (session-2026-07-10-1530): original ELI5 doc rewrite — logged as first_pass:true
  // but required a full correction pass on July 13 across 7 files.
  await sql`
    UPDATE ai_interactions
    SET first_pass = false, corrections = 1
    WHERE id = 28
  `

  const rows = await sql`
    SELECT id, session_id, task_type, description, first_pass, corrections
    FROM ai_interactions
    WHERE id IN (28, 63)
    ORDER BY id
  `

  return res.status(200).json({ ok: true, updated: rows })
}
