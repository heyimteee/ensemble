#!/usr/bin/env bash
# Shared helpers for Ensemble live TUI checks.
#
# Source this file from a scenario:
#
#   source "$(dirname "$0")/lib/live-harness.sh"
#
# The library owns:
#   - resolution of the opencode, tmux, and node binaries
#   - isolated HOME/config/data/state/project/log directories
#   - fake-provider, OpenCode server, and TUI tmux sessions
#   - condition waits, keystrokes, pane capture, assertions
#   - failure context and cleanup, with ENSEMBLE_LIVE_KEEP=1 preserve mode
#   - failure-only artifact retention for CI uploads
#
# Scenarios must call live_require_runtime (and live_require_node when they
# need Node) before live_setup, and live_setup before any live_start_* helper.
# Linux-first by design because it uses tmux.
#
# Set ENSEMBLE_LIVE_REQUIRE=1 to turn a missing prerequisite into a failure.
# Local runs keep the historical skip-and-exit-zero behavior; CI uses require
# mode so a skipped suite cannot look green.
#
# Set ENSEMBLE_LIVE_FAILURE_ARTIFACTS=<dir> to retain a redacted diagnostic set
# under <dir>/<scenario> when a run fails. The temporary tree is still removed.
# ENSEMBLE_LIVE_KEEP=1 remains the full local preserve mode.

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  echo "live-harness: source this file; do not execute it" >&2
  exit 2
fi

LIVE_WAIT_INTERVAL="${ENSEMBLE_LIVE_WAIT_INTERVAL:-0.1}"
LIVE_START_TIMEOUT="${ENSEMBLE_LIVE_START_TIMEOUT:-30}"
LIVE_TUI_TIMEOUT="${ENSEMBLE_LIVE_TUI_TIMEOUT:-60}"
LIVE_STEP_TIMEOUT="${ENSEMBLE_LIVE_STEP_TIMEOUT:-20}"
LIVE_BASE=""
LIVE_ROOT=""
LIVE_KIND=""
LIVE_EXIT_STATUS=""
LIVE_CONFIG=""
LIVE_DATA=""
LIVE_STATE=""
LIVE_PROJECT=""
LIVE_HOME=""
LIVE_LOGS=""
LIVE_FAKE_URL_FILE=""
LIVE_FAKE_URL=""
LIVE_SERVER_URL=""
LIVE_SERVER_PASSWORD=""
LIVE_OPENCODE_BIN=""
LIVE_TMUX_BIN=""
LIVE_NODE_BIN=""
LIVE_SESSION_NAMES=()
LIVE_PROCESS_ENV=()
LIVE_SKIP_MARKER="${ENSEMBLE_LIVE_SKIP_MARKER:-}"

live_log() { printf 'live: %s\n' "$*"; }
live_debug() { [[ "${ENSEMBLE_LIVE_DEBUG:-0}" == "1" ]] && printf 'live: %s\n' "$*" >&2 || true; }
live_require_enabled() { [[ "${ENSEMBLE_LIVE_REQUIRE:-0}" == "1" ]]; }
# Local runs keep the skip contract. Require mode (CI) treats the same missing
# prerequisite as a hard failure instead of exiting zero. When a caller sets
# ENSEMBLE_LIVE_SKIP_MARKER, the local path also records the skip structurally
# so an aggregate runner never has to scrape log text.
live_skip() {
  if live_require_enabled; then
    live_fail "$* (required; ENSEMBLE_LIVE_REQUIRE=1)"
  fi
  if [[ -n "$LIVE_SKIP_MARKER" ]]; then
    : >"$LIVE_SKIP_MARKER" || live_fail "could not write skip marker: $LIVE_SKIP_MARKER"
  fi
  live_log "$*; skipping"
  exit 0
}
live_fail() { printf 'live: %s\n' "$*" >&2; exit 1; }

# Resolve the absolute binary. The nvm installation is preferred over the
# ~/.local/bin wrapper because the wrapper reads $HOME/.nvm and would break
# under an isolated HOME.
live_resolve_opencode() {
  local candidate
  if [[ -n "${OPENCODE_BIN:-}" ]]; then
    [[ -x "$OPENCODE_BIN" ]] || return 1
    printf '%s\n' "$OPENCODE_BIN"
    return 0
  fi
  if [[ -n "${HOME:-}" ]] && compgen -G "$HOME/.nvm/versions/node/*/bin/opencode" >/dev/null; then
    candidate=$(ls -d "$HOME"/.nvm/versions/node/*/bin/opencode 2>/dev/null | sort -Vr | head -n1)
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  fi
  if candidate=$(command -v opencode 2>/dev/null) && [[ -n "$candidate" ]]; then
    printf '%s\n' "$candidate"
    return 0
  fi
  if [[ -n "${HOME:-}" && -x "$HOME/.local/bin/opencode" ]]; then
    printf '%s\n' "$HOME/.local/bin/opencode"
    return 0
  fi
  return 1
}

live_resolve_tmux() {
  local candidate
  if [[ -n "${TMUX_BIN:-}" ]]; then
    [[ -x "$TMUX_BIN" ]] || return 1
    printf '%s\n' "$TMUX_BIN"
    return 0
  fi
  if candidate=$(command -v tmux 2>/dev/null) && [[ -n "$candidate" ]]; then
    printf '%s\n' "$candidate"
    return 0
  fi
  for candidate in /usr/bin/tmux /usr/local/bin/tmux /opt/homebrew/bin/tmux; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

live_resolve_node() {
  local candidate
  if [[ -n "${NODE_BIN:-}" ]]; then
    [[ -x "$NODE_BIN" ]] || return 1
    printf '%s\n' "$NODE_BIN"
    return 0
  fi
  if candidate=$(command -v node 2>/dev/null) && [[ -n "$candidate" ]]; then
    printf '%s\n' "$candidate"
    return 0
  fi
  if [[ -n "${HOME:-}" ]] && compgen -G "$HOME/.nvm/versions/node/*/bin/node" >/dev/null; then
    candidate=$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -Vr | head -n1)
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  fi
  return 1
}

# The harness itself invokes these after the runtime gates. They were never
# optional, so a missing curl or git fails in every mode rather than skipping.
live_require_support_tool() {
  local tool="$1"
  command -v "$tool" >/dev/null 2>&1 \
    || live_fail "$tool is required by the live harness but is not installed or on PATH"
}

# Scenarios normally call this before live_setup. Missing tools skip cleanly;
# an explicitly configured but unusable binary fails instead of hiding.
live_require_runtime() {
  local explicit
  live_require_support_tool curl
  live_require_support_tool git
  explicit="${OPENCODE_BIN:-}"
  if [[ -n "$explicit" && ! -x "$explicit" ]]; then
    live_fail "OPENCODE_BIN is set but not executable: $explicit"
  fi
  explicit="${TMUX_BIN:-}"
  if [[ -n "$explicit" && ! -x "$explicit" ]]; then
    live_fail "TMUX_BIN is set but not executable: $explicit"
  fi

  LIVE_OPENCODE_BIN=$(live_resolve_opencode || true)
  if [[ -z "$LIVE_OPENCODE_BIN" ]]; then
    local known
    for known in "${HOME:-}/.local/bin/opencode" /opt/homebrew/bin/opencode /usr/local/bin/opencode; do
      if [[ -e "$known" ]]; then
        live_fail "opencode exists at $known but is not executable"
      fi
    done
    live_skip "opencode is not installed or not on PATH"
  fi
  LIVE_TMUX_BIN=$(live_resolve_tmux || true)
  if [[ -z "$LIVE_TMUX_BIN" ]]; then
    live_skip "tmux is not installed or not on PATH"
  fi
  # The live harness isolates HOME. The user-facing ~/.local/bin/opencode
  # wrapper selects a binary through $HOME/.nvm, so it cannot run under that
  # isolation. Prefer the resolved nvm binary and fail clearly otherwise.
  if [[ -n "${HOME:-}" && "$LIVE_OPENCODE_BIN" == "$HOME/.local/bin/opencode" \
        && -f "$LIVE_OPENCODE_BIN" && "$(head -n1 "$LIVE_OPENCODE_BIN" 2>/dev/null)" == "#!"* ]]; then
    live_fail "opencode resolves to the HOME-dependent wrapper $LIVE_OPENCODE_BIN; set OPENCODE_BIN to the absolute opencode binary"
  fi
  live_debug "opencode=$LIVE_OPENCODE_BIN tmux=$LIVE_TMUX_BIN"
}

