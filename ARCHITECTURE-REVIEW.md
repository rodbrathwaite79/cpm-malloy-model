# CPM Agent System — Architecture Review
July 2026

---

## Completed

### ✅ 1. `callGemini()` latent ReferenceError — FIXED
Gemini code path and dead `geminiKey` config removed from `cpm-report.js`.

### ✅ 2. Extract `synthesizeInsights()` to `lib/insights.js` — DONE
`cpm-vercel/lib/insights.js` created. Both `cpm-report.js` and `generate-dashboard.mjs` import from it. Single source of truth.

### ✅ 3. `daily-report.mjs` divergence — RESOLVED (Option A)
Accepted as a standalone fallback runner. Constants synced at last review. Clearly marked in the file header as the Mac backup, not part of the primary pipeline. Option B (shared imports) remains available if a significant report change requires it.

### ✅ 4. Remove dead `geminiKey` from `cfg()` — DONE
Covered by #1 fix.

### ✅ 5. Switch Malloyyo to Neon for CPM benchmarks — DONE
`index.malloy` now reads from `neon.table('public.cpm_benchmarks')`. Parquet source removed.

### ✅ 7. Document `generate-dashboard.mjs` role — DONE
File header updated with clear "LOCAL PREVIEW TOOL — not part of the production pipeline" notice.

---

## Still Open

### 6. Three Guild agents with overlapping log functionality
**Files:** `agent/agent.ts`, `agent/cowork-tracker.ts`, `agent/universal-tracker.ts`
**Status:** Left as-is by design. All three write to `ai_interactions` but each serves a distinct workflow context (CPM pipeline metrics, Cowork session logging, general AI tracking). The separation keeps each agent's modes focused.
**Revisit if:** A fourth tracking agent is ever added — that would be the signal to consolidate.

---

## Leave It Alone

### 8. Vercel cron + Mac launchd redundancy
The dual runner is intentional. Vercel is primary; Mac launchd is a backup that also fires Monday 8am local time.

### 9. API endpoint split (`/api/log-interaction`, `/api/interactions`, `/api/tracker-stats`)
Each has a distinct access pattern and auth level. Consolidating would trade clarity for brevity. Leave it.

### 10. `cfg()` called repeatedly in `cpm-report.js`
Reads from `process.env` on every call — fine for Lambda. Not worth touching.

---

## Summary

| # | Item | Status |
|---|------|--------|
| 1 | Fix `callGemini()` ReferenceError | ✅ Done |
| 2 | Extract `synthesizeInsights()` to shared lib | ✅ Done |
| 3 | Sync `daily-report.mjs` + note divergence | ✅ Done (Option A) |
| 4 | Delete dead `geminiKey` config | ✅ Done |
| 5 | Switch Malloyyo to Neon | ✅ Done |
| 6 | Consolidate Guild agents | ⏸ Skip — intentionally separate |
| 7 | Document `generate-dashboard.mjs` role | ✅ Done |
