#!/usr/bin/env node
/**
 * migrate-to-neon.mjs — One-time migration from local parquet → Neon Postgres
 *
 * Run this ONCE from the Mac that has the parquet + CSV files.
 * After migration, the Vercel function reads all data from Neon.
 *
 * Usage:
 *   cd ~/Documents/cpm-agent/cpm-vercel
 *   DATABASE_URL="postgresql://..." node scripts/migrate-to-neon.mjs
 *
 *   OR copy DATABASE_URL into .env here first, then just:
 *   node scripts/migrate-to-neon.mjs
 *
 * Prerequisites:
 *   npm install @neondatabase/serverless   (run in cpm-vercel/)
 *   duckdb must be installed in ../agent/cpm-report-agent/node_modules/
 */

import path from "path"
import { fileURLToPath } from "url"
import { existsSync, readFileSync } from "fs"
import { createRequire } from "module"
import { neon } from "@neondatabase/serverless"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT      = path.resolve(__dirname, "../../")

// ── Load .env from cpm-vercel directory ───────────────────────────────────────
const envPath = path.join(__dirname, "../.env.example")
const envLocal = path.join(__dirname, "../.env")
for (const p of [envLocal]) {
  if (existsSync(p)) {
    for (const line of readFileSync(p, "utf-8").split("\n")) {
      const m = line.match(/^([A-Z_]+)=["']?(.+?)["']?\s*$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
    }
  }
}

if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL not set. Export it or add to cpm-vercel/.env")
  console.error("   Get it from: console.neon.tech → your project → Connection String")
  process.exit(1)
}

const sql = neon(process.env.DATABASE_URL)

const PARQUET_PATH = path.resolve(ROOT, "malloy-model-git/cpm_benchmarks.parquet")
const CSV_PATH     = path.resolve(ROOT, "malloy-model-git/cpm_monthly_updates.csv")
const DUCKDB_PATH  = path.resolve(ROOT, "agent/cpm-report-agent/node_modules/duckdb")

const MONTH_NAMES = ["","January","February","March","April","May","June","July","August","September","October","November","December"]
const CHANNEL_LABELS = {
  paid_social: "Paid Social", paid_search: "Paid Search",
  programmatic_display: "Programmatic Display", video_ctv: "Video / CTV",
  streaming_audio: "Streaming Audio",
}

// ── Create schema ─────────────────────────────────────────────────────────────
async function ensureSchema() {
  console.log("Creating schema if not exists…")
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
  console.log("✅ Schema ready")
}

// ── Query local data via DuckDB ───────────────────────────────────────────────
async function queryLocalRows() {
  if (!existsSync(DUCKDB_PATH)) {
    console.error("❌ DuckDB not found at", DUCKDB_PATH)
    console.error("   Run: cd ~/Documents/cpm-agent/agent/cpm-report-agent && npm install")
    process.exit(1)
  }
  const require = createRequire(import.meta.url)
  const duckdb  = require(DUCKDB_PATH)
  const query   = (db, sql2) => new Promise((res, rej) => db.all(sql2, (e, r) => e ? rej(e) : res(r)))
  const db      = new duckdb.Database(":memory:")

  let parquetRows = [], csvRows = []

  if (existsSync(PARQUET_PATH)) {
    parquetRows = await query(db, `
      SELECT year, month, month_name, channel, channel_label, cpm
      FROM read_parquet('${PARQUET_PATH}')
      ORDER BY year, month, channel
    `)
    console.log(`  Parquet: ${parquetRows.length} rows`)
  } else {
    console.warn("  ⚠️  Parquet file not found:", PARQUET_PATH)
  }

  if (existsSync(CSV_PATH)) {
    csvRows = await query(db, `
      SELECT year, month, month_name, channel, channel_label, cpm, source_note, report_date
      FROM read_csv_auto('${CSV_PATH}')
      ORDER BY year, month, channel
    `)
    console.log(`  CSV:     ${csvRows.length} rows`)
  } else {
    console.warn("  ⚠️  CSV file not found:", CSV_PATH)
  }

  db.close()
  return { parquetRows, csvRows }
}

// ── Insert rows into Neon ─────────────────────────────────────────────────────
async function insertRows(rows, source) {
  let inserted = 0, skipped = 0
  for (const r of rows) {
    const monthName   = r.month_name   ?? MONTH_NAMES[Number(r.month)]   ?? ""
    const channelLabel = r.channel_label ?? CHANNEL_LABELS[r.channel]     ?? r.channel
    const sourceNote  = r.source_note  ?? `Migrated from local ${source}`
    const reportDate  = r.report_date
      ? new Date(r.report_date).toISOString().slice(0, 10)
      : `${r.year}-${String(r.month).padStart(2, "0")}-01`

    try {
      await sql`
        INSERT INTO cpm_benchmarks (year, month, month_name, channel, channel_label, cpm, source_note, report_date)
        VALUES (${Number(r.year)}, ${Number(r.month)}, ${monthName}, ${r.channel}, ${channelLabel}, ${Number(r.cpm)}, ${sourceNote}, ${reportDate})
        ON CONFLICT (year, month, channel) DO NOTHING
      `
      inserted++
    } catch (e) {
      console.warn(`  Skipped row (${r.year}-${r.month} ${r.channel}):`, e.message.slice(0, 60))
      skipped++
    }
  }
  return { inserted, skipped }
}

// ── Verify ────────────────────────────────────────────────────────────────────
async function verify() {
  const rows = await sql`SELECT COUNT(*)::int AS n FROM cpm_benchmarks`
  return rows[0].n
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("═".repeat(60))
  console.log("  CPM → Neon Migration Script")
  console.log("  Target:", process.env.DATABASE_URL.replace(/:[^:@]+@/, ":***@"))
  console.log("═".repeat(60))

  await ensureSchema()

  console.log("\nReading local data…")
  const { parquetRows, csvRows } = await queryLocalRows()

  if (parquetRows.length > 0) {
    console.log(`\nInserting ${parquetRows.length} parquet rows into Neon…`)
    const r = await insertRows(parquetRows, "parquet")
    console.log(`  ✅ Inserted: ${r.inserted}  Skipped (duplicate): ${r.skipped}`)
  }

  if (csvRows.length > 0) {
    console.log(`\nInserting ${csvRows.length} CSV rows into Neon…`)
    const r = await insertRows(csvRows, "csv")
    console.log(`  ✅ Inserted: ${r.inserted}  Skipped (duplicate): ${r.skipped}`)
  }

  const total = await verify()
  console.log(`\n${"═".repeat(60)}`)
  console.log(`  ✅ Migration complete — ${total} rows now in Neon cpm_benchmarks`)
  console.log("   You can now deploy the Vercel function.")
  console.log("═".repeat(60))
}

main().catch(e => { console.error("Fatal:", e); process.exit(1) })
