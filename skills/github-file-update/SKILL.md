---
name: github-file-update
description: >
  Read and update a file in a GitHub repository via the GitHub Contents API (base64 PUT).
  Use this skill whenever an agent needs to append rows to a CSV, update a config file,
  or write any content to GitHub as a backup or source-of-truth store.
---

# GitHub File Update — Contents API Pattern

## Use case in this project
After each monthly CPM data collection, new rows are appended to `cpm_monthly_updates.csv`
on GitHub as a belt-and-suspenders backup alongside Neon Postgres.

## Read → modify → write pattern
The GitHub API requires the file's current SHA to perform an update (optimistic locking).
Always GET first, then PUT with the SHA.

```js
const GITHUB_OWNER = "rodbrathwaite79"
const GITHUB_REPO  = "cpm-malloy-model"
const FILE_PATH    = "cpm_monthly_updates.csv"

async function updateGitHubFile(newContent) {
  const token   = process.env.GITHUB_TOKEN
  const apiBase = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${FILE_PATH}`
  const headers = {
    Authorization: `token ${token}`,
    Accept:        "application/vnd.github.v3+json",
    "Content-Type": "application/json",
    "User-Agent":  "cpm-report-agent/2.0",
  }

  // Step 1: GET current file (to obtain SHA)
  let currentContent = CSV_HEADER, sha
  const getRes = await fetch(apiBase, { headers })
  if (getRes.ok) {
    const fileData = await getRes.json()
    sha = fileData.sha
    // Content is base64-encoded with line breaks — strip them before decoding
    currentContent = Buffer.from(fileData.content.replace(/\n/g, ""), "base64").toString("utf-8")
  } else if (getRes.status === 401 || getRes.status === 403) {
    console.warn("GitHub token issue — skipping backup"); return
  }
  // 404 means file doesn't exist yet — we'll create it

  // Step 2: Build updated content
  const updated = currentContent + newContent   // append rows

  // Step 3: PUT with base64-encoded content
  const body = {
    message:   `chore: add CPM data — ${new Date().toISOString().slice(0, 10)}`,
    content:   Buffer.from(updated, "utf-8").toString("base64"),
    committer: { name: "CPM Report Agent", email: "agent@cpm-reports.internal" },
    ...(sha ? { sha } : {}),   // omit sha for new file creation
  }
  const putRes = await fetch(apiBase, { method: "PUT", headers, body: JSON.stringify(body) })
  if (putRes.ok) {
    console.log("GitHub: file updated")
  } else {
    console.warn("GitHub PUT failed:", putRes.status, await putRes.text())
  }
}
```

## Deduplication before appending
Track existing keys to avoid duplicate rows:
```js
const existingKeys = new Set()
for (const line of currentContent.split("\n").slice(1)) {  // skip header
  const [yr, mo, , ch] = line.split(",")
  if (yr && mo && ch) existingKeys.add(`${yr}-${mo}-${ch}`)
}
// Only append rows whose key isn't already present
const newRows = allRows.filter(r => !existingKeys.has(`${r.year}-${r.month}-${r.channel}`))
```

## Token scope
GitHub token needs only `repo` scope (read + write to the target repo).
Never use a token with broader permissions.

## In Vercel (no native fetch)
Use the `request()` / `get()` / `post()` helpers from the vercel-serverless skill,
passing the same headers and body patterns above.

## Environment variable
| Var | Notes |
|-----|-------|
| `GITHUB_TOKEN` | Classic PAT, `repo` scope only. Rotate periodically. |
