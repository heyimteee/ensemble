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

EMPTY=$(tmux capture-pane -p -t "$TUI")
if ! grep -q "No currently opened session" <<<"$EMPTY"; then
  echo "live-check: empty chat state was not shown" >&2
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

printf 'live fixture\n' > "$BASE/project/notes.md"
python3 - "$URL" "$PASS" "$BASE/project" > "$BASE/snapshot.json" <<'PY'
import base64, json, sys, urllib.parse, urllib.request
url, password, directory = sys.argv[1:4]
auth = "Basic " + base64.b64encode(f"opencode:{password}".encode()).decode()
body = json.dumps({"input": {"directory": directory}}).encode()
location = urllib.parse.quote(directory, safe="")
request = urllib.request.Request(f"{url}/api/rpc/ensemble.v2/snapshot?location%5Bdirectory%5D={location}", data=body, headers={"Authorization": auth, "Content-Type": "application/json"}, method="POST")
print(json.dumps(json.load(urllib.request.urlopen(request, timeout=20))["output"]))
PY
MODELS=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["models"]))' "$BASE/snapshot.json")
if [ "$MODELS" -gt 0 ]; then
  tmux send-keys -t "$TUI" 'a'; sleep 1
  tmux send-keys -t "$TUI" 'LiveAgent'; sleep 0.3
  tmux send-keys -t "$TUI" Enter; sleep 0.8
  tmux send-keys -t "$TUI" Enter; sleep 0.8
  tmux send-keys -t "$TUI" Enter; sleep 1
  tmux send-keys -t "$TUI" Enter; sleep 1
  VARIANT=$(tmux capture-pane -p -t "$TUI")
  if grep -q "Reasoning effort" <<<"$VARIANT"; then
    tmux send-keys -t "$TUI" Enter; sleep 1
  fi
  sleep 2
  AGENT_SCREEN=$(tmux capture-pane -p -t "$TUI")
  if ! grep -q "LiveAgent" <<<"$AGENT_SCREEN"; then
    echo "live-check: creating an agent did not update the roster" >&2
    tmux capture-pane -p -t "$TUI" >&2 || true
    exit 1
  fi
  if ! grep -q "Direct chat with LiveAgent" <<<"$AGENT_SCREEN"; then
    echo "live-check: creating an agent did not open a direct chat" >&2
    tmux capture-pane -p -t "$TUI" >&2 || true
    exit 1
  fi

  python3 - "$URL" "$PASS" "$BASE/project" "$BASE/ids.json" <<'PY'
import base64, json, sys, urllib.parse, urllib.request
url, password, directory, output = sys.argv[1:5]
auth = "Basic " + base64.b64encode(f"opencode:{password}".encode()).decode()
location = urllib.parse.quote(directory, safe="")
def call(method, payload):
    body = json.dumps({"input": payload}).encode()
    request = urllib.request.Request(f"{url}/api/rpc/ensemble.v2/{method}?location%5Bdirectory%5D={location}", data=body, headers={"Authorization": auth, "Content-Type": "application/json"}, method="POST")
    return json.load(urllib.request.urlopen(request, timeout=20))["output"]
state = call("snapshot", {"directory": directory})["state"]
agent = next(agent for agent in state["agents"].values() if agent["name"] == "LiveAgent")
workspace = call("invoke", {"directory": directory, "action": "workspace.create", "payload": {"name": "live", "directory": directory, "memberIDs": [agent["id"]], "leaderID": agent["id"]}})["result"]
call("invoke", {"directory": directory, "action": "workspace.activate", "payload": {"id": workspace["id"]}})
json.dump({"agent": agent["id"], "workspace": workspace["id"]}, open(output, "w"))
PY
  sleep 2
  tmux send-keys -t "$TUI" 'i'; sleep 0.5
  tmux send-keys -t "$TUI" '$'; sleep 1
  tmux send-keys -t "$TUI" Enter; sleep 0.5
  tmux send-keys -t "$TUI" ' review '; sleep 0.3
  tmux send-keys -t "$TUI" '@'; sleep 1
  tmux send-keys -t "$TUI" 'notes'; sleep 0.5
  tmux send-keys -t "$TUI" Enter; sleep 0.5
  COMPOSER=$(tmux capture-pane -p -t "$TUI")
  if ! grep -q '\$LiveAgent' <<<"$COMPOSER" || ! grep -q '@notes.md' <<<"$COMPOSER"; then
    echo "live-check: composer completions did not insert \$agent and @file" >&2
    tmux capture-pane -p -t "$TUI" >&2 || true
    exit 1
  fi
  tmux send-keys -t "$TUI" C-u; sleep 0.3
  tmux send-keys -t "$TUI" '/'; sleep 1
  COMMAND=$(tmux capture-pane -p -t "$TUI")
  if ! grep -q "Ensemble command" <<<"$COMMAND"; then
    echo "live-check: slash command palette did not open" >&2
    exit 1
  fi
  tmux send-keys -t "$TUI" Escape; sleep 0.5
  tmux send-keys -t "$TUI" Escape; sleep 0.5

  python3 - "$URL" "$PASS" "$BASE/project" "$BASE/ids.json" <<'PY'
import base64, json, sys, urllib.parse, urllib.request
url, password, directory, input_path = sys.argv[1:5]
auth = "Basic " + base64.b64encode(f"opencode:{password}".encode()).decode()
location = urllib.parse.quote(directory, safe="")
ids = json.load(open(input_path))
def invoke(action, payload):
    body = json.dumps({"input": {"directory": directory, "action": action, "payload": payload}}).encode()
    request = urllib.request.Request(f"{url}/api/rpc/ensemble.v2/invoke?location%5Bdirectory%5D={location}", data=body, headers={"Authorization": auth, "Content-Type": "application/json"}, method="POST")
    return json.load(urllib.request.urlopen(request, timeout=20))["output"]
invoke("workspace.delete", {"id": ids["workspace"], "deleteNativeSessions": True})
invoke("agent.delete", {"id": ids["agent"], "deleteNativeSessions": True})
PY
fi

tmux send-keys -t "$TUI" '~'; sleep 0.3
tmux send-keys -t "$TUI" 'q'; sleep 1
HOME_SCREEN=$(tmux capture-pane -p -t "$TUI")
if ! grep -q "Ask anything" <<<"$HOME_SCREEN"; then
  echo "live-check: leaving Ensemble did not return to the native TUI" >&2
  exit 1
fi

echo "live-check: passed ($URL)"
