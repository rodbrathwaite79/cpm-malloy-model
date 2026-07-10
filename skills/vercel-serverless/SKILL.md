---
name: vercel-serverless
description: >
  Build Vercel serverless API handlers with proper structure, CORS, auth, cron scheduling,
  and environment variable access. Use this skill whenever creating or modifying any file
  under cpm-vercel/api/ — including cron jobs, authenticated endpoints, and public read APIs.
---

# Vercel Serverless — Handler Patterns

## Handler structure
Every file in `api/` exports a default async function:

```js
export default async function handler(req, res) {
  // CORS — needed if dashboard or browser fetches this endpoint
  res.setHeader("Access-Control-Allow-Origin",  "*")
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")
  if (req.method === "OPTIONS") return res.status(204).end()

  // Route by method
  if (req.method === "GET")  { /* ... */ }
  if (req.method === "POST") { /* ... */ }
  return res.status(405).json({ error: "Method not allowed" })
}
```

## Auth pattern
Use `Authorization: Bearer <SECRET>` for protected endpoints:

```js
const secret = process.env.CRON_SECRET
const auth   = req.headers.authorization ?? ""
if (secret && auth !== `Bearer ${secret}`) {
  return res.status(401).json({ error: "Unauthorized" })
}
```

The Vercel cron runner automatically sends the `CRON_SECRET` as the Bearer token.

## Cron configuration (`vercel.json`)
```json
{
  "crons": [{ "path": "/api/cpm-report", "schedule": "0 13 * * 1" }],
  "functions": {
    "api/cpm-report.js": { "maxDuration": 120 },
    "api/metrics.js":    { "maxDuration": 10 }
  }
}
```
- `0 13 * * 1` = 8am EST (UTC-5) / 1pm UTC, every Monday
- Default `maxDuration` is 10s; bump to 120 for crons that do web scraping + DB writes
- Cron requires Vercel Hobby or Pro plan

## Environment variables
Read from `process.env` — never hard-code secrets:

```js
function cfg() {
  return {
    braveApiKey:  process.env.BRAVE_API_KEY  ?? "",
    resendApiKey: process.env.RESEND_API_KEY ?? "",
    githubToken:  process.env.GITHUB_TOKEN   ?? "",
    emailTo:      process.env.EMAIL_TO       ?? "fallback@example.com",
    forceUpdate:  process.env.FORCE_UPDATE === "true",
  }
}
```

Set env vars in Vercel dashboard → Settings → Environment Variables (never in `vercel.json`).

## Body parsing
Vercel parses JSON bodies automatically if `Content-Type: application/json`.
For string bodies: `typeof req.body === "string" ? JSON.parse(req.body) : req.body ?? {}`

## Deploy
```bash
cd cpm-vercel/
vercel --prod
```
Env vars carry over from the dashboard — no local `.env` needed for deployment.

## Key env vars for this project
| Var | Purpose |
|-----|---------|
| `DATABASE_URL` | Neon Postgres connection string |
| `CRON_SECRET` | Authenticates Vercel cron + manual triggers |
| `METRICS_API_KEY` | Authenticates POST /api/metrics |
| `BRAVE_API_KEY` | Brave Search web queries |
| `RESEND_API_KEY` | Email sending |
| `GITHUB_TOKEN` | GitHub CSV backup writes |
| `EMAIL_TO` | Primary report recipient |
| `LOG_API_KEY` | Authenticates POST /api/log-interaction |
