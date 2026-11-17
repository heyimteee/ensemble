#!/usr/bin/env bash
set -euo pipefail
if [[ "${ENSEMBLE_LIVE_TRACE_ERR:-0}" == "1" ]]; then
  trap 'printf "live: command failed at line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
fi

# Ticket #276: repeatable fake-provider soak/leak run.
#
# Samples service/TUI RSS, durable messages/tasks, queue depth, native state,
# store bytes, and structured-log sink counters. The record is JSONL and is
# reduced by `scripts/soak-report.mjs`.
#
#   npm run soak:smoke                 # ~3 minutes, observe-only, local/CI
#   npm run soak                       # 4 hours, enforced
#   npm run soak -- --duration 900     # shorter full-mode run (still enforced)
#
# Environment:
#   ENSEMBLE_SOAK_DURATION_SECONDS      default 14400 (4 h); --smoke forces 180
#   ENSEMBLE_SOAK_SAMPLE_SECONDS        default 60; --smoke forces 15
#   ENSEMBLE_SOAK_BURST                 messages per cycle, default 2
#   ENSEMBLE_SOAK_AGENTS                agents, default 4
#   ENSEMBLE_SOAK_WORKSPACES            workspaces, default 2
#   ENSEMBLE_SOAK_CYCLE_PAUSE_SECONDS   default 5
#   ENSEMBLE_SOAK_MAX_RSS_MB_PER_HOUR   enforced absolute growth gate, default 256
#   ENSEMBLE_SOAK_MAX_RSS_MB_PER_1000_MESSAGES  normalized growth gate, default 64
#   ENSEMBLE_SOAK_ENFORCE              1 to enforce the gate (full mode default)
#   ENSEMBLE_SOAK_OUT                   output directory for samples/report
#
# Linux/tmux only, matching the live harness. The fake provider is deterministic;
# no real model, credential, or conversation content is used. A failure keeps
# the usual redacted live-harness artifacts when the matrix sets them.

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
source "$SCRIPT_DIR/lib/live-harness.sh"

usage() {
  cat <<'EOF'
usage: bash scripts/soak-fake.sh [--smoke] [--duration SECONDS] [--enforce|--no-enforce] [--help]

  --smoke         Short local/CI run (180 s, observe-only) that still records
                  every growth metric. A smoke pass is not a multi-hour pass.
  --duration N    Override the run duration in seconds.
  --enforce       Fail when RSS growth exceeds the gate, or queue/native work
                  does not settle by the tail.
  --no-enforce    Record findings without failing.
EOF
}

mode="full"
duration="${ENSEMBLE_SOAK_DURATION_SECONDS:-14400}"
sample_interval="${ENSEMBLE_SOAK_SAMPLE_SECONDS:-60}"
burst="${ENSEMBLE_SOAK_BURST:-2}"
agent_count="${ENSEMBLE_SOAK_AGENTS:-4}"
workspace_count="${ENSEMBLE_SOAK_WORKSPACES:-2}"
cycle_pause="${ENSEMBLE_SOAK_CYCLE_PAUSE_SECONDS:-5}"
max_rss="${ENSEMBLE_SOAK_MAX_RSS_MB_PER_HOUR:-256}"
max_rss_per_message="${ENSEMBLE_SOAK_MAX_RSS_MB_PER_1000_MESSAGES:-64}"
enforce="${ENSEMBLE_SOAK_ENFORCE:-1}"

while (( $# > 0 )); do
  case "$1" in
    --smoke)
      mode="smoke"
      duration=180
      sample_interval=15
      burst=2
      agent_count=2
      workspace_count=1
      cycle_pause=2
      enforce=0
      shift
      ;;
    --duration)
      duration="${2:-}"
      [[ "$duration" =~ ^[0-9]+$ ]] || { printf 'soak: --duration needs a positive integer\n' >&2; exit 2; }
      shift 2
      ;;
    --enforce) enforce=1; shift ;;
    --no-enforce) enforce=0; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

(( duration > 0 )) || { printf 'soak: duration must be positive\n' >&2; exit 2; }
(( sample_interval > 0 )) || { printf 'soak: sample interval must be positive\n' >&2; exit 2; }
(( agent_count > 0 && workspace_count > 0 )) || { printf 'soak: agents and workspaces must be positive\n' >&2; exit 2; }

live_require_runtime
live_require_node
live_require_support_tool du
live_setup "soak"

