#!/usr/bin/env bash
set -euo pipefail

# Deterministic live TUI check. Starts a dependency-free OpenAI-compatible fake
# provider, points an isolated OpenCode configuration at it, then verifies rich
# Markdown streaming/finalization, the absence of stale transcript lines, and
# searchable shortcut help. It never calls a real model and needs no API key.

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
source "$SCRIPT_DIR/lib/live-harness.sh"

live_require_runtime
live_require_node
live_setup "fake"

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
live_assert_single_model "ensemble-fake" "ensemble-fake-model"
live_start_tui
live_wait_for_native_tui
live_open_ensemble

live_require_text "$LIVE_TUI_SESSION" "ENSEMBLE" 15 "Ensemble page"
live_require_text "$LIVE_TUI_SESSION" "No currently opened session" 10 "empty chat state"
live_require_text "$LIVE_TUI_SESSION" "I init" 10 "I init shortcut"
live_require_text "$LIVE_TUI_SESSION" "git:(" 10 "git metadata"
live_check_help

# The fake catalog contains one model with variants, so the agent wizard always
# offers a Reasoning effort step. Select the first model and first variant.
live_key "$LIVE_TUI_SESSION" "a"
live_require_text "$LIVE_TUI_SESSION" "Agent name" 10 "agent wizard"
live_assert_text "$LIVE_TUI_SESSION" "Ctrl+P back" "wizard nav hint back"
live_assert_text "$LIVE_TUI_SESSION" "Ctrl+N next" "wizard nav hint next"
live_key "$LIVE_TUI_SESSION" "C-n"
live_require_text "$LIVE_TUI_SESSION" "Agent title" 10 "wizard next via Ctrl+N"
live_key "$LIVE_TUI_SESSION" "C-p"
live_require_text "$LIVE_TUI_SESSION" "Agent name" 10 "wizard back via Ctrl+P"
live_type "$LIVE_TUI_SESSION" "FakeAgent"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Agent title" 10 "agent title step"
live_type "$LIVE_TUI_SESSION" "Engineering"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Agent role" 10 "agent role step"
live_type "$LIVE_TUI_SESSION" "Renders deterministic Markdown."
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Main model" 10 "agent model step"
live_key "$LIVE_TUI_SESSION" Enter
live_require_any_text "$LIVE_TUI_SESSION" 15 "reasoning step or direct chat" "Reasoning effort" "FakeAgent · direct"
if live_capture_contains "$LIVE_TUI_SESSION" "Reasoning effort"; then
  live_key "$LIVE_TUI_SESSION" Enter
fi
live_require_text "$LIVE_TUI_SESSION" "FakeAgent · direct" 20 "direct chat opened"
live_require_text "$LIVE_TUI_SESSION" "FakeAgent" 10 "agent roster entry"
live_require_text "$LIVE_TUI_SESSION" "Onboarding complete. I am ready." 20 "fake onboarding reply"
live_require_absence "$LIVE_TUI_SESSION" "streaming…" 15 "onboarding finalization"

# Send the marker that makes the fake provider stream the rich Markdown
# fixture, then observe the live block before it is finalized in place.
live_key "$LIVE_TUI_SESSION" "i"
live_require_text "$LIVE_TUI_SESSION" "COMPOSER" 10 "composer focus"
live_type "$LIVE_TUI_SESSION" "fake-rich-fixture"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "streaming…" 15 "live streaming block"
live_require_text "$LIVE_TUI_SESSION" "Rich Markdown Fixture" 20 "streamed rich reply"
live_require_text "$LIVE_TUI_SESSION" "table cell marker" 20 "final table row"
live_require_absence "$LIVE_TUI_SESSION" "streaming…" 20 "in-place finalization"

