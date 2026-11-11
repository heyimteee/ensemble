#!/usr/bin/env bash
set -euo pipefail
if [[ "${ENSEMBLE_LIVE_TRACE_ERR:-0}" == "1" ]]; then
  trap 'printf "live: command failed at line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
fi

# Ticket #241: Vera regression and cutover verification.
#
# One isolated fake host, three host starts, and a fresh-store upgrade shape:
#
#   seed    create the Vera roster in a real temp workspace, warm the group
#           binding, and seed a pre-v6 AGENTS.md contract.
#   unset   stop the host and remove the persisted nativeFirst key from the
#           isolated plugin store, exactly as a pre-#240 store looked.
#   run     restart, prove the effective mode is `on` and the default was
#           persisted, assert the generated v6 roster table, drive one leader
#           native turn that delegates one member and then `$Name`-mentions
#           several, and prove `:native-first off` + `:tools legacy` rollback
#           and on/native restore.
#   restart restart again and prove durable native turns, the contact ledger,
#           the exact roster table, and no completion bounce.
#
#   npm run test:live:vera
#   ENSEMBLE_LIVE_KEEP=1 npm run test:live:vera
#
# The deterministic fake provider is the only model. Linux/tmux only. No model
# API, external network request, or user credential. The store fixture removes
# one settings key and reports counts only; it never copies store content.

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
source "$SCRIPT_DIR/lib/live-harness.sh"

live_require_runtime
live_require_node
live_setup "vera"

live_tmux_env_add "ENSEMBLE_FAKE_CHUNK_DELAY_MS=20"
live_tmux_env_add "ENSEMBLE_FAKE_INITIAL_DELAY_MS=0"
live_tmux_env_add "ENSEMBLE_FAKE_TURN_START_DELAY_MS=0"

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

STATE_FILE="$LIVE_LOGS/vera-state.json"
SEED_OUT="$LIVE_LOGS/vera-seed.json"
RUN_OUT="$LIVE_LOGS/vera-run.json"
RESTART_OUT="$LIVE_LOGS/vera-restart.json"
PRESTART_STORE="$LIVE_LOGS/vera-prestart-store.json"
POSTSTART_STORE="$LIVE_LOGS/vera-poststart-store.json"
STORE_DB="$LIVE_DATA/opencode/opencode.db"

run_driver() {
  local phase="$1"
  shift
  "$LIVE_NODE_BIN" "$SCRIPT_DIR/lib/vera-regression-driver.mjs" \
    --url "$LIVE_SERVER_URL" \
    --password "$LIVE_SERVER_PASSWORD" \
    --project "$LIVE_PROJECT" \
    --phase "$phase" \
    --state-file "$STATE_FILE" \
    --fake-log "$LIVE_LOGS/fake.log" \
    "$@"
}

restart_host() {
  live_log "restarting the isolated host"
  "$LIVE_TMUX_BIN" kill-session -t "$LIVE_SERVE_SESSION" 2>/dev/null || true
  sleep 0.5
  live_start_server
  live_check_plugin
  live_wait_for_model "ensemble-fake" "ensemble-fake-model"
}

SEED_STATUS=0
run_driver seed --out "$SEED_OUT" || SEED_STATUS=$?
if [[ ! -s "$STATE_FILE" ]]; then
  live_fail "the Vera seed phase did not record scenario state (status $SEED_STATUS)"
fi

restart_host

# Upgrade-store fixture: remove only the persisted nativeFirst key. Retry while
# the previous host releases the isolated database.
REMOVE_STATUS=1
for _ in $(seq 1 20); do
  if "$LIVE_NODE_BIN" "$SCRIPT_DIR/lib/vera-store-fixture.mjs" --db "$STORE_DB" --mode remove --out "$PRESTART_STORE" \
    >/dev/null 2>"$LIVE_LOGS/store-fixture.err"; then
    REMOVE_STATUS=0
    break
  fi
  sleep 0.25
done
if [[ "$REMOVE_STATUS" != "0" ]]; then
  live_fail "could not shape the upgrade store: $(cat "$LIVE_LOGS/store-fixture.err" 2>/dev/null || true)"
fi
live_json_matches "$PRESTART_STORE" \
  'value.metaRows > 0 && value.hadNativeFirst === true && value.removed > 0 && value.absent === true' \
  15 "an upgrade-shaped store without nativeFirst" \
  || live_fail "the upgrade store fixture did not report one removed nativeFirst key"

restart_host

CHECK_STATUS=0
"$LIVE_NODE_BIN" "$SCRIPT_DIR/lib/vera-store-fixture.mjs" --db "$STORE_DB" --mode check --out "$POSTSTART_STORE" \
  >/dev/null 2>"$LIVE_LOGS/store-check.err" || CHECK_STATUS=$?
