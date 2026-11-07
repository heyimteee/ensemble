#!/usr/bin/env bash
set -euo pipefail

# Reproducible keypress-to-repaint latency probe.
#
# Starts the isolated fake host (own HOME, XDG dirs, project, server, TUI),
# creates one agent and one workspace, then times `j`/`k` on the rail cursor:
# from `tmux send-keys` until a pane capture first shows the cursor on the
# target row. The measurement crosses the same tmux boundary used by the live
# checks, so it includes tmux send/capture overhead (roughly a few ms), not
# just host render time.
#
#   npm run test:live:latency
#   ENSEMBLE_LATENCY_SAMPLES=20 npm run test:live:latency
#
# This is a measurement, not a pass/fail gate. A missing prerequisite follows
# the harness skip behavior; a scenario problem exits nonzero. The fixture
# stays local and never calls a real model.

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
source "$SCRIPT_DIR/lib/live-harness.sh"

live_require_runtime
live_require_node
live_setup "latency"

SAMPLES="${ENSEMBLE_LATENCY_SAMPLES:-10}"
if ! [[ "$SAMPLES" =~ ^[1-9][0-9]*$ ]]; then
  live_fail "ENSEMBLE_LATENCY_SAMPLES must be a positive integer (got: $SAMPLES)"
fi

ENSEMBLE_LIVE_TUI_WIDTH="${ENSEMBLE_LIVE_TUI_WIDTH:-140}"
ENSEMBLE_LIVE_TUI_HEIGHT="${ENSEMBLE_LIVE_TUI_HEIGHT:-50}"
export ENSEMBLE_LIVE_TUI_WIDTH ENSEMBLE_LIVE_TUI_HEIGHT

live_start_fake_provider

live_write_config <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "plugins": ["$LIVE_ROOT"],
  "model": "ensemble-fake/ensemble-fake-model",
  "enabled_providers": ["ensemble-fake"],
  "providers": {
    "ensemble-fake": {
      "name": "Ensemble Fake",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "$LIVE_FAKE_URL/v1"
      },
      "models": {
        "ensemble-fake-model": {
          "name": "Ensemble Fake Model",
          "modelID": "ensemble-fake-model",
          "capabilities": { "tools": true, "input": ["text"], "output": ["text"] },
          "limit": { "context": 100000, "output": 4096 },
          "variants": [{ "id": "low" }, { "id": "medium" }, { "id": "high" }]
        }
      }
    }
  }
}
EOF

live_tmux_env_add "OPENCODE_DISABLE_MODELS_FETCH=1"
live_tmux_env_add "OPENCODE_DISABLE_FREE_MODELS=1"
live_start_server
live_check_plugin

# Build the smallest rail fixture through the public RPC surface: one agent
# row and one workspace row, so j/k visibly moves the cursor between them.
live_invoke agent.create '{"name":"ProbeAgent","title":"Latency","role":"Rail latency fixture.","mainModel":{"providerID":"ensemble-fake","modelID":"ensemble-fake-model"}}' >/dev/null
live_wait_for "$LIVE_STEP_TIMEOUT" "ProbeAgent in the snapshot" live_snapshot_has_agent_named "ProbeAgent" \
  || live_fail "latency fixture agent was not created"
probe_agent=$(live_snapshot_value 'Object.values(output.state.agents).filter(function (agent) { return agent.name === "ProbeAgent" })[0]?.id' | tr -d '"')
[[ -n "$probe_agent" ]] || live_fail "latency fixture agent id is missing"
live_invoke workspace.create "{\"name\":\"LatencyProbe\",\"memberIDs\":[\"$probe_agent\"],\"leaderID\":\"$probe_agent\"}" >/dev/null
live_wait_for "$LIVE_STEP_TIMEOUT" "LatencyProbe in the snapshot" live_snapshot_has_workspace_named "LatencyProbe" \
  || live_fail "latency fixture workspace was not created"
