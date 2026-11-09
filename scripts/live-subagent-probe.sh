#!/usr/bin/env bash
set -euo pipefail
if [[ "${ENSEMBLE_LIVE_TRACE_ERR:-0}" == "1" ]]; then
  trap 'printf "live: command failed at line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
fi

# Ticket #188/#197/#201: native subagent live probe.
#
# This starts an isolated real OpenCode 2.2.6 host on the current worktree and
# uses the deterministic fake provider so no real model or user credentials are
# touched. The fake parent turn calls the host's built-in `subagent` tool with
# `background: true`; OpenCode creates a genuine child session, and the child
# streams a bounded hold. The probe then checks the durable NativeSubagentRun,
# the Work card, the group mapping, lifecycle timing, the delayed post-child
# wake-up answer in the task result and completion handoff, cleanup, privacy,
# and restart retention. Ticket #199/#201 add the durable backstop: after a
# restart, one genuinely late native follow-up turn is reconciled into the group
# exactly once with one follow-up hop, no new group, and no hop spend; a second
# restart does not duplicate it, and the doctor reports no terminal delivery-hold
# or retry contradiction.
#
#   npm run test:live:subagent
#   ENSEMBLE_SUBAGENT_EXPECT=early npm run test:live:subagent
#
# `early` is the pre-barrier baseline: it asserts the parent task finalizes
# while the real child is still working. The default `barrier` mode asserts the
# parent stays `working` until the child finishes.
#
# The user's live host is never restarted or reconfigured. This harness uses its
# own HOME/XDG roots and kills its own tmux sessions on exit.

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
source "$SCRIPT_DIR/lib/live-harness.sh"

live_require_runtime
live_require_node
live_setup "subagent"

EXPECT="${ENSEMBLE_SUBAGENT_EXPECT:-barrier}"
case "$EXPECT" in
  barrier|early) ;;
  *) live_fail "ENSEMBLE_SUBAGENT_EXPECT must be barrier or early (got $EXPECT)" ;;
esac
# The debug ring proves the host delivered `experimental.idle` with the
# documented background shape. It carries IDs and kinds only.
export ENSEMBLE_LOG_LEVEL="${ENSEMBLE_LOG_LEVEL:-debug}"

ENSEMBLE_LIVE_TUI_WIDTH="${ENSEMBLE_LIVE_TUI_WIDTH:-160}"
ENSEMBLE_LIVE_TUI_HEIGHT="${ENSEMBLE_LIVE_TUI_HEIGHT:-60}"

PARENT_AGENT="Kakiko"
LEADER_AGENT="Lead"
WORKSPACE_NAME="SubagentProbe"
PARENT_TEXT="fake-subagent-parent-fixture"
CHILD_INSTRUCTION="Watch the CI pipeline"
# Ticket #197: the pre-child and post-child answers carry distinct markers. The
# final task result and completion hop must carry only the wake-up marker.
PRE_CHILD_MARKER="fake-subagent-pre-child-marker"
WAKEUP_MARKER="fake-subagent-wakeup-marker"
# Ticket #201: delay the fake wake-up answer for this run so the probe proves a
# genuinely delayed post-child answer, not only the immediate happy path.
WAKEUP_DELAY_MS="${ENSEMBLE_SUBAGENT_WAKEUP_DELAY_MS:-3000}"
WAKEUP_DURATION_FLOOR_MS=2000
# Ticket #201: after the host restart, one native follow-up turn produces a
# genuinely late report. The trigger stays out of the answer marker so the
# native pane and group assertions cannot match the user prompt.
LATE_TRIGGER="fake-native-late-report-fixture"
LATE_MARKER="fake-native-late-report-marker"
NBSP=$'\u00a0'
# The card title is bounded and truncated to the actual card width, so the probe
# asserts the stable prefix rather than the full instruction.
CHILD_TITLE_PREFIX="Subagents: Watch the"

wait_for_native_count() {
  local expected="$1" seconds="${2:-$LIVE_STEP_TIMEOUT}" description="${3:-$expected native subagent record(s)}"
  live_wait_for "$seconds" "$description" native_count_is "$expected" \
    || live_fail "native subagent record count never became $expected (found $(native_count))"
}

native_count() {
  live_snapshot_value 'Object.values(output.state.nativeSubagents).length' | tr -d '"'
}

native_count_is() {
  [[ "$(native_count)" == "$1" ]]
}

