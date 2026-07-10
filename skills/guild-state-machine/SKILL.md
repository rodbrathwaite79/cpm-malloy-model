---
name: guild-state-machine
description: >
  Implement a change request lifecycle (pending → implemented) in a Guild.ai agent,
  with HITL approval steps and run-history tracking. Use this skill whenever building
  or modifying the CPM Research agent's change management workflow.
---

# Guild State Machine — Change Request Lifecycle

## Overview
The CPM Research agent tracks suggested optimizations through a two-step lifecycle:
1. **Pending** — agent suggests a change (from a pipeline run or custom query)
2. **Implemented** — user marks it done, agent logs the result

This is a lightweight HITL (Human-in-the-Loop) pattern that doesn't require approval
infrastructure — the human simply invokes MODE C to close a loop.

## State shape
```typescript
interface ChangeRequest {
  id:          string       // UUID
  type:        "data" | "report" | "alert" | "integration" | "analysis"
  description: string
  addedAt:     string       // ISO date
  source:      string       // which mode created it
  priority:    "high" | "medium" | "low"
}

interface ImplementedChange {
  id:           string
  type:         string
  description:  string
  implementedAt: string
  notes:        string
  sessionId:    string     // for AI interaction tracker correlation
}

interface AgentState {
  pendingChanges:      ChangeRequest[]
  implementedChanges:  ImplementedChange[]
  runHistory:          RunRecord[]
  totalRuns:           number
  lastRunDate:         string | null
}
```

## Adding a pending change (MODE B)
```typescript
async function handleChangeRequest(req: { type: string; description: string }, ctx) {
  const state = ctx.state ?? defaultState()
  const change: ChangeRequest = {
    id:          crypto.randomUUID(),
    type:        req.type as ChangeRequest["type"],
    description: req.description,
    addedAt:     new Date().toISOString(),
    source:      "user-request",
    priority:    "medium",
  }
  state.pendingChanges.push(change)
  await ctx.setState(state)
  return {
    message: `Change request logged (ID: ${change.id})`,
    pendingCount: state.pendingChanges.length,
  }
}
```

## Marking implemented (MODE C)
```typescript
async function handleMarkImplemented(
  req: { sessionId: string; notes: string },
  ctx
) {
  const state = ctx.state ?? defaultState()
  // Pop the most recent pending change
  const change = state.pendingChanges.pop()
  if (!change) return { message: "No pending changes to mark implemented" }

  state.implementedChanges.push({
    id:            change.id,
    type:          change.type,
    description:   change.description,
    implementedAt: new Date().toISOString(),
    notes:         req.notes,
    sessionId:     req.sessionId,
  })
  await ctx.setState(state)
  return {
    message:            `Marked implemented: ${change.description}`,
    implementedCount:   state.implementedChanges.length,
    remainingPending:   state.pendingChanges.length,
  }
}
```

## Run history tracking
```typescript
interface RunRecord {
  date:         string
  outcome:      "autonomous" | "hitl" | "error"
  dataPoints:   number
  inputTokens:  number
  outputTokens: number
}

// In the pipeline handler:
state.runHistory.push({ date: today, outcome, dataPoints, inputTokens, outputTokens })
state.runHistory = state.runHistory.slice(-30)  // keep last 30 runs
state.totalRuns++
state.lastRunDate = today
await ctx.setState(state)
```

## ROI dimensions tracked
The agent tracks 8 dimensions of value from each run:
1. Data accuracy improvement
2. Time savings (automated vs manual)
3. Decision support value
4. Error prevention
5. Consistency improvement
6. Insight generation
7. Improvement signal (pending/implemented ratio)
8. Implementation rate (% of suggestions acted on)
