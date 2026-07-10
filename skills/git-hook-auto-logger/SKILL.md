---
name: git-hook-auto-logger
description: >
  Install a global git post-commit hook that automatically logs every commit as an AI
  interaction to the ROI tracker. Use this skill when setting up auto-logging on a new Mac
  or when modifying the hook's task type detection or hours estimation logic.
---

# Git Hook Auto-Logger — Post-Commit ROI Logging

## What it does
After every `git commit`, the hook:
1. Detects task type from file extensions in the commit
2. Estimates hours from lines added
3. POSTs silently to `/api/log-interaction` in the background (non-blocking)

## Install script
`agent/setup-auto-logging.sh` — run once per Mac:
```bash
bash ~/Documents/cpm-agent/malloy-model-git/agent/setup-auto-logging.sh
```
This writes the hook to `~/.git-hooks/post-commit` and sets:
```bash
git config --global core.hooksPath ~/.git-hooks
```

## Hook logic

### Task type detection (from changed file extensions)
```bash
TASK_TYPE="code"   # default
if echo "$FILES" | grep -qE '\.(sql|malloy)$'; then
  TASK_TYPE="analysis"
elif echo "$FILES" | grep -qE '(test|spec)\.' ; then
  TASK_TYPE="testing"
elif echo "$FILES" | grep -qvE '\.(md|html|txt)$'; then
  TASK_TYPE="code"
else
  TASK_TYPE="document"
fi
```

### Hours estimation (from lines added)
```bash
LINES_ADDED=$(git diff HEAD~1 HEAD --stat | tail -1 | grep -oE '[0-9]+ insertion' | grep -oE '[0-9]+' || echo "0")

if   [ "$LINES_ADDED" -lt 25  ]; then HOURS=0.25
elif [ "$LINES_ADDED" -lt 75  ]; then HOURS=0.5
elif [ "$LINES_ADDED" -lt 200 ]; then HOURS=1.0
elif [ "$LINES_ADDED" -lt 400 ]; then HOURS=2.0
else                                   HOURS=3.0
fi
```

### Silent background POST
```bash
curl -s -X POST "https://cpm-vercel.vercel.app/api/log-interaction" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $LOG_API_KEY" \
  -d "{
    \"provider\": \"claude\",
    \"tool\": \"cowork\",
    \"taskType\": \"$TASK_TYPE\",
    \"hoursEstimate\": $HOURS,
    \"hoursSource\": \"estimated\",
    \"description\": \"$COMMIT_MSG\",
    \"valueUsd\": $VALUE,
    \"project\": \"$PROJECT\"
  }" > /dev/null 2>&1 &
```
The `&` at the end makes it non-blocking — `git commit` returns immediately,
the POST runs in the background.

## Value calculation
```bash
# Rate table (per task type)
case "$TASK_TYPE" in
  research)  RATE=125 ;;
  document)  RATE=80  ;;
  analysis)  RATE=175 ;;
  code)      RATE=150 ;;
  testing)   RATE=100 ;;
  design)    RATE=175 ;;
  *)         RATE=125 ;;
esac
VALUE=$(echo "$HOURS * $RATE" | bc)
```

## Environment variable required
`LOG_API_KEY` must be set in the shell environment (add to `~/.zshrc` or `~/.bashrc`):
```bash
export LOG_API_KEY="ai_interaction_tracker29"
```

## Verify the hook is active
```bash
git config --global core.hooksPath
# → /Users/rod/.git-hooks

ls ~/.git-hooks/post-commit
cat ~/.git-hooks/post-commit | head -5
```
