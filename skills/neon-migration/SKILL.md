---
name: neon-migration
description: >
  Migrate local Parquet and CSV data into Neon Postgres using DuckDB for reading and
  @neondatabase/serverless for writing. Use this skill when setting up a new Neon project
  or re-seeding the database from the local parquet backup.
---

# Neon Migration — DuckDB → Neon Postgres

## When to use
- First-time setup: seed Neon from local `cpm_benchmarks.parquet`
- Recovery: re-seed after accidental data loss
- The migration script `cpm-vercel/scripts/migrate-to-neon.mjs` handles this

## Run the migration
```bash
cd ~/Documents/cpm-agent/malloy-model-git/cpm-vercel
DATABASE_URL="postgresql://..." node scripts/migrate-to-neon.mjs
```
Or set `DATABASE_URL` in `.env` first, then just `node scripts/migrate-to-neon.mjs`.

The migration is **idempotent** — duplicate rows are skipped via `ON CONFLICT DO NOTHING`.
Safe to run multiple times.

## Migration pattern
```js
import { neon } from "@neondatabase/serverless"
import duckdb from "duckdb"

async function migrate() {
  const sql = neon(process.env.DATABASE_URL)

  // 1. Ensure schema exists
  await initSchema(sql)

  // 2. Read local data with DuckDB
  const db   = new duckdb.Database(":memory:")
  const rows = await queryDuck(db,
    `SELECT year, month, month_name, channel, channel_label, cpm, source_note, report_date
     FROM read_parquet('${parquetPath}')
     ORDER BY year, month, channel`
  )
  db.close()
  console.log(`Read ${rows.length} rows from parquet`)

  // 3. Batch insert into Neon
  let inserted = 0, skipped = 0
  for (const row of rows) {
    try {
      await sql`
        INSERT INTO cpm_benchmarks (year, month, month_name, channel, channel_label, cpm, source_note, report_date)
        VALUES (${row.year}, ${row.month}, ${row.month_name}, ${row.channel},
                ${row.channel_label}, ${row.cpm}, ${row.source_note}, ${row.report_date})
        ON CONFLICT (year, month, channel) DO NOTHING
      `
      inserted++
    } catch (e) {
      console.warn(`Skip: ${row.year}-${row.month} ${row.channel}:`, e.message)
      skipped++
    }
  }
  console.log(`Done: ${inserted} inserted, ${skipped} skipped`)
}
```

## Verifying the migration
```bash
# Via Neon console SQL editor:
SELECT COUNT(*) FROM cpm_benchmarks;
-- Should return 210 (5 channels × 42 months, June 2023 – June 2026)

SELECT channel, COUNT(*) FROM cpm_benchmarks GROUP BY channel ORDER BY channel;
```

Or via the public metrics API:
```bash
curl https://cpm-vercel.vercel.app/api/metrics
# → { stats: { totalRows: 210, ... }, runHistory: [...] }
```

## Schema reference
See the `neon-postgres` skill for the full `cpm_benchmarks` table definition.

## After migration
The Vercel cron and Malloy model both read from Neon — no further action needed.
The local parquet file remains as a cold backup only.