native_probe_value() {
  local expression="$1"
  live_snapshot_value "(() => { const runs = Object.values(output.state.nativeSubagents); const run = runs[0]; const task = run && output.state.subtasks[run.parentTaskID]; return $expression })()" | tr -d '"'
}

native_field() {
  local field="$1"
  live_snapshot_value "Object.values(output.state.nativeSubagents)[0]?.[\"$field\"]" | tr -d '"'
}

child_state_terminal() {
  local state
  state=$(native_field state)
  [[ "$state" == "replied" || "$state" == "failed" || "$state" == "cancelled" ]]
}

native_working() {
  native_probe_value 'run && task && run.state === "working" && run.parentTaskID === task.id'
}

parent_working_with_live_lease() {
  native_probe_value 'run && task && run.state === "working" && task.state === "working" && task.activeRunID && task.claimedBy && task.leaseUntil > Date.now()'
}

parent_replied_before_child_success() {
  native_probe_value 'run && task && task.state === "replied" && run.state !== "replied"'
}

parent_replied_after_child() {
  native_probe_value 'run && task && run.state === "replied" && task.state === "replied" && task.outcome === "succeeded" && typeof task.finishedAt === "number"'
}

# Ticket #197: the parent is not the leader, so the normal completion handoff
# creates one hop carrying the post-child answer. No second task, group, or hop.
parent_result_text() {
  live_snapshot_value "(() => { const task = output.state.subtasks[\"$TASK_ID\"]; const message = task && (output.state.messages[task.workspaceID] || []).find(function (item) { return item.id === task.resultMessageID }); return message ? message.text : \"\" })()" | tr -d '"'
}

completion_hop_count() {
  live_snapshot_value "Object.values(output.state.subtasks).filter(function (task) { return task.workspaceID === \"$WS_ID\" && task.parentID === \"$TASK_ID\" && task.handoff && task.handoff.completion === true }).length" | tr -d '"'
}

completion_hop_count_is_one() {
  [[ "$(completion_hop_count)" == "1" ]]
}

completion_hop_instruction() {
  live_snapshot_value "(() => { const hop = Object.values(output.state.subtasks).find(function (task) { return task.workspaceID === \"$WS_ID\" && task.parentID === \"$TASK_ID\" && task.handoff && task.handoff.completion === true }); return hop ? hop.instruction : \"\" })()" | tr -d '"'
}

parent_result_has_wakeup_marker() {
  grep -qF "$WAKEUP_MARKER" <<<"$(parent_result_text)"
}

completion_hop_has_wakeup_marker() {
  grep -qF "$WAKEUP_MARKER" <<<"$(completion_hop_instruction)"
}

# Ticket #201: the late report gets its own completion hop and group row.
late_completion_hop_instruction() {
  live_snapshot_value "(() => { const hop = Object.values(output.state.subtasks).find(function (task) { return task.workspaceID === \"$WS_ID\" && task.parentID === \"$TASK_ID\" && task.handoff && task.handoff.completion === true && task.instruction.indexOf(\"$LATE_MARKER\") >= 0 }); return hop ? hop.instruction : \"\" })()" | tr -d '"'
}

late_completion_hop_has_marker() {
  grep -qF "$LATE_MARKER" <<<"$(late_completion_hop_instruction)"
}

parent_late_report_rows() {
  live_snapshot_value "(() => { const task = output.state.subtasks[\"$TASK_ID\"]; if (!task) return -1; return (output.state.messages[task.workspaceID] || []).filter(function (message) { return message.taskID === task.id && message.author === \"agent\" && message.agentID === \"$AGENT_ID\" && message.kind === \"text\" && message.text.indexOf(\"$LATE_MARKER\") >= 0 }).length })()" | tr -d '"'
}

late_report_one() {
  [[ "$(parent_late_followup_count)" == "1" && "$(parent_late_report_rows)" == "1" && "$(completion_hop_count)" == "2" ]]
}