live_require_node() {
  local explicit="${NODE_BIN:-}"
  if [[ -n "$explicit" && ! -x "$explicit" ]]; then
    live_fail "NODE_BIN is set but not executable: $explicit"
  fi
  LIVE_NODE_BIN=$(live_resolve_node || true)
  [[ -n "$LIVE_NODE_BIN" ]] || live_skip "node is not installed or not on PATH"
  live_debug "node=$LIVE_NODE_BIN"
}

live_keep_enabled() {
  [[ "${ENSEMBLE_LIVE_KEEP:-0}" == "1" ]]
}

live_setup() {
  local kind="$1"
  local tmp="${TMPDIR:-/tmp}/opencode"
  mkdir -p "$tmp"
  LIVE_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
  LIVE_KIND="$kind"
  LIVE_BASE=$(mktemp -d "$tmp/ensemble-$kind-XXXXXX")
  LIVE_CONFIG="$LIVE_BASE/config"
  LIVE_DATA="$LIVE_BASE/data"
  LIVE_STATE="$LIVE_BASE/state"
  LIVE_PROJECT="$LIVE_BASE/project"
  LIVE_HOME="$LIVE_BASE/home"
  LIVE_LOGS="$LIVE_BASE/logs"
  LIVE_FAKE_URL_FILE="$LIVE_BASE/fake-url"
  mkdir -p "$LIVE_CONFIG/opencode" "$LIVE_DATA" "$LIVE_STATE" "$LIVE_PROJECT" "$LIVE_HOME" "$LIVE_LOGS"
  git -C "$LIVE_PROJECT" init -q
  LIVE_RUN_ID="$$-${RANDOM}"
  LIVE_SERVE_SESSION="ensemble-$kind-serve-$LIVE_RUN_ID"
  LIVE_TUI_SESSION="ensemble-$kind-tui-$LIVE_RUN_ID"
  LIVE_FAKE_SESSION="ensemble-$kind-fake-$LIVE_RUN_ID"
  LIVE_SESSION_NAMES=("$LIVE_SERVE_SESSION" "$LIVE_TUI_SESSION" "$LIVE_FAKE_SESSION")
  LIVE_PROCESS_ENV=(
    "PATH=$PATH"
    "TERM=xterm-256color"
    "HOME=$LIVE_HOME"
    "XDG_CONFIG_HOME=$LIVE_CONFIG"
    "XDG_DATA_HOME=$LIVE_DATA"
    "XDG_STATE_HOME=$LIVE_STATE"
    "XDG_CACHE_HOME=$LIVE_BASE/cache"
    "OPENCODE_DISABLE_AUTOUPDATE=1"
  )
  trap live_on_exit EXIT
  trap 'exit 130' INT TERM
  live_debug "base=$LIVE_BASE"
}

live_tmux_env_add() {
  LIVE_PROCESS_ENV+=("$1")
}

# Do not inherit credentials/config overrides from the caller or an existing
# tmux server. Quote each argument for tmux's shell-command boundary.
live_command() {
  printf '%q ' env -i "${LIVE_PROCESS_ENV[@]}" "$@"
}

live_write_plugin_config() {
  cat >"$LIVE_CONFIG/opencode/opencode.json" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "plugins": ["$LIVE_ROOT"]
}
EOF
}

live_write_config() {
  cat >"$LIVE_CONFIG/opencode/opencode.json"
}

# --- condition waits -------------------------------------------------------

live_wait_for() {
  local seconds="$1" description="$2"
  shift 2
  local end=$(( $(date +%s%N) + seconds * 1000000000 ))
  while true; do
    if "$@"; then return 0; fi
    if (( $(date +%s%N) >= end )); then
      live_log "timed out after ${seconds}s waiting for ${description}"
      return 1
    fi
    sleep "$LIVE_WAIT_INTERVAL"
  done
}

# Like live_wait_for, but quiet on timeout. For optional UI states.
live_poll_for() {
  local seconds="$1"
  shift
  local end=$(( $(date +%s%N) + seconds * 1000000000 ))
  while true; do
    if "$@"; then return 0; fi
    if (( $(date +%s%N) >= end )); then return 1; fi
    sleep "$LIVE_WAIT_INTERVAL"
  done
}

live_capture() {
  "$LIVE_TMUX_BIN" capture-pane -p -J -t "$1" 2>/dev/null
}

live_capture_contains() {
  local session="$1" text="$2"
  live_capture "$session" | grep -qF -- "$text"
}

live_capture_matches() {
  local session="$1" expression="$2"
  live_capture "$session" | grep -qE -- "$expression"
}

live_wait_for_text() {
  local session="$1" text="$2" seconds="${3:-$LIVE_STEP_TIMEOUT}" description="${4:-$text}"
  live_wait_for "$seconds" "$description" live_capture_contains "$session" "$text"
}

live_wait_for_absence() {
  local session="$1" text="$2" seconds="${3:-$LIVE_STEP_TIMEOUT}" description="${4:-absence of $text}"
  live_wait_for "$seconds" "$description" live_capture_absence "$session" "$text"
}

live_capture_absence() {
  ! live_capture_contains "$1" "$2"
}

live_require_text() {
  local session="$1" text="$2" seconds="${3:-$LIVE_STEP_TIMEOUT}" description="${4:-$text}"
  live_wait_for_text "$session" "$text" "$seconds" "$description" \
    || live_fail "TUI did not show: $description"
}

live_require_absence() {
  local session="$1" text="$2" seconds="${3:-$LIVE_STEP_TIMEOUT}" description="${4:-absence of $text}"
  live_wait_for_absence "$session" "$text" "$seconds" "$description" \
    || live_fail "TUI still shows: $description"
}

live_require_any_text() {
  local session="$1" seconds="$2" description="$3"
  shift 3
  local text
  live_wait_for "$seconds" "$description" live_capture_any_text "$session" "$@" \
    || live_fail "TUI did not show any of: $description"
}

live_capture_any_text() {
  local session="$1"
  shift
  local pane
  pane=$(live_capture "$session")
  local text
  for text in "$@"; do
    grep -qF -- "$text" <<<"$pane" && return 0
  done
  return 1
}

live_try_text() {
  local session="$1" text="$2" seconds="${3:-2}"
  live_poll_for "$seconds" live_capture_contains "$session" "$text"
}

# True when every listed marker co-occurs in ONE pane capture. Rich Markdown
# lays out over several frames, so instant asserts after the first marker can
# catch a partial render (a different missing element per run). Polling for
# co-occurrence first settles the layout without weakening any assertion.
live_capture_all_text() {
  local session="$1"
  shift
  local pane
  pane=$(live_capture "$session")
  local text
  for text in "$@"; do
    grep -qF -- "$text" <<<"$pane" || return 1
  done
  return 0
}

# Bounded settle window: wait until every marker is visible together, then
# return so the caller's instant asserts/counts observe the settled layout.
live_require_all_text() {
  local session="$1" seconds="$2" description="$3"
  shift 3
  live_wait_for "$seconds" "$description" live_capture_all_text "$session" "$@" \
    || live_fail "TUI did not settle: $description"
}

live_assert_text() {
  local session="$1" text="$2" description="${3:-$text}"
  live_capture_contains "$session" "$text" || live_fail "TUI does not show: $description"
}

# Joined chat text: group-chat wraps long system/assignment lines over several
# terminal rows, and tmux cannot rejoin them because the app draws each row
# itself. Slice the chat pane's content cells (the same `workspacePaneWidths`
# model the app uses), trim each row, and join with single spaces. Content
# assertions that span a visual wrap still prove the full message reached the
# transcript. Only use this on a group surface wide enough for the right Work
# pane; the bounds are intentionally derived from the shared pane helper.
LIVE_CHAT_COLUMNS=""
LIVE_CHAT_COLUMNS_WIDTH=""
live_chat_columns() {
  local width="${ENSEMBLE_LIVE_TUI_WIDTH:-160}"
  if [[ -n "$LIVE_CHAT_COLUMNS" && "$LIVE_CHAT_COLUMNS_WIDTH" == "$width" ]]; then
    printf '%s\n' "$LIVE_CHAT_COLUMNS"
    return 0
  fi
  local start end
  read -r start end < <(
    "$LIVE_NODE_BIN" --experimental-strip-types -e '
      const { pathToFileURL } = require("node:url");
      import(pathToFileURL(process.argv[1]).href).then((module) => {
        const panes = module.workspacePaneWidths(Number(process.argv[2]));
        const start = 2 + panes.railWidth + 3;
        const end = start + (panes.chatWidth - 4) - 1;
        process.stdout.write(`${start} ${end}\n`);
      });
    ' "$LIVE_ROOT/src/v2/tui/workpane.ts" "$width"
  )
  [[ -n "$start" && -n "$end" ]] || live_fail "could not resolve the chat column bounds"
  LIVE_CHAT_COLUMNS="$start $end"
  LIVE_CHAT_COLUMNS_WIDTH="$width"
  printf '%s\n' "$LIVE_CHAT_COLUMNS"
}

