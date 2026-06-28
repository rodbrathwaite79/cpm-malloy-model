# CPM Report — New Mac Migration Guide

## What you need on the new Mac

**Time required:** ~10 minutes  
**Manual steps:** 2 (copy `.env`, enter credentials if not copying)  
**Everything else:** fully automated

---

## Step 1: Run one command on the new Mac

Open Terminal on the **new Mac** and run:

```bash
curl -sSL https://raw.githubusercontent.com/rodbrathwaite79/cpm-malloy-model/main/agent/setup-new-mac.sh | bash
```

That's it. The script downloads everything from GitHub and handles the full setup automatically:
1. Installs Homebrew (if not present)
2. Installs nvm + Node.js v22
3. Clones the GitHub repo (CPM database + Malloy model)
4. Runs `npm install` (installs duckdb)
5. Downloads scripts: `daily-report.mjs`, `agent.ts`, `quality-agent.mjs`, `package.json`
6. Generates the launchd plist for this Mac
7. Asks you for API credentials (one time, interactive)
8. Installs the daily 8am schedule via launchd
9. Runs the Quality Agent to validate everything
10. Prints Guild CLI install instructions (optional — for monitoring dashboard)

**Optional shortcut:** If you have the `.env` file from the old Mac, copy it to  
`~/Documents/cpm-agent/agent/cpm-report-agent/.env` first — the script will skip the credential prompts entirely.

No files need to be manually copied — everything downloads from GitHub.

---

## Credentials you'll need

Gather these before running the setup:

| Credential | Where to get it |
|------------|----------------|
| `BRAVE_API_KEY` | [search.brave.com](https://search.brave.com) → API |
| `GITHUB_TOKEN` | [github.com/settings/tokens](https://github.com/settings/tokens) → Classic → `repo` scope |
| `SENDGRID_API_KEY` | [app.sendgrid.com](https://app.sendgrid.com) → Settings → API Keys |
| `EMAIL_TO` | Your email (rod.brathwaite@gmail.com) |
| `ANTHROPIC_API_KEY` | Optional — [console.anthropic.com](https://console.anthropic.com) |

**Shortcut:** If you have the `.env` file from the old Mac, just copy it directly to  
`~/Documents/cpm-agent/agent/cpm-report-agent/.env` and the setup script will skip the credential prompts.

---

## After setup: verify with Quality Agent

```bash
node ~/Documents/cpm-agent/agent/cpm-report-agent/quality-agent.mjs
```

Expected output: **~38 ✅, 2 ⚠️ (optional), 0 ❌**

The 2 optional warnings are always expected:
- `ANTHROPIC_API_KEY` not set (enables AI insights in email — optional)
- `EMAIL_CC` not set (add when you want to CC others)

The Quality Agent now checks 9 sections including the Guild `agent.ts` file.  
A fresh install will also show a **WARN** for `logs/agent-metrics.json` — this is normal.  
That file is created automatically on the first successful report run.

---

## Guild agent (monitoring dashboard)

The Guild agent (`rod.brathwaite~cpm-report-agent`) is published to Guild's cloud and **does not need to be reinstalled** on the new Mac. It runs remotely whenever `daily-report.mjs` calls it.

However, the agent's run-history state (total runs, tokens, ROI) is stored in Guild's cloud and carries over from your old machine. If you want a clean slate on the new machine:

1. Install Guild CLI (one-time, optional):
   ```bash
   npm install -g @guildai/guild-cli
   guild login
   ```
2. Send a reset from the Guild UI — paste this into the agent input:
   ```json
   { "reset": true }
   ```
   You'll see: `✅ Agent metrics state has been reset to zero.`

---

## Agent metrics file

The daily report saves a local metrics cache to:

```
~/Documents/cpm-agent/logs/agent-metrics.json
```

This file does **not** need to be copied from your old Mac — it's recreated automatically on the first successful report run. It only contains a rolling 30-run history used to render the metrics section of the daily email.

---

## Permissions the setup script needs

All permissions are standard macOS developer tools — no admin access required beyond what Homebrew normally requests:

| Permission | Why |
|-----------|-----|
| Internet access | Download Homebrew, nvm, Node.js, npm packages |
| `~/Documents/cpm-agent/` | Read/write all agent files |
| `~/Library/LaunchAgents/` | Install the daily 8am schedule |
| `launchctl` | Load/unload the schedule |
| `xcode-select` | Install git and compilers |
| GitHub API | Clone repo + commit monthly CPM updates |
| SendGrid API | Send daily report emails |
| Brave Search API | Find verified CPM data |

---

## Troubleshooting

**"node not found" after nvm install:**  
Close and reopen Terminal, then run `nvm use 22`.

**Quality Agent shows GitHub token failures:**  
Generate a new token at github.com/settings/tokens (Classic, `repo` scope checked).  
Update `~/.Documents/cpm-agent/agent/cpm-report-agent/.env` and run:  
```bash
node quality-agent.mjs --fix
```

**Emails going to spam:**  
Go to sendgrid.com → Settings → Sender Authentication → Single Sender Verification  
and verify `rod.brathwaite@gmail.com`.

**Schedule not running at 8am:**  
```bash
launchctl list com.rod.cpm-report     # Check if loaded
launchctl load ~/Library/LaunchAgents/com.rod.cpm-report.plist  # Reload if needed
tail -f ~/Documents/cpm-agent/logs/cpm-report.log               # View logs
```

---

## CC recipients

To add CC recipients (e.g. casey.brathwaite@gmail.com), edit `.env`:

```bash
echo 'EMAIL_CC=casey.brathwaite@gmail.com' >> ~/Documents/cpm-agent/agent/cpm-report-agent/.env
```

Then reload the schedule:
```bash
cp ~/Documents/cpm-agent/agent/cpm-report-agent/com.rod.cpm-report.plist \
   ~/Library/LaunchAgents/com.rod.cpm-report.plist
launchctl unload ~/Library/LaunchAgents/com.rod.cpm-report.plist
launchctl load  ~/Library/LaunchAgents/com.rod.cpm-report.plist
```