all_completion_hops_terminal() {
  [[ "$(live_snapshot_value "Object.values(output.state.subtasks).filter(function (task) { return task.workspaceID === \"$WS_ID\" && task.parentID === \"$TASK_ID\" && task.handoff && task.handoff.completion === true }).every(function (task) { return task.state === \"replied\" })" | tr -d '"')" == "true" ]]
}

dispatch_group_count() {
  live_snapshot_value 'Object.keys(output.state.dispatchGroups).length' | tr -d '"'
}

# Ticket #201: the delayed wake-up answer is measured from the service log. The
# duration floor proves the probe observed a real delay, not the happy path.
native_wakeup_duration_ms() {
  local task="$1" line
  line=$(grep -h '"event":"native.subagent.wakeup.received"' "$LIVE_STATE"/ensemble/logs/service-*.jsonl 2>/dev/null | grep -F "\"parentTaskID\":\"$task\"" | tail -1)
  [[ -n "$line" ]] || { printf '0'; return; }
  sed -n 's/.*"durationMs":\([0-9][0-9]*\).*/\1/p' <<<"$line" | head -1
}

# Ticket #199: the captured wake-up answer is already the task result, so it
# must never be mirrored again as a late native follow-up. A real host restart
# must not duplicate the parent row, the late marker, or the completion hop.
parent_late_followup_count() {
  live_snapshot_value "(() => { const task = output.state.subtasks[\"$TASK_ID\"]; return task && task.lateNativeFollowUps ? task.lateNativeFollowUps.length : 0 })()" | tr -d '"'
}

parent_agent_row_count() {
  live_snapshot_value "(() => { const task = output.state.subtasks[\"$TASK_ID\"]; if (!task) return -1; return (output.state.messages[task.workspaceID] || []).filter(function (message) { return message.taskID === task.id && message.author === \"agent\" && message.kind === \"text\" }).length })()" | tr -d '"'
}

parent_group_unchanged() {
  native_probe_value 'run && task && run.dispatchGroupID === task.dispatchGroupID && run.workspaceID === task.workspaceID && run.parentAgent === "Kakiko" && run.instruction === "Watch the CI pipeline" && run.source === "session-created"'
}

one_task_only() {
  local tasks
  tasks=$(live_snapshot_value "Object.values(output.state.subtasks).filter(function (task) { return task.workspaceID === \"$WS_ID\" && task.assigneeID === \"$AGENT_ID\" }).length" | tr -d '"')
  [[ "$tasks" == "1" ]]
}

hop_count_unchanged() {
  local used
  used=$(live_snapshot_value "output.state.dispatchGroups[\"$GROUP_ID\"].usedHops" | tr -d '"')
  [[ "$used" == "$HOPS_BEFORE" ]]
}

verify_idle_hook_shape() {
  local lines line
  lines=$(grep -h '"event":"native.subagent.idle-hook"' "$LIVE_STATE"/ensemble/logs/service-*.jsonl 2>/dev/null)
  if [[ -z "$lines" ]]; then
    # Honest fallback record: the tracker still reconciles from `session.idle`
    # and `session.created`, but the experimental hook was not observed.
    live_log "experimental.idle: no background delivery observed; tracker fell back to session.created/session.idle"
    return 0
  fi
  line=$(grep -F '"kind":"subagent"' <<<"$lines" | grep -F "$CHILD_ID" | tail -1)
  if [[ -z "$line" ]]; then
    live_fail "experimental.idle did not report the expected subagent background entry"
  fi
  if grep -qE '"description"|"command"|"path"' <<<"$line"; then
    live_fail "experimental.idle log carried content fields"
  fi
  live_log "experimental.idle delivered the documented subagent background shape for $CHILD_ID"
}

live_capture_active_work() {
  live_capture "$1" | grep -Eq 'WORK (ACTIVE|HISTORY) │ [0-9]+ groups? · [1-9][0-9]* active'
}

live_require_active_work() {
  local session="$1" seconds="${2:-$LIVE_STEP_TIMEOUT}" description="${3:-active work}"
  live_wait_for "$seconds" "$description" live_capture_active_work "$session" \
    || live_fail "TUI did not show: $description"
}

live_focus_work() {
  local attempt pane
  for attempt in 1 2 3 4 5 6 7 8; do
    pane=$(live_capture "$LIVE_TUI_SESSION")
    # `Work list` is shared by pane selection and Work interaction. The hint
    # `j/k cards` proves Enter already moved into the list, where `f` toggles
    # ACTIVE/HISTORY.
    if grep -qF "NORMAL  │ Work list" <<<"$pane" && grep -qF "j/k cards" <<<"$pane"; then
      return 0
    fi
    if grep -qF "NORMAL  │ Work list" <<<"$pane"; then
      live_key "$LIVE_TUI_SESSION" Enter
      sleep 0.35
      continue
    fi
    if grep -qF "│ Work list" <<<"$pane" || grep -qF "│ Work approvals" <<<"$pane"; then
      live_key "$LIVE_TUI_SESSION" Escape
      sleep 0.35
      continue
    fi
    live_key "$LIVE_TUI_SESSION" Tab
    sleep 0.35
  done
  live_fail "could not focus and enter the Work list"
}

require_history_card() {
  local description="$1"
  live_focus_work
  live_key "$LIVE_TUI_SESSION" "f"
  live_require_text "$LIVE_TUI_SESSION" "WORK HISTORY │" 10 "history view: $description"
  live_require_text "$LIVE_TUI_SESSION" "$CHILD_TITLE_PREFIX" 10 "history card: $description"
  live_key "$LIVE_TUI_SESSION" "f"
  live_require_text "$LIVE_TUI_SESSION" "WORK ACTIVE │" 10 "history toggled back to ACTIVE"
}

start_fixture_host() {
  live_tmux_env_add "ENSEMBLE_FAKE_SUBAGENT_WAKEUP_DELAY_MS=$WAKEUP_DELAY_MS"
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
  if [[ -n "${ENSEMBLE_LOG_LEVEL:-}" ]]; then
    live_tmux_env_add "ENSEMBLE_LOG_LEVEL=$ENSEMBLE_LOG_LEVEL"
  fi
  live_start_server
  live_check_plugin
  live_wait_for_model "ensemble-fake" "ensemble-fake-model"
}

start_tui() {
  live_start_tui
  live_wait_for_native_tui
  live_open_ensemble
  live_require_text "$LIVE_TUI_SESSION" "#$WORKSPACE_NAME" 20 "$WORKSPACE_NAME workspace surface"
}

open_group_chat() {
  live_focus_chat "$LIVE_TUI_SESSION"
  live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Group chat" 10 "group chat surface"
}

# Ticket #201: open the parent's durable native session through the group-chat
# picker. The session exists after the restart; no Ensemble run is created.
open_parent_native_session() {
  live_focus_chat_interact "$LIVE_TUI_SESSION"
  live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Group chat" 10 "chat interaction before the native picker"
  live_key "$LIVE_TUI_SESSION" "o"
  live_require_text "$LIVE_TUI_SESSION" "Native${NBSP}session" 15 "native-session picker"
  live_key "$LIVE_TUI_SESSION" "/"
  live_type "$LIVE_TUI_SESSION" "$PARENT_AGENT"
  live_require_text "$LIVE_TUI_SESSION" "1${NBSP}matches" 10 "parent-only native-session filter"
  live_key "$LIVE_TUI_SESSION" Enter
  live_require_text "$LIVE_TUI_SESSION" "j/k move" 10 "native-session filter committed"
  live_key "$LIVE_TUI_SESSION" Enter
  live_require_text "$LIVE_TUI_SESSION" "ctrl+p commands" 20 "parent native session opened"
}

# Ticket #201: no terminal delivery-hold or retry contradiction on the final
# state. The doctor reads the same durable rows as the board.
run_doctor() {
  OPENCODE_PASSWORD="$LIVE_SERVER_PASSWORD" "$LIVE_NODE_BIN" --experimental-strip-types \
    "$LIVE_ROOT/src/v2/doctor-cli.ts" --server "$LIVE_SERVER_URL" "$LIVE_PROJECT" \
    >"$LIVE_LOGS/doctor.txt" 2>&1 || true
  grep -q "Mismatches: none" "$LIVE_LOGS/doctor.txt" \
    || live_fail "doctor reported a mismatch: $(grep -A3 'Mismatches:' "$LIVE_LOGS/doctor.txt" | tail -n +2 | head -n 2)"
  OPENCODE_PASSWORD="$LIVE_SERVER_PASSWORD" "$LIVE_NODE_BIN" --experimental-strip-types \
    "$LIVE_ROOT/src/v2/doctor-cli.ts" --json --server "$LIVE_SERVER_URL" "$LIVE_PROJECT" \
    >"$LIVE_LOGS/doctor.json" 2>&1 || true
  "$LIVE_NODE_BIN" -e '
    const report = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const codes = (report.mismatches ?? []).map((mismatch) => mismatch.code);
    const contradiction = codes.filter((code) => code === "work_terminal_contradiction");
    if (contradiction.length > 0) {
      console.error(`terminal contradictions: ${contradiction.join(",")}`);
      process.exit(1);
    }
    if (report.summary?.mismatchCount !== 0) {
      console.error(`unexpected mismatches: ${codes.join(",")}`);
      process.exit(1);
    }
  ' "$LIVE_LOGS/doctor.json" || live_fail "doctor JSON reported terminal delivery-hold or retry contradictions"
  live_log "doctor reports no terminal delivery-hold or retry contradictions"
}

copy_artifacts() {
  [[ -n "${ENSEMBLE_LIVE_ARTIFACTS:-}" ]] || return 0
  mkdir -p "$ENSEMBLE_LIVE_ARTIFACTS"
  cp -R "$LIVE_LOGS/." "$ENSEMBLE_LIVE_ARTIFACTS/"
  mkdir -p "$ENSEMBLE_LIVE_ARTIFACTS/service-logs"
  cp -R "$LIVE_STATE/ensemble/logs/." "$ENSEMBLE_LIVE_ARTIFACTS/service-logs/"
  live_log "artifacts copied to $ENSEMBLE_LIVE_ARTIFACTS"
}

start_fixture_host

live_invoke agent.create "{\"name\":\"$PARENT_AGENT\",\"title\":\"Subagent probe\",\"role\":\"Native subagent fixture.\",\"mainModel\":{\"providerID\":\"ensemble-fake\",\"modelID\":\"ensemble-fake-model\"}}" >/dev/null
live_wait_for "$LIVE_STEP_TIMEOUT" "$PARENT_AGENT in the snapshot" live_snapshot_has_agent_named "$PARENT_AGENT" \
  || live_fail "subagent probe agent was not created"
AGENT_ID=$(live_snapshot_value "Object.values(output.state.agents).find(function (agent) { return agent.name === \"$PARENT_AGENT\" }).id" | tr -d '"')
# Ticket #197: a non-leader parent makes the normal completion handoff visible,
# so the probe can assert the wake-up answer is the handoff content.
live_invoke agent.create "{\"name\":\"$LEADER_AGENT\",\"title\":\"Subagent probe leader\",\"role\":\"Completion handoff owner.\",\"mainModel\":{\"providerID\":\"ensemble-fake\",\"modelID\":\"ensemble-fake-model\"}}" >/dev/null
live_wait_for "$LIVE_STEP_TIMEOUT" "$LEADER_AGENT in the snapshot" live_snapshot_has_agent_named "$LEADER_AGENT" \
  || live_fail "subagent probe leader was not created"
LEADER_ID=$(live_snapshot_value "Object.values(output.state.agents).find(function (agent) { return agent.name === \"$LEADER_AGENT\" }).id" | tr -d '"')
live_invoke workspace.create "{\"name\":\"$WORKSPACE_NAME\",\"memberIDs\":[\"$AGENT_ID\",\"$LEADER_ID\"],\"leaderID\":\"$LEADER_ID\"}" >/dev/null
live_wait_for "$LIVE_STEP_TIMEOUT" "$WORKSPACE_NAME in the snapshot" live_snapshot_has_workspace_named "$WORKSPACE_NAME" \
  || live_fail "subagent probe workspace was not created"
WS_ID=$(live_snapshot_value "Object.values(output.state.workspaces).find(function (workspace) { return workspace.name === \"$WORKSPACE_NAME\" }).id" | tr -d '"')

start_tui
open_group_chat

live_invoke "message.send" "{\"workspaceID\":\"$WS_ID\",\"text\":\"$PARENT_TEXT\",\"recipientIDs\":[\"$AGENT_ID\"]}" >/dev/null
live_wait_for "$LIVE_STEP_TIMEOUT" "parent task row" one_task_only \
  || live_fail "the parent task row never appeared"
TASK_ID=$(live_snapshot_value "Object.values(output.state.subtasks).find(function (task) { return task.workspaceID === \"$WS_ID\" }).id" | tr -d '"')
[[ -n "$TASK_ID" && "$TASK_ID" != "null" ]] || live_fail "parent task id is missing"
GROUP_ID=$(live_snapshot_value "output.state.subtasks[\"$TASK_ID\"].dispatchGroupID" | tr -d '"')
[[ -n "$GROUP_ID" && "$GROUP_ID" != "null" ]] || live_fail "parent dispatch group id is missing"
HOPS_BEFORE=$(live_snapshot_value "output.state.dispatchGroups[\"$GROUP_ID\"].usedHops" | tr -d '"')
GROUPS_BEFORE=$(dispatch_group_count)
[[ -n "$GROUPS_BEFORE" && "$GROUPS_BEFORE" != "null" ]] || live_fail "dispatch group count is missing"

wait_for_native_count 1 30 "native subagent record"
live_wait_for "$LIVE_STEP_TIMEOUT" "native subagent working" native_working \
  || live_fail "the native subagent record never became working"
live_wait_for "$LIVE_STEP_TIMEOUT" "parent task keeps the child mapping" parent_group_unchanged \
  || live_fail "native subagent record does not match the parent task/group/agent/instruction"
CHILD_ID=$(native_field childSessionID)
[[ -n "$CHILD_ID" && "$CHILD_ID" != "null" ]] || live_fail "child session id is missing"

# The parent's first turn must be idle while the child still streams; the
# probe's mode decides whether the service held it (barrier) or finalized early.
if [[ "$EXPECT" == "barrier" ]]; then
  live_wait_for "$LIVE_STEP_TIMEOUT" "parent stays working with a live lease" parent_working_with_live_lease \
    || live_fail "barrier did not keep the parent working while the child was active"
else
  live_wait_for "$LIVE_STEP_TIMEOUT" "pre-barrier parent finalizes early" parent_replied_before_child_success \
    || live_fail "the pre-barrier parent did not finalize before the child success"
  live_log "early-finalization baseline observed: parent replied while child $CHILD_ID was not successful (state $(native_field state))"
  copy_artifacts
  live_log "baseline complete; the post-barrier assertions are skipped in early mode"
  exit 0
fi

live_require_active_work "$LIVE_TUI_SESSION" 20 "active subagent card mounts"
live_require_text "$LIVE_TUI_SESSION" "KAKIKO" 20 "subagent card names the parent agent"
live_require_text "$LIVE_TUI_SESSION" "$CHILD_TITLE_PREFIX" 20 "subagent card title"

live_wait_for 40 "child reaches a terminal state" child_state_terminal \
  || live_fail "native subagent never reached a terminal state"
live_wait_for 20 "parent terminal after child" parent_replied_after_child \
  || live_fail "parent task did not finalize after its child"
[[ "$(native_field state)" == "replied" ]] || live_fail "child terminal state should be replied (got $(native_field state))"
[[ -n "$(native_field finishedAt)" && "$(native_field finishedAt)" != "null" ]] || live_fail "child has no finishedAt"
one_task_only || live_fail "the subagent created a queue row"
hop_count_unchanged || live_fail "the subagent consumed a dispatch hop"
# Ticket #197: the post-child answer is the task result and the completion
# handoff content; the pre-child answer was replaced, not appended.
live_wait_for 10 "one completion handoff for the finished parent" completion_hop_count_is_one \
  || live_fail "the parent completion hop was not created exactly once"
live_wait_for 10 "wake-up marker in the task result" parent_result_has_wakeup_marker \
  || live_fail "the task result does not carry the post-child wake-up marker (got: $(parent_result_text))"
live_wait_for 10 "wake-up marker in the completion handoff" completion_hop_has_wakeup_marker \
  || live_fail "the completion handoff does not carry the post-child wake-up marker"
if grep -qF "$PRE_CHILD_MARKER" <<<"$(parent_result_text)"; then
  live_fail "the task result still carries the replaced pre-child answer"
fi
if grep -qF "$PRE_CHILD_MARKER" <<<"$(completion_hop_instruction)"; then
  live_fail "the completion handoff still carries the replaced pre-child answer"
fi
# Ticket #201: the fake provider held this answer for WAKEUP_DELAY_MS after the
# host started the wake-up turn. The received duration proves the result came
# from a genuinely delayed answer, not the immediate happy path.
WAKEUP_OBSERVED_MS=0
for _ in $(seq 1 40); do
  WAKEUP_OBSERVED_MS=$(native_wakeup_duration_ms "$TASK_ID")
  [[ "$WAKEUP_OBSERVED_MS" =~ ^[0-9]+$ && "$WAKEUP_OBSERVED_MS" -ge "$WAKEUP_DURATION_FLOOR_MS" ]] && break
  sleep 0.25
done
[[ "$WAKEUP_OBSERVED_MS" =~ ^[0-9]+$ && "$WAKEUP_OBSERVED_MS" -ge "$WAKEUP_DURATION_FLOOR_MS" ]] \
  || live_fail "the wake-up answer was not delayed (observed ${WAKEUP_OBSERVED_MS}ms, floor ${WAKEUP_DURATION_FLOOR_MS}ms)"
live_log "delayed post-child wake-up answer captured after ${WAKEUP_OBSERVED_MS}ms"
# Ticket #199: the wake-up answer was consumed by the task result. It must not
# be mirrored a second time as a late follow-up, even after the restart below.
[[ "$(parent_late_followup_count)" == "0" ]] || live_fail "the captured wake-up answer was mirrored as a late follow-up"
[[ "$(parent_agent_row_count)" == "1" ]] || live_fail "the parent task has more than one agent row"
verify_idle_hook_shape

require_history_card "after completion"
# Ticket #201: let the first completion delivery settle before the restart so
# the late-report restart proves reconciliation, not an interrupted hop.
live_wait_for 60 "original completion delivery terminal before restart" all_completion_hops_terminal \
  || live_fail "the original completion delivery did not settle before the restart"

# Reopen the durable card under HISTORY, then restart the isolated host and TUI
# with the same state root. The record must survive with terminal state.
live_key "$LIVE_TUI_SESSION" "Escape"
"$LIVE_TMUX_BIN" kill-session -t "$LIVE_TUI_SESSION" 2>/dev/null || true
"$LIVE_TMUX_BIN" kill-session -t "$LIVE_SERVE_SESSION" 2>/dev/null || true
sleep 0.5
live_start_server
live_check_plugin
start_tui
live_wait_for "$LIVE_STEP_TIMEOUT" "native record after restart" native_count_is 1 \
  || live_fail "native subagent record did not survive the service restart"
[[ "$(native_field state)" == "replied" ]] || live_fail "restart changed the terminal child state"
require_history_card "after restart"
# Ticket #199: restart neither mirrors the already-captured wake-up answer as a
# late follow-up nor duplicates the parent row or its single completion hop.
[[ "$(parent_late_followup_count)" == "0" ]] || live_fail "restart created a spurious late follow-up"
[[ "$(parent_agent_row_count)" == "1" ]] || live_fail "restart duplicated the parent agent row"
[[ "$(completion_hop_count)" == "1" ]] || live_fail "restart duplicated the parent completion hop"
live_log "restart retained the terminal child and parent state with no duplicate row or hop"

# Ticket #201/#199: after the restart, one native follow-up turn produces a
# genuinely late report with no active Ensemble run. The parent idle must
# reconcile it into the group exactly once and create one follow-up hop in the
# same dispatch group, spending no hop and minting no new group.
live_key "$LIVE_TUI_SESSION" "Escape"
open_group_chat
open_parent_native_session
live_type "$LIVE_TUI_SESSION" "$LATE_TRIGGER"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "$LATE_MARKER" 45 "late native follow-up answer in the native session"
live_key "$LIVE_TUI_SESSION" F2
live_require_text "$LIVE_TUI_SESSION" "ENSEMBLE" 20 "F2 returns after the late native answer"
open_group_chat
live_wait_for 30 "late native report reconciled exactly once" late_report_one \
  || live_fail "late native report did not reconcile once (followups $(parent_late_followup_count), rows $(parent_late_report_rows), hops $(completion_hop_count))"
[[ "$(parent_late_report_rows)" == "1" ]] || live_fail "the late native report added $(parent_late_report_rows) group rows"
[[ "$(completion_hop_count)" == "2" ]] || live_fail "the late native report created $(completion_hop_count) completion hops, expected 2"
late_completion_hop_has_marker || live_fail "the late follow-up completion hop does not carry the native report"
[[ "$(parent_agent_row_count)" == "2" ]] || live_fail "the parent task did not keep one row per captured answer (got $(parent_agent_row_count))"
[[ "$(dispatch_group_count)" == "$GROUPS_BEFORE" ]] || live_fail "the late report minted a new dispatch group ($(dispatch_group_count) vs $GROUPS_BEFORE)"
hop_count_unchanged || live_fail "the late report spent a dispatch hop"
[[ "$(live_snapshot_value "output.state.subtasks[\"$TASK_ID\"].lateNativeFollowUps[0].hopID" | tr -d '"')" != "null" ]] \
  || live_fail "the late follow-up marker records no hop"
# The transcript may still be scrolled where it was before the native detour;
# jump to the bottom rather than weakening the content assertion.
live_focus_chat_interact "$LIVE_TUI_SESSION"
live_key "$LIVE_TUI_SESSION" End
live_require_joined_text "$LIVE_TUI_SESSION" "$LATE_MARKER" 20 "late native report visible in the group transcript"
live_log "late native report reconciled once, attributed to the parent, with one follow-up hop and no new group"
live_wait_for 30 "both completion deliveries terminal before diagnosis" all_completion_hops_terminal \
  || live_fail "a completion delivery did not settle before the doctor check"

# A further restart of the isolated host and TUI must not duplicate the late
# group row or its follow-up hop: the durable marker is the authority.
live_key "$LIVE_TUI_SESSION" "Escape"
"$LIVE_TMUX_BIN" kill-session -t "$LIVE_TUI_SESSION" 2>/dev/null || true
"$LIVE_TMUX_BIN" kill-session -t "$LIVE_SERVE_SESSION" 2>/dev/null || true
sleep 0.5
live_start_server
live_check_plugin
start_tui
live_wait_for "$LIVE_STEP_TIMEOUT" "native record after the second restart" native_count_is 1 \
  || live_fail "native subagent record did not survive the second service restart"
live_wait_for 20 "late report remains exactly once after restart" late_report_one \
  || live_fail "restart duplicated or dropped the late report (followups $(parent_late_followup_count), rows $(parent_late_report_rows), hops $(completion_hop_count))"
[[ "$(parent_agent_row_count)" == "2" ]] || live_fail "restart duplicated the parent agent rows (got $(parent_agent_row_count))"
[[ "$(dispatch_group_count)" == "$GROUPS_BEFORE" ]] || live_fail "restart minted a new dispatch group"
hop_count_unchanged || live_fail "restart spent a dispatch hop"
live_log "second restart retained the late report exactly once"
run_doctor

# Privacy: the display instruction is durable, but the service diagnostics and
# every log entry carry IDs, agent, state, and counts only.
DIAG_BODY=$(live_rpc_body "$LIVE_PROJECT" "" "{}")
DIAG_JSON=$(live_rpc diagnostic "$DIAG_BODY")
if grep -qF "$CHILD_INSTRUCTION" <<<"$DIAG_JSON"; then
  live_fail "diagnostics carried the subagent instruction"
fi
# `diagnostic` is the explicit full-state support surface: it carries the
# durable transcript, including the late report. The content-free claim applies
# to logs (below), not to this state dump.
LOG_BODY=$("$LIVE_NODE_BIN" -e 'process.stdout.write(JSON.stringify({input:{directory:process.argv[1],limit:1000}}))' "$LIVE_PROJECT")
LOG_JSON=$(live_rpc logs.recent "$LOG_BODY")
if grep -qF "$CHILD_INSTRUCTION" <<<"$LOG_JSON"; then
  live_fail "logs.recent carried the subagent instruction"
fi
if grep -qF "$LATE_MARKER" <<<"$LOG_JSON"; then
  live_fail "logs.recent carried the late native report"
fi
if compgen -G "$LIVE_STATE/ensemble/logs/*" >/dev/null; then
  if grep -R -qF "$CHILD_INSTRUCTION" "$LIVE_STATE/ensemble/logs"; then
    live_fail "the service log files carried the subagent instruction"
  fi
  # Ticket #197/#201: the pre-child, wake-up, and late-report answers are
  # conversation content; the durable task/hop may carry them, but no service
  # log may.
  if grep -R -qF "$WAKEUP_MARKER" "$LIVE_STATE/ensemble/logs"; then
    live_fail "the service log files carried the post-child wake-up answer"
  fi
  if grep -R -qF "$PRE_CHILD_MARKER" "$LIVE_STATE/ensemble/logs"; then
    live_fail "the service log files carried the pre-child answer"
  fi
  if grep -R -qF "$LATE_MARKER" "$LIVE_STATE/ensemble/logs"; then
    live_fail "the service log files carried the late native report"
  fi
fi

# Cleanup: remove the probe workspace and agent; no active child record remains.
live_invoke workspace.delete "{\"id\":\"$WS_ID\",\"deleteNativeSessions\":true}" >/dev/null
live_invoke agent.delete "{\"id\":\"$AGENT_ID\",\"deleteNativeSessions\":true}" >/dev/null
live_invoke agent.delete "{\"id\":\"$LEADER_ID\",\"deleteNativeSessions\":true}" >/dev/null
live_wait_for "$LIVE_STEP_TIMEOUT" "no native subagent records left" native_count_is 0 \
  || live_fail "native subagent records lingered after cleanup"
live_log "native subagent probe passed ($EXPECT): child=$CHILD_ID parentTask=$TASK_ID group=$GROUP_ID"

copy_artifacts
