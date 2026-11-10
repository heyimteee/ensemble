#!/usr/bin/env bash
set -euo pipefail
if [[ "${ENSEMBLE_LIVE_TRACE_ERR:-0}" == "1" ]]; then
  trap 'printf "live: command failed at line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
fi

# Ticket #165/#177 lifecycle verification.
#
# A full wall-clock run crossing the old five-minute delivery deadline while its
# heartbeat lease stays live, plus a queue backlog that waits past the same
# deadline without failing. The fake provider streams one chunk every two
# seconds for 170 chunks (~5m40s); the service heartbeats every 20s and only a
# lost lease can retry it. The backlog message is sent immediately and stays
# pending past its delivery timestamp, then runs when the first turn finishes.
#
#   npm run test:live:lifecycle
#
# Late-success repair, genuine host interruption, and stalled/retrying labels
# are covered at the service and TUI seams (`service.test.ts`,
# `stream-settlement.test.ts`, `workrows.test.ts`) because no public live RPC
# can inject a stalled row or a host interruption without editing durable state.
# This scenario records those skips explicitly. Linux/tmux only.

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
source "$SCRIPT_DIR/lib/live-harness.sh"

live_require_runtime
live_require_node
live_setup "lifecycle"

live_capture_active_work() {
  live_capture "$1" | grep -Eq 'WORK (ACTIVE|HISTORY) │ [0-9]+ groups? · [1-9][0-9]* active'
}
live_require_active_work() {
  local session="$1" seconds="${2:-$LIVE_STEP_TIMEOUT}" description="${3:-active work}"
  live_wait_for "$seconds" "$description" live_capture_active_work "$session" \
    || live_fail "TUI did not show: $description"
}
live_capture_no_active_work() {
  live_capture "$1" | grep -Eq 'WORK ACTIVE │ none yet|WORK ACTIVE │ 0 groups'
}
live_require_no_active_work() {
  local session="$1" seconds="${2:-$LIVE_STEP_TIMEOUT}" description="${3:-no active work}"
  live_wait_for "$seconds" "$description" live_capture_no_active_work "$session" \
    || live_fail "TUI still shows: $description"
}

ENSEMBLE_LIVE_TUI_WIDTH="${ENSEMBLE_LIVE_TUI_WIDTH:-160}"
ENSEMBLE_LIVE_TUI_HEIGHT="${ENSEMBLE_LIVE_TUI_HEIGHT:-80}"

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

live_invoke agent.create '{"name":"LifeAgent","title":"Lifecycle","role":"Lifecycle fixture.","mainModel":{"providerID":"ensemble-fake","modelID":"ensemble-fake-model"}}' >/dev/null
live_wait_for "$LIVE_STEP_TIMEOUT" "LifeAgent in the snapshot" live_snapshot_has_agent_named "LifeAgent" \
  || live_fail "lifecycle fixture agent was not created"
AGENT_ID=$(live_snapshot_value 'Object.values(output.state.agents).find(function (agent) { return agent.name === "LifeAgent" }).id' | tr -d '"')
live_invoke workspace.create "{\"name\":\"LifeProbe\",\"memberIDs\":[\"$AGENT_ID\"],\"leaderID\":\"$AGENT_ID\"}" >/dev/null
live_wait_for "$LIVE_STEP_TIMEOUT" "LifeProbe in the snapshot" live_snapshot_has_workspace_named "LifeProbe" \
  || live_fail "lifecycle fixture workspace was not created"
WS_ID=$(live_snapshot_value 'Object.values(output.state.workspaces).find(function (workspace) { return workspace.name === "LifeProbe" }).id' | tr -d '"')

live_start_tui
live_wait_for_native_tui
live_open_ensemble
live_require_text "$LIVE_TUI_SESSION" "#LifeProbe" 20 "lifecycle workspace surface"
# A remounted page starts on the rail; l focuses the chat, w opens the workspace.
live_key "$LIVE_TUI_SESSION" "l"
live_key "$LIVE_TUI_SESSION" "w"
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Group chat" 10 "group surface for the lifecycle run"

TASK_START_MS=$(date +%s%3N)
live_invoke "message.send" "{\"workspaceID\":\"$WS_ID\",\"text\":\"fake-lease-hold lease-first\",\"recipientIDs\":[\"$AGENT_ID\"]}" >/dev/null
live_require_active_work "$LIVE_TUI_SESSION" 20 "long lease work mounts"
live_require_text "$LIVE_TUI_SESSION" "LIFEAGENT" 20 "lifecycle card names its agent"
live_require_text "$LIVE_TUI_SESSION" "WORK ACTIVE │ 1 group · 1 active · 0 done" 20 "one active lifecycle group"