live_capture_chat_joined() {
  local start end
  read -r start end <<<"$(live_chat_columns)"
  # Node slices UTF-16 code units, which match terminal cells for the BMP
  # glyphs the chat uses. `cut -c` counts bytes and would drift after a border.
  live_capture "$1" | "$LIVE_NODE_BIN" -e '
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { value += chunk });
    process.stdin.on("end", () => {
      const start = Number(process.argv[1]) - 1;
      const end = Number(process.argv[2]);
      const rows = value.split("\n")
        // The transcript scrollbar is a full-cell block inside the chat cell.
        .map((line) => line.slice(start, end).replace(/[▁▂▃▄▅▆▇█]+\s*$/, "").trim())
        .filter((line) => line.length > 0);
      process.stdout.write(rows.join(" "));
    });
  ' "$start" "$end"
}

live_capture_contains_joined() {
  live_capture_chat_joined "$1" | grep -qF -- "$2"
}

# Work-column bounds from the same shared pane model. Used for Work-local
# assertions so a transcript copy of a title cannot satisfy a card check.
LIVE_WORK_COLUMNS=""
LIVE_WORK_COLUMNS_WIDTH=""
live_work_columns() {
  local width="${ENSEMBLE_LIVE_TUI_WIDTH:-160}"
  if [[ -n "$LIVE_WORK_COLUMNS" && "$LIVE_WORK_COLUMNS_WIDTH" == "$width" ]]; then
    printf '%s\n' "$LIVE_WORK_COLUMNS"
    return 0
  fi
  local start end
  read -r start end < <(
    "$LIVE_NODE_BIN" --experimental-strip-types -e '
      const { pathToFileURL } = require("node:url");
      import(pathToFileURL(process.argv[1]).href).then((module) => {
        const panes = module.workspacePaneWidths(Number(process.argv[2]));
        const workStart = panes.mode === "drawer"
          ? panes.terminalWidth - panes.workWidth
          : 2 + panes.railWidth + 1 + panes.chatWidth + 1;
        process.stdout.write(`${workStart + 2} ${panes.terminalWidth - 3}\n`);
      });
    ' "$LIVE_ROOT/src/v2/tui/workpane.ts" "$width"
  )
  [[ -n "$start" && -n "$end" ]] || live_fail "could not resolve the Work column bounds"
  LIVE_WORK_COLUMNS="$start $end"
  LIVE_WORK_COLUMNS_WIDTH="$width"
  printf '%s\n' "$LIVE_WORK_COLUMNS"
}

live_capture_work_joined() {
  local start end
  read -r start end <<<"$(live_work_columns)"
  live_capture "$1" | "$LIVE_NODE_BIN" -e '
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { value += chunk });
    process.stdin.on("end", () => {
      const start = Number(process.argv[1]) - 1;
      const end = Number(process.argv[2]);
      const rows = value.split("\n")
        .map((line) => line.slice(start, end).replace(/[▁▂▃▄▅▆▇█]+\s*$/, "").trim())
        .filter((line) => line.length > 0);
      process.stdout.write(rows.join(" "));
    });
  ' "$start" "$end"
}

live_capture_work_contains() {
  live_capture_work_joined "$1" | grep -qF -- "$2"
}

live_require_work_text() {
  local session="$1" text="$2" seconds="${3:-$LIVE_STEP_TIMEOUT}" description="${4:-$text}"
  live_wait_for "$seconds" "$description" live_capture_work_contains "$session" "$text" \
    || live_fail "Work pane did not show: $description"
}

live_assert_work_text() {
  local session="$1" text="$2" description="${3:-$text}"
  live_capture_work_contains "$session" "$text" || live_fail "Work pane does not show: $description"
}

live_assert_absence_work() {
  local session="$1" text="$2" description="${3:-absence of $text}"
  live_capture_work_contains "$session" "$text" && live_fail "Work pane unexpectedly shows: $description"
  return 0
}

# Rail-column bounds from the same shared pane model. Used to prove the left
# footer is gone without matching the right column's APPROVALS heading.
LIVE_RAIL_COLUMNS=""
LIVE_RAIL_COLUMNS_WIDTH=""
live_rail_columns() {
  local width="${ENSEMBLE_LIVE_TUI_WIDTH:-160}"
  if [[ -n "$LIVE_RAIL_COLUMNS" && "$LIVE_RAIL_COLUMNS_WIDTH" == "$width" ]]; then
    printf '%s\n' "$LIVE_RAIL_COLUMNS"
    return 0
  fi
  local end
  end=$(
    "$LIVE_NODE_BIN" --experimental-strip-types -e '
      const { pathToFileURL } = require("node:url");
      import(pathToFileURL(process.argv[1]).href).then((module) => {
        const panes = module.workspacePaneWidths(Number(process.argv[2]));
        process.stdout.write(String(1 + panes.railWidth));
      });
    ' "$LIVE_ROOT/src/v2/tui/workpane.ts" "$width"
  )
  [[ -n "$end" ]] || live_fail "could not resolve the rail column bounds"
  LIVE_RAIL_COLUMNS="1 $end"
  LIVE_RAIL_COLUMNS_WIDTH="$width"
  printf '%s\n' "$LIVE_RAIL_COLUMNS"
}

live_capture_rail_joined() {
  local start end
  read -r start end <<<"$(live_rail_columns)"
  live_capture "$1" | "$LIVE_NODE_BIN" -e '
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { value += chunk });
    process.stdin.on("end", () => {
      const start = Number(process.argv[1]) - 1;
      const end = Number(process.argv[2]);
      const rows = value.split("\n").map((line) => line.slice(start, end).trim()).filter((line) => line.length > 0);
      process.stdout.write(rows.join(" "));
    });
  ' "$start" "$end"
}

live_capture_rail_contains() {
  live_capture_rail_joined "$1" | grep -qF -- "$2"
}

live_assert_absence_rail() {
  local session="$1" text="$2" description="${3:-absence of $text}"
  live_capture_rail_contains "$session" "$text" && live_fail "rail unexpectedly shows: $description"
  return 0
}

live_capture_all_joined() {
  local session="$1"
  shift
  local joined text
  joined=$(live_capture_chat_joined "$session")
  for text in "$@"; do
    grep -qF -- "$text" <<<"$joined" || return 1
  done
  return 0
}

live_require_joined_all_text() {
  local session="$1" seconds="$2" description="$3"
  shift 3
  live_wait_for "$seconds" "$description" live_capture_all_joined "$session" "$@" \
    || live_fail "TUI did not settle: $description"
}

live_wait_for_joined_text() {
  local session="$1" text="$2" seconds="${3:-$LIVE_STEP_TIMEOUT}" description="${4:-$text}"
  live_wait_for "$seconds" "$description" live_capture_contains_joined "$session" "$text"
}

live_require_joined_text() {
  local session="$1" text="$2" seconds="${3:-$LIVE_STEP_TIMEOUT}" description="${4:-$text}"
  live_wait_for_joined_text "$session" "$text" "$seconds" "$description" \
    || live_fail "TUI did not show: $description"
}

live_assert_joined_text() {
  local session="$1" text="$2" description="${3:-$text}"
  live_capture_contains_joined "$session" "$text" || live_fail "TUI does not show: $description"
}

# Bounded wait for a transient label that must appear exactly once in the chat
# column in the SAME frame. Work-card details live outside this slice, so the
# aggregate chat line is measured without counting a card's matching detail.
live_require_joined_single_text() {
  local session="$1" text="$2" seconds="${3:-$LIVE_STEP_TIMEOUT}" description="${4:-$text}"
  local end value count
  end=$(( $(date +%s%N) + seconds * 1000000000 ))
  while true; do
    value=$(live_capture_chat_joined "$session")
    count=$(grep -oF -- "$text" <<<"$value" | wc -l | tr -d ' ')
    if [[ "$count" == "1" ]]; then return 0; fi
    if [[ "$count" != "0" ]]; then live_fail "expected one '$description' in chat, found $count in one frame"; fi
    if (( $(date +%s%N) >= end )); then
      live_fail "TUI did not show exactly one '$description' in chat within ${seconds}s"
    fi
    sleep "$LIVE_WAIT_INTERVAL"
  done
}

live_count_joined_text() {
  local session="$1" text="$2"
  live_capture_chat_joined "$session" | { grep -oF -- "$text" || true; } | wc -l | tr -d ' '
}

# The guarded grep form above is required under `set -o pipefail`: an absent
# match must count zero, not abort the scenario.

