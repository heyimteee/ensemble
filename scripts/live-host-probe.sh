#!/usr/bin/env bash
set -euo pipefail
if [[ "${ENSEMBLE_LIVE_TRACE_ERR:-0}" == "1" ]]; then
  trap 'printf "live: command failed at line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
fi

# Ticket #210: native host event-contract probe.
#
# Starts an isolated real OpenCode 2.2.x host (2.2.6 or 2.2.7) pointed at the
# deterministic fake provider, drives the native turns the native-first
# ingestion path depends on, and records the real event order and payload
# shapes. No model, external network request, or user credential is used. The
# user's live host is never restarted or reconfigured.
#
#   npm run test:live:probe
#   ENSEMBLE_PROBE_OUT=/path/contract.jsonl npm run test:live:probe
#   ENSEMBLE_PROBE_WRITE=1 npm run test:live:probe   # refresh the committed fixture
#
# The probe records identities and shapes only: message text becomes a length
# plus a digest, file bytes are never written, and absolute paths become
# placeholders. The record is validated by src/v2/native-host-fixture.test.ts.

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
source "$SCRIPT_DIR/lib/live-harness.sh"

live_require_runtime
live_require_node
live_setup "host-probe"

LIVE_WORKSPACE="$LIVE_BASE/workspace"
mkdir -p "$LIVE_WORKSPACE"
git -C "$LIVE_WORKSPACE" init -q
printf 'workspace fixture\n' >"$LIVE_WORKSPACE/README.md"

NODE_VERSION=$("$LIVE_NODE_BIN" --version | sed 's/^v//')
OPENCODE_VERSION=$("$LIVE_OPENCODE_BIN" --version | sed 's/^opencode v//; s/^v//')
TMUX_VERSION=$("$LIVE_TMUX_BIN" -V | sed 's/^tmux //')
PROBE_OUT="${ENSEMBLE_PROBE_OUT:-$LIVE_LOGS/native-host-contract.jsonl}"

live_log "node=$NODE_VERSION opencode=$OPENCODE_VERSION tmux=$TMUX_VERSION"
live_log "fixture=$PROBE_OUT"

live_start_fake_provider
live_tmux_env_add "ENSEMBLE_HOST_PROBE_EVENTS=$LIVE_LOGS/host-events.jsonl"
live_write_config <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "plugins": ["$SCRIPT_DIR/host-probe-plugin"],
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

set +e
"$LIVE_NODE_BIN" "$SCRIPT_DIR/host-probe.mjs" \
  --url "$LIVE_SERVER_URL" \
  --password "$LIVE_SERVER_PASSWORD" \
  --project "$LIVE_PROJECT" \
  --workspace "$LIVE_WORKSPACE" \
  --out "$PROBE_OUT" \
  --events "$LIVE_LOGS/host-events.jsonl" \
  --node-version "$NODE_VERSION" \
  --opencode-version "$OPENCODE_VERSION" \
  --tmux-version "$TMUX_VERSION"
PROBE_STATUS=$?
set -e
[[ "$PROBE_STATUS" == "0" ]] || live_fail "host probe driver failed with status $PROBE_STATUS (partial record: $PROBE_OUT)"
[[ -s "$PROBE_OUT" ]] || live_fail "host probe produced no record"

# Privacy gate: the record never carries the isolated absolute paths, file
# bytes, or the server password. The fixture's only text is length plus digest.
for private_value in "$LIVE_BASE" "$LIVE_PROJECT" "$LIVE_WORKSPACE" "$LIVE_SERVER_PASSWORD"; do
  if [[ -n "$private_value" ]] && grep -qF -- "$private_value" "$PROBE_OUT"; then
    live_fail "the host probe record carried a private path or credential"
  fi
done
if grep -qE 'data:[A-Za-z0-9+/=]{40,}' "$PROBE_OUT"; then
  live_fail "the host probe record carried an inline file payload"
fi
if grep -qF "/home/" "$PROBE_OUT"; then
  live_fail "the host probe record carried an absolute home path"
fi

# The same contract test that guards the committed fixture also guards a fresh
# live record, so the checked-in evidence cannot drift from the probe.
if [[ "${ENSEMBLE_PROBE_VALIDATE:-1}" == "1" ]]; then
  ENSEMBLE_NATIVE_HOST_FIXTURE="$PROBE_OUT" "$LIVE_NODE_BIN" --test --experimental-strip-types \
    "$REPO_ROOT/src/v2/native-host-fixture.test.ts"
fi

if [[ "${ENSEMBLE_PROBE_WRITE:-0}" == "1" ]]; then
  mkdir -p "$REPO_ROOT/src/v2/fixtures"
  cp "$PROBE_OUT" "$REPO_ROOT/src/v2/fixtures/native-host-contract.jsonl"
  live_log "wrote $REPO_ROOT/src/v2/fixtures/native-host-contract.jsonl"
fi

if [[ -n "${ENSEMBLE_PROBE_ARTIFACTS:-}" ]]; then
  mkdir -p "$ENSEMBLE_PROBE_ARTIFACTS"
  cp -R "$LIVE_LOGS/." "$ENSEMBLE_PROBE_ARTIFACTS/"
  cp "$PROBE_OUT" "$ENSEMBLE_PROBE_ARTIFACTS/native-host-contract.jsonl"
  live_log "artifacts copied to $ENSEMBLE_PROBE_ARTIFACTS"
fi

live_log "native host contract probe passed: $PROBE_OUT"