probe_ws=$(live_snapshot_value 'Object.keys(output.state.workspaces)[0]' | tr -d '"')
[[ -n "$probe_ws" && "$probe_ws" != "null" ]] || live_fail "latency fixture workspace id is missing"

live_start_tui
live_wait_for_native_tui
live_open_ensemble
live_require_text "$LIVE_TUI_SESSION" "ProbeAgent" 15 "latency fixture agent row"
live_require_text "$LIVE_TUI_SESSION" "#LatencyProbe" 15 "latency fixture workspace row"

# Own the rail cursor explicitly; depending on restored history the page can
# open on chat. `h` is the Normal rail-column key in both roster and chat.
live_key "$LIVE_TUI_SESSION" "h"
live_require_text "$LIVE_TUI_SESSION" "ProbeAgent" 10 "rail visible before sampling"

# Read the rail cursor marker from the TUI helper rather than restating its
# literal here. It renders only on the surface that owns the focus border.
CURSOR_MARK=$("$LIVE_NODE_BIN" --experimental-strip-types -e '
  const { pathToFileURL } = require("node:url");
  import(pathToFileURL(process.argv[1]).href).then((module) => {
    process.stdout.write(module.settingsCursorMark(true));
  });
' "$LIVE_ROOT/src/v2/tui/settings.ts") || live_fail "could not read settingsCursorMark"
[[ -n "$CURSOR_MARK" ]] || live_fail "settingsCursorMark returned an empty marker"
AGENT_MARK="${CURSOR_MARK}ProbeAgent"
WORKSPACE_MARK="${CURSOR_MARK}#LatencyProbe"

wait_for_marker() {
  local marker="$1" seconds="$2"
  live_wait_for "$seconds" "rail cursor at $marker" live_capture_contains "$LIVE_TUI_SESSION" "$marker"
}

if ! wait_for_marker "$AGENT_MARK" 10; then
  # Some hosts restore focus to the composer. Leave Insert/chat deliberately,
  # then claim the rail once more before failing.
  live_key "$LIVE_TUI_SESSION" C-g
  sleep 0.25
  live_key "$LIVE_TUI_SESSION" "h"
  wait_for_marker "$AGENT_MARK" 10 \
    || live_fail "could not observe the rail cursor before sampling"
fi

# Time one settled keypress. Poll short captures until the target marker is
# visible; the timeout is diagnostic, not a latency threshold. The result is
# assigned to MEASURED_MS so callers stay in this shell (a command substitution
# would turn live_fail into a subshell exit).
MEASURED_MS=""
measure_key() {
  local key="$1" marker="$2"
  local start now
  start=$(date +%s%N)
  "$LIVE_TMUX_BIN" send-keys -t "$LIVE_TUI_SESSION" "$key"
  while true; do
    if live_capture "$LIVE_TUI_SESSION" | grep -qF -- "$marker"; then
      now=$(date +%s%N)
      MEASURED_MS=$(( (now - start) / 1000000 ))
      return 0
    fi
    now=$(date +%s%N)
    if (( now - start > 10000000000 )); then
      live_fail "rail did not repaint to '$marker' within 10s after '$key'"
    fi
  done
}

samples=()
for ((i = 0; i < SAMPLES; i++)); do
  if (( i % 2 == 0 )); then
    wait_for_marker "$AGENT_MARK" 5 || live_fail "rail cursor left ProbeAgent before sample $((i + 1))"
    measure_key "j" "$WORKSPACE_MARK"
    samples+=("$MEASURED_MS")
    wait_for_marker "$WORKSPACE_MARK" 5 || live_fail "j did not move the rail cursor to the workspace"
  else
    wait_for_marker "$WORKSPACE_MARK" 5 || live_fail "rail cursor left #LatencyProbe before sample $((i + 1))"
    measure_key "k" "$AGENT_MARK"
    samples+=("$MEASURED_MS")
    wait_for_marker "$AGENT_MARK" 5 || live_fail "k did not move the rail cursor to the agent"
  fi
done

summary=$(
  printf '%s\n' "${samples[@]}" | sort -n | awk '
    { values[NR] = $1; total += $1 }
    END {
      n = NR
      p50 = values[int((n + 1) / 2)]
      p95 = values[int((n * 95 + 99) / 100)]
      printf "min=%dms p50=%dms p95=%dms max=%dms mean=%.1fms n=%d", values[1], p50, p95, values[n], total / n, n
    }
  '
)

live_log "rail keypress-to-repaint latency: $summary"
live_log "raw samples (ms): ${samples[*]}"
live_log "measurement boundary: tmux send-keys -> first capture-pane showing the moved cursor"

# v7 delegation-card appearance (ticket #138, final verification #143): time
# from the task.delegate RPC to the first capture showing the Work card title.
# This crosses the same tmux boundary as the rail probe and exercises the
# durable patch path; it is a measurement, not a threshold. Each sample is a
# separate dispatch group, cancelled and held out before the next sample.
live_key "$LIVE_TUI_SESSION" "j"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Message…" 15 "workspace surface for the card probe"
CARD_SAMPLES="${ENSEMBLE_LATENCY_CARD_SAMPLES:-5}"
if ! [[ "$CARD_SAMPLES" =~ ^[1-9][0-9]*$ ]]; then
  live_fail "ENSEMBLE_LATENCY_CARD_SAMPLES must be a positive integer (got: $CARD_SAMPLES)"
fi

CARD_MEASURED_MS=""
measure_card() {
  local title="$1" start now pane task_id lines
  start=$(date +%s%N)
  live_invoke "task.delegate" "{\"workspaceID\":\"$probe_ws\",\"assigneeID\":\"$probe_agent\",\"title\":\"$title\",\"instruction\":\"fake-queue-hold\",\"mode\":\"research\"}" >/dev/null
  while true; do
    pane=$(live_capture "$LIVE_TUI_SESSION")
    lines=$(grep -F -- "$title" <<<"$pane" | grep -vF "Assigned to" || true)
    if [[ -n "$lines" ]]; then
      now=$(date +%s%N)
      CARD_MEASURED_MS=$(( (now - start) / 1000000 ))
      break
    fi
    now=$(date +%s%N)
    if (( now - start > 10000000000 )); then
      live_fail "Work card for '$title' did not appear within 10s after task.delegate"
    fi
  done
  task_id=$(live_snapshot_value "Object.values(output.state.subtasks).filter(function (t) { return t.title === \"$title\" })[0]?.id" | tr -d '"')
  [[ -n "$task_id" && "$task_id" != "null" ]] || live_fail "card probe task '$title' is missing from the snapshot"
  live_invoke "task.cancel" "{\"id\":\"$task_id\"}" >/dev/null
  live_wait_for 15 "card probe group cleared" live_capture_absence "$LIVE_TUI_SESSION" "WORK 1 group" \
    || live_fail "card probe group did not clear after cancellation"
}

card_samples=()
for ((i = 0; i < CARD_SAMPLES; i++)); do
  measure_card "latency-card-$((i + 1))"
  card_samples+=("$CARD_MEASURED_MS")
done

card_summary=$(
  printf '%s\n' "${card_samples[@]}" | sort -n | awk '
    { values[NR] = $1; total += $1 }
    END {
      n = NR
      p50 = values[int((n + 1) / 2)]
      p95 = values[int((n * 95 + 99) / 100)]
      printf "min=%dms p50=%dms p95=%dms max=%dms mean=%.1fms n=%d", values[1], p50, p95, values[n], total / n, n
    }
  '
)
live_log "delegation-card appearance latency: $card_summary"
live_log "raw card samples (ms): ${card_samples[*]}"
live_log "card measurement boundary: task.delegate RPC invoke -> first capture-pane showing the Work card title"
live_log "latency probe complete (measurement only; no threshold gate)"