live_assert_joined_count() {
  local session="$1" text="$2" expected="$3" description="${4:-$text}"
  local actual
  actual=$(live_count_joined_text "$session" "$text")
  [[ "$actual" == "$expected" ]] \
    || live_fail "expected $expected occurrence(s) of '$description' in the TUI, found $actual"
}

live_assert_absence() {
  local session="$1" text="$2" description="${3:-absence of $text}"
  live_capture_absence "$session" "$text" || live_fail "TUI unexpectedly shows: $description"
}

# Count literal occurrences (not just matching lines) in a joined pane capture.
live_count_text() {
  local session="$1" text="$2"
  live_capture "$session" | { grep -oF -- "$text" || true; } | wc -l | tr -d ' '
}

live_assert_count() {
  local session="$1" text="$2" expected="$3" description="${4:-$text}"
  local actual
  actual=$(live_count_text "$session" "$text")
  [[ "$actual" == "$expected" ]] \
    || live_fail "expected $expected occurrence(s) of '$description' in the TUI, found $actual"
}

# Wait for an asynchronous list/field pair to settle on the expected count,
# instead of racing a store patch that lands a frame after the field update.
live_require_count() {
  local session="$1" text="$2" expected="$3" seconds="${4:-$LIVE_STEP_TIMEOUT}" description="${5:-$text}"
  local end actual
  end=$(( $(date +%s%N) + seconds * 1000000000 ))
  while true; do
    actual=$(live_count_text "$session" "$text")
    [[ "$actual" == "$expected" ]] && return 0
    if (( $(date +%s%N) >= end )); then
      live_fail "expected $expected occurrence(s) of '$description' in the TUI, found $actual"
    fi
    sleep "$LIVE_WAIT_INTERVAL"
  done
}

# Bounded wait for a transient label that must appear exactly once in the SAME
# frame. A follow-up count would race the next state; this polls and counts one
# capture, so a fast streaming transition cannot hide or double the label.
live_require_single_text() {
  local session="$1" text="$2" seconds="${3:-$LIVE_STEP_TIMEOUT}" description="${4:-$text}"
  local end pane count
  end=$(( $(date +%s%N) + seconds * 1000000000 ))
  while true; do
    pane=$(live_capture "$session")
    count=$({ grep -oF -- "$text" <<<"$pane" || true; } | wc -l | tr -d ' ')
    if [[ "$count" == "1" ]]; then return 0; fi
    if [[ "$count" != "0" ]]; then live_fail "expected one '$description', found $count in one frame"; fi
    if (( $(date +%s%N) >= end )); then
      live_fail "TUI did not show exactly one '$description' within ${seconds}s"
    fi
    sleep "$LIVE_WAIT_INTERVAL"
  done
}

live_wait_for_file_text() {
  local file="$1" text="$2" seconds="${3:-$LIVE_STEP_TIMEOUT}" description="${4:-$text}"
  live_wait_for "$seconds" "$description" live_file_contains "$file" "$text"
}

live_file_contains() {
  [[ -f "$1" ]] && grep -qF -- "$2" "$1"
}

live_wait_for_http() {
  local url="$1" seconds="${2:-$LIVE_STEP_TIMEOUT}" description="${3:-$url}"
  live_wait_for "$seconds" "$description" live_http_ready "$url"
}

live_http_ready() {
  curl -fsS --max-time 2 "$1" >/dev/null 2>&1
}

live_wait_for_json() {
  local file="$1" expression="$2" seconds="${3:-$LIVE_STEP_TIMEOUT}" description="${4:-$expression}"
  live_wait_for "$seconds" "$description" live_json_matches "$file" "$expression"
}

live_json_matches() {
  [[ -s "$1" ]] && "$LIVE_NODE_BIN" -e '
    const fs = require("fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.exit(Function("value", `return (${process.argv[2]})`)(value) ? 0 : 1);
  ' "$1" "$2" >/dev/null 2>&1
}

# --- process and tmux lifecycle -------------------------------------------

live_start_fake_provider() {
  [[ -n "$LIVE_NODE_BIN" ]] || live_fail "live_start_fake_provider requires live_require_node"
  local script="$LIVE_ROOT/scripts/fake-provider.mjs"
  [[ -f "$script" ]] || live_fail "fake provider script is missing: $script"
  rm -f "$LIVE_FAKE_URL_FILE"
  "$LIVE_TMUX_BIN" new-session -d -s "$LIVE_FAKE_SESSION" -x 120 -y 20 -c "$LIVE_ROOT" \
    "$(live_command "$LIVE_NODE_BIN" "$script" --url-file "$LIVE_FAKE_URL_FILE" "$@") >'$LIVE_LOGS/fake.log' 2>&1"
  live_wait_for 20 "fake provider URL file" test -s "$LIVE_FAKE_URL_FILE" \
    || live_fail "fake provider did not write its URL"
  LIVE_FAKE_URL=$(cat "$LIVE_FAKE_URL_FILE")
  live_wait_for_http "$LIVE_FAKE_URL/v1/models" 20 "fake provider model list" \
    || live_fail "fake provider did not become ready"
}

live_start_server() {
  [[ -n "$LIVE_OPENCODE_BIN" ]] || live_fail "live_start_server requires live_require_runtime"
  : >"$LIVE_LOGS/server.log"
  "$LIVE_TMUX_BIN" new-session -d -s "$LIVE_SERVE_SESSION" -x 200 -y 20 -c "$LIVE_PROJECT" \
    "$(live_command "$LIVE_OPENCODE_BIN" serve --hostname 127.0.0.1 --port 0 --print-logs) 2>'$LIVE_LOGS/server.log'"
  live_wait_for "$LIVE_START_TIMEOUT" "OpenCode server URL" live_server_url_ready \
    || live_fail "OpenCode server did not print its URL"
  LIVE_SERVER_URL=$(live_server_url)
  live_wait_for "$LIVE_START_TIMEOUT" "OpenCode server password" live_server_password_ready \
    || live_fail "OpenCode server did not print its password"
  LIVE_SERVER_PASSWORD=$(live_server_password)
  live_debug "server=$LIVE_SERVER_URL"
}

live_server_url_ready() {
  [[ -n "$(live_server_url)" ]]
}

live_server_url() {
  live_capture "$LIVE_SERVE_SESSION" | sed -n 's/^server listening on //p' | head -n1
}

live_server_password_ready() {
  [[ -n "$(live_server_password)" ]]
}

live_server_password() {
  live_capture "$LIVE_SERVE_SESSION" | sed -n 's/^server password //p' | head -n1
}

live_start_tui() {
  local width="${ENSEMBLE_LIVE_TUI_WIDTH:-160}"
  local height="${ENSEMBLE_LIVE_TUI_HEIGHT:-60}"
  : >"$LIVE_LOGS/tui.log"
  "$LIVE_TMUX_BIN" new-session -d -s "$LIVE_TUI_SESSION" -x "$width" -y "$height" -c "$LIVE_PROJECT" \
    "$(live_command env "OPENCODE_PASSWORD=$LIVE_SERVER_PASSWORD" "$LIVE_OPENCODE_BIN" --server "$LIVE_SERVER_URL" --print-logs) 2>'$LIVE_LOGS/tui.log'"
}

live_wait_for_native_tui() {
  live_require_text "$LIVE_TUI_SESSION" "Ask anything" "$LIVE_TUI_TIMEOUT" "native OpenCode TUI"
}

live_open_ensemble() {
  live_type "$LIVE_TUI_SESSION" "/ensemble"
  live_key "$LIVE_TUI_SESSION" Enter
  if ! live_try_text "$LIVE_TUI_SESSION" "ENSEMBLE" "$LIVE_STEP_TIMEOUT"; then
    live_key "$LIVE_TUI_SESSION" Enter
    live_require_text "$LIVE_TUI_SESSION" "ENSEMBLE" "$LIVE_STEP_TIMEOUT" "Ensemble page"
  fi
}

# --- pane select/interact (ticket #180/#183) ------------------------------

# The statusline row is the one text-observable pane model. The mode chip and
# context are core segments, so they survive every width; hints are droppable.
live_status_line() {
  live_capture "$1" | grep -E '^ *((NORMAL|INSERT|COMMAND|VISUAL|V-LINE) +│)' | tail -n 1
}

# True while pane selection owns the keyboard: its shipped hint is present.
live_capture_pane_select() {
  live_capture "$1" | grep -qF "h/l column"
}

live_require_pane_select() {
  local session="$1" seconds="${2:-10}" description="${3:-pane selection}"
  live_wait_for "$seconds" "$description" live_capture_pane_select "$session" \
    || live_fail "TUI did not show: $description"
}

# Esc always returns one level and is a no-op in select mode, so a bounded
# ladder reaches pane selection from any ordinary normal/interact surface.
live_escape_to_pane_select() {
  local session="$1" attempt
  for attempt in 1 2 3 4 5 6; do
    live_capture_pane_select "$session" && return 0
    live_key "$session" Escape
    sleep 0.25
  done
  live_fail "could not return to pane selection"
}

# One of: agents, workspaces, chat, work, approvals, composer, other.
live_pane_context() {
  local line context
  line=$(live_status_line "$1")
  [[ -n "$line" ]] || { printf 'other\n'; return 0; }
  context=$(awk -F'│' '{ if (NF >= 2) { value = $2; gsub(/^[ \t]+|[ \t]+$/, "", value); print value } }' <<<"$line")
  case "$context" in
    Agents) printf 'agents\n' ;;
    Workspaces) printf 'workspaces\n' ;;
    "Work list") printf 'work\n' ;;
    Approvals|"Work approvals") printf 'approvals\n' ;;
    "Group chat"|"Direct conversation") printf 'chat\n' ;;
    COMPOSER) printf 'composer\n' ;;
    *) printf 'other\n' ;;
  esac
}

