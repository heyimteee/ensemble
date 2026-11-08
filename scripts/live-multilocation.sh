#!/usr/bin/env bash
set -euo pipefail

# Multi-location regression probe (spec #146, extended by #157 and #164).
#
# Starts the isolated fake host, opens the TUI, creates four channels and eight
# agents, sends 100 requests, then adds a fifth channel/agent pair whose native
# session must execute ensemble_ask_person. It asserts:
#   - one service.start despite one plugin load per location
#   - every 100-run task succeeds; no task.failed or failure records
#   - the fifth location creates and resolves a durable ask_person approval
#   - fewer than five warn-level feed.gap lines in the TUI log
#
# Ticket #164 then adds a sixth location whose deterministic relay proves the
# dispatch-budget ledger end to end: a five-hop group, a nine-hop continuation,
# a command-cap stop, and one consumed row per hop. The doctor and log-summary
# run after the measured path, so the 100-request mix stays unchanged.

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
source "$SCRIPT_DIR/lib/live-harness.sh"

live_require_runtime
live_require_node
live_setup "multilocation"

ENSEMBLE_LIVE_TUI_WIDTH="${ENSEMBLE_LIVE_TUI_WIDTH:-160}"
ENSEMBLE_LIVE_TUI_HEIGHT="${ENSEMBLE_LIVE_TUI_HEIGHT:-80}"

live_tmux_env_add "ENSEMBLE_FAKE_CHUNK_DELAY_MS=0"
live_tmux_env_add "ENSEMBLE_FAKE_INITIAL_DELAY_MS=0"
live_start_fake_provider --handoff-dir "$LIVE_PROJECT/channels/mock-f/.ensemble/handoffs"

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
live_assert_single_model "ensemble-fake" "ensemble-fake-model"

live_start_tui
live_wait_for_native_tui
live_open_ensemble
live_require_text "$LIVE_TUI_SESSION" "ENSEMBLE" 15 "Ensemble page"

"$LIVE_NODE_BIN" "$SCRIPT_DIR/lib/multilocation-driver.mjs" \
  --url "$LIVE_SERVER_URL" \
  --password "$LIVE_SERVER_PASSWORD" \
  --project "$LIVE_PROJECT" \
  --state "$LIVE_STATE" \
  --prompts "$SCRIPT_DIR/lib/multilocation-prompts.json" \
  --out "$LIVE_LOGS/multilocation.json"

# Ticket #164: budget scenarios run after the measured 100-request path and
# the #157 tool probe, so they cannot change its counts or timings.
"$LIVE_NODE_BIN" "$SCRIPT_DIR/lib/dispatch-budgets-driver.mjs" \
  --url "$LIVE_SERVER_URL" \
  --password "$LIVE_SERVER_PASSWORD" \
  --project "$LIVE_PROJECT" \
  --state "$LIVE_STATE" \
  --handoff-dir "$LIVE_PROJECT/channels/mock-f/.ensemble/handoffs" \
  --out "$LIVE_LOGS/dispatch-budgets.json"

# Doctor evidence: one selected service, dispatch group counters, continuation
# lineage, and command caps. The JSON form is not used because the text line
# includes the compact dispatch summary support needs.
OPENCODE_PASSWORD="$LIVE_SERVER_PASSWORD" "$LIVE_NODE_BIN" --experimental-strip-types \
  "$LIVE_ROOT/src/v2/doctor-cli.ts" --server "$LIVE_SERVER_URL" "$LIVE_PROJECT" \
  2>&1 | tee "$LIVE_LOGS/doctor.txt"

# Log-summary evidence, whole run and each budget root group.
"$LIVE_NODE_BIN" "$LIVE_ROOT/scripts/log-summary.mjs" --dir "$LIVE_STATE/ensemble/logs" --json \
  >"$LIVE_LOGS/log-summary.json"
for root in $("$LIVE_NODE_BIN" -e '
  const fs = require("node:fs");
  const summary = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  for (const scenario of summary.scenarios ?? []) if (scenario.rootID) process.stdout.write(`${scenario.rootID}\n`);
' "$LIVE_LOGS/dispatch-budgets.json"); do
  "$LIVE_NODE_BIN" "$LIVE_ROOT/scripts/log-summary.mjs" --dir "$LIVE_STATE/ensemble/logs" \
    --group "$root" --json >"$LIVE_LOGS/log-summary-$root.json"
done

if [[ -n "${ENSEMBLE_LIVE_ARTIFACTS:-}" ]]; then
  mkdir -p "$ENSEMBLE_LIVE_ARTIFACTS"
  cp -R "$LIVE_LOGS/." "$ENSEMBLE_LIVE_ARTIFACTS/"
  mkdir -p "$ENSEMBLE_LIVE_ARTIFACTS/service-logs"
  cp -R "$LIVE_STATE/ensemble/logs/." "$ENSEMBLE_LIVE_ARTIFACTS/service-logs/"
  live_log "artifacts copied to $ENSEMBLE_LIVE_ARTIFACTS"
fi
