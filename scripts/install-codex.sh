#!/usr/bin/env bash
# Register the webrunner MCP server with Codex by writing an
# [mcp_servers.webrunner] block to ~/.codex/config.toml.
#
#   scripts/install-codex.sh [--dry-run] [--skip-build]
#
# What it does:
#   1. checks for node 22+ and npm, and builds this checkout (npm ci && npm run build)
#   2. backs up ~/.codex/config.toml (when it exists and will change)
#   3. replaces any existing [mcp_servers.webrunner] block, or adds one
#
# Safe to run again: the block is replaced, never duplicated, and an unchanged
# file is left alone.
#
# Secrets: key VALUES are never written. The block uses Codex's `env_vars`
# list, which names the variables Codex forwards from the environment Codex
# itself is started in. Export your keys in your shell profile. Only variables
# that are set in this shell when the script runs are listed; run it again
# after you add one.

set -euo pipefail

BLOCK_BEGIN="# >>> webrunner (managed by scripts/install-codex.sh; edits inside this block are overwritten) >>>"
BLOCK_END="# <<< webrunner <<<"

# Every variable webrunner reads (src/config.ts).
ENV_NAMES=(
  ANTHROPIC_API_KEY
  BRAVE_API_KEY
  EXA_API_KEY
  TAVILY_API_KEY
  PERPLEXITY_API_KEY
  FIRECRAWL_API_KEY
  JINA_API_KEY
  DUFFEL_API_KEY
  REDDIT_CLIENT_ID
  REDDIT_CLIENT_SECRET
  REDDIT_USER_AGENT
  YOUTUBE_API_KEY
  FINNHUB_API_KEY
  BROWSER_CDP_URL
  BROWSER_HEADLESS
  RESEARCH_MAX_COST_USD
  WEBRUNNER_CACHE_DIR
  WEBRUNNER_LOG_LEVEL
  WEBRUNNER_BROWSER_PROFILE_DIR
  WEBRUNNER_SAVE_SCREENSHOTS
  WEBRUNNER_CURRENCY
  WEBRUNNER_MODEL_PLANNER
  WEBRUNNER_MODEL_SCORER
  WEBRUNNER_MODEL_EXTRACTOR
  WEBRUNNER_MODEL_WRITER
)

# Codex's default tool timeout is 60 s, far too short for deep_research (minutes),
# search_flights (up to 90 s) and browse_task. 900 s covers deep research.
TOOL_TIMEOUT_SEC=900
STARTUP_TIMEOUT_SEC=30

DRY_RUN=0
SKIP_BUILD=0

usage() {
  sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  cat <<'EOF'

Options:
  --dry-run     print the block that would be written; build nothing, change nothing
  --skip-build  do not run npm ci / npm run build (dist/index.js must already exist)
  -h, --help    show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "error: unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
warn() { printf 'warning: %s\n' "$*" >&2; }

[ -n "${HOME:-}" ] || die "HOME is not set."

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENTRY="$ROOT/dist/index.js"
CONFIG_DIR="$HOME/.codex"
CONFIG="$CONFIG_DIR/config.toml"

# --- prerequisites ---------------------------------------------------------

if [ "$SKIP_BUILD" -eq 0 ] && [ "$DRY_RUN" -eq 0 ]; then
  if ! command -v node >/dev/null 2>&1; then
    die "node is not installed. Install Node.js 22 or newer (https://nodejs.org, or your version manager), then run this script again."
  fi
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  case "$NODE_MAJOR" in
    '' | *[!0-9]*) NODE_MAJOR=0 ;;
  esac
  if [ "$NODE_MAJOR" -lt 22 ]; then
    die "node $(node -v 2>/dev/null || echo '?') is too old; webrunner needs Node.js 22 or newer. Upgrade node and run this script again."
  fi
  command -v npm >/dev/null 2>&1 || die "npm is not installed. It normally ships with Node.js; reinstall Node.js 22 or newer."
fi
if ! command -v codex >/dev/null 2>&1; then
  warn "the codex CLI is not on PATH. The config will still be written; install Codex (https://github.com/openai/codex) to use it."
fi

# --- build -----------------------------------------------------------------

if [ "$SKIP_BUILD" -eq 1 ]; then
  say "Skipping build (--skip-build)."
elif [ "$DRY_RUN" -eq 1 ]; then
  say "[dry-run] would run in $ROOT: npm ci && npm run build"
else
  say "Building webrunner in $ROOT ..."
  (cd "$ROOT" && npm ci && npm run build)
fi

if [ ! -f "$ENTRY" ]; then
  if [ "$DRY_RUN" -eq 1 ] || [ "$SKIP_BUILD" -eq 1 ]; then
    warn "$ENTRY does not exist yet (run without --skip-build / --dry-run to build it)."
  else
    die "build finished but $ENTRY is missing. Check the npm output above."
  fi
fi

# --- the block --------------------------------------------------------------

# TOML basic string: escape backslash and double quote.
toml_string() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '"%s"' "$s"
}

PASSED_NAMES=()
for name in "${ENV_NAMES[@]}"; do
  if [ -n "${!name:-}" ]; then
    PASSED_NAMES+=("$name")
  fi