first_id=$(live_snapshot_value 'Object.values(output.state.subtasks).filter(function (task) { return task.title.indexOf("lease-first") >= 0 })[0]?.id' | tr -d '"')
[[ -n "$first_id" && "$first_id" != "null" ]] || live_fail "lease-hold task id is missing"
initial_lease=$(live_snapshot_value "output.state.subtasks[\"$first_id\"].leaseUntil")
initial_deadline=$(live_snapshot_value "output.state.subtasks[\"$first_id\"].deadlineAt")
[[ -n "$initial_lease" && "$initial_lease" != "null" ]] || live_fail "lease-hold task has no live lease"
[[ "$initial_deadline" -gt "$TASK_START_MS" ]] || live_fail "lease-hold deadline is not in the future"

# Queue backlog: the second delivery arrives while the first run owns the
# agent session. It must stay pending past its own delivery timestamp.
sleep 2
live_invoke "message.send" "{\"workspaceID\":\"$WS_ID\",\"text\":\"lease-backlog\",\"recipientIDs\":[\"$AGENT_ID\"]}" >/dev/null
live_require_text "$LIVE_TUI_SESSION" "WORK ACTIVE │ 2 groups · 2 active · 0 done" 20 "backlog group joins the active pane"
backlog_id=$(live_snapshot_value 'Object.values(output.state.subtasks).filter(function (task) { return task.title === "lease-backlog" })[0]?.id' | tr -d '"')
[[ -n "$backlog_id" && "$backlog_id" != "null" ]] || live_fail "backlog task id is missing"
backlog_deadline=$(live_snapshot_value "output.state.subtasks[\"$backlog_id\"].deadlineAt")

# Heartbeat evidence at 70s: a live lease keeps the run working past any early
# delivery pressure and the lease timestamp moves forward.
poll_seconds() {
  local seconds="$1" start now
  start=$(date +%s)
  while true; do
    now=$(date +%s)
    (( now - start >= seconds )) && return 0
    sleep 5
  done
}
poll_seconds 70
lease_now=$(live_snapshot_value "output.state.subtasks[\"$first_id\"].leaseUntil")
status_now=$(live_snapshot_value "output.state.subtasks[\"$first_id\"].status" | tr -d '"')
[[ "$status_now" == "working" ]] || live_fail "long run is not working at 70s (got $status_now)"
[[ "$lease_now" -gt "$initial_lease" ]] || live_fail "heartbeat did not renew the lease ($initial_lease -> $lease_now)"
live_require_text "$LIVE_TUI_SESSION" "WORK ACTIVE │ 2 groups · 2 active · 0 done" 10 "long card and backlog stay mounted at 70s"
live_require_text "$LIVE_TUI_SESSION" "LIFEAGENT" 10 "long card stays mounted at 70s"
live_log "heartbeat renewed the live lease at 70s ($initial_lease -> $lease_now)"

# Cross the old five-minute deadline. The first run is still streaming, so the
# delivery timestamp is in the past while the work is truthfully working. The
# queued backlog is past its own delivery timestamp and must stay pending.
poll_seconds 240
elapsed_ms=$(( $(date +%s%3N) - TASK_START_MS ))
now_ms=$(date +%s%3N)
[[ "$now_ms" -gt "$initial_deadline" ]] || live_fail "five-minute deadline has not passed (${elapsed_ms}ms)"
status_past=$(live_snapshot_value "output.state.subtasks[\"$first_id\"].status" | tr -d '"')
backlog_status=$(live_snapshot_value "output.state.subtasks[\"$backlog_id\"].status" | tr -d '"')
backlog_attempts=$(live_snapshot_value "output.state.subtasks[\"$backlog_id\"].attempts")
backlog_deadline_now=$(live_snapshot_value "output.state.subtasks[\"$backlog_id\"].deadlineAt")
[[ "$status_past" == "working" ]] || live_fail "long run left working before its run finished (got $status_past)"
[[ "$backlog_status" == "pending" ]] || live_fail "queued backlog did not stay pending past its delivery window (got $backlog_status)"
[[ "$backlog_attempts" == "0" ]] || live_fail "queued backlog was claimed or retried (attempts $backlog_attempts)"
[[ "$now_ms" -gt "$backlog_deadline_now" ]] || live_fail "backlog delivery timestamp has not passed"
live_require_text "$LIVE_TUI_SESSION" "WORK ACTIVE │ 2 groups · 2 active · 0 done" 10 "card persists past the deadline"
live_require_text "$LIVE_TUI_SESSION" "LIFEAGENT" 10 "working card is still mounted past the deadline"
live_log "delivery deadline crossed while working; backlog stayed pending at ${elapsed_ms}ms"

