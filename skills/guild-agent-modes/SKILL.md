---
name: guild-agent-modes
description: >
  Build Guild.ai TypeScript agents with multiple named input modes using type guards
  and mode routing. Use this skill whenever creating or modifying agent.ts, cowork-tracker.ts,
  or universal-tracker.ts — or when building any new multi-mode Guild agent for this project.
---

# Guild Agent Modes — Multi-Mode TypeScript Pattern

## Core pattern
Each agent accepts a single input object. Different modes are distinguished by which
fields are present. Type guards route to the correct handler.

```typescript
import { createAgent } from "@guildai/agents-sdk"

// 1. Define input types for each mode
interface ModeA { rows: CpmRow[]; webFindings: string[]; outcome: string }
interface ModeB { changeRequest: { type: string; description: string } }
interface ModeC { markImplemented: { sessionId: string; notes: string } }
interface ModeD { rows: CpmRow[]; webFindings: string[]; question: string }
interface ModeE { }   // no fields — read-only dashboard
interface ModeF { reset: true }

type AgentInput = ModeA | ModeB | ModeC | ModeD | ModeE | ModeF

// 2. Type guards
const isModeB = (i: AgentInput): i is ModeB => "changeRequest" in i
const isModeC = (i: AgentInput): i is ModeC => "markImplemented" in i
const isModeD = (i: AgentInput): i is ModeD => "question" in i
const isModeE = (i: AgentInput): i is ModeE =>
  !("rows" in i) && !("changeRequest" in i) && !("markImplemented" in i) &&
  !("question" in i) && !("reset" in i)
const isModeF = (i: AgentInput): i is ModeF => "reset" in i && i.reset === true

// 3. Agent handler with mode routing
export default createAgent<AgentInput>(async (input, ctx) => {
  if (isModeF(input)) return handleReset(ctx)
  if (isModeB(input)) return handleChangeRequest(input.changeRequest, ctx)
  if (isModeC(input)) return handleMarkImplemented(input.markImplemented, ctx)
  if (isModeD(input)) return handleCustomQuery(input, ctx)
  if (isModeE(input)) return handleDashboard(ctx)
  // Default: Mode A (automated pipeline)
  return handlePipeline(input as ModeA, ctx)
})
```

## State management
Guild agents have persistent state across invocations via `ctx.state`:
```typescript
interface AgentState {
  pendingChanges: ChangeRequest[]
  implementedChanges: ImplementedChange[]
  lastRunDate: string | null
  totalRuns: number
}

const state: AgentState = ctx.state ?? {
  pendingChanges: [], implementedChanges: [], lastRunDate: null, totalRuns: 0
}
// Mutate then save
state.totalRuns++
await ctx.setState(state)
```

## Context object
```typescript
ctx.state          // current persisted state (null on first run)
ctx.setState(s)    // persist state for next invocation
ctx.log(msg)       // log visible in Guild dashboard
ctx.env.MY_VAR     // environment variable access (not process.env in Guild)
```

## API calls from Guild
Guild agents run in a sandboxed environment where `fetch` is available but `process.env`
is not — use `ctx.env` instead. HTTP calls work normally.

## Mode documentation convention
Document each mode clearly at the top of the file:
```typescript
/**
 * MODE A — Automated pipeline: { rows, webFindings, outcome, dataPoints }
 * MODE B — Change request:     { changeRequest: { type, description } }
 * MODE C — Mark implemented:   { markImplemented: { sessionId, notes } }
 * MODE D — Custom query:       { rows, webFindings, question }
 * MODE E — Dashboard:          {}
 * MODE F — Reset:              { reset: true }
 */
```

## Files in this project
- `agent/agent.ts` — CPM Research & Metrics Agent (6 modes: A–F)
- `agent/cowork-tracker.ts` — Cowork Session Tracker (4 modes: INIT/LOG/CORRECTION/DASHBOARD)
- `agent/universal-tracker.ts` — Universal AI Tracker (4 modes: A–D)