live_require_pane_context() {
  local session="$1" expected="$2" seconds="${3:-10}" description="${4:-$2 pane}"
  live_wait_for "$seconds" "$description" live_capture_pane_context "$session" "$expected" \
    || live_fail "TUI did not show: $description (got $(live_pane_context "$session"))"
}

live_capture_pane_context() {
  [[ "$(live_pane_context "$1")" == "$2" ]]
}

# True while the right column (Work or full approvals) is rendered.
live_capture_right_pane() {
  live_capture "$1" | grep -Eq 'WORK (ACTIVE|HISTORY) │|APPROVALS [0-9]+ pending │'
}

live_capture_left_pane() {
  live_capture "$1" | grep -qE 'AGENTS \([0-9]+\)'
}

live_open_leader() {
  local session="$1"
  live_key "$session" Space
  live_wait_for 5 "leader mode" live_capture_matches "$session" "chord space" \
    || live_fail "Space did not open the leader"
}

live_open_pane_prefix() {
  local session="$1"
  live_open_leader "$session"
  live_key "$session" b
  live_wait_for 5 "pane prefix" live_capture_matches "$session" "chord space b" \
    || live_fail "Space b did not open the pane submenu"
}

live_toggle_pane_side() {
  local session="$1" side="$2"
  live_open_pane_prefix "$session"
  live_key "$session" "$side"
  sleep 0.5
}

live_ensure_right_pane() {
  local session="$1"
  live_capture_right_pane "$session" && return 0
  live_toggle_pane_side "$session" r
  live_wait_for 10 "right pane visible" live_capture_right_pane "$session" \
    || live_fail "right pane did not open"
}

live_ensure_left_pane() {
  local session="$1"
  live_capture_left_pane "$session" && return 0
  live_toggle_pane_side "$session" l
  live_wait_for 10 "left pane visible" live_capture_left_pane "$session" \
    || live_fail "left pane did not open"
}

# Select a pane with the pure select-mode grammar. Every call first returns to
# selection, so callers never depend on the previous interact depth.
live_select_pane() {
  local session="$1" target="$2" attempt current
  live_escape_to_pane_select "$session"
  for attempt in 1 2 3 4 5 6 7 8; do
    current=$(live_pane_context "$session")
    [[ "$current" == "$target" ]] && return 0
    case "$target" in
      chat)
        case "$current" in
          agents|workspaces) live_key "$session" l ;;
          work|approvals) live_key "$session" h ;;
          *) live_key "$session" Escape ;;
        esac
        ;;
      work)
        case "$current" in
          agents|workspaces) live_key "$session" l; sleep 0.2; live_key "$session" l ;;
          chat) live_key "$session" l ;;
          approvals) live_key "$session" k ;;
          *) live_key "$session" Escape ;;
        esac
        ;;
      agents)
        case "$current" in
          workspaces) live_key "$session" k ;;
          chat) live_key "$session" h ;;
          work|approvals) live_key "$session" h; sleep 0.2; live_key "$session" h ;;
          *) live_key "$session" Escape ;;
        esac
        ;;
      workspaces)
        case "$current" in
          agents) live_key "$session" j ;;
          chat) live_key "$session" h; sleep 0.2; live_key "$session" j ;;
          work|approvals) live_key "$session" h; sleep 0.2; live_key "$session" h; sleep 0.2; live_key "$session" j ;;
          *) live_key "$session" Escape ;;
        esac
        ;;
      approvals)
        case "$current" in
          work) live_key "$session" j ;;
          chat) live_key "$session" l; sleep 0.2; live_key "$session" j ;;
          agents|workspaces) live_key "$session" l; sleep 0.2; live_key "$session" l; sleep 0.2; live_key "$session" j ;;
          *) live_key "$session" Escape ;;
        esac
        ;;
      *) live_fail "unsupported pane target: $target" ;;
    esac
    sleep 0.2
  done
  live_fail "could not select the $target pane (last context $(live_pane_context "$session"))"
}

live_enter_selected_pane() {
  local session="$1"
  live_key "$session" Enter
  sleep 0.3
}

live_focus_chat() {
  live_select_pane "$1" chat
}

live_focus_chat_interact() {
  live_focus_chat "$1"
  live_enter_selected_pane "$1"
}

live_focus_agents_interact() {
  local session="$1"
  live_ensure_left_pane "$session"
  live_select_pane "$session" agents
  live_enter_selected_pane "$session"
}

live_focus_workspaces_interact() {
  local session="$1"
  live_ensure_left_pane "$session"
  live_select_pane "$session" workspaces
  live_enter_selected_pane "$session"
}

live_focus_work_interact() {
  local session="$1"
  live_ensure_right_pane "$session"
  live_select_pane "$session" work
  live_enter_selected_pane "$session"
}

# --- ANSI colour probes ---------------------------------------------------

# Read the active SGR foreground for a visible substring in a capture.
live_sgr_fg_for_text() {
  local session="$1" text="$2" occurrence="${3:-1}"
  "$LIVE_TMUX_BIN" capture-pane -e -p -J -t "$session" | "$LIVE_NODE_BIN" -e '
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { value += chunk });
    process.stdin.on("end", () => {
      const target = process.argv[1];
      const wanted = Number(process.argv[2]);
      const sgr = /\x1b\[([0-9;]*)m/g;
      const parse = (raw) => {
        let fg = "default";
        let visible = "";
        const colors = [];
        let index = 0;
        while (index < raw.length) {
          if (raw[index] === "\x1b") {
            sgr.lastIndex = index;
            const match = sgr.exec(raw);
            if (match && match.index === index) {
              const parts = match[1].split(";").map(Number);
              if (parts.length === 1 && (parts[0] === 0 || parts[0] === 39)) fg = "default";
              else if (parts[0] === 38) fg = parts.join(";");
              else if (parts.includes(39)) fg = "default";
              index = sgr.lastIndex;
              continue;
            }
          }
          colors.push(fg);
          visible += raw[index];
          index += 1;
        }
        return { visible, colors };
      };
      for (const raw of value.split("\n")) {
        const { visible, colors } = parse(raw);
        let index = -1;
        let seen = 0;
        while (true) {
          index = visible.indexOf(target, index + 1);
          if (index < 0) break;
          seen += 1;
          if (seen === wanted) {
            process.stdout.write(colors[index] ?? "default");
            return;
          }
        }
      }
      process.exit(1);
    });
  ' "$text" "$occurrence"
}

# Read the active SGR foreground for a visible substring whose first cell is
# inside the given 1-based column range. Chat headings can share text with the
# app header or rail, so the column slice is the pane authority.
live_sgr_fg_for_text_in_columns() {
  local session="$1" text="$2" start="$3" end="$4" occurrence="${5:-1}"
  "$LIVE_TMUX_BIN" capture-pane -e -p -J -t "$session" | "$LIVE_NODE_BIN" -e '
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { value += chunk });
    process.stdin.on("end", () => {
      const target = process.argv[1];
      const start = Number(process.argv[2]);
      const end = Number(process.argv[3]);
      const wanted = Number(process.argv[4]);
      const sgr = /\x1b\[([0-9;]*)m/g;
      for (const raw of value.split("\n")) {
        let fg = "default";
        let visible = "";
        const colors = [];
        let index = 0;
        while (index < raw.length) {
          if (raw[index] === "\x1b") {
            sgr.lastIndex = index;
            const match = sgr.exec(raw);
            if (match && match.index === index) {
              const parts = match[1].split(";").map(Number);
              if (parts.length === 1 && (parts[0] === 0 || parts[0] === 39)) fg = "default";
              else if (parts[0] === 38) fg = parts.join(";");
              else if (parts.includes(39)) fg = "default";
              index = sgr.lastIndex;
              continue;
            }
          }
          colors.push(fg);
          visible += raw[index];
          index += 1;
        }
        let at = -1;
        let seen = 0;
        while (true) {
          at = visible.indexOf(target, at + 1);
          if (at < 0) break;
          const column = at + 1;
          if (column < start || column > end) continue;
          seen += 1;
          if (seen === wanted) {
            process.stdout.write(colors[at] ?? "default");
            return;
          }
        }
      }
      process.exit(1);
    });
  ' "$text" "$start" "$end" "$occurrence"
}