SOAK_STARTED_MS=$(date +%s%3N)
SOAK_DEADLINE=$(( $(date +%s) + duration ))
SOAK_SAMPLES="$LIVE_LOGS/soak.jsonl"
SOAK_ERRORS="$LIVE_LOGS/soak-errors.log"
SOAK_DIAG="$LIVE_LOGS/diagnostic.json"
SOAK_DIAG_ERR="$LIVE_LOGS/diagnostic.err"
SOAK_STOP="$LIVE_LOGS/soak.stop"
: >"$SOAK_SAMPLES"
: >"$SOAK_ERRORS"
rm -f "$SOAK_STOP" "$SOAK_DIAG" "$SOAK_DIAG_ERR"
SOAK_RESULT_DIR="${ENSEMBLE_SOAK_OUT:-${ENSEMBLE_LIVE_ARTIFACTS:-${TMPDIR:-/tmp}/opencode/ensemble-soak-$(date +%Y%m%d-%H%M%S)-$$}}"
mkdir -p "$SOAK_RESULT_DIR"

live_log "soak: mode=$mode duration=${duration}s sample=${sample_interval}s burst=$burst agents=$agent_count workspaces=$workspace_count enforce=$enforce"
live_log "soak: output $SOAK_RESULT_DIR"

ENSEMBLE_LIVE_TUI_WIDTH="${ENSEMBLE_LIVE_TUI_WIDTH:-160}"
ENSEMBLE_LIVE_TUI_HEIGHT="${ENSEMBLE_LIVE_TUI_HEIGHT:-60}"

# A fast deterministic stream. The soak measures Ensemble, not model latency;
# this keeps a multi-hour run productive without changing any product path.
live_start_fake_provider --initial-delay-ms 50 --chunk-delay-ms 5 --turn-start-delay-ms 50

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
      "settings": { "baseURL": "$LIVE_FAKE_URL/v1" },
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

soak_json_lines() {
  "$LIVE_NODE_BIN" -e '
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { value += chunk });
    process.stdin.on("end", () => {
      let parsed;
      try { parsed = JSON.parse(value) } catch { process.exit(0) }
      for (const item of Array.isArray(parsed) ? parsed : []) process.stdout.write(`${item}\n`);
    });
  '
}

soak_agents_ready() {
  local count
  count=$(live_snapshot_value 'Object.values(output.state.agents).filter(function (agent) { return agent.name.indexOf("SoakAgent") === 0 }).length' 2>/dev/null | tr -d '"') || return 1
  [[ -n "$count" && "$count" -ge "$agent_count" ]]
}

soak_workspaces_ready() {
  local count
  count=$(live_snapshot_value 'Object.values(output.state.workspaces).filter(function (workspace) { return workspace.name.indexOf("SoakWS") === 0 }).length' 2>/dev/null | tr -d '"') || return 1
  [[ -n "$count" && "$count" -ge "$workspace_count" ]]
}

for ((index = 1; index <= agent_count; index++)); do
  live_invoke agent.create "{\"name\":\"SoakAgent$index\",\"title\":\"Soak fixture $index\",\"role\":\"Soak fixture. No product content.\",\"mainModel\":{\"providerID\":\"ensemble-fake\",\"modelID\":\"ensemble-fake-model\"}}" >/dev/null
done
live_wait_for "$LIVE_STEP_TIMEOUT" "$agent_count soak agents" soak_agents_ready \
  || live_fail "soak agents were not created"
