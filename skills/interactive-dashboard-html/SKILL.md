---
name: interactive-dashboard-html
description: >
  Build a self-contained interactive HTML dashboard for CPM benchmark data with sidebar filters,
  a Chart.js trend chart, a sortable MoM/YoY data table, and an AI Analysis panel.
  Use this skill whenever generating or modifying the CPM dashboard HTML — whether as an
  email attachment or a local preview file.
---

# Interactive Dashboard HTML — Structure & Patterns

## Where the code lives
`cpm-vercel/lib/report-html.js` — `buildInteractiveDashboard(rows, runDate, aiInsights)`

## Function signature
```js
buildInteractiveDashboard(
  rows,        // Array<{ channel, year, month, avg_cpm }>
  runDate,     // string — "Friday, July 11, 2026"
  aiInsights   // object from synthesizeInsights() | null
)
// Returns: string (complete HTML document, self-contained)
```

## Dashboard sections

### 1. Sidebar filters (Year / Month / Channel)
- Checkboxes for each dimension, dynamically populated from data
- "Select All" toggle per group
- Filtering rerenders both chart and table in-memory (no server round-trip)

### 2. Chart.js trend chart
- Line chart showing CPM over time, one series per channel
- Chart.js loaded from CDN: `https://cdn.jsdelivr.net/npm/chart.js`
- Filters apply: only selected channels/periods are rendered

### 3. Sortable data table
Columns: Channel, Period, CPM, MoM Change, YoY Change
- Clicking a column header sorts ascending/descending
- MoM/YoY cells color-coded: green (up), red (down), amber (flat)
- Computed client-side from raw row data

### 4. AI Analysis panel (conditional)
Renders only if `aiInsights !== null`:
```html
<!-- Summary -->
<p class="summary-text">{{ aiInsights.summary }}</p>

<!-- Key Insights -->
<div class="insight-card">
  <h4>{{ insight.title }}</h4>
  <p>{{ insight.body }}</p>
</div>

<!-- Recommendations with urgency badge -->
<span class="urgency-badge urgency-{{ rec.urgency }}">{{ rec.urgency }}</span>

<!-- Next Steps (numbered list) -->
```

Urgency badge colors:
- `immediate` → red
- `this-quarter` → amber
- `monitor` → blue/grey

## All styles are inline
The dashboard is designed to be emailed as an attachment — external stylesheets won't load.
All CSS is in a `<style>` block in the `<head>`. No external CSS dependencies.

## Generating locally (dev tool)
```bash
cd cpm-vercel/
node scripts/generate-dashboard.mjs
# Output: CPM-Dashboard-local.html
```
Uses demo data if `DATABASE_URL` is not set — 5 channels × 42 months of synthetic data.

## Email attachment pattern
```js
const dashHtml   = buildInteractiveDashboard(allRows, runDate, aiInsights)
const dashBase64 = Buffer.from(dashHtml, "utf-8").toString("base64")
// Attach via Resend:
attachments: [{ filename: "CPM-Dashboard.html", content: dashBase64 }]
```

## Key design decisions
- **Self-contained HTML**: Chart.js loaded from CDN but everything else inline, so the file
  works when opened locally from email or Downloads folder
- **No backend calls**: All data is embedded in the HTML as a JS variable at generation time
- **AI panel is optional**: If `aiInsights` is null, the panel is omitted entirely — the
  dashboard still works as a pure data explorer