live_assert_white_chat_text() {
  local session="$1" text="$2" description="${3:-$text}" columns start end color=""
  columns=$(live_chat_columns)
  read -r start end <<<"$columns"
  local deadline=$(( $(date +%s%N) + 3 * 1000000000 ))
  while true; do
    color=$(live_sgr_fg_for_text_in_columns "$session" "$text" "$start" "$end" 1 2>/dev/null || true)
    live_color_is_white "$color" && return 0
    (( $(date +%s%N) >= deadline )) && break
    sleep 0.1
  done
  live_fail "$description is not white (got ${color:-unreadable})"
}

live_assert_grey_chat_text() {
  local session="$1" text="$2" description="${3:-$text}" columns start end color=""
  columns=$(live_chat_columns)
  read -r start end <<<"$columns"
  local deadline=$(( $(date +%s%N) + 3 * 1000000000 ))
  while true; do
    color=$(live_sgr_fg_for_text_in_columns "$session" "$text" "$start" "$end" 1 2>/dev/null || true)
    live_color_is_grey "$color" && return 0
    (( $(date +%s%N) >= deadline )) && break
    sleep 0.1
  done
  live_fail "$description is not grey (got ${color:-unreadable})"
}

# Foreground colours of every top-left rounded corner on the first frame row
# that carries two or more boxes, in left-to-right pane order.
live_top_border_colors() {
  local session="$1"
  "$LIVE_TMUX_BIN" capture-pane -e -p -J -t "$session" | "$LIVE_NODE_BIN" -e '
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { value += chunk });
    process.stdin.on("end", () => {
      const sgr = /\x1b\[([0-9;]*)m/g;
      for (const raw of value.split("\n")) {
        let fg = "default";
        let visible = "";
        const colors = [];
        let index = 0;
        while (index < raw.length) {
          if (raw[index] === "\x1b") {
            sgr.lastIndex = index;
            const match = sgr.exec(raw);
            if (match && match.index === index) {
              const parts = match[1].split(";").map(Number);
              if (parts.length === 1 && (parts[0] === 0 || parts[0] === 39)) fg = "default";
              else if (parts[0] === 38) fg = parts.join(";");
              else if (parts.includes(39)) fg = "default";
              index = sgr.lastIndex;
              continue;
            }
          }
          colors.push(fg);
          visible += raw[index];
          index += 1;
        }
        const corners = [];
        for (let at = 0; at < visible.length; at += 1) {
          if (visible[at] === "┌") corners.push(colors[at]);
        }
        if (corners.length >= 2) {
          process.stdout.write(corners.join(","));
          return;
        }
      }
      process.exit(1);
    });
  '
}

# Foreground of the first top-left corner on the frame row immediately above
# the row that contains `text`. Used for stacked rail/section borders.
live_border_above_text_color() {
  local session="$1" text="$2"
  "$LIVE_TMUX_BIN" capture-pane -e -p -J -t "$session" | "$LIVE_NODE_BIN" -e '
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { value += chunk });
    process.stdin.on("end", () => {
      const sgr = /\x1b\[([0-9;]*)m/g;
      const lines = value.split("\n").map((raw) => {
        let fg = "default";
        let visible = "";
        const colors = [];
        let index = 0;
        while (index < raw.length) {
          if (raw[index] === "\x1b") {
            sgr.lastIndex = index;
            const match = sgr.exec(raw);
            if (match && match.index === index) {
              const parts = match[1].split(";").map(Number);
              if (parts.length === 1 && (parts[0] === 0 || parts[0] === 39)) fg = "default";
              else if (parts[0] === 38) fg = parts.join(";");
              else if (parts.includes(39)) fg = "default";
              index = sgr.lastIndex;
              continue;
            }
          }
          colors.push(fg);
          visible += raw[index];
          index += 1;
        }
        return { visible, colors };
      });
      const target = process.argv[1];
      const at = lines.findIndex((line) => line.visible.includes(target));
      if (at <= 0) process.exit(1);
      const column = lines[at].visible.indexOf(target);
      const glyphs = new Set(["┌", "╭", "─"]);
      for (let offset = 1; offset <= 3 && at - offset >= 0; offset += 1) {
        const above = lines[at - offset];
        for (const candidate of [column, column - 1, column - 2]) {
          if (candidate < 0 || candidate >= above.visible.length) continue;
          if (glyphs.has(above.visible[candidate])) {
            process.stdout.write(above.colors[candidate] ?? "default");
            return;
          }
        }
      }
      process.exit(1);
    });
  ' "$text"
}

live_color_is_white() {
  case "$1" in
    38\;5\;15|38\;5\;231|38\;5\;255|38\;2\;255\;255\;255) return 0 ;;
    *) return 1 ;;
  esac
}

live_color_is_grey() {
  case "$1" in
    38\;5\;8|38\;5\;140|38\;5\;232|38\;5\;236|38\;5\;238|38\;5\;240|38\;5\;242) return 0 ;;
    38\;2\;*) return 0 ;;
    *) return 1 ;;
  esac
}

# Bounded read of the border above a heading; a pane repaint can expose the
# heading one frame before its border settles.
live_assert_border_above() {
  local session="$1" text="$2" want="$3" description="${4:-$text border}" color=""
  local deadline=$(( $(date +%s%N) + 3 * 1000000000 ))
  while true; do
    color=$(live_border_above_text_color "$session" "$text" 2>/dev/null || true)
    if [[ "$want" == "white" ]]; then
      live_color_is_white "$color" && return 0
    else
      live_color_is_grey "$color" && return 0
    fi
    (( $(date +%s%N) >= deadline )) && break
    sleep 0.1
  done
  live_fail "$description is not $want (got ${color:-unreadable})"
}

live_assert_white_text() {
  local session="$1" text="$2" description="${3:-$text}" color=""
  local end=$(( $(date +%s%N) + 3 * 1000000000 ))
  while true; do
    color=$(live_sgr_fg_for_text "$session" "$text" 1 2>/dev/null || true)
    live_color_is_white "$color" && return 0
    (( $(date +%s%N) >= end )) && break
    sleep 0.1
  done
  live_fail "$description is not white (got ${color:-unreadable})"
}

live_assert_grey_text() {
  local session="$1" text="$2" description="${3:-$text}" color=""
  local end=$(( $(date +%s%N) + 3 * 1000000000 ))
  while true; do
    color=$(live_sgr_fg_for_text "$session" "$text" 1 2>/dev/null || true)
    live_color_is_grey "$color" && return 0
    (( $(date +%s%N) >= end )) && break
    sleep 0.1
  done
  live_fail "$description is not grey (got ${color:-unreadable})"
}

# --- input ----------------------------------------------------------------

live_type() {
  "$LIVE_TMUX_BIN" send-keys -l -t "$1" -- "$2"
  # Let the TUI commit the text before the next key (Enter/Escape) is parsed;
  # a single write can otherwise coalesce with the following key event.
  sleep 0.5
}

live_key() {
  "$LIVE_TMUX_BIN" send-keys -t "$1" "$2"
}

live_key_repeat() {
  local session="$1" key="$2" count="$3" i
  for ((i = 0; i < count; i++)); do live_key "$session" "$key"; done
}

# --- shared scenario steps ------------------------------------------------

