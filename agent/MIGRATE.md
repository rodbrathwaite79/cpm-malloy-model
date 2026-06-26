# CPM Report — New Mac Migration Guide

## What you need on the new Mac

**Time required:** ~10 minutes  
**Manual steps:** 2 (copy files, enter credentials)  
**Everything else:** fully automated

---

## Step 1: Copy the agent folder to the new Mac

On your **old Mac**, open Terminal and run:

```bash
# This copies the entire agent folder (scripts, config, node_modules excluded)
rsync -av --exclude='node_modules' --exclude='dist' \
  ~/Documents/cpm-agent/agent/cpm-report-agent/ \
  NEW_MAC_NAME.local:~/Documents/cpm-agent/agent/cpm-report-agent/
```

Or use AirDrop / USB / iCloud Drive to copy the `cpm-report-agent` folder.

**Files that MUST be copied:**
- `daily-report.mjs` — the main report script
- `quality-agent.mjs` — the QA validator
- `setup-new-mac.sh` — this setup script
- `com.rod.cpm-report.plist` — the launchd schedule config
- `package.json` — npm dependencies list

**Files that will be regenerated automatically:**
- `node_modules/` — recreated by `npm install`
- `.env` — you'll enter credentials interactively

---

## Step 2: Run the setup script

On the **new Mac**, open Terminal and run:

```bash
bash ~/Documents/cpm-agent/agent/cpm-report-agent/setup-new-mac.sh
```

The script will automatically:
1. Install Homebrew (if not present)
2. Install nvm + Node.js v22
3. Clone the GitHub repo (CPM database)
4. Run `npm install`
5. Ask you to enter API credentials (one time)
6. Update the launchd plist with the correct Node.js path for this Mac
7. Install the daily 8am schedule
8. Run the Quality Agent to validate everything

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

Expected output: **31 ✅, 2 ⚠️ (optional), 0 ❌**

The 2 warnings are always optional:
- `ANTHROPIC_API_KEY` not set (enables AI insights — optional)
- `EMAIL_CC` not set (add when you want to CC others)

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
