#!/usr/bin/env bash
set -euo pipefail

# Deterministic empty-catalog live check. Starts the dependency-free fake
# provider with no models, then verifies the New-agent wizard explains why the
# Main model step is empty instead of showing a bare "0 options", and that the
# wizard stays cancellable. No real model call and no API key.

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
source "$SCRIPT_DIR/lib/live-harness.sh"

live_require_runtime
live_require_node
live_setup "fake-empty"

ENSEMBLE_LIVE_TUI_WIDTH="${ENSEMBLE_LIVE_TUI_WIDTH:-160}"
ENSEMBLE_LIVE_TUI_HEIGHT="${ENSEMBLE_LIVE_TUI_HEIGHT:-80}"

live_start_fake_provider

live_write_config <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "plugins": ["$LIVE_ROOT"],
  "enabled_providers": ["ensemble-fake"],
  "providers": {
    "ensemble-fake": {
      "name": "Ensemble Fake",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "$LIVE_FAKE_URL/v1"
      },
      "models": {}
    }
  }
}
EOF

live_tmux_env_add "OPENCODE_DISABLE_MODELS_FETCH=1"
live_tmux_env_add "OPENCODE_DISABLE_FREE_MODELS=1"
live_start_server
live_check_plugin
live_start_tui
# A zero-model instance may not show the native "Ask anything" placeholder, so
# wait briefly for it without requiring it before opening Ensemble.
live_poll_for 15 live_capture_contains "$LIVE_TUI_SESSION" "Ask anything" || true
live_open_ensemble

live_require_text "$LIVE_TUI_SESSION" "ENSEMBLE" 15 "Ensemble page"
live_assert_text "$LIVE_TUI_SESSION" "○───○───○" "one-shot empty-state mark"
live_assert_absence "$LIVE_TUI_SESSION" "SUBTASKS" "right-hand task board retired"
live_key "$LIVE_TUI_SESSION" "a"
live_require_text "$LIVE_TUI_SESSION" "Agent name" 10 "agent wizard"
live_key "$LIVE_TUI_SESSION" "i"
live_type "$LIVE_TUI_SESSION" "FakeAgent"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Agent title" 10 "agent title step"
live_type "$LIVE_TUI_SESSION" "Engineering"
sleep 0.25
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Wizard" 10 "wizard text field Normal"
# v5.6 T8: Visual works in wizard text fields too.
live_key "$LIVE_TUI_SESSION" "v"
live_require_text "$LIVE_TUI_SESSION" "VISUAL  │ Wizard" 10 "v enters Visual in a wizard field"
live_key "$LIVE_TUI_SESSION" "0"
live_require_text "$LIVE_TUI_SESSION" "chars" 10 "a motion extends the wizard selection"
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Wizard" 10 "Esc cancels Visual in the wizard field"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Agent role" 10 "agent role step"
live_key "$LIVE_TUI_SESSION" "i"
live_type "$LIVE_TUI_SESSION" "Renders deterministic Markdown."
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Agent memories (optional)" 10 "agent memories step"
# T4: the empty list skips without creating a blob. Arrival keeps Insert with
# no text target; Enter advances to the empty model step.
live_require_text "$LIVE_TUI_SESSION" "INSERT  │ Wizard" 10 "the empty memory list keeps Insert"
live_require_text "$LIVE_TUI_SESSION" "no text target │ Esc normal" 10 "the empty memory list has no text target"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Main model" 10 "main model step after an empty memory list"
live_require_text "$LIVE_TUI_SESSION" "0 options" 10 "empty option count"
live_assert_text "$LIVE_TUI_SESSION" "No models available" "explained empty model state"

# T4 navigation: Esc leaves Insert, N goes back to the memory step, n returns
# to the model step, and both keep Normal. Esc then asks before discarding the
# dirty draft; n keeps it and y confirms the discard.
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Wizard" 10 "Esc leaves Insert on the list step"
live_key "$LIVE_TUI_SESSION" "N"
live_require_text "$LIVE_TUI_SESSION" "Agent memories (optional)" 10 "N goes back one wizard step"
live_assert_text "$LIVE_TUI_SESSION" "NORMAL  │ Wizard" "the previous list step keeps Normal"
live_key "$LIVE_TUI_SESSION" "n"
live_require_text "$LIVE_TUI_SESSION" "Main model" 10 "n returns to the next step"
live_assert_text "$LIVE_TUI_SESSION" "NORMAL  │ Wizard" "the next list step keeps Normal"
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "discard draft?" 10 "dirty Esc asks before discarding"
live_key "$LIVE_TUI_SESSION" "n"
live_require_absence "$LIVE_TUI_SESSION" "discard draft?" 10 "n kept the wizard draft"
live_assert_text "$LIVE_TUI_SESSION" "Main model" "the wizard stayed on its step"
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "discard draft?" 10 "cancel confirm reopened"
live_key "$LIVE_TUI_SESSION" "y"
live_require_absence "$LIVE_TUI_SESSION" "Agent name" 10 "y cancelled the wizard"
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Roster" 10 "cancel restored Normal mode"

# v5.8 init routing with an empty catalog: `:init` is an Ensemble System Agent
# command, not a host skill, and extra mentions are rejected instead of being
# discarded. Both paths work without a model catalog.
live_require_text "$LIVE_TUI_SESSION" "I init" 10 "I init shortcut survives an empty catalog"
live_key "$LIVE_TUI_SESSION" ":"
live_type "$LIVE_TUI_SESSION" "init"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Open a workspace first." 10 ":init routes to the Ensemble init path"
live_key "$LIVE_TUI_SESSION" ":"
live_type "$LIVE_TUI_SESSION" 'init $FakeAgent'
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Init is solo-only." 10 ":init with an extra mention is rejected"
live_log "v5.8 init routing and solo guard verified with an empty catalog"

empty_memory_count=$(live_snapshot_value 'Object.values(output.state.memories).filter(function (m) { return !m.deletedAt }).length')
[[ "$empty_memory_count" == "0" ]] || live_fail "empty memory list wrote memories (got $empty_memory_count)"

live_log "fake empty-catalog live-check passed ($LIVE_SERVER_URL)"