# All rich Markdown elements must be rendered by the finalized message.
live_assert_text "$LIVE_TUI_SESSION" "Rich Markdown Fixture" "heading"
live_assert_text "$LIVE_TUI_SESSION" "bold text" "bold emphasis"
live_assert_text "$LIVE_TUI_SESSION" "italic text" "italic emphasis"
live_assert_text "$LIVE_TUI_SESSION" "alpha item" "unordered list"
live_assert_text "$LIVE_TUI_SESSION" "ordered one" "ordered list"
live_assert_text "$LIVE_TUI_SESSION" "quoted line one" "block quote"
live_assert_text "$LIVE_TUI_SESSION" "inline code" "inline code"
live_assert_text "$LIVE_TUI_SESSION" "RICH_CODE_MARKER" "fenced code"
live_assert_text "$LIVE_TUI_SESSION" "Ensemble repository" "link text"
live_assert_text "$LIVE_TUI_SESSION" "table cell marker" "table cell"

# Finalization must replace the streaming block, not leave a duplicate behind.
live_assert_count "$LIVE_TUI_SESSION" "Rich Markdown Fixture" 1 "rich reply heading"
live_assert_count "$LIVE_TUI_SESSION" "RICH_CODE_MARKER" 1 "fenced code marker"
live_assert_count "$LIVE_TUI_SESSION" "quoted line one" 1 "quoted line"
live_assert_count "$LIVE_TUI_SESSION" "table cell marker" 1 "table cell"
live_assert_absence "$LIVE_TUI_SESSION" "streaming…" "streaming block after finalization"

# The durable direct-message user line renders exactly once next to the reply.
live_assert_text "$LIVE_TUI_SESSION" "fake-rich-fixture" "DM user line"
live_assert_count "$LIVE_TUI_SESSION" "fake-rich-fixture" 1 "DM user line exactly once"

# Workspace wizard: Enter owns every non-text step, including the
# leader-synthesis yes/no choice, and never opens a completion surface.
live_key "$LIVE_TUI_SESSION" "n"
live_require_text "$LIVE_TUI_SESSION" "New workspace" 10 "workspace wizard"
live_require_text "$LIVE_TUI_SESSION" "Workspace directory" 10 "directory step"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Workspace name" 10 "workspace name step"
live_type "$LIVE_TUI_SESSION" "LiveSite"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Workspace members" 10 "members step"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Workspace leader" 10 "leader step"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Leader synthesis" 10 "synthesis choice step"
live_assert_text "$LIVE_TUI_SESSION" "Yes — let the leader synthesize" "synthesis yes option"
live_key "$LIVE_TUI_SESSION" Enter
live_assert_absence "$LIVE_TUI_SESSION" "\$ agents" "no completion popup from wizard Enter"
live_require_text "$LIVE_TUI_SESSION" "Move FakeAgent into" 15 "move-home confirm"
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "#LiveSite" 20 "workspace created"
live_require_text "$LIVE_TUI_SESSION" "leader FakeAgent" 15 "leader visible on group surface"
synthesis=$(live_snapshot_value 'Object.values(output.state.workspaces)[0].synthesis')
[[ "$synthesis" == "true" ]] || live_fail "synthesis choice did not persist as Yes (got $synthesis)"
leader_name=$(live_snapshot_value 'Object.values(output.state.agents).filter(function (agent) { return !agent.archived })[0].name')
[[ "$leader_name" == '"FakeAgent"' ]] || live_fail "unexpected roster leader (got $leader_name)"

live_check_help

live_key "$LIVE_TUI_SESSION" '~'
live_require_text "$LIVE_TUI_SESSION" "LEADER" 10 "leader mode before leaving"
live_key "$LIVE_TUI_SESSION" 'q'
live_require_text "$LIVE_TUI_SESSION" "Ask anything" 15 "native TUI after leaving Ensemble"
live_assert_absence "$LIVE_TUI_SESSION" "Rich Markdown Fixture" "stale heading after leaving Ensemble"
live_assert_absence "$LIVE_TUI_SESSION" "RICH_CODE_MARKER" "stale code after leaving Ensemble"

live_log "fake live-check passed ($LIVE_SERVER_URL)"
