#!/usr/bin/env bash
# Push variables from YOUR_RAILWAY_VARS.txt to Railway (requires login + link).
# Usage:
#   source ~/.railway/env
#   cd /home/tim/Applications/Suresecured/Email_Suresecured
#   ./scripts/push-railway-vars.sh
#
# Or with a project token (no interactive login):
#   RAILWAY_TOKEN=your_project_token ./scripts/push-railway-vars.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VARS_FILE="${RAILWAY_VARS_FILE:-$ROOT/YOUR_RAILWAY_VARS.txt}"

if ! command -v railway >/dev/null 2>&1; then
  if [[ -f "$HOME/.railway/env" ]]; then
    # shellcheck source=/dev/null
    source "$HOME/.railway/env"
  fi
fi

if ! command -v railway >/dev/null 2>&1; then
  echo "Railway CLI not found. Install: bash <(curl -fsSL railway.com/install.sh)"
  exit 1
fi

if [[ ! -f "$VARS_FILE" ]]; then
  echo "Missing $VARS_FILE"
  exit 1
fi

echo "Using vars file: $VARS_FILE"
echo "Checking Railway auth..."
railway whoami >/dev/null 2>&1 || {
  echo "Not logged in. Run: railway login"
  echo "Or set RAILWAY_TOKEN from Railway → Project → Settings → Tokens"
  exit 1
}

skip_line() {
  local v="$1"
  [[ -z "$v" ]] && return 0
  [[ "$v" =~ ^(>>>|\(when|\(or|DATABASE_URL|SES_|OPENROUTER|RETELL|TELNYX|TELEGRAM|IMAP_) ]] && return 0
  [[ "$v" =~ ^=+$ ]] && return 0
  [[ "$v" =~ ^-+$ ]] && return 0
  [[ "$v" =~ ^(REQUIRED|YOU MUST|OPTIONAL|ALREADY|After all|How to|App:|Created:|Using ) ]] && return 0
  return 1
}

key=""
count=0
skipped=0

while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line//$'\r'/}"
  if skip_line "$line"; then
    continue
  fi
  if [[ -z "$key" ]]; then
    key="$line"
    continue
  fi
  if skip_line "$line"; then
    echo "SKIP (placeholder): $key"
    skipped=$((skipped + 1))
    key=""
    continue
  fi
  echo "SET $key"
  railway variable set "${key}=${line}" --skip-deploys
  count=$((count + 1))
  key=""
done < "$VARS_FILE"

echo ""
echo "Set $count variable(s), skipped $skipped placeholder(s)."
echo "Redeploy when ready: railway redeploy -y"
