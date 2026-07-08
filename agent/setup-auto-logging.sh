#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# setup-auto-logging.sh
#
# Run ONCE on your Mac to enable automatic AI interaction logging for ALL repos.
# After this, every git commit on your machine silently logs to the ROI tracker.
#
# Usage: bash agent/setup-auto-logging.sh
# ─────────────────────────────────────────────────────────────────────────────

set -e

HOOK_DIR="$HOME/.git-hooks"
HOOK_FILE="$HOOK_DIR/post-commit"

echo "Setting up global AI interaction auto-logger..."

# ── 1. Create global hooks directory ─────────────────────────────────────────
mkdir -p "$HOOK_DIR"

# ── 2. Write the post-commit hook ─────────────────────────────────────────────
cat > "$HOOK_FILE" << 'HOOK'
#!/bin/bash
# Global post-commit: auto-logs every AI-assisted commit to CPM ROI tracker

LOG_API_URL="https://cpm-vercel.vercel.app/api/log-interaction"
LOG_API_KEY="ai_interaction_tracker29"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"

# Override key from local .env if present
LOCAL_KEY=$(grep '^LOG_API_KEY=' "$REPO_ROOT/cpm-vercel/.env" 2>/dev/null | cut -d'=' -f2)
[ -n "$LOCAL_KEY" ] && LOG_API_KEY="$LOCAL_KEY"

COMMIT_HASH=$(git rev-parse HEAD 2>/dev/null)
COMMIT_MSG=$(git log -1 --pretty=%B 2>/dev/null | head -1 | sed 's/[\"\\]/ /g' | cut -c1-120)
[ -z "$COMMIT_MSG" ] && COMMIT_MSG="Code commit"

CHANGED_FILES=$(git diff-tree --no-commit-id -r --name-only HEAD 2>/dev/null | head -30)
LINES_ADDED=$(git show --shortstat HEAD 2>/dev/null | grep -oE '[0-9]+ insertion' | grep -oE '[0-9]+' | head -1)
[ -z "$LINES_ADDED" ] && LINES_ADDED=50

TASK_TYPE="code"
if echo "$CHANGED_FILES" | grep -qE '\.(sql|malloy)$'; then
  TASK_TYPE="analysis"
elif echo "$CHANGED_FILES" | grep -qE '(\.test\.|\.spec\.|test-)'; then
  TASK_TYPE="testing"
elif echo "$CHANGED_FILES" | grep -qE '\.(md|html|txt)$' && ! echo "$CHANGED_FILES" | grep -qE '\.(ts|js|py|go|rs)$'; then
  TASK_TYPE="document"
fi

if   [ "$LINES_ADDED" -lt 25  ] 2>/dev/null; then HOURS="0.25"
elif [ "$LINES_ADDED" -lt 75  ] 2>/dev/null; then HOURS="0.5"
elif [ "$LINES_ADDED" -lt 200 ] 2>/dev/null; then HOURS="1.0"
elif [ "$LINES_ADDED" -lt 400 ] 2>/dev/null; then HOURS="2.0"
else HOURS="3.0"
fi

case $TASK_TYPE in
  code)     RATE=150 ;;
  analysis) RATE=175 ;;
  testing)  RATE=100 ;;
  document) RATE=80  ;;
  *)        RATE=150 ;;
esac
VALUE=$(echo "$HOURS * $RATE" | bc 2>/dev/null || echo "75")

PROJECT=$(basename "$REPO_ROOT" 2>/dev/null || echo "unknown")
SESSION_ID="git-${COMMIT_HASH}"

(
  curl -s -X POST "$LOG_API_URL" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $LOG_API_KEY" \
    --connect-timeout 5 --max-time 10 \
    -d "{\"provider\":\"cursor\",\"tool\":\"cursor\",\"task_type\":\"$TASK_TYPE\",\"description\":\"$COMMIT_MSG\",\"hours_estimate\":$HOURS,\"value_usd\":$VALUE,\"project\":\"$PROJECT\",\"cost_model\":\"subscription\",\"first_pass\":true,\"session_id\":\"$SESSION_ID\"}" \
    -o /tmp/ai-log-last.txt 2>&1
) &
disown 2>/dev/null

exit 0
HOOK

chmod +x "$HOOK_FILE"
echo "✓ Hook written to $HOOK_FILE"

# ── 3. Set as global git hooks path ───────────────────────────────────────────
git config --global core.hooksPath "$HOOK_DIR"
echo "✓ Global git hooks path set to $HOOK_DIR"

# ── 4. Verify ─────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Auto-logging ACTIVE for all repos on this machine."
echo "  Every commit will silently log to CPM ROI tracker."
echo "  Check last result: cat /tmp/ai-log-last.txt"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "Global hook path: $(git config --global core.hooksPath)"
echo "Hook file:        $HOOK_FILE"
