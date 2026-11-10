#!/usr/bin/env bash
set -euo pipefail

# Real-runtime live TUI acceptance check. Loads this repository as a local
# OpenCode plugin in isolated config/data/state/home directories and exercises
# the plugin page, leader help, agent/workspace wizards, composer completions,
# and the snapshot/invoke RPC surface. Requires opencode and tmux.

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
source "$SCRIPT_DIR/lib/live-harness.sh"

live_require_runtime
live_require_node
command -v fd >/dev/null 2>&1 || live_skip "fd is unavailable (required for real file-completion coverage)"
live_setup "real"
# Ticket #232: the real host runs the same 160-column shell as the fake matrix.
# At 120 the right Work column leaves the chat cell too narrow for the palette
# flag assertions, which tests the truncation layout rather than the real host.
ENSEMBLE_LIVE_TUI_WIDTH=160
ENSEMBLE_LIVE_TUI_HEIGHT=40

live_write_plugin_config
live_start_server
live_check_plugin
live_start_tui
live_wait_for_native_tui
live_open_ensemble

live_require_text "$LIVE_TUI_SESSION" "ENSEMBLE" 15 "Ensemble page"
live_require_text "$LIVE_TUI_SESSION" "No currently opened session" 10 "empty chat state"
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Agents" 10 "initial pane selection"
live_assert_text "$LIVE_TUI_SESSION" "h/l column" "select mode teaches h/l columns"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "I init" 10 "I init shortcut"
live_require_text "$LIVE_TUI_SESSION" "git:(" 10 "git metadata"
live_check_help

printf 'live fixture\n' >"$LIVE_PROJECT/notes.md"
printf 'handover fixture\n' >"$LIVE_PROJECT/handover.md"
mkdir -p "$LIVE_PROJECT/docs"
printf 'spaced path fixture\n' >"$LIVE_PROJECT/docs/my notes.md"
clear_composer_text() {
  live_key "$LIVE_TUI_SESSION" C-g
  live_key "$LIVE_TUI_SESSION" "i"
  sleep 0.2
  live_key "$LIVE_TUI_SESSION" End
  live_key_repeat "$LIVE_TUI_SESSION" BSpace 160
  sleep 0.4
}

