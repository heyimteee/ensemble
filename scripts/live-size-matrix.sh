#!/usr/bin/env bash
set -euo pipefail

# Ticket #127: v6 Work-card size matrix plus the 1/2/3-working-card load probe.
#
# This is a targeted live check, not the full nine-scene scenario. The full
# `test:live:fake` scenario is calibrated for its 160x80 default and contains
# viewport-sensitive transcript assertions; this script exercises the Work
# card layout at the four approved sizes in an isolated fake host. It records
# observed CPU and tmux output for one, two, and three working cards, and
# proves NO_COLOR freezes live motion while preserving state text.
#
#   npm run test:live:sizes
#   ENSEMBLE_V6_SIZES="80x24 160x50" npm run test:live:sizes
#
# Each size restarts the TUI at that geometry, delegates one long-running fake
# task to each of three agents, asserts the visible card/compact layout,
# overflow line, focus ownership, and composer, then cancels the tasks and
# waits out the eight-second recent-card window. The default size set is
# 80x24, 100x30, 120x40, and 160x50. Linux/tmux only, like the rest of the
# live harness.

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
source "$SCRIPT_DIR/lib/live-harness.sh"

live_require_runtime
live_require_node
live_setup "sizes"

SIZES="${ENSEMBLE_V6_SIZES:-80x24 100x30 120x40 160x50}"

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
live_wait_for_model "ensemble-fake" "ensemble-fake-model"

AGENT_IDS=()
for name in SizeAgent1 SizeAgent2 SizeAgent3; do
  live_invoke agent.create "{\"name\":\"$name\",\"title\":\"Size matrix\",\"role\":\"Work card size fixture.\",\"mainModel\":{\"providerID\":\"ensemble-fake\",\"modelID\":\"ensemble-fake-model\"}}" >/dev/null
  live_wait_for "$LIVE_STEP_TIMEOUT" "$name in the snapshot" live_snapshot_has_agent_named "$name" \
    || live_fail "size fixture agent $name was not created"
  agent_id=$(live_snapshot_value "Object.values(output.state.agents).find(function (agent) { return agent.name === \"$name\" }).id" | tr -d '"')
  [[ -n "$agent_id" ]] || live_fail "size fixture agent $name id is missing"
  AGENT_IDS+=("$agent_id")
done

live_invoke workspace.create "{\"name\":\"SizeProbe\",\"memberIDs\":[\"${AGENT_IDS[0]}\",\"${AGENT_IDS[1]}\",\"${AGENT_IDS[2]}\"],\"leaderID\":\"${AGENT_IDS[0]}\"}" >/dev/null
live_wait_for "$LIVE_STEP_TIMEOUT" "SizeProbe in the snapshot" live_snapshot_has_workspace_named "SizeProbe" \
  || live_fail "size fixture workspace was not created"
WS_ID=$(live_snapshot_value 'Object.values(output.state.workspaces).find(function (workspace) { return workspace.name === "SizeProbe" }).id' | tr -d '"')
[[ -n "$WS_ID" ]] || live_fail "size fixture workspace id is missing"

active_count() {
  live_snapshot_value "Object.values(output.state.subtasks).filter(function (task) { return task.workspaceID === \"$WS_ID\" && task.state !== \"replied\" }).length" | tr -d '"'
}

card_header_count() {
  live_capture "$LIVE_TUI_SESSION" | grep -oE 'SIZE[^ ]* WORKING' | wc -l
}

live_active_count_is() {
  [[ "$(active_count)" == "$1" ]]
}

wait_active() {
  local expected="$1" seconds="${2:-$LIVE_STEP_TIMEOUT}"
  live_wait_for "$seconds" "$expected active size tasks" live_active_count_is "$expected" \
    || live_fail "expected $expected active size tasks, found $(active_count)"
}

delegate() {
  local agent_index="$1" title="$2"
  live_invoke task.delegate "{\"workspaceID\":\"$WS_ID\",\"assigneeID\":\"${AGENT_IDS[$agent_index]}\",\"title\":\"$title\",\"instruction\":\"fake-queue-hold\",\"mode\":\"research\"}" >/dev/null
}

