#!/usr/bin/env node
/**
 * cleanup-cursor-entries.mjs
 * Deletes the 12 mislabeled "cursor" entries from ai_interactions.
 * These were auto-logged by the now-deleted setup-auto-logging.sh git hook
 * which hardcoded provider="cursor" for every git commit.
 * The user never used Cursor — these entries should not exist.
 *
 * Usage:
 *   cd ~/Documents/cpm-agent/malloy-model-git
 *   node agent/cleanup-cursor-entries.mjs
 *
 * Requires DATABASE_URL in environment or agent/.env file.
 * Uses @neondatabase/serverless from cpm-vercel/node_modules (already installed).
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from agent/, repo root, or cpm-vercel/ — whichever has DATABASE_URL
const envCandidates = [
  join(__dirname, '.env'),
  join(__dirname, '..', '.env'),
  join(__dirname, '..', '.env.local'),
  join(__dirname, '..', 'cpm-vercel', '.env'),
];
for (const envPath of envCandidates) {
  try {
    const lines = readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (key && !process.env[key]) process.env[key] = val;
    }
    if (process.env.DATABASE_URL) break;
  } catch { /* file not found, try next */ }
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL not set.');
  process.exit(1);
}

// Import from cpm-vercel's already-installed node_modules
const { neon } = await import('../cpm-vercel/node_modules/@neondatabase/serverless/index.js');
const sql = neon(DATABASE_URL);

async function run() {
  // Safety preview — show what we're about to delete
  const preview = await sql`
    SELECT id, session_id, description, created_at
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
    const desc = (row.description || '').slice(0, 60);
    console.log(`  id=${row.id}  ${row.session_id}  "${desc}..."`);
  }

  console.log('\nDeleting...');
  await sql`
    DELETE FROM ai_interactions
    WHERE provider = 'cursor' AND session_id LIKE 'git-%'
  `;
  console.log(`\n✅ Deleted ${preview.length} rows.`);

  // Show updated totals
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
