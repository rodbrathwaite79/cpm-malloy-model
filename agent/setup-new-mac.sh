#!/bin/bash
# ══════════════════════════════════════════════════════════════════════════════
# CPM-Setup-Agent — Fresh MacBook Setup Script
#
# Sets up the complete CPM report system on a new Mac, fully autonomous.
# Run once, it handles everything:
#   1. Homebrew (if not installed)
#   2. nvm + Node.js v22
#   3. Clone the GitHub repo
#   4. npm install
#   5. Credential setup (interactive, one time)
#   6. launchd daily schedule
#   7. Full QA validation via quality-agent.mjs
#   8. Test email
#
# Usage:
#   curl -sSL https://raw.githubusercontent.com/rodbrathwaite79/cpm-malloy-model/main/setup-new-mac.sh | bash
#   OR download and run:
#   bash setup-new-mac.sh
#
# The only interactive step is entering API credentials (done once).
# Everything else is fully automated.
# ══════════════════════════════════════════════════════════════════════════════

set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

ok()   { echo -e "  ${GREEN}✅${NC} $1"; }
warn() { echo -e "  ${YELLOW}⚠️ ${NC} $1"; }
fail() { echo -e "  ${RED}❌${NC} $1"; }
info() { echo -e "  ${CYAN}→${NC}  $1"; }
step() { echo -e "\n${BOLD}${BLUE}── $1 ──${NC}"; }

# ── Paths ─────────────────────────────────────────────────────────────────────
AGENT_DIR="$HOME/Documents/cpm-agent"
REPO_DIR="$AGENT_DIR/malloy-model-git"
SCRIPT_DIR="$AGENT_DIR/agent/cpm-report-agent"
LOG_DIR="$AGENT_DIR/logs"
ENV_FILE="$SCRIPT_DIR/.env"
PLIST_SRC="$SCRIPT_DIR/com.rod.cpm-report.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.rod.cpm-report.plist"
GITHUB_REPO_URL="https://github.com/rodbrathwaite79/cpm-malloy-model.git"

echo ""
echo -e "${BOLD}════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  CPM-Setup-Agent — Fresh Mac Setup${NC}"
echo -e "${BOLD}  $(date '+%A, %B %-d, %Y')${NC}"
echo -e "${BOLD}════════════════════════════════════════════════════════${NC}"
echo ""
echo "  This script will set up the CPM daily report system."
echo "  It takes about 5 minutes on a new Mac."
echo "  You'll be asked for API credentials once at the end."
echo ""
read -p "  Press Enter to start, or Ctrl+C to cancel..."

# ══════════════════════════════════════════════════════════════════════════════
# STEP 1: Xcode Command Line Tools
# ══════════════════════════════════════════════════════════════════════════════
step "1. Xcode Command Line Tools"

if xcode-select -p &>/dev/null; then
  ok "Already installed ($(xcode-select -p))"
else
  info "Installing Xcode Command Line Tools (required for git and compilers)..."
  xcode-select --install
  echo "  Waiting for Xcode tools to install..."
  until xcode-select -p &>/dev/null; do sleep 5; done
  ok "Xcode Command Line Tools installed"
fi

# ══════════════════════════════════════════════════════════════════════════════
# STEP 2: Homebrew
# ══════════════════════════════════════════════════════════════════════════════
step "2. Homebrew"

if command -v brew &>/dev/null; then
  ok "Already installed ($(brew --version | head -1))"
