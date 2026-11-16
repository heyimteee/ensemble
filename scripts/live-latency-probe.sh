#!/usr/bin/env bash
set -euo pipefail

# Reproducible latency budget probe.
#
# Starts the isolated fake host (own HOME, XDG dirs, project, server, TUI) and
# measures three separate things:
#
#   rail        tmux send-keys -> first capture showing the moved rail cursor
#   patchCard   task.delegate RPC -> durable patch -> real Work-card render
#   firstToken  task.delegate RPC -> first visible model reply (report only)
#
# The patch-card fixture is headless and deterministic: it reads the durable
# `changes.since` patch and renders the same pure `workCardForTask` mapping the
# TUI uses. It never waits for a model token, so the fake provider's hold
# cannot dominate the card number.
#
#   npm run test:live:latency                     # smoke profile (default)
#   ENSEMBLE_LATENCY_PROFILE=reference npm run test:live:latency
#   ENSEMBLE_LATENCY_SAMPLES=20 ENSEMBLE_LATENCY_CARD_SAMPLES=10 npm run test:live:latency
#   ENSEMBLE_LATENCY_REGRESSION_MS=1000 npm run test:live:latency
#
# Profiles:
#   reference  rail p95 <= 50ms, patch-card p95 <= 250ms (reference host/nightly)
#   smoke      rail p95 <= 500ms, patch-card p95 <= 5000ms (PR runner)
#   report     summarize only; never gate
#
# A missing prerequisite follows the harness skip behavior; a scenario problem
# exits nonzero. The fixture stays local and never calls a real model.

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
source "$SCRIPT_DIR/lib/live-harness.sh"

live_require_runtime
live_require_node
live_setup "latency"

SAMPLES="${ENSEMBLE_LATENCY_SAMPLES:-10}"
if ! [[ "$SAMPLES" =~ ^[1-9][0-9]*$ ]]; then
  live_fail "ENSEMBLE_LATENCY_SAMPLES must be a positive integer (got: $SAMPLES)"
fi

CARD_SAMPLES="${ENSEMBLE_LATENCY_CARD_SAMPLES:-5}"
if ! [[ "$CARD_SAMPLES" =~ ^[1-9][0-9]*$ ]]; then
  live_fail "ENSEMBLE_LATENCY_CARD_SAMPLES must be a positive integer (got: $CARD_SAMPLES)"
fi

# The report-only fixture uses one unique model reply marker per run. A second
# sample would match the first reply still visible in the transcript.
FIRST_TOKEN_SAMPLES="${ENSEMBLE_LATENCY_FIRST_TOKEN_SAMPLES:-1}"
if ! [[ "$FIRST_TOKEN_SAMPLES" =~ ^[01]$ ]]; then
  live_fail "ENSEMBLE_LATENCY_FIRST_TOKEN_SAMPLES must be 0 or 1 (got: $FIRST_TOKEN_SAMPLES)"
fi

PROFILE="${ENSEMBLE_LATENCY_PROFILE:-smoke}"
case "$PROFILE" in
  reference|smoke|report) ;;
  *) live_fail "ENSEMBLE_LATENCY_PROFILE must be reference, smoke, or report (got: $PROFILE)" ;;
esac

REGRESSION_MS="${ENSEMBLE_LATENCY_REGRESSION_MS:-0}"
if ! [[ "$REGRESSION_MS" =~ ^[0-9]+$ ]]; then
  live_fail "ENSEMBLE_LATENCY_REGRESSION_MS must be a non-negative integer (got: $REGRESSION_MS)"
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

# Build the smallest rail fixture through the public RPC surface: two agent
# rows in the Agents pane, so j/k visibly moves the cursor between them.
live_invoke agent.create '{"name":"ProbeAgent","title":"Latency","role":"Rail latency fixture.","mainModel":{"providerID":"ensemble-fake","modelID":"ensemble-fake-model"}}' >/dev/null
live_wait_for "$LIVE_STEP_TIMEOUT" "ProbeAgent in the snapshot" live_snapshot_has_agent_named "ProbeAgent" \
  || live_fail "latency fixture agent was not created"
