#!/usr/bin/env bash
# Deterministic quickstart end-to-end proof (ticket #310).
#
# Packs the current package, serves it from a loopback-only npm registry,
# installs it with `opencode plugin add`, then drives the documented quickstart
# through the real TUI: /ensemble -> two agent wizards -> workspace wizard ->
# first group message -> Work card.
#
# This is a timed deterministic smoke, not a human-usability study. The pack,
# local registry, isolated HOME/XDG directories, and fake provider are harness
# setup; every product transition below is driven and observed through the TUI.
set -euo pipefail
if [[ "${ENSEMBLE_LIVE_TRACE_ERR:-0}" == "1" ]]; then
  trap 'printf "live: command failed at line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
fi

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
source "$SCRIPT_DIR/lib/live-harness.sh"

export ENSEMBLE_LIVE_REQUIRE=1

live_require_runtime
live_require_node
live_setup "quickstart"

QUICKSTART_START_MS=$(date +%s%3N)
PHASES_FILE="$LIVE_LOGS/quickstart-phases.tsv"
: >"$PHASES_FILE"
PHASE_NAME=""
PHASE_START_MS=0
phase_start() {
  PHASE_NAME="$1"
  PHASE_START_MS=$(date +%s%3N)
  live_log "phase: $PHASE_NAME"
}
phase_end() {
  local now_ms
  now_ms=$(date +%s%3N)
  printf '%s\t%s\n' "$PHASE_NAME" "$((now_ms - PHASE_START_MS))" >>"$PHASES_FILE"
}

LIVE_NPM_BIN="$(dirname "$LIVE_NODE_BIN")/npm"
[[ -x "$LIVE_NPM_BIN" ]] || live_fail "npm is not next to the resolved node binary"

PACKAGE_NAME=$("$LIVE_NODE_BIN" -p 'require(process.argv[1]).name' "$LIVE_ROOT/package.json")
PACKAGE_VERSION=$("$LIVE_NODE_BIN" -p 'require(process.argv[1]).version' "$LIVE_ROOT/package.json")
[[ "$PACKAGE_NAME" == "@heyimteee/ensemble" ]] \
  || live_fail "unexpected package name: $PACKAGE_NAME"
PACKAGE_SPEC="$PACKAGE_NAME@$PACKAGE_VERSION"

# --- harness setup: pack and loopback registry ------------------------------

phase_start "pack"
PACK_DIR="$LIVE_BASE/pack"
mkdir -p "$PACK_DIR"
TARBALL_NAME=$("$LIVE_NPM_BIN" pack --pack-destination "$PACK_DIR" --silent)
TARBALL="$PACK_DIR/$TARBALL_NAME"
[[ -s "$TARBALL" ]] || live_fail "npm pack did not produce a tarball"
phase_end
live_log "PASS pack: $PACKAGE_SPEC ($(wc -c <"$TARBALL") bytes)"

phase_start "registry"
REGISTRY_URL_FILE="$LIVE_BASE/registry-url"
LIVE_REGISTRY_SESSION="ensemble-quickstart-registry-$LIVE_RUN_ID"
LIVE_SESSION_NAMES+=("$LIVE_REGISTRY_SESSION")
"$LIVE_TMUX_BIN" new-session -d -s "$LIVE_REGISTRY_SESSION" -c "$LIVE_ROOT" \
  "$(live_command "$LIVE_NODE_BIN" "$SCRIPT_DIR/lib/local-npm-registry.mjs" \
    --manifest "$LIVE_ROOT/package.json" \
    --tarball "$TARBALL" \
    --url-file "$REGISTRY_URL_FILE") >'$LIVE_LOGS/registry.log' 2>&1"
live_wait_for 20 "local npm registry" test -s "$REGISTRY_URL_FILE" \
  || live_fail "local npm registry did not start"
REGISTRY_URL=$(cat "$REGISTRY_URL_FILE")
printf '@heyimteee:registry=%s\n' "$REGISTRY_URL" >"$LIVE_HOME/.npmrc"
phase_end

# --- product entry: install the packed package -----------------------------

