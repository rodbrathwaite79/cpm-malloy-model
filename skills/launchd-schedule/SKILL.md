---
name: launchd-schedule
description: >
  Create a macOS launchd plist to schedule a Node.js script at a specific time daily.
  Use this skill whenever setting up or debugging the Mac-side daily report schedule
  for daily-report.mjs — including fixing Node path issues and verifying the schedule is loaded.
---

# macOS launchd — Daily Script Scheduling

## Plist template
Save as `~/Library/LaunchAgents/com.rod.cpm-report.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.rod.cpm-report</string>

  <key>ProgramArguments</key>
  <array>
    <string>/Users/rod/.nvm/versions/node/v22.16.0/bin/node</string>
    <string>/Users/rod/Documents/cpm-agent/agent/cpm-report-agent/daily-report.mjs</string>
  </array>

  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>   <integer>8</integer>
    <key>Minute</key> <integer>0</integer>
  </dict>

  <key>StandardOutPath</key>
  <string>/Users/rod/Documents/cpm-agent/logs/cpm-report.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/rod/Documents/cpm-agent/logs/cpm-report-error.log</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/Users/rod/.nvm/versions/node/v22.16.0/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
```

## Critical: Node path must be exact
The most common failure is a wrong Node path. Find the correct path:
```bash
which node
# → /Users/rod/.nvm/versions/node/v22.16.0/bin/node
```
Use this exact string in `ProgramArguments[0]`. Symlinks like `/usr/local/bin/node` may
not resolve correctly in the launchd environment.

## Install and verify
```bash
# Create log directory
mkdir -p ~/Documents/cpm-agent/logs

# Load the schedule
launchctl load ~/Library/LaunchAgents/com.rod.cpm-report.plist

# Verify it's loaded
launchctl list | grep cpm-report

# Test run immediately (without waiting for 8am)
launchctl start com.rod.cpm-report

# Check output
tail -50 ~/Documents/cpm-agent/logs/cpm-report.log
tail -20 ~/Documents/cpm-agent/logs/cpm-report-error.log
```

## Unload / reload after changes
```bash
launchctl unload ~/Library/LaunchAgents/com.rod.cpm-report.plist
launchctl load   ~/Library/LaunchAgents/com.rod.cpm-report.plist
```

## Troubleshooting
| Symptom | Fix |
|---------|-----|
| Script doesn't run at 8am | Check `launchctl list \| grep cpm-report` — if not listed, plist has a parse error |
| Error: `env: node: No such file or directory` | Wrong Node path — update `ProgramArguments[0]` |
| Script runs but fails silently | Check error log; DuckDB binary may need rebuild (`rm -rf node_modules && npm install`) |
| Wrong Node version | Update path to new version after `nvm install` |

## Architecture note
The Mac launchd schedule is a backup to the Vercel cron. Both run at 8am local time.
The Vercel cron is primary — it runs regardless of whether the Mac is on.
