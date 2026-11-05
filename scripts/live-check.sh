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
ENSEMBLE_LIVE_TUI_WIDTH=120
ENSEMBLE_LIVE_TUI_HEIGHT=40

live_write_plugin_config
live_start_server
live_check_plugin
live_start_tui
live_wait_for_native_tui
live_open_ensemble

live_require_text "$LIVE_TUI_SESSION" "ENSEMBLE" 15 "Ensemble page"
live_require_text "$LIVE_TUI_SESSION" "No currently opened session" 10 "empty chat state"
live_require_text "$LIVE_TUI_SESSION" "I init" 10 "I init shortcut"
live_require_text "$LIVE_TUI_SESSION" "git:(" 10 "git metadata"
live_check_help

printf 'live fixture\n' >"$LIVE_PROJECT/notes.md"
MODELS=$(live_snapshot_value '.models.length')
if [[ "$MODELS" -gt 0 ]]; then
  live_key "$LIVE_TUI_SESSION" "a"
  live_require_text "$LIVE_TUI_SESSION" "Agent name" 10 "agent wizard"
  live_type "$LIVE_TUI_SESSION" "LiveAgent"
  live_key "$LIVE_TUI_SESSION" Enter
  live_require_text "$LIVE_TUI_SESSION" "Agent title" 10 "agent title step"
  live_type "$LIVE_TUI_SESSION" "Engineering"
  live_key "$LIVE_TUI_SESSION" Enter
  live_require_text "$LIVE_TUI_SESSION" "Agent role" 10 "agent role step"
  live_type "$LIVE_TUI_SESSION" "Reviews changes and keeps the build green."
  live_key "$LIVE_TUI_SESSION" Enter
  live_require_text "$LIVE_TUI_SESSION" "Agent memories (optional)" 10 "agent memories step"
  live_key "$LIVE_TUI_SESSION" Enter
  live_require_text "$LIVE_TUI_SESSION" "Main model" 10 "agent model step"
  live_key "$LIVE_TUI_SESSION" Enter
  live_require_any_text "$LIVE_TUI_SESSION" 20 "reasoning step or direct chat" "Reasoning effort" "LiveAgent · direct"
  if live_capture_contains "$LIVE_TUI_SESSION" "Reasoning effort"; then
    live_key "$LIVE_TUI_SESSION" Enter
  fi
  live_require_text "$LIVE_TUI_SESSION" "LiveAgent · direct" 20 "direct chat opened"
  live_require_text "$LIVE_TUI_SESSION" "LiveAgent" 10 "agent roster entry"

  live_key "$LIVE_TUI_SESSION" "n"
  live_require_text "$LIVE_TUI_SESSION" "Workspace directory" 10 "workspace wizard"
  live_key "$LIVE_TUI_SESSION" Enter
  live_require_text "$LIVE_TUI_SESSION" "Workspace name" 10 "workspace name step"
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
    live_key "$LIVE_TUI_SESSION" Escape
    live_require_absence "$LIVE_TUI_SESSION" "Move LiveAgent into #live" 10 "move-home prompt dismissed"
  fi

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
  live_type "$LIVE_TUI_SESSION" '@'
  live_require_text "$LIVE_TUI_SESSION" '@ files' 10 "inline file completion"
  live_type "$LIVE_TUI_SESSION" "notes"
  live_require_text "$LIVE_TUI_SESSION" "notes.md" 10 "file completion results"
  live_key "$LIVE_TUI_SESSION" Enter
  live_require_text "$LIVE_TUI_SESSION" '$LiveAgent' 10 "agent mention inserted"
  live_require_text "$LIVE_TUI_SESSION" '@notes.md' 10 "file mention inserted"
  live_key "$LIVE_TUI_SESSION" C-u
  live_type "$LIVE_TUI_SESSION" "ping"
  live_key "$LIVE_TUI_SESSION" Enter
  live_require_text "$LIVE_TUI_SESSION" "→ Assigned to \$LiveAgent: ping" 15 "group message sent"
  live_key "$LIVE_TUI_SESSION" C-g
  live_require_absence "$LIVE_TUI_SESSION" "COMPOSER" 10 "composer left after send"

  live_key "$LIVE_TUI_SESSION" "i"
  live_require_text "$LIVE_TUI_SESSION" "COMPOSER" 10 "composer focus"
  live_type "$LIVE_TUI_SESSION" "/"
  live_require_text "$LIVE_TUI_SESSION" "/ commands" 10 "slash command palette"
  live_key "$LIVE_TUI_SESSION" Escape
  live_require_absence "$LIVE_TUI_SESSION" "/ commands" 10 "slash command palette closed"
  live_key "$LIVE_TUI_SESSION" Escape
  live_require_text "$LIVE_TUI_SESSION" "NORMAL · COMPOSER" 10 "composer Normal after the palette"
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

live_log "live-check passed ($LIVE_SERVER_URL)"
