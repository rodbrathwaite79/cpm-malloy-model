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
 * Requires DATABASE_URL in environment or .env file.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const { Client } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from agent/ directory if present
try {
  const envPath = join(__dirname, '.env');
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const [key, ...vals] = line.split('=');
    if (key && !process.env[key]) process.env[key] = vals.join('=').trim();
  }
} catch { /* no .env, rely on environment */ }

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL not set.');
  process.exit(1);
}

const client = new Client({ connectionString: DATABASE_URL });

async function run() {
  await client.connect();

  // Safety check — show what we're about to delete
  const preview = await client.query(
    `SELECT id, session_id, description, created_at
     FROM ai_interactions
     WHERE provider = 'cursor' AND session_id LIKE 'git-%'
     ORDER BY id`
  );

  if (preview.rows.length === 0) {
    console.log('No cursor/git entries found — nothing to delete.');
    await client.end();
    return;
  }

  console.log(`\nFound ${preview.rows.length} mislabeled cursor entries:\n`);
  for (const row of preview.rows) {
    console.log(`  id=${row.id}  ${row.session_id}  "${row.description.slice(0, 60)}..."`);
  }

  // Confirm before deleting
  console.log('\nDeleting...');
  const result = await client.query(
    `DELETE FROM ai_interactions
     WHERE provider = 'cursor' AND session_id LIKE 'git-%'`
  );
  console.log(`\n✅ Deleted ${result.rowCount} rows.`);

  // Show updated totals
  const totals = await client.query(
    `SELECT COUNT(*) AS tasks,
            ROUND(SUM(hours_estimate)::numeric, 2) AS hours,
            SUM(value_usd) AS value_usd
     FROM ai_interactions`
  );
  const t = totals.rows[0];
  console.log(`\nUpdated totals: ${t.tasks} tasks · ${t.hours}h · $${t.value_usd} value`);

  await client.end();
}

run().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