done

make_block() {
  printf '%s\n' "$BLOCK_BEGIN"
  printf '[mcp_servers.webrunner]\n'
  printf 'command = "node"\n'
  printf 'args = [%s]\n' "$(toml_string "$ENTRY")"
  if [ "${#PASSED_NAMES[@]}" -gt 0 ]; then
    local list="" n
    for n in "${PASSED_NAMES[@]}"; do
      list="$list${list:+, }\"$n\""
    done
    printf '# Names only: Codex forwards these from its own environment. No values are stored here.\n'
    printf 'env_vars = [%s]\n' "$list"
  fi
  printf 'startup_timeout_sec = %s\n' "$STARTUP_TIMEOUT_SEC"
  printf 'tool_timeout_sec = %s\n' "$TOOL_TIMEOUT_SEC"
  printf '%s\n' "$BLOCK_END"
}

# Print the config with any webrunner block removed: the marked block, and any
# unmarked [mcp_servers.webrunner] table (with its sub-tables) written by hand or
# by `codex mcp add`. Trailing blank lines are dropped so reruns are stable.
strip_webrunner() {
  awk -v begin="$BLOCK_BEGIN" -v end="$BLOCK_END" '
    function flush_blanks() { while (blanks > 0) { print ""; blanks-- } }
    {
      line = $0
      if (line == begin) { in_marked = 1; next }
      if (in_marked) { if (line == end) in_marked = 0; next }
      if (line ~ /^[ \t]*\[/) {
        if (line ~ /^[ \t]*\[mcp_servers\.webrunner([ \t]*\]|\.)/ || line ~ /^[ \t]*\[mcp_servers\."webrunner"([ \t]*\]|\.)/) { skipping = 1; next }
        skipping = 0
      }
      if (skipping) next
      if (line ~ /^[ \t]*$/) { blanks++; next }
      flush_blanks()
      print line
    }
  ' "$1"
}

BLOCK="$(make_block)"

if [ -f "$CONFIG" ]; then
  REST="$(strip_webrunner "$CONFIG")"
else
  REST=""
fi

if printf '%s\n' "$REST" | grep -Eq '^[[:space:]]*(mcp_servers\.["]?webrunner["]?[[:space:]]*[.=]|mcp_servers[[:space:]]*=)'; then
  die "$CONFIG defines webrunner in a form this script cannot rewrite safely (dotted keys or an inline table). Remove that entry by hand and run the script again."
fi

if [ -n "$REST" ]; then
  NEW="$REST"$'\n\n'"$BLOCK"$'\n'
else
  NEW="$BLOCK"$'\n'
fi

if [ "$DRY_RUN" -eq 1 ]; then
  say "[dry-run] would write this block to $CONFIG:"
  say ""
  say "$BLOCK"
  say ""
  if [ "${#PASSED_NAMES[@]}" -eq 0 ]; then
    say "[dry-run] no webrunner environment variables are set in this shell, so the block has no env_vars line."
  fi
  say "[dry-run] nothing was changed."
  exit 0
fi

# --- write -----------------------------------------------------------------

mkdir -p "$CONFIG_DIR"

if [ -f "$CONFIG" ] && [ "$(cat "$CONFIG")"$'\n' = "$NEW" ]; then
  say "$CONFIG already contains this exact webrunner block; nothing to do."
else
  if [ -f "$CONFIG" ]; then
    BACKUP="$CONFIG.bak-$(date +%Y%m%d%H%M%S)-$$"
    cp -p "$CONFIG" "$BACKUP"
    say "Backed up $CONFIG to $BACKUP"
  fi
  TMP="$(mktemp "$CONFIG_DIR/config.toml.XXXXXX")"
  printf '%s' "$NEW" >"$TMP"
  if [ -f "$CONFIG" ]; then
    chmod --reference="$CONFIG" "$TMP" 2>/dev/null || chmod 600 "$TMP"
  else
    chmod 600 "$TMP"
  fi
  mv "$TMP" "$CONFIG"
  say "Wrote the [mcp_servers.webrunner] block to $CONFIG"
fi

cat <<EOF

Done. Codex will start: node $ENTRY
EOF
if [ "${#PASSED_NAMES[@]}" -gt 0 ]; then
  say "Variables Codex will forward (names only, from the environment Codex starts in): ${PASSED_NAMES[*]}"
  say "Keep exporting them in your shell profile; no values were written to $CONFIG."
else
  say "No webrunner environment variables were set in this shell, so the block forwards none."
  say "Export your keys (for example BRAVE_API_KEY, EXA_API_KEY, ANTHROPIC_API_KEY) and run this script again,"
  say "or put them in ~/.config/webrunner/config.json (see README, Configuration)."
fi
cat <<EOF

Verify:
  codex mcp list             # webrunner should be listed
Then start a new Codex session; the tools are ping, web_search, fetch_page,
deep_research, browse_task, search_flights, search_hotels, market_quote, weather,
exchange_rate, social_search, search_reviews, accounts and health.

tool_timeout_sec is $TOOL_TIMEOUT_SEC because Codex's default (60 s) is shorter than a deep_research call.
To remove it: scripts/uninstall.sh
EOF
