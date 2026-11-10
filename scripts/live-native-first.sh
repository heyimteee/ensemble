#!/usr/bin/env bash
set -euo pipefail
if [[ "${ENSEMBLE_LIVE_TRACE_ERR:-0}" == "1" ]]; then
  trap 'printf "live: command failed at line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
fi

# Ticket #227: native-first cutover matrix on an isolated fake host.
#
# Reuses the #210 live-harness isolation and the deterministic ensemble-fake
# provider. The driver uses the same public @opencode/client surface as the
# host probe and reads durable state only through the public Ensemble RPC.
#
# Covers a native direct turn, a workspace native turn, user mention routing,
# agent final-text mention routing, an attachment prompt, session adoption,
# retry, user interruption, Work history reload, rollback to the explicit-tool
# path, a host restart with post-restart ingestion, and latency/token metrics.
# Shadow-mode comparison is probed last and reported as a gap when absent.
#
#   npm run test:live:native-first
#   OPENCODE_BIN=/path/to/opencode npm run test:live:native-first
#   ENSEMBLE_LIVE_ARTIFACTS=/path npm run test:live:native-first
#
# Linux/tmux only. No model API, external network request, or user credential.

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
source "$SCRIPT_DIR/lib/live-harness.sh"

live_require_runtime
live_require_node
live_setup "native-first"

# Fixture timing only. The retry delay keeps the durable `retrying` phase
# observable without slowing any other turn.
live_tmux_env_add "ENSEMBLE_FAKE_CHUNK_DELAY_MS=20"
live_tmux_env_add "ENSEMBLE_FAKE_INITIAL_DELAY_MS=0"
live_tmux_env_add "ENSEMBLE_FAKE_TURN_START_DELAY_MS=0"
live_tmux_env_add "ENSEMBLE_FAKE_RETRY_DELAY_MS=1500"

NODE_VERSION=$("$LIVE_NODE_BIN" --version | sed 's/^v//')
OPENCODE_VERSION=$("$LIVE_OPENCODE_BIN" --version | sed 's/^opencode v//; s/^v//')
TMUX_VERSION=$("$LIVE_TMUX_BIN" -V | sed 's/^tmux //')
live_log "node=$NODE_VERSION opencode=$OPENCODE_VERSION tmux=$TMUX_VERSION"

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

STATE_FILE="$LIVE_LOGS/native-first-state.json"
MAIN_OUT="$LIVE_LOGS/native-first-main.json"
RESTART_OUT="$LIVE_LOGS/native-first-restart.json"

MAIN_STATUS=0
"$LIVE_NODE_BIN" "$SCRIPT_DIR/lib/native-first-driver.mjs" \
  --url "$LIVE_SERVER_URL" \
  --password "$LIVE_SERVER_PASSWORD" \
  --project "$LIVE_PROJECT" \
  --phase main \
  --state-file "$STATE_FILE" \
  --out "$MAIN_OUT" \
  --fake-log "$LIVE_LOGS/fake.log" \
  --service-log-dir "$LIVE_STATE/ensemble/logs" || MAIN_STATUS=$?
if [[ ! -s "$STATE_FILE" ]]; then
  live_fail "the native-first main phase did not record scenario state (status $MAIN_STATUS)"
fi

# A real host restart with the same XDG state root. The fake provider stays up.
# The service must reload the durable store, keep every terminal native turn,
# and ingest the next native prompt from the reattached location.
live_log "restarting the isolated host for the restart/reconnect pass"
"$LIVE_TMUX_BIN" kill-session -t "$LIVE_SERVE_SESSION" 2>/dev/null || true
sleep 0.5
live_start_server
live_check_plugin
live_wait_for_model "ensemble-fake" "ensemble-fake-model"

RESTART_STATUS=0
"$LIVE_NODE_BIN" "$SCRIPT_DIR/lib/native-first-driver.mjs" \
  --url "$LIVE_SERVER_URL" \
  --password "$LIVE_SERVER_PASSWORD" \
  --project "$LIVE_PROJECT" \
  --phase restart \
  --state-file "$STATE_FILE" \
  --out "$RESTART_OUT" \
  --fake-log "$LIVE_LOGS/fake.log" \
  --service-log-dir "$LIVE_STATE/ensemble/logs" || RESTART_STATUS=$?

