#!/usr/bin/env bash
set -euo pipefail
if [[ "${ENSEMBLE_LIVE_TRACE_ERR:-0}" == "1" ]]; then
  trap 'printf "live: command failed at line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
fi

# Ticket #127/#166/#172/#173/#177: three-pane size matrix.
#
# This is a targeted live check, not the full nine-scene scenario. The full
# `test:live:fake` scenario is calibrated for its 160x80 default and contains
# viewport-sensitive transcript assertions; this script restarts the TUI at the
# four approved sizes and proves the shell breakpoints, the right Work pane and
# the 80x24 drawer, one full-width card per row at 160x50, compact rows at the
# narrower sizes, spatial `hjkl`, page edges, ACTIVE pagination, the exact right
# edge, and the white/grey Work-card focus border.
#
#   npm run test:live:sizes
#   ENSEMBLE_V6_SIZES="80x24 160x50" npm run test:live:sizes
#
# Each size starts a fresh five-group fixture (one group of three, four groups
# of one) through the public RPC surface, waits for six active tasks, checks the
# layout, then cancels every task before the next size. The default set is
# 80x24, 100x30, 120x40, and 160x50. Linux/tmux only, like the rest of the live
# harness.

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
source "$SCRIPT_DIR/lib/live-harness.sh"

live_require_runtime
live_require_node
live_setup "sizes"

SIZES="${ENSEMBLE_V6_SIZES:-80x24 100x30 120x40 160x50}"

# The size matrix sends five two/one-task groups and then runs layout, focus,
# and page-edge probes. The fixture's lease hold outlives those checks so a
# task never terminalizes mid-measurement.

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

live_active_count_is() {
  [[ "$(active_count)" == "$1" ]]
}

