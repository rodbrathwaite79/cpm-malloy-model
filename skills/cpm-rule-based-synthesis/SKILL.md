---
name: cpm-rule-based-synthesis
description: >
  Generate CPM market insights, recommendations, and next steps from historical benchmark data
  using pure JavaScript math — no paid AI API required. Use this skill whenever an agent needs
  to produce a narrative summary, channel-level insights, or actionable recommendations from
  CPM benchmark rows without calling Gemini, Claude, or any LLM.
---

# CPM Rule-Based Synthesis — Zero-Cost Insight Engine

## Where the code lives
The canonical implementation is in `cpm-vercel/lib/insights.js`, exported as `synthesizeInsights(rows)`.
Both `cpm-report.js` (Vercel cron) and `generate-dashboard.mjs` (local preview) import from it.

## Input format
```js
rows = [
  { channel: "paid_social", year: 2026, month: 6, avg_cpm: 9.87 },
  { channel: "video_ctv",   year: 2026, month: 6, avg_cpm: 24.10 },
  // ... one row per channel per month
]
```

## Output format
```js
{
  summary: "In June 2026, Video / CTV leads all channels at $24.10 CPM ...",
  insights: [
    { title: "Video / CTV CPM up +5.2% MoM", body: "...", sources: [] },
    { title: "Programmatic Display softening — -3.1% MoM", body: "...", sources: [] },
    { title: "Video / CTV–Programmatic Display spread: $20.90", body: "...", sources: [] },
  ],
  recommendations: [
    { title: "Increase Programmatic Display spend now", body: "...", urgency: "immediate" },
    { title: "Cap Video / CTV CPM exposure", body: "...", urgency: "this-quarter" },
    { title: "Rebalance mix toward below-average channels", body: "...", urgency: "this-quarter" },
  ],
  next_steps: [
    "This week: Pull Programmatic Display line items ...",
    "This month: Set CPM alerts ...",
    "This quarter: Run a channel mix A/B test ...",
  ],
  _inputTokens: 0,
  _outputTokens: 0,
}
```

## Core algorithm
1. **Group** rows by channel, sort each channel's time series by `year * 100 + month`
2. **Find latest period** across all channels
3. **Per-channel stats**: current CPM, MoM%, YoY%, 3-month average, aboveAvg flag
4. **Rank**: highest/lowest by current CPM, biggest mover up/down by MoM%
5. **Generate** summary sentence, 3 insights, 3 recommendations (urgency: immediate / this-quarter / monitor), 3 next steps

## Urgency thresholds
| Condition | Urgency |
|-----------|---------|
| bigDown.momPct < -3% | `"immediate"` — shift budget now |
| bigDown.momPct < 0% | `"this-quarter"` — test incremental |
| bigUp.momPct > 10% | `"immediate"` — cap exposure |
| bigUp.momPct > 5% | `"this-quarter"` — set ceiling alert |
| all channels rising | `"this-quarter"` — lock in rates |

## Why no LLM
This approach:
- Costs $0 (no API calls)
- Is deterministic (same data → same insight every time)
- Never hallucinates a CPM figure
- Runs in <1ms regardless of data size

The tradeoff is that the language is formulaic. If richer prose is needed, the function's
output can be passed to an LLM for style rewriting — but the factual content comes from
the math, not the model.

## Extension pattern
To add a 4th insight (e.g., seasonal signal), push to the `insights` array before returning:
```js
if (latestMonth === 11 || latestMonth === 12) {
  insights.push({
    title: "Q4 seasonality driving CPM inflation",
    body: "Year-end holiday demand typically pushes CPMs 10-20% above Q3 levels.",
    sources: []
  })
}
```