mapfile -t AGENT_IDS < <(live_snapshot_value 'Object.values(output.state.agents).filter(function (agent) { return agent.name.indexOf("SoakAgent") === 0 }).map(function (agent) { return agent.id })' | soak_json_lines)
(( ${#AGENT_IDS[@]} >= agent_count )) || live_fail "soak agent ids are missing (${#AGENT_IDS[@]} of $agent_count)"

for ((workspace = 1; workspace <= workspace_count; workspace++)); do
  member_ids=""
  for ((member = 0; member < agent_count; member++)); do
    id="${AGENT_IDS[$member]}"
    [[ -n "$member_ids" ]] && member_ids+=","
    member_ids+="\"$id\""
  done
  leader="${AGENT_IDS[$((workspace - 1)) % ${#AGENT_IDS[@]}]}"
  workspace_directory="$LIVE_PROJECT/soak-ws$workspace"
  mkdir -p "$workspace_directory"
  if ! live_invoke workspace.create "{\"directory\":\"$workspace_directory\",\"name\":\"SoakWS$workspace\",\"memberIDs\":[$member_ids],\"leaderID\":\"$leader\"}" >/dev/null; then
    live_log "soak: workspace $workspace invoke failed"
  fi
done
live_wait_for "$LIVE_STEP_TIMEOUT" "$workspace_count soak workspaces" soak_workspaces_ready \
  || live_fail "soak workspaces were not created"
mapfile -t WORKSPACE_IDS < <(live_snapshot_value 'Object.values(output.state.workspaces).filter(function (workspace) { return workspace.name.indexOf("SoakWS") === 0 }).map(function (workspace) { return workspace.id })' | soak_json_lines)
(( ${#WORKSPACE_IDS[@]} >= workspace_count )) || live_fail "soak workspace ids are missing (${#WORKSPACE_IDS[@]} of $workspace_count)"

if [[ "${ENSEMBLE_SOAK_TUI:-1}" == "1" ]]; then
  live_start_tui
  live_wait_for_native_tui
  live_open_ensemble
  live_require_text "$LIVE_TUI_SESSION" "#SoakWS1" 20 "soak workspace surface"
else
  live_log "soak: TUI disabled (ENSEMBLE_SOAK_TUI=0); service-only memory sample"
fi

SERVICE_PANE_PID=$("$LIVE_TMUX_BIN" list-panes -t "$LIVE_SERVE_SESSION" -F '#{pane_pid}' 2>/dev/null | head -n1 || true)
TUI_PANE_PID=""
if [[ "${ENSEMBLE_SOAK_TUI:-1}" == "1" ]]; then
  TUI_PANE_PID=$("$LIVE_TMUX_BIN" list-panes -t "$LIVE_TUI_SESSION" -F '#{pane_pid}' 2>/dev/null | head -n1 || true)
fi
soak_active_count() {
  local body output
  body=$(live_rpc_body "$LIVE_PROJECT" "" "{}")
  output=$(live_rpc "work.project" "$body" 2>/dev/null) || return 1
  printf '%s' "$output" | "$LIVE_NODE_BIN" -e '
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { value += chunk });
    process.stdin.on("end", () => {
      let parsed;
      try { parsed = JSON.parse(value) } catch { process.exit(1) }
      const tasks = Object.values(parsed?.output?.tasks ?? {});
      process.stdout.write(String(tasks.filter((task) => task.state === "pending" || task.state === "working").length));
    });
  '
}

soak_wait_idle() {
  local seconds="$1" deadline active
  deadline=$(( $(date +%s) + seconds ))
  while true; do
    if active=$(soak_active_count); then
      [[ "$active" == "0" ]] && return 0
    fi
    if (( $(date +%s) >= deadline )); then
      printf 'soak: queue did not settle within %ss (active=%s)\n' "$seconds" "${active:-unknown}" >&2
      return 1
    fi
    sleep 1
  done
}

soak_send() {
  local workspace="$1" agent="$2" text="$3" result
  result=$(live_invoke message.send "{\"workspaceID\":\"$workspace\",\"text\":\"$text\",\"recipientIDs\":[\"$agent\"]}") \
    || return 1
  printf '%s' "$result" | "$LIVE_NODE_BIN" -e '
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { value += chunk });
    process.stdin.on("end", () => {
      try {
        const parsed = JSON.parse(value);
        process.exit((parsed?.output?.ok ?? parsed?.ok) === true ? 0 : 1);
      } catch { process.exit(1) }
    });
  '
}

soak_sample_once() {
  local at elapsed start end bytes ms storage_kb body
  at=$(date +%s%3N)
  elapsed=$(( (at - SOAK_STARTED_MS) / 1000 ))
  body=$(live_rpc_body "$LIVE_PROJECT" "" "{}")
  start=$(date +%s%3N)
  if ! live_rpc diagnostic "$body" >"$SOAK_DIAG" 2>"$SOAK_DIAG_ERR"; then
    printf 'soak: sample failed at %ss: %s\n' "$elapsed" "$(tail -n 1 "$SOAK_DIAG_ERR" 2>/dev/null || true)" >>"$SOAK_ERRORS"
    rm -f "$SOAK_DIAG" "$SOAK_DIAG_ERR"
    return 1
  fi
  end=$(date +%s%3N)
  bytes=$(stat -c%s "$SOAK_DIAG" 2>/dev/null || stat -f%z "$SOAK_DIAG" 2>/dev/null || printf '0')
  ms=$(( end - start ))
  storage_kb=$(du -sk "$LIVE_DATA" "$LIVE_STATE" 2>/dev/null | awk '{ total += $1 } END { print total + 0 }')
  if ! "$LIVE_NODE_BIN" --experimental-strip-types "$SCRIPT_DIR/soak-sample.mjs" \
      --diagnostic "$SOAK_DIAG" \
      --at "$at" \
      --elapsed "$elapsed" \
      --server-pid "${SERVICE_PANE_PID:-0}" \
      --tui-pid "${TUI_PANE_PID:-0}" \
      --storage-bytes "$(( storage_kb * 1024 ))" \
      --diagnostic-bytes "$bytes" \
      --diagnostic-ms "$ms" >>"$SOAK_SAMPLES"; then
    printf 'soak: sampler failed at %ss\n' "$elapsed" >>"$SOAK_ERRORS"
  fi
  rm -f "$SOAK_DIAG" "$SOAK_DIAG_ERR"
}

soak_sample_loop() {
  while [[ ! -f "$SOAK_STOP" ]]; do
    soak_sample_once || true
    sleep "$sample_interval"
  done
}

soak_sample_loop &
SAMPLER_PID=$!
soak_on_exit() {
  local status=$?
  rm -f "$SOAK_STOP" 2>/dev/null || true
  if [[ -n "${SAMPLER_PID:-}" ]]; then kill "$SAMPLER_PID" 2>/dev/null || true; fi
  if [[ -s "${SOAK_SAMPLES:-}" ]]; then cp "$SOAK_SAMPLES" "$SOAK_RESULT_DIR/soak.jsonl" 2>/dev/null || true; fi
  if [[ -s "${SOAK_ERRORS:-}" ]]; then cp "$SOAK_ERRORS" "$SOAK_RESULT_DIR/soak-errors.log" 2>/dev/null || true; fi
  ( exit "$status" )
  live_on_exit
}
trap soak_on_exit EXIT

live_log "soak: workload start"
cycles=0
sent=0
failed=0
index=0
while (( $(date +%s) < SOAK_DEADLINE )); do
  for ((message = 1; message <= burst; message++)); do
    workspace="${WORKSPACE_IDS[$((index % ${#WORKSPACE_IDS[@]}))]}"
    agent="${AGENT_IDS[$((index % ${#AGENT_IDS[@]}))]}"
    if soak_send "$workspace" "$agent" "soak c${cycles} m${message}"; then
      sent=$((sent + 1))
    else
      failed=$((failed + 1))
      printf 'soak: message.send failed at cycle %s\n' "$cycles" >>"$SOAK_ERRORS"
    fi
    index=$((index + 1))
  done
  # Every fourth cycle adds a short backlog on the first agent, so queue depth
  # is exercised rather than only the fully-idle steady state.
  if (( cycles % 4 == 3 )); then
    for extra in 1 2; do
      if soak_send "${WORKSPACE_IDS[0]}" "${AGENT_IDS[0]}" "soak c${cycles} backlog${extra}"; then
        sent=$((sent + 1))
      else
        failed=$((failed + 1))
      fi
    done
  fi
  soak_wait_idle 180 || { failed=$((failed + 1)); printf 'soak: queue did not settle in cycle %s\n' "$cycles" >>"$SOAK_ERRORS"; }
  cycles=$((cycles + 1))
  if (( failed > 20 )); then
    live_fail "soak aborted after $failed failed operations"
  fi
  sleep "$cycle_pause"
done

soak_wait_idle 300 || true
: >"$SOAK_STOP"
wait "$SAMPLER_PID" 2>/dev/null || true
# Record the settled tail after the final drain, never a mid-cycle sample.
soak_sample_once || true
live_log "soak: workload done cycles=$cycles sent=$sent failed=$failed"

WARMUP=$(( duration / 10 ))
(( WARMUP > 1200 )) && WARMUP=1200
(( WARMUP < 30 )) && WARMUP=30
REPORT_ARGS=(--samples "$SOAK_SAMPLES" --out "$SOAK_RESULT_DIR/soak-summary.json" --warmup-seconds "$WARMUP" --max-rss-mb-per-hour "$max_rss" --max-rss-mb-per-1000-messages "$max_rss_per_message")
if [[ "$enforce" == "1" ]]; then REPORT_ARGS+=(--enforce); fi
set +e
"$LIVE_NODE_BIN" --experimental-strip-types "$SCRIPT_DIR/soak-report.mjs" "${REPORT_ARGS[@]}"
report_status=$?
set -e

cp "$SOAK_SAMPLES" "$SOAK_RESULT_DIR/soak.jsonl" 2>/dev/null || true
if [[ -s "$SOAK_ERRORS" ]]; then cp "$SOAK_ERRORS" "$SOAK_RESULT_DIR/soak-errors.log" 2>/dev/null || true; fi
if [[ -f "$SOAK_RESULT_DIR/soak-summary.json" ]]; then
  live_log "soak: record $SOAK_RESULT_DIR/soak-summary.json"
fi

if (( report_status != 0 )); then
  live_fail "soak gate failed (see $SOAK_RESULT_DIR/soak-summary.json)"
fi
if [[ "$mode" == "smoke" ]]; then
  live_log "soak: smoke complete; this is a short observation, not the multi-hour gate"
else
  live_log "soak: full run complete in ${duration}s"
fi
