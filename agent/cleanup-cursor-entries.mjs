#!/usr/bin/env node
/**
 * cleanup-cursor-entries.mjs
 * Deletes the 12 mislabeled "cursor" entries from ai_interactions.
 * These were auto-logged by the now-deleted setup-auto-logging.sh git hook
 * which hardcoded provider="cursor" for every git commit.
 * The user never used Cursor — these entries should not exist.
 *
 * Usage (from repo root):
 *   node agent/cleanup-cursor-entries.mjs
 *
 * Reads DATABASE_URL from cpm-vercel/.env (no npm install required).
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Load .env — check agent/, repo root, and cpm-vercel/
const envCandidates = [
  join(__dirname, '.env'),
  join(__dirname, '..', '.env'),
  join(__dirname, '..', '.env.local'),
  join(__dirname, '..', 'cpm-vercel', '.env'),
];
for (const envPath of envCandidates) {
  try {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (key && !process.env[key]) process.env[key] = val;
    }
    if (process.env.DATABASE_URL) break;
  } catch { /* try next */ }
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL not found in any .env file.');
  process.exit(1);
}

// Use @neondatabase/serverless already installed in cpm-vercel/
const { neon } = require('../cpm-vercel/node_modules/@neondatabase/serverless');
const sql = neon(DATABASE_URL);

async function run() {
  const preview = await sql`
    SELECT id, session_id, description
    FROM ai_interactions
    WHERE provider = 'cursor' AND session_id LIKE 'git-%'
    ORDER BY id
  `;

  if (preview.length === 0) {
    console.log('No cursor/git entries found — nothing to delete.');
    return;
  }

  console.log(`\nFound ${preview.length} mislabeled cursor entries:\n`);
  for (const row of preview) {
    console.log(`  id=${row.id}  ${row.session_id}  "${(row.description || '').slice(0, 60)}"`);
  }

  console.log('\nDeleting...');
  await sql`
    DELETE FROM ai_interactions
    WHERE provider = 'cursor' AND session_id LIKE 'git-%'
  `;
  console.log(`\n✅ Deleted ${preview.length} rows.`);

  const [totals] = await sql`
    SELECT COUNT(*) AS tasks,
           ROUND(SUM(hours_estimate)::numeric, 2) AS hours,
           SUM(value_usd) AS value_usd
    FROM ai_interactions
  `;
  console.log(`\nUpdated totals: ${totals.tasks} tasks · ${totals.hours}h · $${totals.value_usd} value`);
}

run().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
