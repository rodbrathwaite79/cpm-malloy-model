---
name: neon-postgres
description: >
  Connect to Neon Postgres using @neondatabase/serverless (HTTP driver), initialize schema,
  and perform inserts and queries. Use this skill whenever building a Vercel serverless function
  or Node.js script that needs to read from or write to Neon Postgres — including schema creation,
  upserts, aggregations, and multi-table queries.
---

# Neon Postgres — Connection & Schema Patterns

## Package
```bash
npm install @neondatabase/serverless
```

## Connection pattern
Always use the HTTP driver (`neon()`), not the WebSocket pool. The HTTP driver works in
Vercel Edge/Serverless and standard Node without extra config.

```js
import { neon } from "@neondatabase/serverless"
const sql = neon(process.env.DATABASE_URL)

// Tagged-template query — SQL injection safe
const rows = await sql`SELECT * FROM cpm_benchmarks WHERE year = ${year}`
```

`DATABASE_URL` format: `postgresql://user:password@host/dbname?sslmode=require`
Obtain from Neon console → project → connection string.

## Schema init pattern
Run `initSchema()` once per cold start (guard with a module-level flag):

```js
let schemaReady = false

export async function initSchema() {
  const sql = neon(process.env.DATABASE_URL)
  await sql`
    CREATE TABLE IF NOT EXISTS cpm_benchmarks (
      id           SERIAL PRIMARY KEY,
      year         INTEGER NOT NULL,
      month        INTEGER NOT NULL,
      month_name   TEXT,
      channel      TEXT NOT NULL,
      channel_label TEXT,
      cpm          NUMERIC(8,2) NOT NULL,
      source_note  TEXT,
      report_date  DATE,
      UNIQUE (year, month, channel)
    )
  `
  // Add columns that may not exist yet (idempotent migration)
  await sql`ALTER TABLE ai_interactions ADD COLUMN IF NOT EXISTS
    hours_source TEXT NOT NULL DEFAULT 'estimated'
    CHECK (hours_source IN ('measured','estimated'))`
}

// In handler:
if (!schemaReady) {
  try { await initSchema(); schemaReady = true }
  catch (e) { return res.status(500).json({ error: "DB init failed", detail: e.message }) }
}
```

## Upsert pattern
Use `ON CONFLICT DO NOTHING` or `ON CONFLICT ... DO UPDATE` to make writes idempotent:

```js
await sql`
  INSERT INTO cpm_benchmarks (year, month, month_name, channel, channel_label, cpm, source_note, report_date)
  VALUES (${row.year}, ${row.month}, ${row.monthName}, ${row.channel},
          ${row.channelLabel}, ${row.cpm}, ${row.note}, ${row.date})
  ON CONFLICT (year, month, channel) DO UPDATE
    SET cpm = EXCLUDED.cpm, source_note = EXCLUDED.source_note
`
```

## Aggregate query pattern
```js
const rows = await sql`
  SELECT channel, year, month,
         AVG(cpm) AS avg_cpm,
         year * 100 + month AS period_sort
  FROM cpm_benchmarks
  GROUP BY channel, year, month
  ORDER BY period_sort
`
```

## Key decisions
- Use `@neondatabase/serverless` HTTP driver — not `pg` or `postgres` — for Vercel compatibility.
- Never hard-code `DATABASE_URL`; always read from `process.env`.
- Schema migrations use `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` — safe to run repeatedly.
- `UNIQUE` constraints + `ON CONFLICT` make all inserts idempotent.

## Environment variable
| Var | Where to get |
|-----|-------------|
| `DATABASE_URL` | Neon console → project → connection string (sslmode=require) |
