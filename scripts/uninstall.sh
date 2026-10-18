#!/usr/bin/env bash
# Remove the webrunner registrations created by the install scripts.
#
#   scripts/uninstall.sh [--dry-run]
#
#   - Claude Code: `claude mcp remove --scope user webrunner`
#   - Codex: removes the [mcp_servers.webrunner] block from ~/.codex/config.toml
#     (backing the file up first)
#
# Not touched: this checkout, the browser profile (~/.config/webrunner/browser-profile),
# ~/.config/webrunner/config.json and the cache (~/.cache/webrunner). Delete those
# yourself if you want them gone.

set -euo pipefail

SERVER_NAME="webrunner"
BLOCK_BEGIN="# >>> webrunner (managed by scripts/install-codex.sh; edits inside this block are overwritten) >>>"
BLOCK_END="# <<< webrunner <<<"

DRY_RUN=0

usage() {
  sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  cat <<'EOF'

Options:
  --dry-run   print what would be removed; change nothing, never run claude
  -h, --help  show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "error: unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[ -n "${HOME:-}" ] || die "HOME is not set."

# --- Claude Code -------------------------------------------------------------

if command -v claude >/dev/null 2>&1; then
  if [ "$DRY_RUN" -eq 1 ]; then
    say "[dry-run] would run: claude mcp remove --scope user $SERVER_NAME"
  elif claude mcp remove --scope user "$SERVER_NAME" >/dev/null 2>&1; then
    say "Claude Code: removed the user-scope '$SERVER_NAME' server."
  else
    say "Claude Code: no user-scope '$SERVER_NAME' server was registered."
  fi
else
  say "Claude Code: the claude CLI is not on PATH, skipping."
fi

# --- Codex -------------------------------------------------------------------

CONFIG="$HOME/.codex/config.toml"

# Same filter as install-codex.sh: drops the marked block and any unmarked
# [mcp_servers.webrunner] table with its sub-tables.
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

if [ ! -f "$CONFIG" ]; then
  say "Codex: $CONFIG does not exist, nothing to remove."
else
  REST="$(strip_webrunner "$CONFIG")"
  if [ -n "$REST" ]; then
    NEW="$REST"$'\n'
  else
    NEW=""
  fi
  CURRENT="$(cat "$CONFIG")"
  if [ -n "$CURRENT" ]; then CURRENT="$CURRENT"$'\n'; fi
  if [ "$CURRENT" = "$NEW" ]; then
    say "Codex: no webrunner block in $CONFIG, nothing to remove."
  elif [ "$DRY_RUN" -eq 1 ]; then
    say "[dry-run] would back up $CONFIG and remove the webrunner block from it."
  else
    BACKUP="$CONFIG.bak-$(date +%Y%m%d%H%M%S)-$$"
    cp -p "$CONFIG" "$BACKUP"
    TMP="$(mktemp "$(dirname "$CONFIG")/config.toml.XXXXXX")"
    printf '%s' "$NEW" >"$TMP"
    chmod --reference="$CONFIG" "$TMP" 2>/dev/null || chmod 600 "$TMP"
    mv "$TMP" "$CONFIG"
    say "Codex: removed the webrunner block from $CONFIG (backup: $BACKUP)."
  fi
fi

if [ "$DRY_RUN" -eq 1 ]; then
  say "[dry-run] nothing was changed."
fi
say "Left in place: the checkout, ~/.config/webrunner (profile and config.json) and ~/.cache/webrunner."
