#!/usr/bin/env bash
# Clean-install release-candidate check (ticket #270).
#
# Packs the candidate, serves it from a loopback-only npm registry, installs it
# with `opencode plugin add` into an isolated OpenCode host, and verifies:
#   1. `opencode plugin list` reports the package source and version.
#   2. The installed server plugin loads and registers the Ensemble tools.
#   3. The installed TUI plugin loads the Ensemble route and `/ensemble` command.
#
# The host, HOME, XDG directories, project, and agents are temporary. The
# caller's OpenCode configuration is never read or written. This script is the
# local/RC proof; CI does not run it and it needs no public registry or
# credentials.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
source "$SCRIPT_DIR/lib/live-harness.sh"

# Release evidence must not silently skip a missing prerequisite.
export ENSEMBLE_LIVE_REQUIRE=1

live_require_runtime
live_require_node
live_setup "install"

LIVE_NPM_BIN="$(dirname "$LIVE_NODE_BIN")/npm"
[[ -x "$LIVE_NPM_BIN" ]] || live_fail "npm is not next to the resolved node binary"

PACKAGE_NAME=$("$LIVE_NODE_BIN" -p 'require(process.argv[1]).name' "$LIVE_ROOT/package.json")
PACKAGE_VERSION=$("$LIVE_NODE_BIN" -p 'require(process.argv[1]).version' "$LIVE_ROOT/package.json")
[[ "$PACKAGE_NAME" == "@heyimteee/ensemble" ]] \
  || live_fail "unexpected package name: $PACKAGE_NAME"
[[ "$PACKAGE_VERSION" == "0.1.0-rc.1" ]] \
  || live_fail "expected release candidate 0.1.0-rc.1, found $PACKAGE_VERSION"
PACKAGE_SPEC="$PACKAGE_NAME@$PACKAGE_VERSION"

# A mock project and agent prove the install does not need the repository as a
# workspace plugin. The project is a fresh Git repository from live_setup.
mkdir -p "$LIVE_PROJECT/.opencode/agent"
cat >"$LIVE_PROJECT/.opencode/agent/install-probe.md" <<'EOF'
---
description: Mock agent for the clean-install release-candidate check.
mode: primary
---

This agent exists only for the isolated install check.
EOF

# --- pack and local registry ---------------------------------------------

PACK_DIR="$LIVE_BASE/pack"
mkdir -p "$PACK_DIR"
TARBALL_NAME=$("$LIVE_NPM_BIN" pack --pack-destination "$PACK_DIR" --silent)
TARBALL="$PACK_DIR/$TARBALL_NAME"
[[ -s "$TARBALL" ]] || live_fail "npm pack did not produce a tarball"
live_log "PASS pack: $PACKAGE_SPEC ($(wc -c <"$TARBALL") bytes)"

REGISTRY_URL_FILE="$LIVE_BASE/registry-url"
LIVE_REGISTRY_SESSION="ensemble-install-registry-$LIVE_RUN_ID"
LIVE_SESSION_NAMES+=("$LIVE_REGISTRY_SESSION")
"$LIVE_TMUX_BIN" new-session -d -s "$LIVE_REGISTRY_SESSION" -c "$LIVE_ROOT" \
  "$(live_command "$LIVE_NODE_BIN" "$SCRIPT_DIR/lib/local-npm-registry.mjs" \
    --manifest "$LIVE_ROOT/package.json" \
    --tarball "$TARBALL" \
    --url-file "$REGISTRY_URL_FILE") >'$LIVE_LOGS/registry.log' 2>&1"
live_wait_for 20 "local npm registry" test -s "$REGISTRY_URL_FILE" \
  || live_fail "local npm registry did not start"
REGISTRY_URL=$(cat "$REGISTRY_URL_FILE")
printf 'registry=%s\n' "$REGISTRY_URL" >"$LIVE_HOME/.npmrc"
live_log "PASS registry: loopback-only candidate"

INSTALL_ENV=(
  "${LIVE_PROCESS_ENV[@]}"
  "NPM_CONFIG_REGISTRY=$REGISTRY_URL"
  "npm_config_registry=$REGISTRY_URL"
)
live_run_isolated() {
  ( cd "$LIVE_PROJECT" && env -i "${INSTALL_ENV[@]}" "$@" )
}

# --- install ---------------------------------------------------------------

if ! live_run_isolated "$LIVE_OPENCODE_BIN" plugin add "$PACKAGE_SPEC" \
  >"$LIVE_LOGS/plugin-add.log" 2>&1; then
  cat "$LIVE_LOGS/plugin-add.log" >&2
  live_fail "opencode plugin add $PACKAGE_SPEC failed"
fi
"$LIVE_NODE_BIN" -e '
  const fs = require("fs");
  const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const spec = process.argv[2];
  if (!Array.isArray(config.plugins) || !config.plugins.includes(spec)) {
    console.error(`plugin add did not record ${spec}`);
    process.exit(1);
  }
' "$LIVE_CONFIG/opencode/opencode.json" "$PACKAGE_SPEC" \
  || live_fail "opencode plugin add did not record $PACKAGE_SPEC"
live_log "PASS plugin add: recorded $PACKAGE_SPEC in isolated config"

# --- plugin list -----------------------------------------------------------

# `plugin list` talks to the managed service. Pin a free loopback port so the
# isolated host can never reuse the caller's service, then stop it explicitly.
SERVICE_PORT=$("$LIVE_NODE_BIN" -e '
  const net = require("net");
  const server = net.createServer();
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    server.close(() => process.stdout.write(String(port)));
  });
