---
name: brave-search
description: >
  Query the Brave Search API for web results and fetch page text for CPM benchmark research.
  Use this skill whenever an agent needs to search for advertising CPM benchmarks, market rates,
  or any structured data that requires scraping credible web sources.
---

# Brave Search — Query & Scrape Pattern

## Search function
```js
const CREDIBLE_SOURCES = [
  "emarketer.com", "adsposure.com", "wordstream.com", "statista.com",
  "iab.com", "comscore.com", "mediaradar.com", "adweek.com",
  "searchengineland.com", "semrush.com", "hubspot.com",
]

async function braveSearch(query, count = 5) {
  const braveApiKey = process.env.BRAVE_API_KEY
  if (!braveApiKey) { console.warn("BRAVE_API_KEY not set"); return [] }
  try {
    const res = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`,
      { headers: { Accept: "application/json", "X-Subscription-Token": braveApiKey } }
    )
    if (!res.ok) { console.warn("Brave HTTP", res.status); return [] }
    const data = await res.json()
    return data?.web?.results ?? []
  } catch (e) { console.warn("Brave error:", e.message); return [] }
}
```

## Page text fetching
Strip HTML tags and truncate — the goal is enough context for CPM extraction:

```js
async function fetchPageText(url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; research-bot/1.0)" } })
    if (!res.ok) return ""
    const html = await res.text()
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 3000)
  } catch { return "" }
}
```

## CPM-specific search query pattern
Combine channel label, time period, and credible domain constraints:

```js
async function findVerifiedCpm(channelLabel, month, year) {
  const monthName = MONTH_NAMES[month]
  const q = Math.ceil(month / 3)
  const query = `"${channelLabel}" CPM benchmark "${monthName} ${year}" OR "Q${q} ${year}" ` +
    `site:emarketer.com OR site:adsposure.com OR site:wordstream.com`
  const results = await braveSearch(query, 5)
  const findings = []
  for (const r of results.slice(0, 3)) {
    const text = r.url ? await fetchPageText(r.url) : ""
    findings.push({ title: r.title ?? "", url: r.url ?? "", excerpt: r.description ?? "", text })
  }
  return findings
}
```

## Credibility weighting
When extracting values from results, prefer credible sources:
```js
const isCredible = CREDIBLE_SOURCES.some(s => (result.url ?? "").includes(s))
// Prefer credible candidates; fall back to all if none found
const preferred = candidates.filter(c => c.credible).length > 0
  ? candidates.filter(c => c.credible)
  : candidates
```

## In Vercel (no native fetch in older Node)
Use the raw `https` module `request()` helper from the vercel-serverless skill.

## Environment variable
| Var | Where to get |
|-----|-------------|
| `BRAVE_API_KEY` | search.brave.com/app → API (free tier available) |