live_check_help() {
  live_key "$LIVE_TUI_SESSION" '?'
  live_require_text "$LIVE_TUI_SESSION" "Keyboard shortcuts" 15 "? opens help from Normal"
  live_key "$LIVE_TUI_SESSION" G
  live_require_text "$LIVE_TUI_SESSION" "Native-session scope" 10 "G reaches the end of help"
  live_key "$LIVE_TUI_SESSION" g
  live_key "$LIVE_TUI_SESSION" g
  live_require_text "$LIVE_TUI_SESSION" "Modes and Esc ladder" 10 "gg returns to the top of help"
  live_key "$LIVE_TUI_SESSION" Escape
  live_require_absence "$LIVE_TUI_SESSION" "Keyboard shortcuts" 10 "help closed from Normal"
  live_key "$LIVE_TUI_SESSION" Space
  live_require_text "$LIVE_TUI_SESSION" "LEADER" 10 "leader mode"
  live_key "$LIVE_TUI_SESSION" '?'
  live_require_text "$LIVE_TUI_SESSION" "Keyboard shortcuts" 15 "searchable shortcut help"
  live_require_text "$LIVE_TUI_SESSION" "Modes and Esc ladder" 10 "help is sectioned"
  live_key "$LIVE_TUI_SESSION" "/"
  # A full key+title phrase stays unique even as prose help entries grow.
  live_type "$LIVE_TUI_SESSION" "Space W Delete workspace"
  live_require_text "$LIVE_TUI_SESSION" "Space W" 10 "leader delete-workspace chord"
  live_require_absence "$LIVE_TUI_SESSION" "Scroll transcript down" 10 "help filter hid unrelated shortcuts"
  live_key "$LIVE_TUI_SESSION" Enter
  live_require_text "$LIVE_TUI_SESSION" "match 1/1" 10 "filtered help names the first match"
  live_key "$LIVE_TUI_SESSION" "/"
  # v5.7 adds the native-quit policy row, so the stable quit-path filter is
  # `Space q`: both documented quit rows plus the leader chord entry.
  live_type "$LIVE_TUI_SESSION" "Space q"
  live_key "$LIVE_TUI_SESSION" Enter
  live_require_text "$LIVE_TUI_SESSION" "match 1/3" 10 "filtered help counts all three quit paths"
  live_key "$LIVE_TUI_SESSION" n
  live_require_text "$LIVE_TUI_SESSION" "match 2/3" 10 "n moves to the next match"
  live_key "$LIVE_TUI_SESSION" Escape
  live_require_absence "$LIVE_TUI_SESSION" "Keyboard shortcuts" 10 "help closed"
}

live_check_plugin() {
  local plugins
  live_wait_for "$LIVE_START_TIMEOUT" "ensemble.v2 plugin registration" live_plugin_registered \
    || live_fail "ensemble.v2 is not active"
  plugins=$(curl -fsS --max-time 10 -u "opencode:$LIVE_SERVER_PASSWORD" "$LIVE_SERVER_URL/api/plugin")
  grep -qF "ensemble.v2" <<<"$plugins" || live_fail "ensemble.v2 is not active"
}

live_plugin_registered() {
  curl -fsS --max-time 5 -u "opencode:$LIVE_SERVER_PASSWORD" "$LIVE_SERVER_URL/api/plugin" 2>/dev/null \
    | grep -qF "ensemble.v2"
}

# --- RPC ------------------------------------------------------------------

live_url_encode() {
  "$LIVE_NODE_BIN" -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"
}

live_rpc_body() {
  local directory="$1" action="$2" payload="$3"
  if [[ -n "$action" ]]; then
    "$LIVE_NODE_BIN" -e 'process.stdout.write(JSON.stringify({input:{directory:process.argv[1],action:process.argv[2],payload:JSON.parse(process.argv[3])}}))' \
      "$directory" "$action" "$payload"
  else
    "$LIVE_NODE_BIN" -e 'process.stdout.write(JSON.stringify({input:{directory:process.argv[1]}}))' "$directory"
  fi
}

live_rpc() {
  local method="$1" body="$2" directory="${3:-$LIVE_PROJECT}"
  local encoded
  encoded=$(live_url_encode "$directory")
  curl -fsS --max-time 30 -u "opencode:$LIVE_SERVER_PASSWORD" \
    -H 'content-type: application/json' -X POST \
    --data-binary "$body" \
    "$LIVE_SERVER_URL/api/rpc/ensemble.v2/$method?location%5Bdirectory%5D=$encoded"
}

live_snapshot() {
  local directory="${1:-$LIVE_PROJECT}" body
  body=$(live_rpc_body "$directory" "" "{}")
  live_rpc snapshot "$body" "$directory"
}

live_invoke() {
  local action="$1" payload="$2" body
  body=$(live_rpc_body "$LIVE_PROJECT" "$action" "$payload")
  live_rpc invoke "$body"
}

live_snapshot_output() {
  "$LIVE_NODE_BIN" -e '
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { value += chunk });
    process.stdin.on("end", () => {
      const parsed = JSON.parse(value);
      process.stdout.write(JSON.stringify(parsed.output));
    });
  '
}

live_snapshot_has_model() {
  local provider="$1" model="$2" output
  output=$(live_snapshot 2>/dev/null | live_snapshot_output 2>/dev/null) || return 1
  [[ -n "$output" ]] || return 1
  printf '%s' "$output" | "$LIVE_NODE_BIN" -e '
    const output = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    const models = Array.isArray(output.models) ? output.models : [];
    process.exit(models.some((item) => item.providerID === process.argv[1] && item.modelID === process.argv[2]) ? 0 : 1);
  ' "$provider" "$model" >/dev/null 2>&1
}

live_wait_for_model() {
  local provider="$1" model="$2" seconds="${3:-$LIVE_STEP_TIMEOUT}"
  live_wait_for "$seconds" "model $provider/$model in the Ensemble catalog" \
    live_snapshot_has_model "$provider" "$model" \
    || live_fail "Ensemble catalog never exposed $provider/$model"
}

live_assert_single_model() {
  local provider="$1" model="$2" actual
  actual=$(live_snapshot | live_snapshot_output | "$LIVE_NODE_BIN" -e '
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { value += chunk });
    process.stdin.on("end", () => {
      const output = JSON.parse(value);
      const models = Array.isArray(output.models) ? output.models : [];
      process.stdout.write(models.map((item) => `${item.providerID}/${item.modelID}`).join(","));
    });
  ')
  [[ "$actual" == "$provider/$model" ]] \
    || live_fail "expected only $provider/$model in the Ensemble catalog, found: ${actual:-<none>}"
}

live_snapshot_has_agent_named() {
  local name="$1" output
  output=$(live_snapshot 2>/dev/null | live_snapshot_output 2>/dev/null) || return 1
  [[ -n "$output" ]] || return 1
  printf '%s' "$output" | "$LIVE_NODE_BIN" -e '
    const output = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    const agents = Object.values(output.state?.agents ?? {});
    process.exit(agents.some((agent) => agent.name === process.argv[1] && !agent.archived) ? 0 : 1);
  ' "$name" >/dev/null 2>&1
}

live_snapshot_has_workspace_named() {
  local name="$1" output
  output=$(live_snapshot 2>/dev/null | live_snapshot_output 2>/dev/null) || return 1
  [[ -n "$output" ]] || return 1
  printf '%s' "$output" | "$LIVE_NODE_BIN" -e '
    const output = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    const workspaces = Object.values(output.state?.workspaces ?? {});
    process.exit(workspaces.some((workspace) => workspace.name === process.argv[1] && !workspace.archived) ? 0 : 1);
  ' "$name" >/dev/null 2>&1
}

live_snapshot_value() {
  local expression="$1" output
  output=$(live_snapshot | live_snapshot_output)
  printf '%s' "$output" | "$LIVE_NODE_BIN" -e '
    const output = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    const raw = process.argv[1];
    const expression = raw.startsWith(".") ? `output${raw}` : raw;
    const value = Function("output", `return (${expression})`)(output);
    process.stdout.write(JSON.stringify(value === undefined ? null : value));
  ' "$expression"
}

# --- subtask waits and diagnostics ----------------------------------------

# One reader for subtask rows. `field` prints one value and stays silent when
# the row/field is absent; `report` prints the timeout diagnostic to stderr.
# Keeping one parser means polling and diagnostics cannot drift apart.
live_subtask_read() {
  local mode="$1" title="$2" field="${3:-}"
  live_snapshot 2>/dev/null | live_snapshot_output 2>/dev/null | "$LIVE_NODE_BIN" -e '
    const raw = require("fs").readFileSync(0, "utf8");
    if (!raw) process.exit(0);
    const output = JSON.parse(raw);
    const title = process.argv[1];
    const mode = process.argv[2];
    const tasks = Object.values(output.state?.subtasks ?? {});
    const task = tasks.find((item) => item.title === title);
    if (mode === "field") {
      const value = task?.[process.argv[3]];
      if (value !== undefined && value !== null) {
        process.stdout.write(typeof value === "object" ? JSON.stringify(value) : String(value));
      }
    } else {
      const counts = { pending: 0, working: 0, replied: 0 };
      for (const item of tasks) if (counts[item.state] !== undefined) counts[item.state] += 1;
      const fields = ["id", "workspaceID", "assigneeID", "state", "stage", "outcome", "attempts", "activeRunID", "claimedBy", "awaitingChildren", "approvalID", "error", "createdAt", "startedAt", "repliedAt", "runSummary"];
      const row = task
        ? Object.fromEntries(fields.filter((name) => task[name] !== undefined).map((name) => [name, task[name]]))
        : null;
      const workspaces = Object.values(output.state?.workspaces ?? {})
        .map((workspace) => `#${workspace.name}${workspace.paused ? " (paused)" : ""}`)
        .join(", ") || "none";
      console.error(`live: task: ${row ? JSON.stringify(row) : "not found"}`);
      console.error(`live: tasks: pending=${counts.pending} working=${counts.working} replied=${counts.replied} total=${tasks.length}`);
      console.error(`live: rows: ${tasks.map((item) => `${item.title}=${item.state}`).join(", ") || "none"}`);
      console.error(`live: workspaces: ${workspaces}`);
    }
  ' "$title" "$mode" "$field"
}