# Privacy gate: the driver output and the isolated service logs never carry the
# harness directories, credentials, source paths, or attachment bytes.
for private_value in "$LIVE_BASE" "$LIVE_PROJECT" "$LIVE_PROJECT/cutover-workspace" "$LIVE_SERVER_PASSWORD"; do
  if grep -qF -- "$private_value" "$MAIN_OUT" "$RESTART_OUT" 2>/dev/null; then
    live_fail "the native-first record carried a private path or credential"
  fi
done
if grep -qE 'data:[A-Za-z0-9+/=]{40,}' "$MAIN_OUT" "$RESTART_OUT" 2>/dev/null; then
  live_fail "the native-first record carried an inline file payload"
fi
if grep -qF "/home/" "$MAIN_OUT" "$RESTART_OUT" 2>/dev/null; then
  live_fail "the native-first record carried an absolute home path"
fi
if grep -qF "native-first attachment fixture" "$MAIN_OUT" "$RESTART_OUT" 2>/dev/null; then
  live_fail "the native-first record carried attachment bytes"
fi
if compgen -G "$LIVE_STATE/ensemble/logs/*" >/dev/null; then
  if grep -R -qF "native-first attachment fixture" "$LIVE_STATE/ensemble/logs"; then
    live_fail "the service logs carried attachment bytes"
  fi
  if grep -R -qE '/home/|/Users/' "$LIVE_STATE/ensemble/logs"; then
    live_fail "the service logs carried an absolute home path"
  fi
fi
RECONNECT_COUNT=$(grep -R -h 'native.reconcile.done' "$LIVE_STATE/ensemble/logs" 2>/dev/null | grep -c '"reason":"reconnect"' || true)
START_COUNT=$(grep -R -h 'native.reconcile.done' "$LIVE_STATE/ensemble/logs" 2>/dev/null | grep -c '"reason":"start"' || true)
[[ "$RECONNECT_COUNT" != "0" ]] || live_fail "the run never recorded a native location reconnect reconciliation"
[[ "$START_COUNT" != "0" ]] || live_fail "the restarted service never recorded a native start reconciliation"
live_log "native reconcile evidence: start=$START_COUNT reconnect=$RECONNECT_COUNT"

SHADOW_GAP=$(grep -c '"name": "shadow-mode-ingestion-and-comparison"' "$RESTART_OUT" || true)
if [[ "$SHADOW_GAP" != "0" ]]; then
  live_fail "shadow-mode ingestion/comparison recorded a gap: see $RESTART_OUT"
fi
SHADOW_COMPARE=$(grep -R -h 'native.shadow.compare' "$LIVE_STATE/ensemble/logs" 2>/dev/null | wc -l | tr -d ' ')
[[ "$SHADOW_COMPARE" != "0" ]] || live_fail "the run never logged a native shadow comparison"
if grep -R -qF "shadow-mode-fixture" "$LIVE_STATE/ensemble/logs" 2>/dev/null; then
  live_fail "the service logs carried native prompt content"
fi
live_log "native shadow comparison rows logged: $SHADOW_COMPARE"

if [[ -n "${ENSEMBLE_LIVE_ARTIFACTS:-}" ]]; then
  mkdir -p "$ENSEMBLE_LIVE_ARTIFACTS"
  cp "$MAIN_OUT" "$RESTART_OUT" "$ENSEMBLE_LIVE_ARTIFACTS/"
  if compgen -G "$LIVE_STATE/ensemble/logs/*" >/dev/null; then
    mkdir -p "$ENSEMBLE_LIVE_ARTIFACTS/service-logs"
    cp -R "$LIVE_STATE/ensemble/logs/." "$ENSEMBLE_LIVE_ARTIFACTS/service-logs/"
  fi
  live_log "artifacts copied to $ENSEMBLE_LIVE_ARTIFACTS"
fi

if [[ "$MAIN_STATUS" != "0" || "$RESTART_STATUS" != "0" ]]; then
  live_fail "the native-first matrix recorded failures (main=$MAIN_STATUS restart=$RESTART_STATUS); see $MAIN_OUT and $RESTART_OUT"
fi

live_log "native-first cutover matrix passed: $MAIN_OUT $RESTART_OUT"