phase_start "install"
live_run_isolated() {
  ( cd "$LIVE_PROJECT" && env -i "${LIVE_PROCESS_ENV[@]}" "$@" )
}
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
CACHE_PACKAGE=$(ls -d "$LIVE_BASE"/cache/opencode/npm/@heyimteee/ensemble@"$PACKAGE_VERSION"/*/node_modules/@heyimteee/ensemble 2>/dev/null | head -n 1)
[[ -n "$CACHE_PACKAGE" && -f "$CACHE_PACKAGE/dist/tui/index.js" ]] \
  || live_fail "the installed package has no dist/tui/index.js in the plugin cache"
[[ ! -e "$CACHE_PACKAGE/src" ]] \
  || live_fail "the installed package still ships TypeScript sources"
"$LIVE_NODE_BIN" -e '
  const { createRequire } = require("node:module");
  const resolved = createRequire(process.argv[1] + "/package.json");
  for (const name of ["@opentui/core", "@opentui/solid", "solid-js"]) {
    const path = resolved.resolve(name);
    if (!path.startsWith(process.argv[2])) {
      console.error(`${name} resolved outside the plugin cache: ${path}`);
      process.exit(1);
    }
  }
' "$CACHE_PACKAGE" "$LIVE_BASE/cache/opencode/npm" \
  || live_fail "the installed TUI runtime dependencies do not resolve from the plugin cache"
phase_end
live_log "PASS install: $PACKAGE_SPEC from the packed tarball with isolated runtime dependencies"

# --- harness setup: fake provider and installed-plugin host -----------------

phase_start "host-start"
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
grep -q "loading plugin.*id=@heyimteee/ensemble@$PACKAGE_VERSION entrypoint=file://$LIVE_BASE/cache/opencode/npm/" \
  "$LIVE_LOGS/server.log" \
  || live_fail "the server did not load $PACKAGE_SPEC from the isolated package cache"
if grep -qF "directory=$LIVE_ROOT" "$LIVE_LOGS/server.log"; then
  live_fail "the installed host opened the repository as a location: $LIVE_ROOT"
fi
phase_end
live_log "PASS host: installed plugin loaded from the package cache, fake provider only"

# --- product path: /ensemble ------------------------------------------------

phase_start "open-ensemble"
live_start_tui
live_wait_for_native_tui
live_open_ensemble
live_require_text "$LIVE_TUI_SESSION" "ENSEMBLE" 15 "Ensemble page"
live_require_text "$LIVE_TUI_SESSION" "no workspace" 10 "empty workspace header"
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Agents" 10 "initial Agents pane"
phase_end
live_log "PASS /ensemble: empty ENSEMBLE page reached through the TUI"

# --- product path: two agent wizards ---------------------------------------

create_agent() {
  local name="$1" title="$2" role="$3"
  live_select_pane "$LIVE_TUI_SESSION" agents
  live_enter_selected_pane "$LIVE_TUI_SESSION"
  live_key "$LIVE_TUI_SESSION" "a"
  live_require_text "$LIVE_TUI_SESSION" "Agent name" 10 "agent wizard for $name"
  live_key "$LIVE_TUI_SESSION" "i"
  live_type "$LIVE_TUI_SESSION" "$name"
  live_key "$LIVE_TUI_SESSION" Enter
  live_require_text "$LIVE_TUI_SESSION" "Agent title" 10 "agent title step for $name"
  live_type "$LIVE_TUI_SESSION" "$title"
  live_key "$LIVE_TUI_SESSION" Enter
  live_require_text "$LIVE_TUI_SESSION" "Agent role" 10 "agent role step for $name"
  live_type "$LIVE_TUI_SESSION" "$role"
  live_key "$LIVE_TUI_SESSION" Enter
  live_require_text "$LIVE_TUI_SESSION" "Agent memories (optional)" 10 "agent memories step for $name"
  live_key "$LIVE_TUI_SESSION" Enter
  live_require_text "$LIVE_TUI_SESSION" "Main model" 10 "agent model step for $name"
  live_key "$LIVE_TUI_SESSION" Enter
  live_require_any_text "$LIVE_TUI_SESSION" 20 "reasoning step or direct chat for $name" \
    "Reasoning effort" "$name │ direct"
  if live_capture_contains "$LIVE_TUI_SESSION" "Reasoning effort"; then
    live_key "$LIVE_TUI_SESSION" Enter
  fi
  live_require_text "$LIVE_TUI_SESSION" "$name │ direct" 20 "direct chat after $name creation"
  live_key "$LIVE_TUI_SESSION" C-g
  live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Direct conversation" 10 "normal mode after $name creation"
  live_wait_for 20 "$name in the durable snapshot" live_snapshot_has_agent_named "$name" \
    || live_fail "the UI created $name but the snapshot never contained it"
  live_focus_chat_interact "$LIVE_TUI_SESSION"
}

phase_start "agent-nova"
create_agent "Nova" "Research" "You research project material and summarize it."
phase_end
live_log "PASS agent 1: Nova created through the agent wizard"

phase_start "agent-rook"
create_agent "Rook" "Review" "You review changes and report risks."
phase_end
live_log "PASS agent 2: Rook created through the agent wizard"

# --- product path: workspace wizard ----------------------------------------

phase_start "workspace"
live_key "$LIVE_TUI_SESSION" C-g
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Direct conversation" 10 "normal mode before the workspace wizard"
live_key "$LIVE_TUI_SESSION" "n"
live_require_text "$LIVE_TUI_SESSION" "Workspace directory" 10 "workspace directory step"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Workspace name" 10 "workspace name step"
live_key "$LIVE_TUI_SESSION" "i"
live_type "$LIVE_TUI_SESSION" "acme-notes"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Workspace members" 10 "workspace members step"
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Wizard" 10 "workspace members Normal mode"
# Nova starts selected. Toggle it off and back on, then select Rook; require
# exactly two checked rows before continuing.
live_key "$LIVE_TUI_SESSION" Space
sleep 0.25
live_key "$LIVE_TUI_SESSION" Space
sleep 0.25
live_key "$LIVE_TUI_SESSION" "j"
live_key "$LIVE_TUI_SESSION" Space
sleep 0.25
live_require_count "$LIVE_TUI_SESSION" "[x]" 2 10 "both agents selected as workspace members"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Workspace leader" 10 "workspace leader step"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Leader synthesis" 10 "workspace synthesis step"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "#acme-notes" 20 "created workspace opens its group chat"
for name in Nova Rook; do
  if live_try_text "$LIVE_TUI_SESSION" "Move $name into #acme-notes" 10; then
    live_key "$LIVE_TUI_SESSION" "y"
    live_log "PASS move: accepted the move-home prompt for $name"
  fi
done
live_wait_for 20 "acme-notes in the durable snapshot" live_snapshot_has_workspace_named "acme-notes" \
  || live_fail "the UI created acme-notes but the snapshot never contained it"
workspace_shape=$(live_snapshot_value '(function () {
  const workspace = Object.values(output.state.workspaces).find(function (item) { return item.name === "acme-notes" && !item.archived });
  if (!workspace) return "missing";
  const agents = Object.values(output.state.agents).filter(function (agent) { return !agent.archived && workspace.memberIDs.includes(agent.id) });
  const leader = output.state.agents[workspace.leaderID];
  return workspace.memberIDs.length + ":" + agents.length + ":" + (leader ? leader.name : "missing");
})()')
[[ "$workspace_shape" == '"2:2:Nova"' ]] \
  || live_fail "expected two members and Nova as leader, got $workspace_shape"
phase_end
live_log "PASS workspace: acme-notes created with Nova and Rook; Nova is leader"

# --- product path: first message and Work card -----------------------------

phase_start "message-work"
live_key "$LIVE_TUI_SESSION" C-g
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Group chat" 10 "group chat before the composer"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "j/k scroll" 10 "group chat interaction"
live_key "$LIVE_TUI_SESSION" "i"
live_require_text "$LIVE_TUI_SESSION" "COMPOSER" 10 "composer focus"
live_type "$LIVE_TUI_SESSION" "Summarize what this project is for in three bullets."
live_key "$LIVE_TUI_SESSION" Enter
live_require_any_text "$LIVE_TUI_SESSION" 20 "Work card after the first message" \
  "WORK ACTIVE │ 1 group" "REPLIED"
live_require_text "$LIVE_TUI_SESSION" "Onboarding complete. I am ready." 30 "fake provider reply in group chat"
live_focus_work_interact "$LIVE_TUI_SESSION"
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Work list" 10 "Work pane interaction"
if live_capture_contains "$LIVE_TUI_SESSION" "WORK ACTIVE"; then
  live_key "$LIVE_TUI_SESSION" "f"
fi
live_require_text "$LIVE_TUI_SESSION" "WORK HISTORY │" 10 "Work HISTORY after the reply"
live_require_text "$LIVE_TUI_SESSION" "REPLIED" 10 "Work card settled as REPLIED"
live_require_work_text "$LIVE_TUI_SESSION" "Summarize" 10 "Work card carries the group message title"
work_shape=$(live_snapshot_value '(function () {
  const workspace = Object.values(output.state.workspaces).find(function (item) { return item.name === "acme-notes" });
  if (!workspace) return "missing-workspace";
  const tasks = Object.values(output.state.subtasks).filter(function (task) {
    return task.workspaceID === workspace.id && task.title.indexOf("Summarize what this project") >= 0
  });
  if (tasks.length !== 1) return "tasks:" + tasks.length;
  return tasks[0].state + ":title";
})()')
[[ "$work_shape" == '"replied:title"' ]] \
  || live_fail "expected one replied Work item titled from the message, got $work_shape"
phase_end
live_log "PASS message: group message sent through the composer and the Work card settled as REPLIED"

# --- timing evidence -------------------------------------------------------

QUICKSTART_END_MS=$(date +%s%3N)
TOTAL_MS=$((QUICKSTART_END_MS - QUICKSTART_START_MS))
TIMINGS_JSON="$LIVE_LOGS/quickstart-timings.json"
"$LIVE_NODE_BIN" - "$PHASES_FILE" "$TIMINGS_JSON" "$TOTAL_MS" "$PACKAGE_SPEC" <<'NODE'
const fs = require("node:fs")
const [phasesFile, output, totalMs, packageSpec] = process.argv.slice(2)
const phases = fs.readFileSync(phasesFile, "utf8").trim().split("\n").filter(Boolean).map((line) => {
  const [phase, ms] = line.split("\t")
  return { phase, ms: Number(ms) }
})
fs.writeFileSync(output, JSON.stringify({
  schema: "ensemble.quickstart-e2e-timings",
  version: 1,
  package: packageSpec,
  totalMs: Number(totalMs),
  phases,
  observed: [
    "packed-install",
    "ensemble-route",
    "agent-nova",
    "agent-rook",
    "workspace-acme-notes",
    "group-message",
    "work-card-replied",
  ],
  note: "Deterministic timed smoke, not a human-usability study.",
}, null, 2) + "\n")
NODE
live_log "timing: deterministic quickstart completed in ${TOTAL_MS}ms"

# Copy sanitized evidence outside the disposable live base. Failure artifacts
# are handled by the harness; success artifacts are copied here.
ARTIFACT_DIR="${ENSEMBLE_LIVE_ARTIFACTS:-/tmp/opencode/ensemble-quickstart-$(date +%Y%m%d-%H%M%S)-$$}"
mkdir -p "$ARTIFACT_DIR"
cp "$TIMINGS_JSON" "$ARTIFACT_DIR/"
for log in plugin-add.log registry.log server.log tui.log fake.log; do
  [[ -f "$LIVE_LOGS/$log" ]] || continue
  live_redact <"$LIVE_LOGS/$log" >"$ARTIFACT_DIR/$log" 2>/dev/null || true
done
live_capture "$LIVE_TUI_SESSION" | live_redact >"$ARTIFACT_DIR/final-pane.txt" 2>/dev/null || true
live_log "artifacts: $ARTIFACT_DIR"
live_log "quickstart: PASS ($PACKAGE_SPEC)"