wait_active() {
  local expected="$1" seconds="${2:-$LIVE_STEP_TIMEOUT}"
  live_wait_for "$seconds" "$expected active size tasks" live_active_count_is "$expected" \
    || live_fail "expected $expected active size tasks, found $(active_count)"
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

send_group() {
  local text="$1"
  shift
  local index ids=""
  for index in "$@"; do ids+="\"${AGENT_IDS[$index]}\","; done
  ids="[${ids%,}]"
  live_invoke message.send "{\"workspaceID\":\"$WS_ID\",\"text\":\"$text\",\"recipientIDs\":$ids}" >/dev/null
}

# Five dispatch groups, six tasks: one two-agent group plus four single-agent
# groups. The long hold keeps every task active through a size's checks; the
# rows are cancelled before the next size.
# The size fixture uses the long lease hold so every task stays active across
# the layout, focus, and page-edge probes; cancel_tasks settles each size.
send_fixture() {
  send_group "size-group-a fake-lease-hold" 0 1
  send_group "size-group-b fake-lease-hold" 0
  send_group "size-group-c fake-lease-hold" 0
  send_group "size-group-d fake-lease-hold" 0
  send_group "size-group-e fake-lease-hold" 0
  wait_active 6 30
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

# Focus the Work pane from any Normal surface with the ticket #180 model.
# The right column may be the closed drawer; Space b r reopens it.
focus_work() {
  live_focus_work_interact "$LIVE_TUI_SESSION"
  live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Work list" 10 "Work list interaction"
}

ensure_active_view() {
  focus_work
  if live_capture "$LIVE_TUI_SESSION" | grep -qF "WORK HISTORY │"; then
    live_key "$LIVE_TUI_SESSION" "f"
  fi
  live_require_text "$LIVE_TUI_SESSION" "WORK ACTIVE │" 10 "ACTIVE Work view"
}

# Work-column bounds from the one shared pane model. Content starts after the
# pane border and padding and ends before the right border and padding.
resolve_work_columns() {
  local width="$1"
  "$LIVE_NODE_BIN" --experimental-strip-types -e '
    const { pathToFileURL } = require("node:url");
    import(pathToFileURL(process.argv[1]).href).then((module) => {
      const panes = module.workspacePaneWidths(Number(process.argv[2]));
      const workStart = panes.mode === "drawer"
        ? panes.terminalWidth - panes.workWidth
        : 2 + panes.railWidth + 1 + panes.chatWidth + 1;
      const start = workStart + 2;
      const end = panes.terminalWidth - 3;
      process.stdout.write(`${start} ${end}\n`);
    });
  ' "$LIVE_ROOT/src/v2/tui/workpane.ts" "$width"
}

# Capture only the Work pane's content cells. Node slices by UTF-16 code unit,
# matching terminal cells for the BMP glyphs this pane uses.
WORK_START=0
WORK_END=0
work_pane() {
  local session="${1:-$LIVE_TUI_SESSION}"
  live_capture "$session" | "$LIVE_NODE_BIN" -e '
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { value += chunk });
    process.stdin.on("end", () => {
      const start = Number(process.argv[1]) - 1;
      const end = Number(process.argv[2]);
      const rows = value.split("\n").map((line) => line.slice(start, end).replace(/[▁▂▃▄▅▆▇█]+\s*$/, "").trimEnd());
      process.stdout.write(rows.join("\n"));
    });
  ' "$WORK_START" "$WORK_END"
}

work_row_count() {
  work_pane | { grep -ciE 'sizeagent[0-9]+' || true; }
}

work_card_border_count() {
  work_pane | { grep -oF '╭' || true; } | wc -l | tr -d ' '
}

assert_right_edge() {
  local width="$1"
  local row
  row=$(live_capture "$LIVE_TUI_SESSION" | awk '/WORK (ACTIVE|HISTORY) │/ { print; exit }')
  [[ -n "$row" ]] || live_fail "Work header row is missing at ${width}x?"
  [[ "${#row}" == "$width" ]] || live_fail "capture row is ${#row} cells at ${width} columns"
  [[ "${row:width-2:1}" == "│" ]] \
    || live_fail "Work pane does not end at the last content column at ${width}"
  [[ "${row:width-1:1}" == " " ]] \
    || live_fail "root right padding is missing at ${width}"
}

# Read the SGR colour of the first two Work-card top borders in reading order.
# Ticket #239 renders one full-width card per row, so the focused card and its
# neighbour never share a row. Focused cards are white; unfocused cards grey.
card_border_colors() {
  "$LIVE_TMUX_BIN" capture-pane -e -p -J -t "$LIVE_TUI_SESSION" | "$LIVE_NODE_BIN" -e '
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { value += chunk });
    process.stdin.on("end", () => {
      const start = Number(process.argv[1]);
      const end = Number(process.argv[2]);
      const sgr = /\x1b\[([0-9;]*)m/g;
      const colors = [];
      for (const line of value.split("\n")) {
        let column = 1;
        let fg = "";
        let index = 0;
        while (index < line.length) {
          if (line[index] === "\x1b") {
            sgr.lastIndex = index;
            const match = sgr.exec(line);
            if (match && match.index === index) {
              const parts = match[1].split(";").map(Number);
              if (parts[0] === 38) fg = parts.join(";");
              index = sgr.lastIndex;
              continue;
            }
          }
          if (line[index] === "╭" && column >= start && column <= end) colors.push(fg);
          column += 1;
          index += 1;
        }
        if (colors.length >= 2) {
          process.stdout.write(colors.slice(0, 2).join(","));
          return;
        }
      }
    });
  ' "$WORK_START" "$WORK_END"
}

is_white_color() {
  case "$1" in
    38\;5\;15|38\;5\;231|38\;5\;255|38\;2\;255\;255\;255) return 0 ;;
    *) return 1 ;;
  esac
}

is_grey_color() {
  case "$1" in
    38\;5\;8|38\;5\;232|38\;5\;236|38\;5\;238|38\;5\;240|38\;5\;242) return 0 ;;
    38\;2\;*) return 0 ;;
    *) return 1 ;;
  esac
}

