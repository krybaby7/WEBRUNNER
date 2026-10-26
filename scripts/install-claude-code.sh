#!/usr/bin/env bash
# Register the webrunner MCP server with Claude Code, user scope (every project).
#
#   scripts/install-claude-code.sh [--dry-run] [--no-env] [--skip-build]
#
# What it does:
#   1. checks for node 22+, npm and the claude CLI
#   2. builds this checkout (npm ci && npm run build)
#   3. removes an existing user-scope "webrunner" server, then adds it again with
#      `claude mcp add`, passing through the webrunner variables that are set in
#      this shell as --env flags
#
# Safe to run again: the old registration is replaced, never duplicated.
#
# Secrets: this script never writes a key into any file. Note that Claude Code
# itself stores the --env values of a server in its own config, ~/.claude.json.
# If you would rather keep keys out of that file, use --no-env and put the keys
# in ~/.config/webrunner/config.json instead (see README, Configuration).

set -euo pipefail

SERVER_NAME="webrunner"

# Every variable webrunner reads (src/config.ts). Only those set and non-empty
# in the calling shell are passed through.
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
  WEBRUNNER_LLM_BACKEND
  WEBRUNNER_LLM_FALLBACK
  WEBRUNNER_CLAUDE_PATH
  WEBRUNNER_CODEX_PATH
  WEBRUNNER_CODEX_MODEL
  WEBRUNNER_LLM_CONCURRENCY
  WEBRUNNER_CLAUDE_MAX_UTILIZATION
)

DRY_RUN=0
PASS_ENV=1
SKIP_BUILD=0

usage() {
  sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  cat <<'EOF'

Options:
  --dry-run     print what would run; build nothing, change nothing, never run claude
  --no-env      do not pass any environment variables to the server
  --skip-build  do not run npm ci / npm run build (dist/index.js must already exist)
  -h, --help    show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --no-env) PASS_ENV=0 ;;
    --skip-build) SKIP_BUILD=1 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "error: unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
warn() { printf 'warning: %s\n' "$*" >&2; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENTRY="$ROOT/dist/index.js"
# Git Bash, MSYS2 and Cygwin print /c/Users/...; Claude Code starts the server
# outside this shell, so register the Windows path (C:/Users/...) instead.
if command -v cygpath >/dev/null 2>&1; then
  ENTRY="$(cygpath -m "$ENTRY")"
fi

# --- prerequisites ---------------------------------------------------------

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

if [ "$SKIP_BUILD" -eq 0 ] && ! command -v npm >/dev/null 2>&1; then
  if [ "$DRY_RUN" -eq 1 ]; then
    warn "npm is not on PATH (fine for --dry-run, required to build)."
  else
    die "npm is not installed. It normally ships with Node.js; reinstall Node.js 22 or newer, or use --skip-build if dist/ is already built."
  fi
fi

if ! command -v claude >/dev/null 2>&1; then
  if [ "$DRY_RUN" -eq 1 ]; then
    warn "the claude CLI is not on PATH (fine for --dry-run, required for a real install)."
  else
    die "the claude CLI is not installed or not on PATH. Install Claude Code (https://code.claude.com/docs, for example: npm install -g @anthropic-ai/claude-code), then run this script again."
  fi
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

# --- assemble the claude mcp add command -----------------------------------

# Option order matters: `--env` takes several values, so the server name must
# not directly follow it. `--transport stdio` sits between them, and `--`
# separates claude's options from the server command.
ENV_FLAGS=()
PASSED_NAMES=()
if [ "$PASS_ENV" -eq 1 ]; then
  for name in "${ENV_NAMES[@]}"; do
    value="${!name:-}"
    if [ -n "$value" ]; then
      ENV_FLAGS+=(--env "$name=$value")
      PASSED_NAMES+=("$name")
    fi
  done
fi

ADD_CMD=(claude mcp add --scope user)
if [ "${#ENV_FLAGS[@]}" -gt 0 ]; then
  ADD_CMD+=("${ENV_FLAGS[@]}")
fi
ADD_CMD+=(--transport stdio "$SERVER_NAME" -- node "$ENTRY")

# Printable form: values of *_KEY, *_SECRET and *_CLIENT_ID variables are never echoed.
print_command() {
  local out="" arg prev=""
  for arg in "${ADD_CMD[@]}"; do
    if [ "$prev" = "--env" ]; then
      case "$arg" in
        *_KEY=* | *_SECRET=* | *_CLIENT_ID=*) arg="${arg%%=*}=REDACTED" ;;
      esac
    fi
    out="$out $(printf '%q' "$arg")"
    prev="$arg"
  done
  printf '%s\n' "${out# }"
}

if [ "${#PASSED_NAMES[@]}" -gt 0 ]; then
  say "Environment variables that will be passed to the server: ${PASSED_NAMES[*]}"
elif [ "$PASS_ENV" -eq 1 ]; then
  say "No webrunner environment variables are set in this shell, so none are passed."
  say "Export your keys first (for example BRAVE_API_KEY) and run this script again, or use ~/.config/webrunner/config.json."
fi

# --- register --------------------------------------------------------------

if [ "$DRY_RUN" -eq 1 ]; then
  say "[dry-run] would remove an existing user-scope server (ignored if absent):"
  say "  claude mcp remove --scope user $SERVER_NAME"
  say "[dry-run] would then run:"
  say "  $(print_command)"
  say "[dry-run] nothing was changed and claude was not run."
  exit 0
fi

if claude mcp remove --scope user "$SERVER_NAME" >/dev/null 2>&1; then
  say "Removed the existing user-scope '$SERVER_NAME' registration."
fi

say "Registering with Claude Code:"
say "  $(print_command)"
"${ADD_CMD[@]}"

cat <<EOF

Done. webrunner is registered with Claude Code for every project (user scope),
pointing at: node $ENTRY

Verify:
  claude mcp list                 # webrunner should show as connected
  claude mcp get $SERVER_NAME          # shows the command and the variable names passed through
Then start a new Claude Code session; the tools are ping, web_search, fetch_page,
deep_research, browse_task, search_flights, search_hotels, market_quote, weather,
exchange_rate, social_search, search_reviews, accounts and health. Inside Claude Code, /mcp shows the same.

To change keys or move the checkout, run this script again. To remove it:
  scripts/uninstall.sh
EOF