# Read one field from the subtask with the given exact title. Prints nothing
# when the row or field is absent, so callers can poll without special cases.
live_subtask_field() {
  live_subtask_read field "$1" "$2" 2>/dev/null || true
}

# Print a compact snapshot diagnostic when a scheduled task does not reach its
# expected state in time. The scenario still fails; this only makes the
# timeout actionable (state, attempts, queue ownership, active rows).
live_report_subtasks() {
  local title="$1" seconds="$2"
  echo "live: subtask diagnostic after ${seconds}s waiting for \"$title\"" >&2
  live_subtask_read report "$title" || echo "live: subtask diagnostic unavailable" >&2
}

# Bounded wait for a subtask state. The caller chooses the bound; a timeout
# prints the diagnostic above and returns nonzero so the scenario can fail.
live_wait_for_subtask_status() {
  local title="$1" expected="$2" seconds="${3:-$LIVE_STEP_TIMEOUT}"
  local deadline state
  deadline=$(( $(date +%s%N) + seconds * 1000000000 ))
  while true; do
    state=$(live_subtask_field "$title" state)
    [[ "$state" == "$expected" ]] && return 0
    if (( $(date +%s%N) >= deadline )); then
      live_report_subtasks "$title" "$seconds"
      return 1
    fi
    sleep "${ENSEMBLE_LIVE_SUBTASK_INTERVAL:-0.5}"
  done
}

# --- failure context, preserve, cleanup -----------------------------------

live_redact() {
  local secret="${LIVE_SERVER_PASSWORD:-}"
  if [[ -n "$secret" ]]; then
    awk -v secret="$secret" '{ while (pos = index($0, secret)) $0 = substr($0, 1, pos - 1) "[redacted]" substr($0, pos + length(secret)); print }'
  else
    cat
  fi | sed -E \
      -e 's#//[^/[:space:]:@]+:[^/[:space:]@]+@#//[redacted]@#g' \
      -e 's/\bsk-[A-Za-z0-9._-]{8,}/[redacted]/g' \
      -e 's/\bgh[pousr]_[A-Za-z0-9_]{12,}/[redacted]/g' \
      -e 's/\b(Bearer|Basic)[[:space:]]+[A-Za-z0-9._~+/=-]+/\1 [redacted]/g' \
    | grep -v -i -E 'password|secret|token|key' || true
  return 0
}

live_dump_context() {
  local session log shown=0
  echo "live: failure context" >&2
  for session in "${LIVE_SESSION_NAMES[@]}"; do
    if "$LIVE_TMUX_BIN" has-session -t "$session" 2>/dev/null; then
      echo "--- tmux pane: $session ---" >&2
      live_capture "$session" | live_redact | tail -n 80 >&2 || true
      shown=1
    fi
  done
  for log in "$LIVE_LOGS/server.log" "$LIVE_LOGS/tui.log" "$LIVE_LOGS/fake.log"; do
    if [[ -f "$log" ]]; then
      echo "--- log: $log (tail) ---" >&2
      tail -n 80 "$log" | live_redact >&2 || true
      shown=1
    fi
  done
  if [[ "$shown" == "0" ]]; then
    echo "live: no pane or log output was available" >&2
  fi
}

live_print_preserved() {
  local session
  echo "live: preserved failure state (ENSEMBLE_LIVE_KEEP=1)" >&2
  echo "  base: $LIVE_BASE" >&2
  echo "  logs: $LIVE_LOGS" >&2
  for session in "${LIVE_SESSION_NAMES[@]}"; do
    if "$LIVE_TMUX_BIN" has-session -t "$session" 2>/dev/null; then
      echo "  session: $session (tmux attach -t $session)" >&2
    fi
  done
}

# --- failure artifact retention (CI) --------------------------------------
#
# CI sets ENSEMBLE_LIVE_FAILURE_ARTIFACTS to a deterministic root and uploads
# it only when the job fails. Retain only harness-written diagnostics, pass
# every file through the same redaction as failure output, and never copy the
# isolated HOME, config, project, dependency tree, fake URL, or host
# descriptors. A successful run writes nothing.
live_retain_failure_artifacts() {
  local dest="$1" file name service_logs session
  mkdir -p "$dest/logs" "$dest/service-logs" "$dest/captures" || return 1
  printf 'scenario: %s\nexit_status: %s\n' \
    "${LIVE_KIND:-unknown}" "${LIVE_EXIT_STATUS:-1}" >"$dest/meta.txt" || return 1
  # A mid-run failure may happen before the scenario reaches its own doctor
  # step. Take one fresh read-only snapshot when the isolated server was up;
  # the doctor never writes files or reads task content.
  if [[ -n "$LIVE_SERVER_URL" && -n "$LIVE_NODE_BIN" && -f "$LIVE_ROOT/src/v2/doctor-cli.ts" ]]; then
    OPENCODE_PASSWORD="$LIVE_SERVER_PASSWORD" "$LIVE_NODE_BIN" --experimental-strip-types \
      "$LIVE_ROOT/src/v2/doctor-cli.ts" --server "$LIVE_SERVER_URL" "$LIVE_PROJECT" 2>&1 \
      | live_redact >"$dest/logs/doctor-failure.txt" || true
  fi
  if [[ -n "$LIVE_LOGS" && -d "$LIVE_LOGS" ]]; then
    for file in "$LIVE_LOGS"/*; do
      [[ -f "$file" ]] || continue
      name=$(basename "$file")
      # Proven harness outputs only. A future scenario file stays out until it
      # is reviewed and added here.
      case "$name" in
        server.log|tui.log|fake.log|doctor.txt|doctor.json) ;;
        multilocation.json|dispatch-budgets.json|log-summary.json|log-summary-*.json) ;;
        *) continue ;;
      esac
      live_redact <"$file" >"$dest/logs/$name" || true
    done
  fi
  # Only the isolated XDG state directory is trusted here. Never fall back to
  # an ambient ENSEMBLE_LOG_DIR: an exported override can point at real host
  # logs, which must not cross the CI artifact privacy boundary.
  service_logs=""
  if [[ -n "$LIVE_STATE" ]]; then
    service_logs="$LIVE_STATE/ensemble/logs"
  fi
  if [[ -n "$service_logs" && -d "$service_logs" ]]; then
    for file in "$service_logs"/*.jsonl; do
      [[ -f "$file" ]] || continue
      name=$(basename "$file")
      live_redact <"$file" >"$dest/service-logs/$name" || true
    done
  fi
  if [[ -n "$LIVE_TMUX_BIN" ]]; then
    for session in "${LIVE_SESSION_NAMES[@]}"; do
      "$LIVE_TMUX_BIN" has-session -t "$session" 2>/dev/null || continue
      live_capture "$session" | live_redact >"$dest/captures/$session.txt" || true
    done
  fi
  printf 'live: retained failure artifacts at %s\n' "$dest" >&2
}

live_cleanup() {
  local session pid
  for session in "${LIVE_SESSION_NAMES[@]}"; do
    "$LIVE_TMUX_BIN" kill-session -t "$session" 2>/dev/null || true
  done
  if [[ -n "$LIVE_BASE" && -d "$LIVE_BASE" ]]; then
    rm -rf "$LIVE_BASE"
  fi
}

live_on_exit() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  LIVE_EXIT_STATUS="$status"
  if (( status != 0 )); then
    live_dump_context
    if [[ -n "${ENSEMBLE_LIVE_FAILURE_ARTIFACTS:-}" ]]; then
      live_retain_failure_artifacts \
        "${ENSEMBLE_LIVE_FAILURE_ARTIFACTS}/${LIVE_KIND:-live}" || true
    fi
  fi
  if (( status != 0 )) && live_keep_enabled; then
    live_print_preserved
  else
    live_cleanup
  fi
  exit "$status"
}
