---
name: api-log-interaction
description: >
  Log AI work sessions to the ROI tracker via the /api/log-interaction endpoint or the
  log-ai CLI tool. Use this skill when manually recording a Claude session, debugging
  the logging endpoint, or adding logging to a new agent or script.
---

# API Log Interaction — Endpoint & CLI Patterns

## Endpoint
`POST https://cpm-vercel.vercel.app/api/log-interaction`
Auth: `Authorization: Bearer <LOG_API_KEY>`

## Request body
```json
{
  "provider":      "claude",
  "tool":          "cowork",
  "taskType":      "code",
  "description":   "Refactored synthesizeInsights into shared lib",
  "hoursEstimate": 1.5,
  "hoursSource":   "measured",
  "valueUsd":      225,
  "costUsd":       0.12,
  "firstPass":     false,
  "corrections":   2,
  "project":       "cpm-agent",
  "output":        "lib/insights.js",
  "notes":         "Also removed 150 lines of duplication",
  "costModel":     "claude-sonnet-4-6",
  "sessionId":     "session-2026-07-10"
}
```

Required fields: `provider`, `tool`, `taskType`, `description`, `hoursEstimate`, `valueUsd`

## log-ai CLI
Installed as a shell alias:
```bash
alias log-ai="node ~/Documents/cpm-agent/malloy-model-git/agent/log-ai.mjs"
```

Full flag reference:
```bash
log-ai \
  --provider claude \        # required: claude | gpt-4 | gemini | etc.
  --tool cowork \            # required: cowork | cursor | api | etc.
  --type code \              # required: code | analysis | document | research | testing | design
  --hours 1.5 \             # required: decimal hours
  --value 225 \             # required: USD value (hours × rate)
  --desc "Description" \    # required: what was done
  --project cpm-agent \     # optional (default: cpm-agent)
  --output "file.js" \      # optional: primary output file/artifact
  --notes "Extra context" \ # optional: additional notes
  --no-first-pass \         # optional: flag if this needed iteration
  --corrections 2 \         # optional: number of corrections needed
  --cost-model claude-sonnet-4-6 \  # optional: model name
  --cost 0.12 \             # optional: actual API cost in USD
  --session session-id \    # optional: session identifier
  --dry-run                 # optional: print payload without POSTing
```

## Example curl (manual logging)
```bash
curl -X POST https://cpm-vercel.vercel.app/api/log-interaction \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ai_interaction_tracker29" \
  -d '{
    "provider": "claude",
    "tool": "cowork",
    "taskType": "analysis",
    "description": "Architecture review and optimization planning",
    "hoursEstimate": 2.0,
    "hoursSource": "measured",
    "valueUsd": 350,
    "firstPass": true
  }'
```

## Response
```json
{ "ok": true, "id": 42 }
```

## Environment variable
| Var | Value |
|-----|-------|
| `LOG_API_KEY` | `ai_interaction_tracker29` — set in shell env and Vercel dashboard |

## Endpoint implementation
`cpm-vercel/api/log-interaction.js` — reads body, validates required fields, calls
`insertAiInteraction()` from `lib/database.js`, returns `{ ok: true, id }`.