# The first run finishes after the shortened long stream; the backlog then
# runs normally. No timeout, lease, or queue condition may mark either failed.
live_wait_for_subtask_status "fake-lease-hold lease-first" replied 120 \
  || live_fail "long-run task did not reply"
live_wait_for_subtask_status "lease-backlog" replied 60 \
  || live_fail "backlog task did not run after the long turn"
live_require_no_active_work "$LIVE_TUI_SESSION" 30 "ACTIVE clears after both lifecycle turns"
live_assert_absence "$LIVE_TUI_SESSION" "Reply interrupted." "no interrupted placeholder in the transcript"
live_assert_absence "$LIVE_TUI_SESSION" "FAILED" "no false failed card in the lifecycle run"

# HISTORY keeps both completed groups.
# Ticket #234: `NORMAL  │ Work list` is shared by pane selection and Work
# interaction, and `f` is a Work-interaction key. Use the shared helper to
# Enter the pane, then require `j/k cards` so the history toggle cannot run
# from selection mode.
live_focus_work_interact "$LIVE_TUI_SESSION"
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Work list" 10 "Work focus after the lifecycle run"
live_require_text "$LIVE_TUI_SESSION" "j/k cards" 10 "Work interaction owns its card grammar"
live_key "$LIVE_TUI_SESSION" "f"
live_require_text "$LIVE_TUI_SESSION" "WORK HISTORY │" 10 "completed lifecycle groups move to HISTORY"
live_require_text "$LIVE_TUI_SESSION" "lease-first" 10 "long-run card is retained in HISTORY"
live_require_text "$LIVE_TUI_SESSION" "lease-backlog" 10 "backlog card is retained in HISTORY"
live_require_text "$LIVE_TUI_SESSION" "REPLIED" 10 "both lifecycle cards ended replied"
live_key "$LIVE_TUI_SESSION" "f"
live_key "$LIVE_TUI_SESSION" Escape

# Operator evidence.
OPENCODE_PASSWORD="$LIVE_SERVER_PASSWORD" "$LIVE_NODE_BIN" --experimental-strip-types \
  "$LIVE_ROOT/src/v2/doctor-cli.ts" --server "$LIVE_SERVER_URL" "$LIVE_PROJECT" \
  >"$LIVE_LOGS/doctor.txt" 2>&1 || true
grep -q "Mismatches: none" "$LIVE_LOGS/doctor.txt" \
  || live_fail "doctor reported a work mismatch: $(grep -A3 'Mismatches:' "$LIVE_LOGS/doctor.txt" | tail -n +2 | head -n 2)"
"$LIVE_NODE_BIN" "$LIVE_ROOT/scripts/log-summary.mjs" --dir "$LIVE_STATE/ensemble/logs" --json \
  >"$LIVE_LOGS/log-summary.json"
"$LIVE_NODE_BIN" -e '
  const summary = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const events = summary.events ?? {};
  const failed = (summary.failedTasks ?? []).length;
  const stalled = events["task.stalled"] ?? 0;
  if (failed !== 0) { console.error(`unexpected task.failed: ${failed}`); process.exit(1) }
  if (stalled !== 0) { console.error(`unexpected task.stalled: ${stalled}`); process.exit(1) }
' "$LIVE_LOGS/log-summary.json" || live_fail "lifecycle log summary contains a false failure or stall"
doctor_timeout=$(grep -ci "timeout.*failed\|failed.*timeout" "$LIVE_LOGS/doctor.txt" 2>/dev/null || true)
[[ "${doctor_timeout:-0}" == "0" ]] || live_fail "doctor reports a timeout mislabeled as failed"

if [[ -n "${ENSEMBLE_LIVE_ARTIFACTS:-}" ]]; then
  mkdir -p "$ENSEMBLE_LIVE_ARTIFACTS"
  cp -R "$LIVE_LOGS/." "$ENSEMBLE_LIVE_ARTIFACTS/"
  mkdir -p "$ENSEMBLE_LIVE_ARTIFACTS/service-logs"
  cp -R "$LIVE_STATE/ensemble/logs/." "$ENSEMBLE_LIVE_ARTIFACTS/service-logs/"
  live_log "artifacts copied to $ENSEMBLE_LIVE_ARTIFACTS"
fi

live_log "lifecycle: long run crossed the five-minute deadline with heartbeats and finished replied"
live_log "lifecycle: queue backlog stayed pending past its delivery deadline and ran after the long turn"
live_log "lifecycle skips: late-success repair, genuine interruption, and stalled/retrying labels are service/TUI-seam tests; no live RPC injects those states without editing durable rows"
live_log "lifecycle live-check passed ($LIVE_SERVER_URL)"
