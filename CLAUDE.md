# CPM Agent — Claude Session Instructions

## Session Logging (Required on Every Cowork Session)

### 1. Session Start
On the **first tool call** of every Cowork session, immediately:
```bash
date -u +%Y-%m-%dT%H:%M:%SZ
```
Use that timestamp to create `session-logs/pending/session-YYYY-MM-DD-HHmm.json`:
```json
{
  "session_id": "YYYY-MM-DD-HHmm",
  "session_start": "<ISO timestamp from date command>",
  "session_end": null,
  "provider": "claude",
  "tool": "cowork",
  "project": "cpm-agent",
  "tasks": [],
  "summary": null
}
```

### 2. After Each Major Task
Capture start time **before** starting and end time **after** finishing each task.
Append a task record to the `tasks` array:
```json
{
  "type": "code|analysis|document|research",
  "description": "What was done (1-2 sentences)",
  "start": "<ISO timestamp>",
  "end": "<ISO timestamp>",
  "duration_minutes": 0,
  "human_equivalent_hours": 0.0,
  "value_usd": 0,
  "first_pass": true,
  "output": "path/to/output/file (if applicable)"
}
```

**Rate table** (value_usd = human_equivalent_hours × rate):
| Task type  | Rate/hr |
|------------|---------|
| code       | $150    |
| analysis   | $175    |
| design     | $175    |
| research   | $125    |
| testing    | $100    |
| document   | $80     |

**Human equivalent hours**: estimate how long a skilled human would take to do the
same task independently — not how long Claude actually took. Examples:
- Writing a 500-line interactive HTML file → 4–5 human hours
- Updating a cron expression across 5 files → 0.5 human hours
- Architecture review and optimization plan → 2–3 human hours

### 2b. Cowork Tracker — Real-Time Log Prompt (Required)
After **every major task completion**, output a ready-to-paste Guild cowork-tracker
log entry in this exact format, so the user can send it to Guild chat immediately:

```
📋 COWORK TRACKER — paste into Guild chat:

Run the Cowork Tracker with input: {"logTask": {"type": "<type>", "description": "<1-2 sentence description>", "hoursEstimate": <N>, "firstPass": <true|false>, "output": "<file or artifact, or null>"}}
```

Rules:
- Always output this block at the end of your response for the completed task
- `type` must be one of: `code`, `document`, `analysis`, `testing`, `research`, `design`
- `hoursEstimate` = human equivalent hours (same estimate as session log)
- `firstPass: false` if the user asked for any corrections or redos on this task
- Skip this block only for trivial responses (answering a question, one-liner fixes)

### 3. Session End
When user says "wrap up", "done", "we're done", "log this", or similar:

1. Capture end timestamp via `date -u +%Y-%m-%dT%H:%M:%SZ`
2. Calculate `duration_minutes` = (session_end - session_start) in minutes
3. Finalize the session JSON with the `summary` block:
```json
{
  "summary": {
    "primary_task_type": "dominant type across tasks",
    "total_human_equivalent_hours": 0.0,
    "total_value_usd": 0,
    "first_pass": true,
    "corrections": 0
  }
}
```
4. Write the final JSON to `session-logs/pending/`
5. Commit:
```bash
git add session-logs/pending/
git commit -m "log: session YYYY-MM-DD"
```
6. Tell the user: **"Session logged. Push when ready to sync to Neon."**

---

## Project Context

**Repo:** https://github.com/rodbrathwaite79/cpm-malloy-model  
**Primary Vercel project:** `cpm-vercel` (cron at `0 13 * * 1` = Monday 8am ET)  
**Database:** Neon Postgres — project `mute-thunder-42290582`  
**ROI endpoint:** `https://cpm-vercel.vercel.app/api/tracker-stats` (public GET)  
**Log endpoint:** `https://cpm-vercel.vercel.app/api/log-interaction` (POST, Bearer auth)  

**Key files:**
- `cpm-vercel/api/cpm-report.js` — weekly cron handler
- `cpm-vercel/lib/insights.js` — rule-based CPM synthesis (zero API cost)
- `cpm-vercel/lib/report-html.js` — HTML dashboard builder
- `agent/daily-report.mjs` — Mac backup runner (launchd, Monday 8am)
- `index.malloy` + `ai_tracker.malloy` — Malloy semantic models (both on Neon)
- `skills/CPM-Skills-Reference.html` — interactive skills documentation

**Security rules (never violate):**
- Never commit `.env` files
- Never hard-code credentials — use `{ "env": "VAR_NAME" }` pattern for Malloy
- `malloy-config-local.json` must stay gitignored