assert_focus_borders() {
  local first_white="$1" colors first second
  colors=$(card_border_colors)
  [[ -n "$colors" ]] || live_fail "could not read Work-card border colours"
  first=$(cut -d, -f1 <<<"$colors")
  second=$(cut -d, -f2 <<<"$colors")
  if [[ "$first_white" == "1" ]]; then
    is_white_color "$first" || live_fail "focused first card border is not white (got $first)"
    is_grey_color "$second" || live_fail "unfocused next card border is not grey (got $second)"
  else
    is_grey_color "$first" || live_fail "unfocused first card border is not grey (got $first)"
    is_white_color "$second" || live_fail "focused second card border is not white (got $second)"
  fi
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

assert_budget_label() {
  local size="$1" want_command="${2:-0}"
  live_capture_matches "$LIVE_TUI_SESSION" "(hops )?0/8" \
    || live_fail "dispatch budget label is missing at $size"
  if [[ "$want_command" == "1" ]]; then
    live_assert_text "$LIVE_TUI_SESSION" "24 left" "command remainder is missing at $size"
  fi
}

run_load_probe_160x50() {
  local pid pct idle_pct
  start_tui_at 160 50
  cancel_tasks
  pid=$(find_tui_pid) || live_fail "could not resolve the TUI opencode process"
  live_log "size matrix: load probe TUI pid=$pid"
  sleep 1.5
  idle_pct=$(measure_cpu_percent "$pid")
  live_log "size matrix: idle TUI cpu=${idle_pct}%"

  live_invoke task.delegate "{\"workspaceID\":\"$WS_ID\",\"assigneeID\":\"${AGENT_IDS[0]}\",\"title\":\"size-load-a\",\"instruction\":\"fake-queue-hold\",\"mode\":\"research\"}" >/dev/null
  wait_active 1
  live_require_text "$LIVE_TUI_SESSION" "WORK ACTIVE │ 1 group · 1 active · 0 done" 20 "one active Work card"
  pct=$(measure_cpu_percent "$pid")
  assert_pane_updates
  live_log "size matrix: 1 working card TUI cpu=${pct}% and tmux output updating"

  live_invoke task.delegate "{\"workspaceID\":\"$WS_ID\",\"assigneeID\":\"${AGENT_IDS[1]}\",\"title\":\"size-load-b\",\"instruction\":\"fake-queue-hold\",\"mode\":\"research\"}" >/dev/null
  wait_active 2
  live_require_text "$LIVE_TUI_SESSION" "WORK ACTIVE │ 2 groups · 2 active · 0 done" 20 "two active Work cards"
  pct=$(measure_cpu_percent "$pid")
  assert_pane_updates
  live_log "size matrix: 2 working cards TUI cpu=${pct}% and tmux output updating"

  live_invoke task.delegate "{\"workspaceID\":\"$WS_ID\",\"assigneeID\":\"${AGENT_IDS[2]}\",\"title\":\"size-load-c\",\"instruction\":\"fake-queue-hold\",\"mode\":\"research\"}" >/dev/null
  wait_active 3
  live_require_text "$LIVE_TUI_SESSION" "WORK ACTIVE │ 3 groups · 3 active · 0 done" 20 "three active Work cards"
  pct=$(measure_cpu_percent "$pid")
  assert_pane_updates
  live_log "size matrix: 3 working cards TUI cpu=${pct}% and tmux output updating"
  cancel_tasks
}

check_spatial_focus() {
  ensure_active_view
  live_require_text "$LIVE_TUI_SESSION" "1/4" 10 "first Work card owns the cursor"
  live_require_text "$LIVE_TUI_SESSION" "page 1/2" 10 "first page holds four one-card rows"
  # Ticket #239: one full-width card per row. h/l have no same-row neighbour;
  # they use the ticket #184 page-edge rule and land on the nearest card.
  live_key "$LIVE_TUI_SESSION" "l"
  live_require_text "$LIVE_TUI_SESSION" "1/2" 10 "l pages forward from the only column"
  live_require_text "$LIVE_TUI_SESSION" "page 2/2" 10 "l advanced the page"
  live_key "$LIVE_TUI_SESSION" "h"
  live_require_text "$LIVE_TUI_SESSION" "1/4" 10 "h pages back to the first card"
  live_require_text "$LIVE_TUI_SESSION" "page 1/2" 10 "h returned to page one"
  live_key "$LIVE_TUI_SESSION" "j"
  live_require_text "$LIVE_TUI_SESSION" "2/4" 10 "j moves to the next full-width card"
  live_key "$LIVE_TUI_SESSION" "k"
  live_require_text "$LIVE_TUI_SESSION" "1/4" 10 "k returns to the first card"
  live_key "$LIVE_TUI_SESSION" "g"
  live_key "$LIVE_TUI_SESSION" "g"
  live_require_text "$LIVE_TUI_SESSION" "1/4" 10 "gg returns to the first card"
  live_key "$LIVE_TUI_SESSION" "G"
  live_require_text "$LIVE_TUI_SESSION" "2/2" 10 "G selects the last of two cards on page two"
  live_require_text "$LIVE_TUI_SESSION" "page 2/2" 10 "the last card lives on page two"
  live_key "$LIVE_TUI_SESSION" "g"
  live_key "$LIVE_TUI_SESSION" "g"
  for _ in $(seq 1 4); do live_key "$LIVE_TUI_SESSION" "j"; done
  live_require_text "$LIVE_TUI_SESSION" "1/2" 10 "j at the page edge moves to the next page"
  live_require_text "$LIVE_TUI_SESSION" "page 2/2" 10 "page edge advanced to page two"
  live_key "$LIVE_TUI_SESSION" "k"
  live_require_text "$LIVE_TUI_SESSION" "4/4" 10 "k at the page edge returns to the previous page"
  live_require_text "$LIVE_TUI_SESSION" "page 1/2" 10 "page edge returned to page one"
  live_key "$LIVE_TUI_SESSION" "g"
  live_key "$LIVE_TUI_SESSION" "g"
  live_key "$LIVE_TUI_SESSION" "l"
  live_require_text "$LIVE_TUI_SESSION" "1/2" 10 "l at the right page edge moves to the next page"
  live_require_text "$LIVE_TUI_SESSION" "page 2/2" 10 "l advanced the page indicator"
  live_key "$LIVE_TUI_SESSION" "h"
  live_require_text "$LIVE_TUI_SESSION" "page 1/2" 10 "h at the left page edge returns to the previous page"
  live_require_text "$LIVE_TUI_SESSION" "1/4" 10 "h lands on the nearest card in the previous page"
  live_key "$LIVE_TUI_SESSION" "g"
  live_key "$LIVE_TUI_SESSION" "g"
  live_require_text "$LIVE_TUI_SESSION" "1/4" 10 "gg returns to the first card before the border probe"
  sleep 0.3
}

check_pane_chrome() {
  local width="$1" colors rail chat work
  # Chat owns the white heading and border; Work and the rail stay muted.
  live_focus_chat "$LIVE_TUI_SESSION"
  live_assert_white_chat_text "$LIVE_TUI_SESSION" "#SizeProbe" "chat heading at ${width}"
  live_assert_grey_text "$LIVE_TUI_SESSION" "WORK ACTIVE" "unfocused Work heading at ${width}"
  colors=$(live_top_border_colors "$LIVE_TUI_SESSION")
  [[ -n "$colors" ]] || live_fail "could not read pane borders at $width"
  IFS=',' read -r rail chat work <<<"$colors"
  [[ -n "$work" ]] || live_fail "expected three pane borders at $width (got $colors)"
  live_color_is_grey "$rail" || live_fail "chat focus left the rail border non-grey at $width (got $rail)"
  live_color_is_white "$chat" || live_fail "focused chat border is not white at $width (got $chat)"
  live_color_is_grey "$work" || live_fail "unfocused Work border is not grey at $width (got $work)"

  # Agents is its own sub-pane: white heading and section border only when it
  # owns selection.
  live_select_pane "$LIVE_TUI_SESSION" agents
  live_assert_white_text "$LIVE_TUI_SESSION" "AGENTS (" "focused Agents heading at ${width}"
  live_assert_grey_text "$LIVE_TUI_SESSION" "WORKSPACES (" "unfocused Workspaces heading at ${width}"
  live_assert_border_above "$LIVE_TUI_SESSION" "AGENTS (" white "focused Agents section border at ${width}"
  live_assert_border_above "$LIVE_TUI_SESSION" "WORKSPACES (" grey "unfocused Workspaces section border at ${width}"

  # Work owns the white heading and right border when selected.
  live_focus_work_interact "$LIVE_TUI_SESSION"
  live_assert_white_text "$LIVE_TUI_SESSION" "WORK ACTIVE" "focused Work heading at ${width}"
  live_assert_grey_chat_text "$LIVE_TUI_SESSION" "#SizeProbe" "unfocused chat heading at ${width}"
  colors=$(live_top_border_colors "$LIVE_TUI_SESSION")
  IFS=',' read -r rail chat work <<<"$colors"
  live_color_is_grey "$rail" || live_fail "Work focus left the rail border non-grey at $width (got $rail)"
  live_color_is_grey "$chat" || live_fail "Work focus left the chat border non-grey at $width (got $chat)"
  live_color_is_white "$work" || live_fail "focused Work border is not white at $width (got $work)"
  live_log "size matrix: ${width}-column pane headings and borders are white focused / grey unfocused"
}

check_size_160x50() {
  ensure_active_view
  live_require_text "$LIVE_TUI_SESSION" "WORK ACTIVE │ 5 groups · 6 active · 0 done │ page 1/2" 20 "five-group Work header at 160x50"
  live_require_text "$LIVE_TUI_SESSION" "GROUP 1 · 2 active · 0 done" 10 "two-card group label"
  live_require_text "$LIVE_TUI_SESSION" "GROUP 3 · 1 active · 0 done" 20 "third group label on the first page"
  # Two cards in group one plus one each in groups two and three fit page one;
  # groups four and five open page two.
  [[ "$(work_card_border_count)" == "4" ]] || live_fail "expected four one-card rows on page one at 160x50, got $(work_card_border_count)"
  assert_budget_label "160x50" 1
  assert_right_edge 160
  check_spatial_focus
  # The first card is focused after gg: white border, grey next card.
  sleep 0.3
  assert_focus_borders 1
  live_key "$LIVE_TUI_SESSION" "j"
  live_require_text "$LIVE_TUI_SESSION" "2/4" 10 "second card owns focus for the border check"
  sleep 0.3
  assert_focus_borders 0
  live_key "$LIVE_TUI_SESSION" "k"
  live_assert_absence "$LIVE_TUI_SESSION" "+1 more" "the Work pane pages instead of an overflow line"
  live_log "size matrix: 160x50 three panes, one card per row, spatial focus, page edges, right edge, and white/grey borders passed"
}

check_size_compact() {
  local size="$1" width="$2" height="$3"
  ensure_active_view
  # The header truncates after the active count on the narrower chat widths.
  live_require_text "$LIVE_TUI_SESSION" "WORK ACTIVE │ 5 groups · 6 active" 20 "five-group compact header at $size"
  [[ "$(work_card_border_count)" == "0" ]] || live_fail "compact Work at $size rendered $([ "$(work_card_border_count)" -gt 0 ] && echo card borders || echo no borders)"
  [[ "$(work_row_count)" == "6" ]] || live_fail "expected six compact Work rows at $size, got $(work_row_count)"
  live_require_text "$LIVE_TUI_SESSION" "GROUP 1 · 2 active · 0 done" 10 "compact group label at $size"
  live_require_text "$LIVE_TUI_SESSION" "page 1/1" 10 "compact page indicator at $size"
  assert_budget_label "$size"
  assert_right_edge "$width"
  ensure_active_view
  live_require_text "$LIVE_TUI_SESSION" "1/6" 10 "first compact row owns the cursor at $size"
  live_key "$LIVE_TUI_SESSION" "j"
  live_require_text "$LIVE_TUI_SESSION" "2/6" 10 "j moves between compact rows at $size"
  live_key "$LIVE_TUI_SESSION" "k"
  live_require_text "$LIVE_TUI_SESSION" "1/6" 10 "k moves back between compact rows at $size"
  # h/l have no card to move to in one compact column; the cursor stays put.
  live_key "$LIVE_TUI_SESSION" "l"
  live_require_text "$LIVE_TUI_SESSION" "1/6" 10 "l keeps the compact cursor at $size"
  live_log "size matrix: $size three panes, compact rows, focus, budget, and right edge passed"
}

check_size_drawer() {
  # Ticket #183: at 80 columns the right pane is a drawer that starts open and
  # its visibility is durable. F3 is retired; Space b r is the only switch.
  live_require_text "$LIVE_TUI_SESSION" "WORK ACTIVE │ 5 groups · 6 active" 20 "drawer starts open at 80x24"
  live_focus_chat "$LIVE_TUI_SESSION"
  live_toggle_pane_side "$LIVE_TUI_SESSION" r
  live_require_absence "$LIVE_TUI_SESSION" "WORK ACTIVE" 10 "Space b r closes the Work drawer"
  live_assert_text "$LIVE_TUI_SESSION" "Message…" "chat and composer fill the closed drawer row"
  live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Group chat" 10 "closing the drawer returns to chat selection"
  live_key "$LIVE_TUI_SESSION" F3
  sleep 0.5
  live_assert_absence "$LIVE_TUI_SESSION" "WORK ACTIVE" "F3 no longer opens the Work drawer"

  # Durability: the closed drawer survives a TUI restart; reopening returns to
  # select mode, then Enter starts card navigation.
  start_tui_at 80 24
  live_require_absence "$LIVE_TUI_SESSION" "WORK ACTIVE" 20 "closed drawer persisted across restart"
  live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Group chat" 10 "restored drawer layout keeps chat selected"
  live_toggle_pane_side "$LIVE_TUI_SESSION" r
  live_require_text "$LIVE_TUI_SESSION" "WORK ACTIVE │ 5 groups · 6 active" 20 "Space b r reopens the Work drawer"
  live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Work list" 10 "reopened drawer selects Work without entering"
  live_assert_text "$LIVE_TUI_SESSION" "h/l column" "reopened drawer stays in select mode"
  live_assert_white_text "$LIVE_TUI_SESSION" "WORK ACTIVE" "focused drawer heading at 80"
  live_key "$LIVE_TUI_SESSION" Enter
  live_require_text "$LIVE_TUI_SESSION" "page 1/2" 10 "drawer pages its compact body"
  [[ "$(work_card_border_count)" == "0" ]] || live_fail "drawer rendered card borders at 80x24"
  [[ "$(work_row_count)" == "5" ]] || live_fail "expected five drawer rows on page one at 80x24, got $(work_row_count)"
  live_assert_text "$LIVE_TUI_SESSION" "SizeAgent1" "drawer rows keep the agent name"
  live_require_text "$LIVE_TUI_SESSION" "1/5" 10 "first drawer row owns the cursor"
  live_key "$LIVE_TUI_SESSION" "j"
  live_require_text "$LIVE_TUI_SESSION" "2/5" 10 "j moves between drawer rows"
  # A page edge advances the drawer by keyboard.
  live_key "$LIVE_TUI_SESSION" "g"
  live_key "$LIVE_TUI_SESSION" "g"
  for _ in $(seq 1 10); do live_key "$LIVE_TUI_SESSION" "j"; done
  live_require_text "$LIVE_TUI_SESSION" "page 2/2" 10 "drawer j crosses the page edge"
  # Ticket #185/#186: the full approvals surface uses the same right column in
  # the narrow drawer. Pending resolution is exercised at 160×80; here the
  # drawer geometry, full-height replacement, and focus colour are proven on
  # the empty inbox so the active size fixture cannot queue the ask.
  live_focus_chat "$LIVE_TUI_SESSION"
  live_key "$LIVE_TUI_SESSION" "v"
  live_require_text "$LIVE_TUI_SESSION" "APPROVALS 0 pending" 10 "v opens full approvals in the drawer"
  live_assert_absence "$LIVE_TUI_SESSION" "WORK ACTIVE" "drawer full approvals cover Work"
  live_assert_white_text "$LIVE_TUI_SESSION" "APPROVALS 0 pending" "focused drawer approvals heading"
  live_key "$LIVE_TUI_SESSION" Escape
  live_require_text "$LIVE_TUI_SESSION" "WORK ACTIVE" 10 "Esc returns the drawer to split mode"
  live_toggle_pane_side "$LIVE_TUI_SESSION" r
  live_require_absence "$LIVE_TUI_SESSION" "WORK ACTIVE" 10 "Space b r closes the reopened drawer"
  live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Group chat" 10 "closing the drawer returns focus to the chat"
  # Leave the durable switch open for the wider sizes in the same run.
  live_toggle_pane_side "$LIVE_TUI_SESSION" r
  live_require_text "$LIVE_TUI_SESSION" "WORK ACTIVE" 10 "drawer reopened for the remaining sizes"
  live_log "size matrix: 80x24 drawer open-by-default, Space b r, F3 removal, durability, rows, page edge, and focus passed"
}

check_size() {
  local size="$1" width height
  width="${size%x*}"
  height="${size#*x}"
  start_tui_at "$width" "$height"
  cancel_tasks
  IFS=' ' read -r WORK_START WORK_END < <(resolve_work_columns "$width")
  # Read the pane chrome before the timing-sensitive fixture starts; the
  # hold tasks must still be active when the functional checks begin.
  if (( width >= 96 )); then
    check_pane_chrome "$width"
  fi
  send_fixture
  case "$size" in
    160x50) check_size_160x50 ;;
    120x40|100x30) check_size_compact "$size" "$width" "$height" ;;
    80x24) check_size_drawer ;;
    *) live_fail "unsupported size $size" ;;
  esac
  cancel_tasks
  live_log "size matrix: $size fixture cancelled"
}

check_no_color_static() {
  live_tmux_env_add "NO_COLOR=1"
  start_tui_at 120 40
  cancel_tasks
  send_group "size-no-color fake-queue-hold" 0
  wait_active 1
  live_wait_for 20 "NO_COLOR frame-0 Work row" live_capture_matches "$LIVE_TUI_SESSION" "[Ss]izeAgent[0-9]+.*⠋ WORKING"
  live_assert_text "$LIVE_TUI_SESSION" "WORKING" "NO_COLOR keeps the state word"
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
}

if [[ "${ENSEMBLE_V6_SKIP_LOAD:-0}" != "1" ]]; then
  run_load_probe_160x50
fi
for size in $SIZES; do
  check_size "$size"
done
check_no_color_static

live_log "three-pane size matrix complete (${SIZES})"