live_invoke agent.create '{"name":"ProbeAgent2","title":"Latency","role":"Second rail latency fixture.","mainModel":{"providerID":"ensemble-fake","modelID":"ensemble-fake-model"}}' >/dev/null
live_wait_for "$LIVE_STEP_TIMEOUT" "ProbeAgent2 in the snapshot" live_snapshot_has_agent_named "ProbeAgent2" \
  || live_fail "second latency fixture agent was not created"
probe_agent=$(live_snapshot_value 'Object.values(output.state.agents).filter(function (agent) { return agent.name === "ProbeAgent" })[0]?.id' | tr -d '"')
probe_agent2=$(live_snapshot_value 'Object.values(output.state.agents).filter(function (agent) { return agent.name === "ProbeAgent2" })[0]?.id' | tr -d '"')
[[ -n "$probe_agent" && -n "$probe_agent2" ]] || live_fail "latency fixture agent ids are missing"
live_invoke workspace.create "{\"name\":\"LatencyProbe\",\"memberIDs\":[\"$probe_agent\",\"$probe_agent2\"],\"leaderID\":\"$probe_agent\"}" >/dev/null
live_wait_for "$LIVE_STEP_TIMEOUT" "LatencyProbe in the snapshot" live_snapshot_has_workspace_named "LatencyProbe" \
  || live_fail "latency fixture workspace was not created"
probe_ws=$(live_snapshot_value 'Object.keys(output.state.workspaces)[0]' | tr -d '"')
[[ -n "$probe_ws" && "$probe_ws" != "null" ]] || live_fail "latency fixture workspace id is missing"

live_start_tui
live_wait_for_native_tui
live_open_ensemble
live_require_text "$LIVE_TUI_SESSION" "ProbeAgent" 15 "latency fixture agent row"
live_require_text "$LIVE_TUI_SESSION" "#LatencyProbe" 15 "latency fixture workspace row"

# --- rail keypress -> visible repaint -------------------------------------

# Own the rail cursor explicitly; depending on restored history the page can
# open on chat. Ticket #180: h selects Agents, Enter starts row navigation, and
# the cursor mark renders only while the Agents pane owns interaction.
live_focus_agents_interact "$LIVE_TUI_SESSION"
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Agents" 10 "Agents interaction before sampling"

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
SECOND_AGENT_MARK="${CURSOR_MARK}ProbeAgent2"

wait_for_marker() {
  local marker="$1" seconds="$2"
  live_wait_for "$seconds" "rail cursor at $marker" live_capture_contains "$LIVE_TUI_SESSION" "$marker"
}

if ! wait_for_marker "$AGENT_MARK" 10; then
  # Some hosts restore focus to the composer. Leave the composer and claim the
  # Agents pane explicitly before failing.
  live_focus_agents_interact "$LIVE_TUI_SESSION"
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
      live_fail_timing "rail did not repaint to '$marker' within 10s after '$key'"
    fi
  done
}

samples=()
for ((i = 0; i < SAMPLES; i++)); do
  if (( i % 2 == 0 )); then
    wait_for_marker "$AGENT_MARK" 5 || live_fail "rail cursor left ProbeAgent before sample $((i + 1))"
    measure_key "j" "$SECOND_AGENT_MARK"
    samples+=("$MEASURED_MS")
    wait_for_marker "$SECOND_AGENT_MARK" 5 || live_fail "j did not move the rail cursor to ProbeAgent2"
  else
    wait_for_marker "$SECOND_AGENT_MARK" 5 || live_fail "rail cursor left ProbeAgent2 before sample $((i + 1))"
    measure_key "k" "$AGENT_MARK"
    samples+=("$MEASURED_MS")
    wait_for_marker "$AGENT_MARK" 5 || live_fail "k did not move the rail cursor to ProbeAgent"
  fi
done

live_log "rail keypress-to-repaint raw samples (ms): ${samples[*]}"
live_log "rail measurement boundary: tmux send-keys -> first capture-pane showing the moved cursor"

# --- first visible model reply (report only) ------------------------------