cancel_tasks() {
  local ids id
  local -a id_list=()
  ids=$(live_snapshot_value "Object.values(output.state.subtasks).filter(function (task) { return task.workspaceID === \"$WS_ID\" && task.state !== \"replied\" }).map(function (task) { return task.id }).join(\",\")" | tr -d '"')
  [[ -n "$ids" ]] || return 0
  IFS=',' read -r -a id_list <<<"$ids"
  for id in "${id_list[@]}"; do
    live_invoke task.cancel "{\"id\":\"$id\"}" >/dev/null || true
  done
  live_wait_for 20 "size tasks terminal" live_active_count_is "0" || true
}

start_tui_at() {
  local width="$1" height="$2"
  "$LIVE_TMUX_BIN" kill-session -t "$LIVE_TUI_SESSION" 2>/dev/null || true
  export ENSEMBLE_LIVE_TUI_WIDTH="$width" ENSEMBLE_LIVE_TUI_HEIGHT="$height"
  live_start_tui
  live_wait_for_native_tui
  live_open_ensemble
  live_require_text "$LIVE_TUI_SESSION" "#SizeProbe" 20 "SizeProbe workspace surface at ${width}x${height}"
}

focus_work_list() {
  live_key "$LIVE_TUI_SESSION" C-g
  local attempt
  for attempt in 1 2 3; do
    if live_capture "$LIVE_TUI_SESSION" | grep -qF "NORMAL  │ Work list"; then return 0; fi
    live_key "$LIVE_TUI_SESSION" Tab
    sleep 0.35
  done
  live_fail "could not focus the Work list"
}

tui_cpu_ticks() {
  "$LIVE_NODE_BIN" -e '
    const fs = require("fs");
    const stat = fs.readFileSync(`/proc/${process.argv[1]}/stat`, "utf8");
    const rest = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    process.stdout.write(String(Number(rest[11]) + Number(rest[12])));
  ' "$1"
}

find_tui_pid() {
  local pid args
  for pid in $(pgrep -f "opencode" 2>/dev/null); do
    args=$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)
    if [[ "$args" == *"--server $LIVE_SERVER_URL"* && "$args" != *" serve "* ]]; then
      printf '%s\n' "$pid"
      return 0
    fi
  done
  return 1
}

measure_cpu_percent() {
  local pid="$1" seconds="${2:-0.9}" start end hz
  hz=$(getconf CLK_TCK)
  start=$(tui_cpu_ticks "$pid")
  sleep "$seconds"
  end=$(tui_cpu_ticks "$pid")
  awk -v d=$((end - start)) -v hz="$hz" -v s="$seconds" 'BEGIN { printf "%.1f", (d / hz) / s * 100 }'
}

assert_pane_updates() {
  local first second
  first=$(live_capture "$LIVE_TUI_SESSION")
  sleep 0.45
  second=$(live_capture "$LIVE_TUI_SESSION")
  [[ "$first" != "$second" ]] || live_fail "tmux pane did not update while work cards were live"
}

run_load_probe_160x50() {
  local pid pct
  start_tui_at 160 50
  pid=$(find_tui_pid) || live_fail "could not resolve the TUI opencode process"
  live_log "size matrix: load probe TUI pid=$pid"

  delegate 0 "size-load-a"
  wait_active 1
  live_require_text "$LIVE_TUI_SESSION" "WORK 1 active" 20 "one active Work card"
  pct=$(measure_cpu_percent "$pid")
  assert_pane_updates
  live_log "size matrix: 1 working card TUI cpu=${pct}% and tmux output updating"

  delegate 1 "size-load-b"
  wait_active 2
  live_require_text "$LIVE_TUI_SESSION" "WORK 2 active" 20 "two active Work cards"
  pct=$(measure_cpu_percent "$pid")
  assert_pane_updates
  live_log "size matrix: 2 working cards TUI cpu=${pct}% and tmux output updating"

  delegate 2 "size-load-c"
  wait_active 3
  live_require_text "$LIVE_TUI_SESSION" "WORK 3 active" 20 "three active Work cards"
  pct=$(measure_cpu_percent "$pid")
  assert_pane_updates
  live_log "size matrix: 3 working cards TUI cpu=${pct}% and tmux output updating"
  cancel_tasks
  sleep 8.3
}