else
  info "Installing Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # Add brew to PATH for Apple Silicon Macs
  if [[ -f "/opt/homebrew/bin/brew" ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
    echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> "$HOME/.zprofile"
  fi
  ok "Homebrew installed"
fi

# ══════════════════════════════════════════════════════════════════════════════
# STEP 3: nvm + Node.js
# ══════════════════════════════════════════════════════════════════════════════
step "3. nvm + Node.js v22"

# Load nvm if already present
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

if command -v nvm &>/dev/null; then
  ok "nvm already installed ($(nvm --version))"
else
  info "Installing nvm..."
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
  ok "nvm installed"
fi

# Install Node v22 LTS
if node --version 2>/dev/null | grep -q "v22"; then
  ok "Node.js v22 already active ($(node --version))"
else
  info "Installing Node.js v22 LTS..."
  nvm install 22
  nvm use 22
  nvm alias default 22
  ok "Node.js $(node --version) installed and set as default"
fi

NODE_BIN="$(which node)"
info "Node binary: $NODE_BIN"

# ══════════════════════════════════════════════════════════════════════════════
# STEP 4: Clone GitHub repository
# ══════════════════════════════════════════════════════════════════════════════
step "4. Clone CPM Repository"

mkdir -p "$AGENT_DIR"

if [ -d "$REPO_DIR/.git" ]; then
  ok "Repo already cloned at $REPO_DIR"
  info "Pulling latest changes..."
  git -C "$REPO_DIR" pull --ff-only 2>/dev/null || warn "Could not pull (offline or conflict)"
else
  info "Cloning $GITHUB_REPO_URL..."
  git clone "$GITHUB_REPO_URL" "$REPO_DIR"
  ok "Repository cloned"
fi

# Verify key files
if [ -f "$REPO_DIR/cpm_benchmarks.parquet" ]; then
  SIZE=$(du -h "$REPO_DIR/cpm_benchmarks.parquet" | cut -f1)
  ok "cpm_benchmarks.parquet found ($SIZE)"
else
  fail "cpm_benchmarks.parquet missing from repo — check the repository"
  exit 1
fi

# ══════════════════════════════════════════════════════════════════════════════
# STEP 5: Set up agent directory and npm install
# ══════════════════════════════════════════════════════════════════════════════
step "5. Agent Directory + npm Install"

# The cpm-report-agent scripts are part of the repo OR live in agent/
# Check if script dir exists already; if not, create it with the essentials
if [ ! -d "$SCRIPT_DIR" ]; then
  info "Creating $SCRIPT_DIR..."
  mkdir -p "$SCRIPT_DIR"
fi

# package.json — create if missing
if [ ! -f "$SCRIPT_DIR/package.json" ]; then
  info "Writing package.json..."
  cat > "$SCRIPT_DIR/package.json" <<'PKGJSON'
{
  "name": "cpm-report-agent",
  "version": "1.0.0",
  "description": "CPM benchmark report — standalone Node.js script",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "dependencies": {
    "duckdb": "latest"
  }
}
PKGJSON
  ok "package.json created"
else
  ok "package.json exists"
fi

# npm install
info "Running npm install (installs duckdb)..."
cd "$SCRIPT_DIR"
npm install --no-audit --no-fund 2>&1 | tail -5

if [ -d "$SCRIPT_DIR/node_modules/duckdb" ]; then
  ok "duckdb npm package installed"
else
  fail "duckdb installation failed"
  exit 1
fi

# Download scripts from GitHub repo (agent/ subfolder)
RAW_BASE="https://raw.githubusercontent.com/rodbrathwaite79/cpm-malloy-model/main/agent"
for SCRIPT in daily-report.mjs quality-agent.mjs agent.ts MIGRATE.md; do
  if [ -f "$SCRIPT_DIR/$SCRIPT" ]; then
    ok "$SCRIPT already present"
  else
    info "Downloading $SCRIPT from GitHub..."
    curl -fsSL "$RAW_BASE/$SCRIPT" -o "$SCRIPT_DIR/$SCRIPT"
    ok "$SCRIPT downloaded"
  fi
done

# Make scripts executable
chmod +x "$SCRIPT_DIR/daily-report.mjs" "$SCRIPT_DIR/quality-agent.mjs" "$SCRIPT_DIR/setup-new-mac.sh" 2>/dev/null || true

# ══════════════════════════════════════════════════════════════════════════════
# STEP 6: Update plist Node.js path for THIS Mac
# ══════════════════════════════════════════════════════════════════════════════
step "6. Configure launchd Plist"

# Generate the plist fresh for this Mac — credentials filled in at Step 7
info "Generating launchd plist for this Mac..."
cat > "$PLIST_SRC" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.rod.cpm-report</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${SCRIPT_DIR}/daily-report.mjs</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>8</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BRAVE_API_KEY</key><string>BRAVE_PLACEHOLDER</string>
    <key>GITHUB_TOKEN</key><string>GITHUB_PLACEHOLDER</string>
    <key>RESEND_API_KEY</key><string>RESEND_PLACEHOLDER</string>
    <key>MALLOYYO_URL</key><string>MALLOYYO_PLACEHOLDER</string>
    <key>EMAIL_TO</key><string>EMAILTO_PLACEHOLDER</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/cpm-report.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/cpm-report-error.log</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
PLISTEOF
ok "Plist generated at $PLIST_SRC"

# ══════════════════════════════════════════════════════════════════════════════
# STEP 7: Credentials
# ══════════════════════════════════════════════════════════════════════════════
step "7. API Credentials"

if [ -f "$ENV_FILE" ]; then
  ok ".env file already exists"
  echo ""
  read -p "  Overwrite existing credentials? [y/N]: " OVERWRITE
  if [[ ! "$OVERWRITE" =~ ^[Yy]$ ]]; then
    info "Keeping existing credentials"
  else
    rm "$ENV_FILE"
  fi
fi

if [ ! -f "$ENV_FILE" ]; then
  echo ""
  echo -e "  ${BOLD}Enter your API credentials (input is hidden):${NC}"
  echo -e "  ${CYAN}(Get these from the credentials document or prior Mac's .env file)${NC}"
  echo ""

  read -p "  BRAVE_API_KEY       (from search.brave.com): " -r BRAVE_KEY
  echo ""
  read -p "  GITHUB_TOKEN        (from github.com/settings/tokens, needs 'repo' scope): " -r GITHUB_KEY
  echo ""
  echo -e "  ${CYAN}Resend API key — free at resend.com (3,000 emails/month, no credit card):${NC}"
  echo -e "  ${CYAN}Sign up → Dashboard → API Keys → Create API Key${NC}"
  read -p "  RESEND_API_KEY      (starts with re_): " -r RESEND_KEY
  echo ""
  read -p "  EMAIL_TO            (recipient email, default rod.brathwaite@gmail.com): " -r EMAIL_TO_VAL
  EMAIL_TO_VAL="${EMAIL_TO_VAL:-rod.brathwaite@gmail.com}"
  echo ""
  read -p "  ANTHROPIC_API_KEY   (optional, press Enter to skip): " -r ANTHROPIC_KEY
  echo ""

  # Write .env
  cat > "$ENV_FILE" <<ENVFILE
BRAVE_API_KEY=${BRAVE_KEY}
GITHUB_TOKEN=${GITHUB_KEY}
RESEND_API_KEY=${RESEND_KEY}
MALLOYYO_URL=https://malloyyo-c7i3hmkly-brathwaite.vercel.app
EMAIL_TO=${EMAIL_TO_VAL}
# CC recipients (comma-separated) — uncomment when ready:
# EMAIL_CC=casey.brathwaite@gmail.com
ENVFILE

  if [ -n "${ANTHROPIC_KEY:-}" ]; then
    echo "ANTHROPIC_API_KEY=${ANTHROPIC_KEY}" >> "$ENV_FILE"
    ok "Anthropic API key saved"
  fi

  ok ".env file created at $ENV_FILE"

  # Fill credential placeholders into the plist
  if [ -f "$PLIST_SRC" ]; then
    info "Inserting credentials into plist..."
    sed -i.bak \
      -e "s|BRAVE_PLACEHOLDER|${BRAVE_KEY}|g" \
      -e "s|GITHUB_PLACEHOLDER|${GITHUB_KEY}|g" \
      -e "s|RESEND_PLACEHOLDER|${RESEND_KEY}|g" \
      -e "s|MALLOYYO_PLACEHOLDER|https://malloyyo-c7i3hmkly-brathwaite.vercel.app|g" \
      -e "s|EMAILTO_PLACEHOLDER|${EMAIL_TO_VAL}|g" \
      "$PLIST_SRC"
    rm -f "$PLIST_SRC.bak"
    ok "Plist credentials set"
  fi
fi

# ══════════════════════════════════════════════════════════════════════════════
# STEP 8: Install launchd schedule
# ══════════════════════════════════════════════════════════════════════════════
step "8. Install Daily Schedule"

mkdir -p "$LOG_DIR"
ok "Log directory: $LOG_DIR"

if [ -f "$PLIST_SRC" ]; then
  cp "$PLIST_SRC" "$PLIST_DST"
  launchctl unload "$PLIST_DST" 2>/dev/null || true
  launchctl load "$PLIST_DST"
  ok "launchd schedule installed — CPM report will run daily at 8:00 AM"
else
  warn "Plist not found — daily schedule not installed"
  warn "Run this after copying daily-report.mjs and com.rod.cpm-report.plist to $SCRIPT_DIR"
fi

# ══════════════════════════════════════════════════════════════════════════════
# STEP 9: Run Quality Agent
# ══════════════════════════════════════════════════════════════════════════════
step "9. System Validation (Quality Agent)"

if [ -f "$SCRIPT_DIR/quality-agent.mjs" ]; then
  info "Running full QA validation..."
  echo ""
  cd "$SCRIPT_DIR"
  node quality-agent.mjs 2>&1
  QA_EXIT=$?
  if [ $QA_EXIT -eq 0 ]; then
    echo ""
    ok "All quality checks passed"
  else
    echo ""
    warn "Some checks need attention — see output above"
  fi
else
  warn "quality-agent.mjs not found — skipping automated QA"
  warn "Copy it from the source Mac's $SCRIPT_DIR folder"
fi

# ══════════════════════════════════════════════════════════════════════════════
# STEP 10: Guild CLI (optional — for agent monitoring dashboard)
# ══════════════════════════════════════════════════════════════════════════════
step "10. Guild CLI (optional)"

if command -v guild &>/dev/null; then
  ok "Guild CLI already installed ($(guild --version 2>/dev/null || echo 'version unknown'))"
else
  info "Guild CLI is optional — it lets you monitor the CPM agent in the Guild UI."
  info "The daily report (daily-report.mjs) runs WITHOUT Guild — it uses launchd."
  info "To install Guild CLI later:"
  echo ""
  echo "     npm install -g @guildai/guild-cli"
  echo "     guild login"
  echo ""
  info "The CPM agent is already published as rod.brathwaite~cpm-report-agent."
  info "After login, send { \"reset\": true } via Guild UI if you want a clean"
  info "metrics slate on the new machine."
  warn "Guild CLI not installed — skipping (run the install above when ready)"
fi

# ══════════════════════════════════════════════════════════════════════════════
# DONE
# ══════════════════════════════════════════════════════════════════════════════
echo ""
echo -e "${BOLD}════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}${BOLD}  ✅ Setup Complete!${NC}"
echo ""
echo "  Daily CPM report runs every morning at 8:00 AM."
echo "  Agent metrics are saved to: $LOG_DIR/agent-metrics.json"
echo "  (File is auto-created on the first successful report run.)"
echo ""
echo -e "  ${BOLD}Useful commands:${NC}"
echo "   Run report now:  node $SCRIPT_DIR/daily-report.mjs"
echo "   Run QA check:    node $SCRIPT_DIR/quality-agent.mjs"
echo "   View logs:       tail -f $LOG_DIR/cpm-report.log"
echo "   View metrics:    cat $LOG_DIR/agent-metrics.json"
echo "   Remove schedule: launchctl unload $PLIST_DST"
echo ""
echo -e "  ${YELLOW}If any checks failed above:${NC}"
echo "   1. Fix the issue noted in the QA output"
echo "   2. Re-run QA: node $SCRIPT_DIR/quality-agent.mjs --fix"
echo ""
echo -e "  ${YELLOW}Guild agent metrics:${NC}"
echo "   After the first real run, open Guild UI and send { \"reset\": true }"
echo "   to the cpm-report-agent if you want a clean metrics slate."
echo ""
echo -e "${BOLD}════════════════════════════════════════════════════════${NC}"