first_token_samples=()
if (( FIRST_TOKEN_SAMPLES > 0 )); then
  # Ticket #180: Workspaces is its own pane; Enter opens #LatencyProbe.
  live_focus_workspaces_interact "$LIVE_TUI_SESSION"
  live_key "$LIVE_TUI_SESSION" Enter
  live_require_text "$LIVE_TUI_SESSION" "Message…" 15 "workspace surface for the first-token probe"

  first_title="latency-first-token-1"
  first_start=$(date +%s%N)
  live_invoke "task.delegate" "{\"workspaceID\":\"$probe_ws\",\"assigneeID\":\"$probe_agent\",\"title\":\"$first_title\",\"instruction\":\"latency-first-token-fixture\",\"mode\":\"research\"}" >/dev/null
  first_rpc_end=$(date +%s%N)
  # The fake provider's short reply is a unique visible model token in this
  # fresh TUI and stays on screen. The marker is report-only; no budget
  # depends on it.
  live_wait_for 30 "first visible model reply" live_capture_contains "$LIVE_TUI_SESSION" "Onboarding complete" \
    || live_fail_timing "first visible model reply did not appear within 30s"
  first_now=$(date +%s%N)
  first_token_samples+=($(( (first_now - first_start) / 1000000 )))
  live_log "first-token: total=$(( (first_now - first_start) / 1000000 ))ms rpc=$(( (first_rpc_end - first_start) / 1000000 ))ms first-visible=$(( (first_now - first_rpc_end) / 1000000 ))ms (report only)"

  first_id=$(live_snapshot_value "Object.values(output.state.subtasks).filter(function (t) { return t.title === \"$first_title\" })[0]?.id" | tr -d '"')
  [[ -n "$first_id" && "$first_id" != "null" ]] || live_fail "first-token fixture task is missing from the snapshot"
  live_invoke "task.cancel" "{\"id\":\"$first_id\"}" >/dev/null
  live_wait_for 15 "first-token card cleared" live_capture_absence "$LIVE_TUI_SESSION" "WORK ACTIVE │ 1 group" \
    || live_fail "first-token card did not clear after cancellation"
fi

# --- patch-card fixture and budget evaluation -----------------------------

result_file="${ENSEMBLE_LATENCY_OUT:-$LIVE_LOGS/latency-result.json}"
mkdir -p "$(dirname "$result_file")"
rail_csv=$(IFS=,; echo "${samples[*]}")
first_csv=""
if (( ${#first_token_samples[@]} > 0 )); then
  first_csv=$(IFS=,; echo "${first_token_samples[*]}")
fi

live_log "patch-card fixture: ${CARD_SAMPLES} sample(s); profile=$PROFILE; deliberate regression=${REGRESSION_MS}ms"
ENSEMBLE_LATENCY_SERVER_URL="$LIVE_SERVER_URL" \
ENSEMBLE_LATENCY_SERVER_PASSWORD="$LIVE_SERVER_PASSWORD" \
ENSEMBLE_LATENCY_DIRECTORY="$LIVE_PROJECT" \
ENSEMBLE_LATENCY_AGENT_ID="$probe_agent" \
ENSEMBLE_LATENCY_WORKSPACE_ID="$probe_ws" \
ENSEMBLE_LATENCY_CARD_SAMPLES="$CARD_SAMPLES" \
ENSEMBLE_LATENCY_RAIL_SAMPLES="$rail_csv" \
ENSEMBLE_LATENCY_FIRST_TOKEN_SAMPLES="$first_csv" \
ENSEMBLE_LATENCY_PROFILE="$PROFILE" \
ENSEMBLE_LATENCY_REGRESSION_MS="$REGRESSION_MS" \
ENSEMBLE_LATENCY_OUT="$result_file" \
  "$LIVE_NODE_BIN" --experimental-strip-types "$LIVE_ROOT/scripts/lib/latency-driver.mjs" \
  || live_fail "patch-card fixture failed"

if ! "$LIVE_NODE_BIN" --experimental-strip-types "$LIVE_ROOT/scripts/latency-budget.mjs" "$result_file"; then
  live_fail "latency budget failed (profile=$PROFILE)"
fi

if (( REGRESSION_MS > 0 )); then
  live_log "deliberate regression injected: ${REGRESSION_MS}ms per patch-card sample"
fi
live_log "latency budget passed (profile=$PROFILE)"