check_size() {
  local size="$1" width height
  width="${size%x*}"
  height="${size#*x}"
  start_tui_at "$width" "$height"
  local a="size-${size}-a" b="size-${size}-b" c="size-${size}-c"
  delegate 0 "$a"
  delegate 1 "$b"
  delegate 2 "$c"
  wait_active 3
  live_require_text "$LIVE_TUI_SESSION" "WORK 3 active · 0 recent" 20 "Work header at $size"
  live_assert_text "$LIVE_TUI_SESSION" "Message…" "composer remains visible at $size"

  case "$size" in
    160x50|120x40)
      [[ "$(card_header_count)" == "3" ]] || live_fail "expected three Work card headers at $size, got $(card_header_count)"
      live_assert_absence "$LIVE_TUI_SESSION" "+1 more" "no card overflow at $size"
      live_assert_absence "$LIVE_TUI_SESSION" "+2 more" "no compact overflow at $size"
      live_assert_text "$LIVE_TUI_SESSION" "d delegate" "card action hints at $size"
      ;;
    100x30)
      [[ "$(card_header_count)" == "2" ]] || live_fail "expected two Work card headers at $size, got $(card_header_count)"
      live_assert_text "$LIVE_TUI_SESSION" "+1 more" "overflow names the hidden card at $size"
      live_assert_text "$LIVE_TUI_SESSION" "d delegate" "card action hints at $size"
      ;;
    80x24)
      live_capture_matches "$LIVE_TUI_SESSION" "$a │ SizeAgent1 │ working" || live_fail "compact active row missing at $size"
      [[ "$(card_header_count)" == "0" ]] || live_fail "compact fallback rendered card headers at $size"
      live_assert_text "$LIVE_TUI_SESSION" "WORK 3 active · 0 recent │ +2 more" "compact header names two hidden rows at $size"
      live_assert_absence "$LIVE_TUI_SESSION" "d delegate" "compact fallback omits card hints at $size"
      ;;
    *) live_fail "unsupported size $size" ;;
  esac

  focus_work_list
  if [[ "$size" == "80x24" ]]; then
    live_capture_matches "$LIVE_TUI_SESSION" "› .*$a" || live_fail "compact Work row did not take the cursor at $size"
  else
    live_capture_matches "$LIVE_TUI_SESSION" "› .*SizeAgent1" || live_fail "first Work card did not take the cursor at $size"
  fi
  live_key "$LIVE_TUI_SESSION" Escape
  live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Group chat" 10 "Esc leaves the Work list at $size"
  live_log "size matrix: $size Work fit, overflow, focus, and composer checks passed"

  cancel_tasks
  sleep 8.3
}

check_no_color_static() {
  live_tmux_env_add "NO_COLOR=1"
  start_tui_at 120 40
  delegate 0 "size-no-color"
  wait_active 1
  live_require_text "$LIVE_TUI_SESSION" "⠋ SIZEAGENT1 WORKING" 20 "NO_COLOR frame-0 Work card"
  live_assert_text "$LIVE_TUI_SESSION" "working" "NO_COLOR keeps the state word"
  live_assert_text "$LIVE_TUI_SESSION" "Message…" "NO_COLOR keeps the composer"
  local pane glyph
  for _ in $(seq 1 8); do
    pane=$(live_capture "$LIVE_TUI_SESSION")
    for glyph in "⠙" "⠹" "⠸" "⠼" "⠴" "⠦" "⠧" "⠇" "⠏"; do
      grep -qF -- "$glyph" <<<"$pane" && live_fail "NO_COLOR run animated (saw $glyph)"
    done
    sleep 0.3
  done
  live_log "NO_COLOR=1 kept frame-0 glyphs and state text while work was live"
  cancel_tasks
  sleep 8.3
}

run_load_probe_160x50
for size in $SIZES; do
  check_size "$size"
done
check_no_color_static

live_log "v6 size matrix complete (${SIZES})"
