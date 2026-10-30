#!/usr/bin/env bash
set -euo pipefail

# Live TUI harness. Loads this repository as a local OpenCode plugin in an
# isolated config/data/state directory, then checks the plugin page and leader key.
# Requires opencode and tmux. Linux-only by design.

if ! command -v opencode >/dev/null 2>&1; then
  echo "live-check: opencode is not installed; skipping"
  exit 0
fi
if ! command -v tmux >/dev/null 2>&1; then
  echo "live-check: tmux is not installed; skipping"
  exit 0
fi

ROOT=$(cd "$(dirname "$0")/.." && pwd)
BASE="${TMPDIR:-/tmp}/opencode/ensemble-live-$$"
SERVE="ensemble-live-serve-$$"
TUI="ensemble-live-tui-$$"
mkdir -p "$BASE/config/opencode" "$BASE/project" "$BASE/data" "$BASE/state"
cat > "$BASE/config/opencode/opencode.json" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "plugins": ["$ROOT"]
}
EOF

cleanup() {
  tmux kill-session -t "$TUI" 2>/dev/null || true
  tmux kill-session -t "$SERVE" 2>/dev/null || true
  rm -rf "$BASE"
}
trap cleanup EXIT

tmux new-session -d -s "$SERVE" -x 120 -y 20 -c "$BASE/project" \
  -e XDG_CONFIG_HOME="$BASE/config" -e XDG_DATA_HOME="$BASE/data" -e XDG_STATE_HOME="$BASE/state" \
  "opencode serve --hostname 127.0.0.1 --port 0 --print-logs 2>$BASE/server.log"

URL=""
for _ in $(seq 1 200); do
  PANE=$(tmux capture-pane -p -t "$SERVE" 2>/dev/null || true)
  URL=$(sed -n 's/^server listening on //p' <<<"$PANE" | head -1)
  [ -n "$URL" ] && break
  sleep 0.1
done
if [ -z "$URL" ]; then
  echo "live-check: server did not start" >&2
  tail -20 "$BASE/server.log" >&2 || true
  exit 1
fi

PASS=$(tmux capture-pane -p -t "$SERVE" | sed -n 's/^server password //p' | head -1)
if [ -z "$PASS" ]; then
  echo "live-check: could not read the server password" >&2
  exit 1
fi

tmux new-session -d -s "$TUI" -x 120 -y 40 -c "$BASE/project" \
  -e XDG_CONFIG_HOME="$BASE/config" -e XDG_DATA_HOME="$BASE/data" -e XDG_STATE_HOME="$BASE/state" \
  -e OPENCODE_PASSWORD="$PASS" \
  "opencode --server $URL --print-logs 2>$BASE/tui.log; sleep 300"
sleep 5
tmux send-keys -t "$TUI" '/ensemble'; sleep 0.5
tmux send-keys -t "$TUI" Enter; sleep 0.5
tmux send-keys -t "$TUI" Enter; sleep 2

SCREEN=$(tmux capture-pane -p -t "$TUI")
if ! grep -q "ENSEMBLE" <<<"$SCREEN"; then
  echo "live-check: the Ensemble page did not open" >&2
  tail -30 "$BASE/tui.log" >&2 || true
  exit 1
fi

PLUGINS=$(curl -s -u "opencode:$PASS" "$URL/api/plugin")
if ! grep -q "ensemble.v2" <<<"$PLUGINS"; then
  echo "live-check: ensemble.v2 is not active" >&2
  exit 1
fi

tmux send-keys -t "$TUI" '~'; sleep 0.5
tmux send-keys -t "$TUI" '?'; sleep 1.5
HELP=$(tmux capture-pane -p -t "$TUI")
if ! grep -q "Keyboard shortcuts" <<<"$HELP"; then
  echo "live-check: leader help did not open" >&2
  tmux capture-pane -p -t "$TUI" >&2 || true
  exit 1
fi

tmux send-keys -t "$TUI" Escape; sleep 0.5

tmux send-keys -t "$TUI" '~'; sleep 0.3
tmux send-keys -t "$TUI" 'q'; sleep 1
HOME_SCREEN=$(tmux capture-pane -p -t "$TUI")
if ! grep -q "Ask anything" <<<"$HOME_SCREEN"; then
  echo "live-check: leaving Ensemble did not return to the native TUI" >&2
  exit 1
fi

echo "live-check: passed ($URL)"
