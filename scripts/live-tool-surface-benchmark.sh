#!/usr/bin/env bash
set -euo pipefail

# Ticket #225: live tool-surface benchmark on an isolated fake host.
#
# Runs one peer-coordination operation through the legacy explicit tool surface
# (send_message) and the native final-text surface ($Name). Records wall-clock,
# streaming model round-trips, tool calls, prompt size, and tool-schema size.
# Measurement only; it is not a pass/fail latency gate.

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
source "$SCRIPT_DIR/lib/live-harness.sh"

live_require_runtime
live_require_node
live_setup "tool-benchmark"

live_tmux_env_add "ENSEMBLE_FAKE_CHUNK_DELAY_MS=0"
# One short provider step per model round-trip makes the extra legacy tool
# round-trip visible in wall-clock without making the benchmark slow.
live_tmux_env_add "ENSEMBLE_FAKE_INITIAL_DELAY_MS=120"
live_tmux_env_add "ENSEMBLE_FAKE_TURN_START_DELAY_MS=0"
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
mkdir -p "$LIVE_PROJECT/bench-native" "$LIVE_PROJECT/bench-legacy"

"$LIVE_NODE_BIN" "$SCRIPT_DIR/lib/tool-surface-benchmark-driver.mjs" \
  --url "$LIVE_SERVER_URL" \
  --password "$LIVE_SERVER_PASSWORD" \
  --project "$LIVE_PROJECT" \
  --fake-log "$LIVE_LOGS/fake.log" \
  --out "$LIVE_LOGS/tool-surface.json"

live_log "tool-surface benchmark complete"
cat "$LIVE_LOGS/tool-surface.json"

if [[ -n "${ENSEMBLE_LIVE_ARTIFACTS:-}" ]]; then
  mkdir -p "$ENSEMBLE_LIVE_ARTIFACTS"
  cp -R "$LIVE_LOGS/." "$ENSEMBLE_LIVE_ARTIFACTS/"
  live_log "artifacts copied to $ENSEMBLE_LIVE_ARTIFACTS"
fi
