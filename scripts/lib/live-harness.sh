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
#
# Scenarios must call live_require_runtime (and live_require_node when they
# need Node) before live_setup, and live_setup before any live_start_* helper.
# Linux-first by design because it uses tmux.
#
# Set ENSEMBLE_LIVE_REQUIRE=1 to turn a missing prerequisite into a failure.
# Local runs keep the historical skip-and-exit-zero behavior; CI uses require
# mode so a skipped suite cannot look green.

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

live_log() { printf 'live: %s\n' "$*"; }
live_debug() { [[ "${ENSEMBLE_LIVE_DEBUG:-0}" == "1" ]] && printf 'live: %s\n' "$*" >&2 || true; }
live_require_enabled() { [[ "${ENSEMBLE_LIVE_REQUIRE:-0}" == "1" ]]; }
# Local runs keep the skip contract. Require mode (CI) treats the same missing
# prerequisite as a hard failure instead of exiting zero.
live_skip() {
  if live_require_enabled; then
    live_fail "$* (required; ENSEMBLE_LIVE_REQUIRE=1)"
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
    "$(live_command "$LIVE_NODE_BIN" "$script" --url-file "$LIVE_FAKE_URL_FILE") >'$LIVE_LOGS/fake.log' 2>&1"
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
  live_type "$LIVE_TUI_SESSION" "delete workspace"
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
  "$LIVE_NODE_BIN" -e '
    const output = JSON.parse(process.argv[1]);
    const models = Array.isArray(output.models) ? output.models : [];
    process.exit(models.some((item) => item.providerID === process.argv[2] && item.modelID === process.argv[3]) ? 0 : 1);
  ' "$output" "$provider" "$model" >/dev/null 2>&1
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
  "$LIVE_NODE_BIN" -e '
    const output = JSON.parse(process.argv[1]);
    const agents = Object.values(output.state?.agents ?? {});
    process.exit(agents.some((agent) => agent.name === process.argv[2] && !agent.archived) ? 0 : 1);
  ' "$output" "$name" >/dev/null 2>&1
}

live_snapshot_has_workspace_named() {
  local name="$1" output
  output=$(live_snapshot 2>/dev/null | live_snapshot_output 2>/dev/null) || return 1
  [[ -n "$output" ]] || return 1
  "$LIVE_NODE_BIN" -e '
    const output = JSON.parse(process.argv[1]);
    const workspaces = Object.values(output.state?.workspaces ?? {});
    process.exit(workspaces.some((workspace) => workspace.name === process.argv[2] && !workspace.archived) ? 0 : 1);
  ' "$output" "$name" >/dev/null 2>&1
}

live_snapshot_value() {
  local expression="$1" output
  output=$(live_snapshot | live_snapshot_output)
  "$LIVE_NODE_BIN" -e '
    const output = JSON.parse(process.argv[1]);
    const raw = process.argv[2];
    const expression = raw.startsWith(".") ? `output${raw}` : raw;
    const value = Function("output", `return (${expression})`)(output);
    process.stdout.write(JSON.stringify(value === undefined ? null : value));
  ' "$output" "$expression"
}

# --- subtask waits and diagnostics ----------------------------------------

# Read one field from the subtask with the given exact title. Prints nothing
# when the row or field is absent, so callers can poll without special cases.
live_subtask_field() {
  local title="$1" field="$2"
  live_snapshot 2>/dev/null | live_snapshot_output 2>/dev/null | "$LIVE_NODE_BIN" -e '
    const raw = require("fs").readFileSync(0, "utf8");
    if (!raw) process.exit(0);
    const output = JSON.parse(raw);
    const task = Object.values(output.state?.subtasks ?? {}).find((item) => item.title === process.argv[1]);
    const value = task?.[process.argv[2]];
    if (value === undefined || value === null) process.exit(0);
    process.stdout.write(typeof value === "object" ? JSON.stringify(value) : String(value));
  ' "$title" "$field" 2>/dev/null || true
}

# Print a compact snapshot diagnostic when a scheduled task does not reach its
# expected state in time. The scenario still fails; this only makes the
# timeout actionable (state, attempts, queue ownership, active rows).
live_report_subtasks() {
  local title="$1" seconds="$2"
  echo "live: subtask diagnostic after ${seconds}s waiting for \"$title\"" >&2
  live_snapshot 2>/dev/null | live_snapshot_output 2>/dev/null | "$LIVE_NODE_BIN" -e '
    const raw = require("fs").readFileSync(0, "utf8");
    const output = JSON.parse(raw);
    const title = process.argv[1];
    const tasks = Object.values(output.state?.subtasks ?? {});
    const task = tasks.find((item) => item.title === title);
    const counts = { pending: 0, working: 0, replied: 0 };
    for (const item of tasks) if (counts[item.state] !== undefined) counts[item.state] += 1;
    const fields = ["id", "workspaceID", "assigneeID", "state", "stage", "outcome", "attempts", "activeRunID", "claimedBy", "awaitingChildren", "approvalID", "error", "createdAt", "startedAt", "repliedAt", "runSummary"];
    const row = task
      ? Object.fromEntries(fields.filter((field) => task[field] !== undefined).map((field) => [field, task[field]]))
      : null;
    const workspaces = Object.values(output.state?.workspaces ?? {})
      .map((workspace) => `#${workspace.name}${workspace.paused ? " (paused)" : ""}`)
      .join(", ") || "none";
    console.error(`live: task: ${row ? JSON.stringify(row) : "not found"}`);
    console.error(`live: tasks: pending=${counts.pending} working=${counts.working} replied=${counts.replied} total=${tasks.length}`);
    console.error(`live: rows: ${tasks.map((item) => `${item.title}=${item.state}`).join(", ") || "none"}`);
    console.error(`live: workspaces: ${workspaces}`);
  ' "$title" >&2 || echo "live: subtask diagnostic unavailable" >&2
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
    awk -v secret="$secret" '{ while (pos = index($0, secret)) $0 = substr($0, 1, pos - 1) "[redacted]" substr($0, pos + length(secret)); print }' | grep -v -i -E 'password|secret|token|key' || true
    return 0
  fi
  grep -v -i -E 'password|secret|token|key' || true
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
  if (( status != 0 )); then
    live_dump_context
  fi
  if (( status != 0 )) && live_keep_enabled; then
    live_print_preserved
  else
    live_cleanup
  fi
  exit "$status"
}
