/**
 * database.js — Neon Postgres client for CPM Vercel project
 *
 * Uses @neondatabase/serverless HTTP driver (no WebSockets needed).
 * All queries use tagged-template literal syntax for safe parameterization.
 */

import { neon } from "@neondatabase/serverless"

let _sql = null

function db() {
  if (!_sql) {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL not set — add it to Vercel environment variables")
    }
    _sql = neon(process.env.DATABASE_URL)
  }
  return _sql
}

// ── Schema ────────────────────────────────────────────────────────────────────
// Call once at deploy time OR on first handler invocation.
// Safe to call repeatedly — uses CREATE TABLE IF NOT EXISTS.
export async function initSchema() {
  const sql = db()
  await sql`
    CREATE TABLE IF NOT EXISTS cpm_benchmarks (
      id            SERIAL PRIMARY KEY,
      year          INTEGER        NOT NULL,
      month         INTEGER        NOT NULL,
      month_name    VARCHAR(20),
      channel       VARCHAR(50)    NOT NULL,
      channel_label VARCHAR(100),
      cpm           NUMERIC(10,2)  NOT NULL,
      source_note   TEXT,
      report_date   DATE,
      created_at    TIMESTAMPTZ    DEFAULT NOW(),
      UNIQUE(year, month, channel)
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS agent_runs (
      id                SERIAL PRIMARY KEY,
      run_date          DATE        NOT NULL,
      source            VARCHAR(20) DEFAULT 'vercel',
      outcome           VARCHAR(20) NOT NULL,
      input_tokens      INTEGER     DEFAULT 0,
      output_tokens     INTEGER     DEFAULT 0,
      data_points_found INTEGER     DEFAULT 0,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `
}

// ── CPM benchmark queries ─────────────────────────────────────────────────────
export async function queryBenchmarks({ years = [], months = [], channels = [] } = {}) {
  const sql = db()
  // Build dynamic WHERE — Neon's tagged-template driver doesn't support dynamic
  // IN lists natively, so we filter in JS for the rare case of non-empty filters.
  const rows = await sql`
    SELECT
      year, month, month_name, channel, channel_label,
      CAST(cpm AS FLOAT)        AS avg_cpm,
      year * 100 + month        AS period_sort
    FROM cpm_benchmarks
    ORDER BY year, month, channel
  `
  return rows.filter(r =>
    (years.length    === 0 || years.includes(r.year))    &&
    (months.length   === 0 || months.includes(r.month))  &&
    (channels.length === 0 || channels.includes(r.channel))
  )
}

export async function upsertBenchmarks(newRows) {
  if (newRows.length === 0) return 0
  const sql = db()
  const MONTH_NAMES = [
    "", "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ]
  const CHANNEL_LABELS = {
    paid_social:          "Paid Social",
    paid_search:          "Paid Search",
    programmatic_display: "Programmatic Display",
    video_ctv:            "Video / CTV",
    streaming_audio:      "Streaming Audio",
  }
  let inserted = 0
  for (const r of newRows) {
    const note       = (r.note ?? "") + (r.sources?.length ? ` (Sources: ${r.sources.join("; ")})` : "")
    const reportDate = `${r.year}-${String(r.month).padStart(2, "0")}-01`
    await sql`
      INSERT INTO cpm_benchmarks
        (year, month, month_name, channel, channel_label, cpm, source_note, report_date)
      VALUES (
        ${r.year}, ${r.month}, ${MONTH_NAMES[r.month]},
        ${r.channel}, ${CHANNEL_LABELS[r.channel] ?? r.channel},
        ${r.cpm}, ${note}, ${reportDate}
      )
      ON CONFLICT (year, month, channel) DO NOTHING
    `
    inserted++
  }
  return inserted
}

// ── Run metrics ───────────────────────────────────────────────────────────────
export async function getRunStats() {
  const sql = db()
  const rows = await sql`
    SELECT
      COUNT(*)::int                                              AS total_runs,
      COUNT(*) FILTER (WHERE outcome = 'autonomous')::int       AS autonomous_runs,
      COUNT(*) FILTER (WHERE outcome = 'hitl')::int             AS hitl_runs,
      COUNT(*) FILTER (WHERE outcome = 'error')::int            AS error_runs,
      COALESCE(SUM(input_tokens),  0)::int                     AS total_input_tokens,
      COALESCE(SUM(output_tokens), 0)::int                     AS total_output_tokens
    FROM agent_runs
  `
  const s = rows[0]
  return {
    totalRuns:         s.total_runs,
    autonomousRuns:    s.autonomous_runs,
    hitlRuns:          s.hitl_runs,
    errorRuns:         s.error_runs,
    totalInputTokens:  s.total_input_tokens,
    totalOutputTokens: s.total_output_tokens,
  }
}

export async function getRecentRuns(limit = 30) {
  const sql = db()
  return sql`
    SELECT id, run_date, source, outcome, input_tokens, output_tokens, data_points_found, created_at
    FROM agent_runs
    ORDER BY created_at DESC
    LIMIT ${limit}
  `
}

export async function insertRun({ runDate, source = "vercel", outcome, inputTokens = 0, outputTokens = 0, dataPointsFound = 0 }) {
  const sql = db()
  await sql`
    INSERT INTO agent_runs (run_date, source, outcome, input_tokens, output_tokens, data_points_found)
    VALUES (${runDate}, ${source}, ${outcome}, ${inputTokens}, ${outputTokens}, ${dataPointsFound})
  `
}
