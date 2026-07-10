---
name: duckdb-parquet
description: >
  Query local or remote Parquet files and CSVs using DuckDB in Node.js.
  Use this skill whenever a Mac-side script needs to read CPM benchmark data from
  local parquet files or remote URLs without a live database connection.
---

# DuckDB Parquet — Node.js Query Pattern

## Package
```bash
npm install duckdb   # native binary, must npm install per CPU architecture
```

Apple Silicon note: if you see a DuckDB architecture error, `rm -rf node_modules && npm install`
to rebuild for the current CPU.

## Query pattern (callback-based, CJS)
The `duckdb` npm package is CommonJS and callback-based. Use `createRequire` to load it from ESM:

```js
import { createRequire } from "module"
import { existsSync } from "fs"
import path from "path"
import { fileURLToPath } from "url"
const __dirname = path.dirname(fileURLToPath(import.meta.url))

async function queryLocalData() {
  const parquetPath = path.resolve(__dirname, "../../cpm_benchmarks.parquet")
  const csvPath     = path.resolve(__dirname, "../../cpm_monthly_updates.csv")

  const require = createRequire(import.meta.url)
  const duckdb  = require("duckdb")

  // Promisify the callback API
  const queryDuck = (db, sql) => new Promise((resolve, reject) =>
    db.all(sql, (err, rows) => err ? reject(err) : resolve(rows))
  )

  const db = new duckdb.Database(":memory:")

  let parquetRows = []
  if (existsSync(parquetPath)) {
    parquetRows = await queryDuck(db,
      `SELECT year, month, month_name, channel, channel_label, cpm AS avg_cpm
       FROM read_parquet('${parquetPath}')
       ORDER BY year, month, channel`
    )
  }

  let csvRows = []
  if (existsSync(csvPath)) {
    csvRows = await queryDuck(db,
      `SELECT year, month, month_name, channel, channel_label, cpm AS avg_cpm
       FROM read_csv_auto('${csvPath}')
       ORDER BY year, month, channel`
    )
  }

  db.close()
  console.log(`DuckDB: ${parquetRows.length} parquet + ${csvRows.length} CSV rows`)
  return [...parquetRows, ...csvRows]
}
```

## Remote Parquet (GitHub raw URL)
DuckDB can query a remote Parquet file over HTTPS without downloading it first:
```js
const rows = await queryDuck(db,
  `SELECT * FROM read_parquet('https://raw.githubusercontent.com/owner/repo/main/file.parquet')`
)
```
Note: this requires network access and the file must be public. Prefer Neon for live/updated data.

## Fallback to CSV-only
If DuckDB isn't available (wrong architecture, missing binary), fall back to reading the CSV
with Node's readline — this gives you the update rows but not the base parquet data.

## Filtering with WHERE
```js
const where = `WHERE year IN (${years.join(",")}) AND channel IN (${channels.map(c => `'${c}'`).join(",")})`
const rows = await queryDuck(db, `SELECT ... FROM read_parquet('${path}') ${where}`)
```

## Architecture notes
- DuckDB is only used Mac-side in `daily-report.mjs`
- The Vercel version reads from Neon Postgres instead (no DuckDB in serverless)
- The Malloy model previously used DuckDB to read a GitHub Parquet URL; it now uses Neon directly