')
live_run_isolated "$LIVE_OPENCODE_BIN" service set port "$SERVICE_PORT" >/dev/null 2>&1 \
  || live_fail "could not pin the isolated managed-service port"
plugin_list_ready() {
  live_run_isolated "$LIVE_OPENCODE_BIN" plugin list >"$LIVE_LOGS/plugin-list.log" 2>&1 || return 1
  grep -qE "^ensemble\\.v2[[:space:]]+$PACKAGE_VERSION[[:space:]]+$PACKAGE_SPEC$" \
    "$LIVE_LOGS/plugin-list.log"
}
live_wait_for "${LIVE_START_TIMEOUT}" "plugin list entry for $PACKAGE_SPEC" plugin_list_ready \
  || {
    cat "$LIVE_LOGS/plugin-list.log" >&2
    live_fail "opencode plugin list did not report $PACKAGE_VERSION from $PACKAGE_SPEC"
  }
live_run_isolated "$LIVE_OPENCODE_BIN" service stop >/dev/null 2>&1 || true
live_log "PASS plugin list: ensemble.v2 $PACKAGE_VERSION from $PACKAGE_SPEC"

# --- installed server and TUI ---------------------------------------------

live_start_fake_provider --log "$LIVE_LOGS/fake.log"
live_write_config <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "plugins": ["$PACKAGE_SPEC"],
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
          "limit": { "context": 100000, "output": 4096 }
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

# The only location the isolated host may open is the mock project. A second
# location would make the tool evidence depend on the repository checkout.
if grep -qF "directory=$LIVE_ROOT" "$LIVE_LOGS/server.log"; then
  live_fail "the installed host opened the repository as a location: $LIVE_ROOT"
fi

# The server log names the installed entrypoint. Require the isolated package
# cache, not the repository path or any workspace link.
grep -q "loading plugin.*id=@heyimteee/ensemble@$PACKAGE_VERSION entrypoint=file://$LIVE_BASE/cache/opencode/npm/" \
  "$LIVE_LOGS/server.log" \
  || live_fail "the server did not load $PACKAGE_SPEC from the isolated package cache"
PLUGIN_RECORD=$(curl -fsS --max-time 10 -u "opencode:$LIVE_SERVER_PASSWORD" \
  "$LIVE_SERVER_URL/api/plugin")
"$LIVE_NODE_BIN" -e '
  const record = JSON.parse(process.argv[1]);
  const spec = process.argv[2];
  const version = process.argv[3];
  const item = (record.data ?? []).find((plugin) => plugin.id === "ensemble.v2");
  if (!item) {
    console.error("ensemble.v2 is not registered");
    process.exit(1);
  }
  if (item.source?.type !== "package" || item.source?.target !== spec || item.source?.version !== version) {
    console.error(`unexpected source: ${JSON.stringify(item.source)}`);
    process.exit(1);
  }
  if (!item.features?.server) {
    console.error(`server feature is not active: ${JSON.stringify(item.features)}`);
    process.exit(1);
  }
' "$PLUGIN_RECORD" "$PACKAGE_SPEC" "$PACKAGE_VERSION" \
  || live_fail "the installed server plugin is not active from $PACKAGE_SPEC"
live_log "PASS server plugin: ensemble.v2 active from $PACKAGE_SPEC"

# Drive one real host turn through the installed plugin. The fake provider logs
# only counts; the native surface declares six Ensemble tools.
( cd "$LIVE_PROJECT" && timeout 120 env -i "${INSTALL_ENV[@]}" "OPENCODE_PASSWORD=$LIVE_SERVER_PASSWORD" \
  "$LIVE_OPENCODE_BIN" run --server "$LIVE_SERVER_URL" --format json --agent build \
  "install-check: reply ready" ) >"$LIVE_LOGS/client.log" 2>&1 \
  || {
    tail -n 40 "$LIVE_LOGS/client.log" >&2
    live_fail "opencode run against the installed plugin failed"
  }
"$LIVE_NODE_BIN" -e '
  const fs = require("fs");
  const entries = fs.readFileSync(process.argv[1], "utf8").trim().split("\n")
    .filter(Boolean).map((line) => JSON.parse(line));
  const counts = entries
    .filter((entry) => entry.event === "request")
    .map((entry) => entry.ensembleToolCount);
  if (!counts.includes(6)) {
    console.error(`expected 6 Ensemble tools in a host turn, found: ${counts.join(",")}`);
    process.exit(1);
  }
' "$LIVE_LOGS/fake.log" \
  || live_fail "the installed server plugin did not register the native Ensemble toolset"
live_log "PASS server tools: 6 Ensemble tools registered in a host turn"

live_start_tui
live_wait_for_native_tui
if live_capture "$LIVE_TUI_SESSION" | grep -qF "Plugin failed"; then
  TUI_PLUGIN_ERROR=$(sed -n 's/.*error="\([^"]*\)".*/\1/p' "$LIVE_LOGS/tui.log" | head -n 1 \
    | sed "s|$LIVE_BASE|<live-base>|g")
  live_fail "the installed TUI plugin did not load from $PACKAGE_SPEC: ${TUI_PLUGIN_ERROR:-unknown error}"
fi
live_open_ensemble
live_require_text "$LIVE_TUI_SESSION" "ENSEMBLE" 15 "Ensemble page from /ensemble"
live_require_text "$LIVE_TUI_SESSION" "No currently opened session" 10 "Ensemble empty state"
live_log "PASS TUI plugin: Ensemble route and /ensemble command loaded"

live_log "install-check: PASS ($PACKAGE_SPEC)"
