# CPM Agent System — Architecture Review
July 2026

---

## Bugs (Fix Now)

### 1. `callGemini()` latent ReferenceError in `cpm-report.js`
**File:** `cpm-vercel/api/cpm-report.js`, line 171  
**Problem:** `synthesizeInsights()` was replaced with rule-based logic, but `extractCpmWithLlm()` — the function that extracts CPM values from web search results — still has a code path that calls `callGemini()`, which no longer exists. If `GEMINI_API_KEY` is set in Vercel, this throws `ReferenceError: callGemini is not defined` and breaks CPM extraction on the 1st of every month.  
**Fix:** Remove the `if (geminiKey)` branch from `extractCpmWithLlm()` and fall straight to the Anthropic path, or fall straight to regex if no AI key is set. Also remove `geminiKey` from the `cfg()` object — it's dead config.  
**Risk of not fixing:** If `GEMINI_API_KEY` is not set in Vercel, `geminiKey` is falsy and this code path is never entered — the bug is dormant. But if the key is ever re-added, CPM extraction will silently fail on month-boundary runs. The dead code should be removed to eliminate the risk entirely.

---

## High-Value Optimizations (Do Soon)

### 2. Extract `synthesizeInsights()` to `lib/insights.js`
**Files:** `cpm-report.js` lines 195–342 and `scripts/generate-dashboard.mjs` lines 17–99  
**Problem:** The same 145-line function is copy-pasted in two files. Any improvement to the insight logic has to be applied in two places, and they've already drifted slightly (generate-dashboard.mjs has minor wording differences).  
**Fix:** Create `cpm-vercel/lib/insights.js` exporting `synthesizeInsights`. Both files import it. Single source of truth.  
**Effort:** ~30 minutes.

### 3. `daily-report.mjs` has diverged badly from `cpm-report.js`
**Problem:** The Mac backup runner re-implements everything from scratch — its own HTTP helper, Brave search, GitHub CSV update, Resend email, CPM extraction, and even its own copies of `CHANNEL_LABELS`, `MONTH_NAMES`, and `CHANNELS` constants. It does not import from `lib/report-html.js` or `lib/database.js`. This means:
- Bug fixes to the Vercel version don't carry to the Mac version
- Constants can drift between the two (and they already have — the Mac version has slightly different User-Agent strings, no timeout parameter on requests, etc.)
- Any improvement to report generation has to be done twice

**Fix options:**
- **Option A (simpler):** Accept that daily-report.mjs is a standalone fallback and add a comment clearly marking it as such. Sync the constants at minimum.
- **Option B (cleaner):** Restructure so daily-report.mjs imports the shared lib modules. This requires the `lib/` files to be accessible from the agent's working directory, which means either symlinking or a small path adjustment.

**Recommendation:** Option A now, Option B when there's a meaningful change that needs to stay in sync.

### 4. Remove dead `geminiKey` from `cfg()` in `cpm-report.js`
**Problem:** `cfg()` still returns a `geminiKey` field even though Gemini was removed. Dead config that signals intent that no longer exists.  
**Fix:** Remove `geminiKey` from the `cfg()` return object. Covered by Bug #1 fix.  
**Effort:** Included in Bug #1 fix.

---

## Medium-Value Optimizations (Do Later)

### 5. Malloyyo `cpm_benchmarks` should read from Neon, not GitHub Parquet
**File:** `index.malloy` line 48  
**Problem:** The CPM benchmarks source reads from a static Parquet file on GitHub:
```
duckdb.table('https://raw.githubusercontent.com/.../cpm_benchmarks.parquet')
```
This file is a snapshot from the initial migration in June 2026. Every new data point added by the Vercel cron goes to Neon, but Malloyyo still queries the stale Parquet. The Malloy model's CPM data is frozen at migration time.  
**Fix:** Point `cpm_benchmarks` to `neon.table('public.cpm_benchmarks')` — the same table the Vercel cron writes to. Delete the Parquet source entirely.  
**Blocker:** Need to verify Malloyyo's Neon connection is configured and working before switching.

### 6. Three Guild agents with overlapping log functionality
**Files:** `agent.ts`, `cowork-tracker.ts`, `universal-tracker.ts`  
**Problem:** All three agents write to `ai_interactions` with the same schema. The primary difference is the workflow context each is designed for. There's no technical reason they can't be one agent with a `context` parameter, but the current split reflects different operator intent (CPM pipeline vs. Cowork sessions vs. general interactions).  
**Recommendation:** Leave as-is for now — the separation makes each agent's prompts simpler and its modes more focused. Revisit if a fourth tracking agent is ever added (that would be the signal to consolidate).

### 7. `generate-dashboard.mjs` has no defined role in the automated workflow
**Problem:** It's a dev/debug tool for generating a local dashboard without triggering an email. Useful but undocumented relative to the rest of the system. It could be a CI step ("generate and review before deploy") but currently it's just a file that exists.  
**Recommendation:** Add a two-line comment at the top clarifying it's a local preview tool, not part of the production pipeline. Takes 2 minutes and prevents future confusion.

---

## Leave It Alone

### 8. Vercel cron + Mac launchd redundancy
The dual runner (Vercel primary, Mac backup) is intentional and correct. The Mac version using DuckDB/parquet rather than Neon is actually a feature — it can run without internet access to the database. The only issue is they need to be kept reasonably in sync (see #3 above).

### 9. API endpoint split (`/api/log-interaction`, `/api/interactions`, `/api/tracker-stats`)
Three endpoints touching the same table sounds redundant, but each has a distinct access pattern and auth level: write-only + auth, read with filtering + auth, public aggregate read. Consolidating them would trade clarity for brevity. Leave it.

### 10. `cfg()` called repeatedly in `cpm-report.js`
It reads from `process.env` on every call, which is fine — env vars don't change during a Lambda invocation. Not worth touching.

---

## Summary

| # | Item | Priority | Effort |
|---|------|----------|--------|
| 1 | Fix `callGemini()` ReferenceError | **Bug — fix now** | 15 min |
| 2 | Extract `synthesizeInsights()` to shared lib | High | 30 min |
| 3 | Sync `daily-report.mjs` constants + note divergence | High | 20 min |
| 4 | Delete `GEMINI_API_KEY` from Vercel | **Do immediately** | 2 min |
| 5 | Switch Malloyyo to Neon for CPM benchmarks | Medium | 45 min |
| 6 | Consolidate Guild agents | Low / skip | — |
| 7 | Document `generate-dashboard.mjs` role | Low | 2 min |