# Ticket #232: opening an agent or workspace focuses its chat column in pane
# selection; chat keys such as `n` exist only after Enter enters interaction.
# Enter is the documented way in and is a no-op when chat already owns focus.
live_enter_chat_interaction() {
  local description="${1:-chat interaction}"
  live_key "$LIVE_TUI_SESSION" Enter
  live_require_text "$LIVE_TUI_SESSION" "j/k scroll" 10 "$description"
}
MODELS=$(live_snapshot_value '.models.length')
if [[ "$MODELS" -gt 0 ]]; then
  live_key "$LIVE_TUI_SESSION" "a"
  live_require_text "$LIVE_TUI_SESSION" "Agent name" 10 "agent wizard"
  # v5.7: a text step keeps the arrival mode (Normal from the roster). `i` is
  # the explicit Insert entry; Insert then persists across the text steps.
  live_assert_text "$LIVE_TUI_SESSION" "NORMAL  │ Wizard" "agent text step keeps the arrival mode"
  live_key "$LIVE_TUI_SESSION" "i"
  live_require_text "$LIVE_TUI_SESSION" "INSERT  │ Wizard" 10 "i enters Insert in the agent name field"
  live_type "$LIVE_TUI_SESSION" "LiveAgent"
  live_key "$LIVE_TUI_SESSION" Enter
  live_require_text "$LIVE_TUI_SESSION" "Agent title" 10 "agent title step"
  live_assert_text "$LIVE_TUI_SESSION" "INSERT  │ Wizard" "title step keeps the Insert mode"
  live_type "$LIVE_TUI_SESSION" "Engineering"
  live_key "$LIVE_TUI_SESSION" Enter
  live_require_text "$LIVE_TUI_SESSION" "Agent role" 10 "agent role step"
  live_type "$LIVE_TUI_SESSION" "Reviews changes and keeps the build green."
  live_key "$LIVE_TUI_SESSION" Enter
  live_require_text "$LIVE_TUI_SESSION" "Agent memories (optional)" 10 "agent memories step"
  live_require_text "$LIVE_TUI_SESSION" "INSERT  │ Wizard" 10 "the memory list keeps Insert"
  live_require_text "$LIVE_TUI_SESSION" "no text target │ Esc normal" 10 "the memory list is honest about Insert with no target"
  live_key "$LIVE_TUI_SESSION" Enter
  live_require_text "$LIVE_TUI_SESSION" "Main model" 10 "agent model step"
  live_key "$LIVE_TUI_SESSION" Enter
  live_require_any_text "$LIVE_TUI_SESSION" 20 "reasoning step or direct chat" "Reasoning effort" "LiveAgent │ direct"
  if live_capture_contains "$LIVE_TUI_SESSION" "Reasoning effort"; then
    live_key "$LIVE_TUI_SESSION" Enter
  fi
  live_require_text "$LIVE_TUI_SESSION" "LiveAgent │ direct" 20 "direct chat opened"
  live_require_text "$LIVE_TUI_SESSION" "LiveAgent" 10 "agent roster entry"
  # The wizard preserved the Insert mode through its list steps; leave it
  # explicitly before using Normal roster/chat keys. Ctrl+G is the reliable
  # chord while the onboarding run is streaming (the host may swallow Esc).
  live_key "$LIVE_TUI_SESSION" C-g
  live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Direct conversation" 10 "leaving the wizard leaves Normal behind"
  live_enter_chat_interaction "agent direct chat interaction before the workspace key"

  live_key "$LIVE_TUI_SESSION" "n"
  live_require_text "$LIVE_TUI_SESSION" "Workspace directory" 10 "workspace wizard"
  live_key "$LIVE_TUI_SESSION" Enter
  live_require_text "$LIVE_TUI_SESSION" "Workspace name" 10 "workspace name step"
  live_assert_text "$LIVE_TUI_SESSION" "NORMAL  │ Wizard" "workspace name keeps the arrival mode"
  live_key "$LIVE_TUI_SESSION" "i"
  live_require_text "$LIVE_TUI_SESSION" "INSERT  │ Wizard" 10 "i enters Insert in the workspace name field"
  live_type "$LIVE_TUI_SESSION" "live"
  live_key "$LIVE_TUI_SESSION" Enter
  live_require_text "$LIVE_TUI_SESSION" "Workspace members" 10 "workspace members step"
  live_key "$LIVE_TUI_SESSION" Enter
  live_require_text "$LIVE_TUI_SESSION" "Workspace leader" 10 "workspace leader step"
  live_key "$LIVE_TUI_SESSION" Enter
  live_require_text "$LIVE_TUI_SESSION" "Leader synthesis" 10 "workspace synthesis step"
  live_key "$LIVE_TUI_SESSION" Enter
  live_require_text "$LIVE_TUI_SESSION" "#live" 20 "workspace created and opened"
  if live_try_text "$LIVE_TUI_SESSION" "Move LiveAgent into #live" 5; then
    # The wizard kept Insert, and Esc changes mode before moving up a context
    # level. Normalize with Ctrl+G, then reject the confirm with its own key.
    live_key "$LIVE_TUI_SESSION" C-g
    live_key "$LIVE_TUI_SESSION" "n"
    live_require_absence "$LIVE_TUI_SESSION" "Move LiveAgent into #live" 10 "move-home prompt dismissed"
  fi
  # The workspace wizard also kept Insert through its list steps. Reset to
  # Normal before the composer and Normal-surface probes below.
  live_key "$LIVE_TUI_SESSION" C-g
  live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Group chat" 10 "leaving the workspace wizard leaves Normal behind"
  live_enter_chat_interaction "workspace group chat interaction before the composer"

  # v5.8: the message-start palette distinguishes commands from skills, the
  # built-in init entry is General, and flags never use a middle dot.
  live_key "$LIVE_TUI_SESSION" "i"
  live_require_text "$LIVE_TUI_SESSION" "COMPOSER" 10 "composer focus for the v5.8 palette"
  live_type "$LIVE_TUI_SESSION" "/"
  live_require_text "$LIVE_TUI_SESSION" "/ commands │ skills" 10 "message-start palette title"
  live_require_text "$LIVE_TUI_SESSION" "Command" 10 "command rows carry the Command flag"
  live_type "$LIVE_TUI_SESSION" "init"
  live_require_text "$LIVE_TUI_SESSION" "Skill | General" 10 "the built-in init skill carries the General flag"
  live_require_text "$LIVE_TUI_SESSION" "/init" 10 "the built-in init skill keeps the /init alias"
  live_assert_absence "$LIVE_TUI_SESSION" "Skill ·" "skill flags never use a middle dot"
  live_key "$LIVE_TUI_SESSION" Escape
  live_key "$LIVE_TUI_SESSION" C-g
  live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Group chat" 10 "palette probe leaves Normal"

  # Prose `/init` is ordinary text and must not start an init job. The real
  # `I` trigger then starts the visible System Agent job and reaches a report.
  live_key "$LIVE_TUI_SESSION" "i"
  live_key_repeat "$LIVE_TUI_SESSION" BSpace 20
  sleep 0.3
  live_type "$LIVE_TUI_SESSION" "hello /init prose-check"
  live_key "$LIVE_TUI_SESSION" Enter
  live_require_text "$LIVE_TUI_SESSION" "→ Assigned to \$LiveAgent: hello /init prose-check" 20 "prose /init is an ordinary group message"
  live_key "$LIVE_TUI_SESSION" C-g
  prose_init_jobs=$(live_snapshot_value 'Object.values(output.state.initJobs).length')
  [[ "$prose_init_jobs" == "0" ]] || live_fail "prose /init started an init job (got $prose_init_jobs)"
  live_key "$LIVE_TUI_SESSION" "I"
  live_require_text "$LIVE_TUI_SESSION" "System Agent" 20 "I starts a visible System Agent init"
  init_state=""
  for _ in $(seq 1 240); do
    init_state=$(live_snapshot_value 'Object.values(output.state.initJobs).map(function (job) { return job.state }).join(",")')
    [[ "$init_state" != "" && "$init_state" != *"running"* ]] && break
    sleep 0.5
  done
  [[ "$init_state" != "" && "$init_state" != *"running"* ]] || live_fail "real init did not reach a terminal state (got $init_state)"
  # The full report is longer than this TUI viewport. Assert the durable report
  # head and the visible report tail; a viewport-only head assertion would test
  # transcript height, not the real host.
  init_report=$(live_snapshot_value '(function () { var jobs = Object.values(output.state.initJobs).filter(function (job) { return job.report }); return jobs.length ? jobs[jobs.length - 1].report : "" })()')
  [[ "$init_report" == *"Ensemble init complete"* ]] || live_fail "System Agent report is missing its completion head"
  live_key "$LIVE_TUI_SESSION" G
  live_require_text "$LIVE_TUI_SESSION" "Wrote .ensemble/init.json" 30 "System Agent report tail is visible"
  init_audit=$(live_snapshot_value '(function () { var ws = Object.values(output.state.workspaces).find(function (w) { return w.name === "live" }); return (output.state.messages[ws.id] || []).filter(function (m) { return m.author === "user" && m.text === "/init" }).length })()')
  [[ "$init_audit" == "1" ]] || live_fail "expected one visible /init audit line, found $init_audit"
  live_log "v5.8 palette, prose guard, and visible System Agent init verified"

  live_wait_for 20 "created agent and workspace in snapshot" \
    live_snapshot_has_agent_named "LiveAgent" \
    || live_fail "snapshot never contained LiveAgent"
  live_wait_for 20 "created workspace in snapshot" \
    live_snapshot_has_workspace_named "live" \
    || live_fail "snapshot never contained workspace live"

  SNAPSHOT_OUTPUT=$(live_snapshot | live_snapshot_output)
  IDS=$("$LIVE_NODE_BIN" -e '
    const output = JSON.parse(process.argv[1]);
    const agents = Object.values(output.state?.agents ?? {});
    const workspaces = Object.values(output.state?.workspaces ?? {});
    const agent = agents.find((item) => item.name === "LiveAgent" && !item.archived);
    const workspace = workspaces.find((item) => item.name === "live" && !item.archived);
    if (!agent || !workspace) process.exit(1);
    process.stdout.write(JSON.stringify({ agent: agent.id, workspace: workspace.id }));
  ' "$SNAPSHOT_OUTPUT")
  AGENT_ID=$("$LIVE_NODE_BIN" -e 'process.stdout.write(JSON.parse(process.argv[1]).agent)' "$IDS")
  WORKSPACE_ID=$("$LIVE_NODE_BIN" -e 'process.stdout.write(JSON.parse(process.argv[1]).workspace)' "$IDS")

  live_key "$LIVE_TUI_SESSION" "i"
  live_require_text "$LIVE_TUI_SESSION" "COMPOSER" 10 "composer focus"
  live_type "$LIVE_TUI_SESSION" "A long message that wraps across the composer width before opening a completion. "
  live_type "$LIVE_TUI_SESSION" '$'
  live_require_text "$LIVE_TUI_SESSION" '$ agents' 10 "inline agent completion"
  live_key "$LIVE_TUI_SESSION" Enter
  live_type "$LIVE_TUI_SESSION" " review "
  # Ticket #175: the token stops at unescaped whitespace, so the query is only
  # the path and a sentence after it stays untouched.
  live_type "$LIVE_TUI_SESSION" "@handover"
  live_require_text "$LIVE_TUI_SESSION" '@ files' 10 "inline file completion"
  live_require_text "$LIVE_TUI_SESSION" "handover.md" 10 "untracked file completion result"
  live_key "$LIVE_TUI_SESSION" Enter
  live_type "$LIVE_TUI_SESSION" "the git log"
  live_require_text "$LIVE_TUI_SESSION" "@handover.md the git log" 10 "the sentence after @file is preserved"
  live_require_absence "$LIVE_TUI_SESSION" '@ files' 10 "the file palette closed on selection"
  # Escaped-space paths use the same grammar on the client and server.
  clear_composer_text
  live_type "$LIVE_TUI_SESSION" "@docs/my\\ notes"
  live_require_text "$LIVE_TUI_SESSION" "docs/my notes" 10 "escaped space is part of the query"
  live_require_text "$LIVE_TUI_SESSION" "docs/my notes.md" 10 "spaced file completion result"
  live_key "$LIVE_TUI_SESSION" Enter
  live_require_text "$LIVE_TUI_SESSION" '@docs/my\ notes.md' 10 "escaped spaced path inserted"
  # A cursor inside the token edits the query and selection preserves the
  # suffix after the token.
  clear_composer_text
  live_type "$LIVE_TUI_SESSION" "before @hand after"
  for _ in $(seq 1 6); do live_key "$LIVE_TUI_SESSION" Left; done
  live_key "$LIVE_TUI_SESSION" "o"
  live_require_text "$LIVE_TUI_SESSION" "@ files │ hando" 10 "typing inside the token keeps the bounded query"
  live_key "$LIVE_TUI_SESSION" BSpace
  live_require_text "$LIVE_TUI_SESSION" "@ files │ hand" 10 "the mid-token query follows the edit"
  live_key "$LIVE_TUI_SESSION" Enter
  live_require_text "$LIVE_TUI_SESSION" "before @handover.md after" 10 "selection preserves the suffix"
  # The same escaped path reaches the server parser.
  clear_composer_text
  live_type "$LIVE_TUI_SESSION" '@docs/my\ notes.md real-parser-check'
  live_key "$LIVE_TUI_SESSION" Enter
  live_require_joined_text "$LIVE_TUI_SESSION" '→ Assigned to $LiveAgent: @docs/my\ notes.md real-parser-check' 20 "escaped spaced reference reaches the server parser"
  # Agent mention plus the send path.
  clear_composer_text
  live_type "$LIVE_TUI_SESSION" '$'
  live_require_text "$LIVE_TUI_SESSION" '$ agents' 10 "inline agent completion reused"
  live_key "$LIVE_TUI_SESSION" Enter
  live_type "$LIVE_TUI_SESSION" " review ping"
  live_key "$LIVE_TUI_SESSION" Enter
  # The assigned row scrolls above the viewport once the answer streams. Prove
  # the durable user row and assignment instead of a viewport-dependent line.
  mention_assigned=""
  for _ in $(seq 1 40); do
    mention_assigned=$(live_snapshot_value '(function () { var ws = Object.values(output.state.workspaces).find(function (w) { return w.name === "live" }); var rows = output.state.messages[ws.id] || []; var user = rows.filter(function (m) { return m.author === "user" && m.text.indexOf("$LiveAgent") === 0 && m.text.indexOf("review ping") >= 0 }); var assigned = rows.filter(function (m) { return m.author === "system" && m.text.indexOf("→ Assigned to $LiveAgent:") === 0 && m.text.indexOf("review ping") >= 0 }); return user.length > 0 && assigned.length > 0 })()')
    [[ "$mention_assigned" == "true" ]] && break
    sleep 0.5
  done
  [[ "$mention_assigned" == "true" ]] || live_fail "group message with agent mention was not assigned"
  live_key "$LIVE_TUI_SESSION" C-g
  live_require_absence "$LIVE_TUI_SESSION" "COMPOSER" 10 "composer left after send"

  live_key "$LIVE_TUI_SESSION" "i"
  live_require_text "$LIVE_TUI_SESSION" "COMPOSER" 10 "composer focus"
  live_type "$LIVE_TUI_SESSION" "/"
  live_require_text "$LIVE_TUI_SESSION" "/ commands" 10 "slash command palette"
  live_key "$LIVE_TUI_SESSION" Escape
  live_require_absence "$LIVE_TUI_SESSION" "/ commands" 10 "slash command palette closed"
  live_key "$LIVE_TUI_SESSION" Escape
  live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ COMPOSER" 10 "composer Normal after the palette"
  live_key "$LIVE_TUI_SESSION" Escape
  live_require_absence "$LIVE_TUI_SESSION" "COMPOSER" 10 "composer closed"

  live_invoke "workspace.delete" "{\"id\":\"$WORKSPACE_ID\",\"deleteNativeSessions\":true}" >/dev/null
  live_invoke "agent.delete" "{\"id\":\"$AGENT_ID\",\"deleteNativeSessions\":true}" >/dev/null
else
  live_log "no models available; agent/workspace/composer coverage skipped explicitly"
fi

live_key "$LIVE_TUI_SESSION" Space
live_require_text "$LIVE_TUI_SESSION" "LEADER" 10 "leader mode before leaving"
live_key "$LIVE_TUI_SESSION" 'q'
live_require_text "$LIVE_TUI_SESSION" "Ask anything" 15 "native TUI after leaving Ensemble"
# v5.7: the hidden Ensemble page owns no keys. Type immediately without Esc,
# then prove `/` reaches the native prompt instead of opening Command mode.
live_type "$LIVE_TUI_SESSION" "native-after-quit"
live_require_text "$LIVE_TUI_SESSION" "native-after-quit" 10 "native prompt accepts letters immediately after leaving"
live_key "$LIVE_TUI_SESSION" C-u
live_require_text "$LIVE_TUI_SESSION" "Ask anything" 10 "native prompt cleared for the slash probe"
live_type "$LIVE_TUI_SESSION" "/"
live_require_text "$LIVE_TUI_SESSION" "Switch agent" 10 "slash reaches the native prompt after leaving"
live_key "$LIVE_TUI_SESSION" Escape

live_log "live-check passed ($LIVE_SERVER_URL)"
