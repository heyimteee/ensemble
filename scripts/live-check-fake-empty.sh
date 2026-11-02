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
live_key "$LIVE_TUI_SESSION" "a"
live_require_text "$LIVE_TUI_SESSION" "Agent name" 10 "agent wizard"
live_type "$LIVE_TUI_SESSION" "FakeAgent"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Agent title" 10 "agent title step"
live_type "$LIVE_TUI_SESSION" "Engineering"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Agent role" 10 "agent role step"
live_type "$LIVE_TUI_SESSION" "Renders deterministic Markdown."
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Main model" 10 "main model step"
live_require_text "$LIVE_TUI_SESSION" "0 options" 10 "empty option count"
live_assert_text "$LIVE_TUI_SESSION" "No models available" "explained empty model state"

live_key "$LIVE_TUI_SESSION" Escape
live_require_absence "$LIVE_TUI_SESSION" "Main model" 10 "wizard closed after cancel"

live_log "fake empty-catalog live-check passed ($LIVE_SERVER_URL)"