if [[ "$CHECK_STATUS" != "0" ]]; then
  live_fail "the restarted store did not persist nativeFirst on: $(cat "$LIVE_LOGS/store-check.err" 2>/dev/null || true)"
fi

RUN_STATUS=0
run_driver run --out "$RUN_OUT" --prestart-store "$PRESTART_STORE" --persisted-store "$POSTSTART_STORE" || RUN_STATUS=$?
if [[ ! -s "$STATE_FILE" ]]; then
  live_fail "the Vera run phase did not record scenario state (status $RUN_STATUS)"
fi

restart_host

RESTART_STATUS=0
run_driver restart --out "$RESTART_OUT" || RESTART_STATUS=$?

# Privacy gate: the driver outputs and isolated service logs never carry the
# harness directories, credentials, prompt markers, or answer text.
for private_value in "$LIVE_BASE" "$LIVE_PROJECT" "$LIVE_PROJECT/vera-workspace" "$LIVE_SERVER_PASSWORD"; do
  if grep -qF -- "$private_value" "$SEED_OUT" "$RUN_OUT" "$RESTART_OUT" 2>/dev/null; then
    live_fail "the Vera record carried a private path or credential"
  fi
done
for marker in "fake-vera-regression" "Vera regression complete" "vera-warmup-fixture" "vera-rollback-fixture"; do
  if grep -qF -- "$marker" "$SEED_OUT" "$RUN_OUT" "$RESTART_OUT" 2>/dev/null; then
    live_fail "the Vera record carried fixture prompt or answer text"
  fi
done
if grep -qF "/home/" "$SEED_OUT" "$RUN_OUT" "$RESTART_OUT" 2>/dev/null; then
  live_fail "the Vera record carried an absolute home path"
fi
if compgen -G "$LIVE_STATE/ensemble/logs/*" >/dev/null; then
  if grep -R -qF -- "fake-vera-regression" "$LIVE_STATE/ensemble/logs"; then
    live_fail "the service logs carried the Vera prompt marker"
  fi
  if grep -R -qE '/home/|/Users/' "$LIVE_STATE/ensemble/logs"; then
    live_fail "the service logs carried an absolute home path"
  fi
fi

SUPPRESS_COUNT=$(grep -R -h 'native.route.suppressed' "$LIVE_STATE/ensemble/logs" 2>/dev/null | grep -c '"reason":"already-routed"' || true)
[[ "$SUPPRESS_COUNT" != "0" ]] || live_fail "the run never logged an already-routed suppression"
SKIP_COUNT=$(grep -R -h 'completion.skipped' "$LIVE_STATE/ensemble/logs" 2>/dev/null | wc -l | tr -d ' ')
[[ "$SKIP_COUNT" != "0" ]] || live_fail "the run never logged a completion skip"
MODE_MIGRATION=$(grep -R -h 'native.mode' "$LIVE_STATE/ensemble/logs" 2>/dev/null | grep -c '"migrated":true' || true)
[[ "$MODE_MIGRATION" != "0" ]] || live_fail "the run never logged the native-first default migration"
live_log "Vera evidence: already-routed suppressions=$SUPPRESS_COUNT completion skips=$SKIP_COUNT mode migrations=$MODE_MIGRATION"

if [[ -n "${ENSEMBLE_LIVE_ARTIFACTS:-}" ]]; then
  mkdir -p "$ENSEMBLE_LIVE_ARTIFACTS"
  cp "$SEED_OUT" "$RUN_OUT" "$RESTART_OUT" "$PRESTART_STORE" "$POSTSTART_STORE" "$ENSEMBLE_LIVE_ARTIFACTS/"
  if compgen -G "$LIVE_STATE/ensemble/logs/*" >/dev/null; then
    mkdir -p "$ENSEMBLE_LIVE_ARTIFACTS/service-logs"
    cp -R "$LIVE_STATE/ensemble/logs/." "$ENSEMBLE_LIVE_ARTIFACTS/service-logs/"
  fi
  live_log "artifacts copied to $ENSEMBLE_LIVE_ARTIFACTS"
fi

if [[ "$SEED_STATUS" != "0" || "$RUN_STATUS" != "0" || "$RESTART_STATUS" != "0" ]]; then
  live_fail "the Vera regression recorded failures (seed=$SEED_STATUS run=$RUN_STATUS restart=$RESTART_STATUS); see $SEED_OUT, $RUN_OUT, and $RESTART_OUT"
fi

live_log "Vera regression passed: $SEED_OUT $RUN_OUT $RESTART_OUT"
