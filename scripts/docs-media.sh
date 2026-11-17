#!/usr/bin/env bash
# Regenerate the documentation screenshots and terminal replay from an isolated
# synthetic workspace. This is a manual command; the docs build never runs it.
#
# It starts only the local fake provider and OpenCode host from the live test
# harness, uses a temporary HOME/config/data tree, and captures the real TUI at
# 140x40 with motion disabled. No real screen, browser tab, conversation, or
# installed user configuration is read. The fixture and visible states are
# deterministic; host-rendered elapsed times and stream-phase glyphs can differ
# between runs. The manifest records the committed bytes.
set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
source "$SCRIPT_DIR/lib/live-harness.sh"

export ENSEMBLE_LIVE_REQUIRE=1
live_require_runtime
live_require_node

[[ -f "$REPO_ROOT/dist/tui/index.js" ]] \
  || live_fail "run npm run build before regenerating docs media"
[[ -x "$LIVE_NODE_BIN" ]] || live_fail "Node is required"
command -v python3 >/dev/null 2>&1 \
  || live_fail "python3 is required for manual media regeneration"
python3 -c 'import PIL' >/dev/null 2>&1 \
  || live_fail "Pillow is required for manual media regeneration (pip install Pillow)"

live_setup "docs-media"
# The workspace lives inside the isolated HOME created by live_setup. The TUI
# renders it as ~/dev/acme-notes, so no host path or username reaches a frame.
# live_setup's EXIT trap owns cleanup; this script never deletes a path it did
# not create.
LIVE_PROJECT="$LIVE_HOME/dev/acme-notes"
mkdir -p "$LIVE_PROJECT/notes"
git -C "$LIVE_PROJECT" init -q
cat >"$LIVE_PROJECT/README.md" <<'EOF'
# Acme Notes

A synthetic workspace used only for documentation captures.
EOF
cat >"$LIVE_PROJECT/notes/release.md" <<'EOF'
# Release notes

- Saved searches sync after sign-in.
- Offline drafts merge on reconnect.
- Import cleanup removes duplicate tags.
EOF

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
live_tmux_env_add "ENSEMBLE_REDUCED_MOTION=1"
live_start_server
live_check_plugin
live_wait_for_model "ensemble-fake" "ensemble-fake-model"

for spec in \
  'Ada|Workspace lead|Routes requests and keeps the team aligned.' \
  'Nova|Research|Finds and summarizes project context.' \
  'Rook|Review|Checks drafts and reports risks.'; do
  IFS='|' read -r name title role <<<"$spec"
  live_invoke agent.create "{\"name\":\"$name\",\"title\":\"$title\",\"role\":\"$role\"}" >/dev/null
done

# Onboarding direct turns must settle before the group work starts.
for _ in $(seq 1 40); do
  active=$(live_snapshot_value 'Object.values(output.state.subtasks).filter(function(t){return t.state === "pending" || t.state === "working"}).length')
  [[ "$active" == "0" ]] && break
  sleep 0.5
done
[[ "$active" == "0" ]] || live_fail "onboarding turns did not settle"

ids=$(live_snapshot_value 'Object.fromEntries(Object.values(output.state.agents).filter(function(a){return !a.archived}).map(function(a){return [a.name,a.id]}))')
agent_id() {
  printf '%s' "$ids" | "$LIVE_NODE_BIN" -e "let v='';process.stdin.on('data',c=>v+=c).on('end',()=>process.stdout.write(JSON.parse(v).$1))"
}
ada=$(agent_id Ada)
nova=$(agent_id Nova)
rook=$(agent_id Rook)
[[ -n "$ada" && -n "$nova" && -n "$rook" ]] || live_fail "synthetic agents were not created"

live_invoke workspace.create "{\"name\":\"acme-notes\",\"directory\":\"$LIVE_PROJECT\",\"memberIDs\":[\"$ada\",\"$nova\",\"$rook\"],\"leaderID\":\"$ada\",\"synthesis\":true}" >/dev/null
sleep 1
workspace=$(live_snapshot_value 'Object.values(output.state.workspaces).filter(function(w){return !w.archived})[0].id' | tr -d '"')
[[ -n "$workspace" ]] || live_fail "synthetic workspace was not created"

mkdir -p "$LIVE_BASE/frames"
# The install frame is a typed command at a real isolated shell prompt. It is
# deliberately not executed: the docs caption says the command is illustrative.
SHELL_SESSION="ensemble-docs-media-shell-$LIVE_RUN_ID"
LIVE_SESSION_NAMES+=("$SHELL_SESSION")
"$LIVE_TMUX_BIN" new-session -d -s "$SHELL_SESSION" -x 140 -y 40 -c "$LIVE_PROJECT" \
  "$(live_command bash --noprofile --norc)"
sleep 0.6
"$LIVE_TMUX_BIN" send-keys -t "$SHELL_SESSION" "export PS1='~ $ '" Enter
"$LIVE_TMUX_BIN" send-keys -t "$SHELL_SESSION" clear Enter
sleep 0.3
"$LIVE_TMUX_BIN" send-keys -t "$SHELL_SESSION" "opencode plugin add @heyimteee/ensemble@0.1.0"
sleep 0.5
"$LIVE_TMUX_BIN" capture-pane -e -p -t "$SHELL_SESSION" >"$LIVE_BASE/frames/hero-install.ansi"
"$LIVE_TMUX_BIN" kill-session -t "$SHELL_SESSION" 2>/dev/null || true

ENSEMBLE_LIVE_TUI_WIDTH=140
ENSEMBLE_LIVE_TUI_HEIGHT=40
live_start_tui
live_wait_for_native_tui
live_type "$LIVE_TUI_SESSION" "/ensemble"
"$LIVE_TMUX_BIN" capture-pane -e -p -t "$LIVE_TUI_SESSION" >"$LIVE_BASE/frames/hero-launch.ansi"
live_key "$LIVE_TUI_SESSION" Enter
sleep 2
for _ in $(seq 1 6); do
  pane=$(live_capture "$LIVE_TUI_SESSION")
  if grep -q "Move .* into #acme-notes" <<<"$pane"; then
    live_key "$LIVE_TUI_SESSION" n
    sleep 0.6
  else
    break
  fi
done
live_require_text "$LIVE_TUI_SESSION" "ENSEMBLE" 10 "Ensemble page"

cap() {
  "$LIVE_TMUX_BIN" capture-pane -e -p -t "$LIVE_TUI_SESSION" >"$LIVE_BASE/frames/$1.ansi"
  live_log "captured $1"
}

# Three leader-only commands keep the synthetic exchange deterministic.
live_invoke message.send "{\"workspaceID\":\"$workspace\",\"text\":\"Summarize the open threads in #acme-notes.\"}" >/dev/null
live_invoke message.send "{\"workspaceID\":\"$workspace\",\"text\":\"Turn the review notes into a short release note for Acme Notes.\"}" >/dev/null
live_invoke message.send "{\"workspaceID\":\"$workspace\",\"text\":\"List the risks in the Acme Notes import change.\"}" >/dev/null
for _ in $(seq 1 60); do
  active=$(live_snapshot_value 'Object.values(output.state.subtasks).filter(function(t){return t.state === "pending" || t.state === "working"}).length')
  [[ "$active" == "0" ]] && break
  sleep 0.5
done
[[ "$active" == "0" ]] || live_fail "synthetic group replies did not settle"
cap shell

# Open a completed card's native session first, so the captured native frame
# shows the synthetic release-note reply rather than the long active fixture.
live_focus_work_interact "$LIVE_TUI_SESSION"
live_key "$LIVE_TUI_SESSION" f
live_require_text "$LIVE_TUI_SESSION" "WORK HISTORY" 10 "history view"
sleep 0.5
live_key "$LIVE_TUI_SESSION" j
sleep 0.3
live_key "$LIVE_TUI_SESSION" o
sleep 1.5
cap native
live_key "$LIVE_TUI_SESSION" F2
sleep 1
live_focus_work_interact "$LIVE_TUI_SESSION"
if live_capture_contains "$LIVE_TUI_SESSION" "WORK HISTORY"; then
  live_key "$LIVE_TUI_SESSION" f
  live_require_text "$LIVE_TUI_SESSION" "WORK ACTIVE" 10 "ACTIVE view"
fi

# A long ACTIVE turn, then a wider capture for the Work-pane screenshots.
live_focus_chat_interact "$LIVE_TUI_SESSION"
live_key "$LIVE_TUI_SESSION" i
live_type "$LIVE_TUI_SESSION" "Draft the release note and keep the review threads open."
"$LIVE_TMUX_BIN" capture-pane -e -p -t "$LIVE_TUI_SESSION" >"$LIVE_BASE/frames/hero-message.ansi"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "WORKING" 20 "working Work card"
live_require_text "$LIVE_TUI_SESSION" "WORK ACTIVE │" 20 "ACTIVE view"
cap work-active

live_focus_work_interact "$LIVE_TUI_SESSION"
live_key "$LIVE_TUI_SESSION" f
live_require_text "$LIVE_TUI_SESSION" "WORK HISTORY" 10 "history view"
sleep 1
cap work-history
live_key "$LIVE_TUI_SESSION" f

# A pending memory-promotion approval gives the approvals screenshot real state.
live_invoke memory.add "{\"agentID\":\"$ada\",\"workspaceID\":\"$workspace\",\"scope\":\"project\",\"text\":\"The release note uses sentence case and names the change, not the ticket.\"}" >/dev/null
sleep 0.5
memory=$(live_snapshot_value 'Object.values(output.state.memories).filter(function(m){return !m.deletedAt})[0].id' | tr -d '"')
[[ -n "$memory" ]] || live_fail "synthetic memory was not created"
live_invoke memory.promote "{\"id\":\"$memory\"}" >/dev/null
sleep 1
live_key "$LIVE_TUI_SESSION" v
live_require_text "$LIVE_TUI_SESSION" "APPROVALS 1 pending" 10 "pending approvals inbox"
cap approvals
live_key "$LIVE_TUI_SESSION" Escape
sleep 0.5

# Settings for the leader agent.
live_focus_chat_interact "$LIVE_TUI_SESSION"
live_key "$LIVE_TUI_SESSION" s
live_require_text "$LIVE_TUI_SESSION" "Ada │ settings" 10 "agent settings"
sleep 0.5
cap settings

# Render the committed assets and the cast from the captured frames.
MEDIA_DIR="$REPO_ROOT/docs/public/media"
mkdir -p "$MEDIA_DIR"
# Redactions keep the original display width so later columns do not shift.
redact() {
  local shown="$1" length="$2"
  printf '%s%*s' "$shown" $((length - ${#shown})) ''
}
replace_args=(
  "$LIVE_PROJECT=$(redact '~/dev/acme-notes' "${#LIVE_PROJECT}")"
  "$LIVE_HOME=$(redact '~' "${#LIVE_HOME}")"
)
# The check derives the current account, home, and host at run time; no
# contributor identity is committed in this script or its fixtures.
identity_user="${USER:-$(id -un 2>/dev/null || true)}"
identity_host="$(hostname 2>/dev/null || true)"
privacy_forbid=(
  --forbid "/home/"
  --forbid "/Users/"
  --forbid "${TMPDIR:-/tmp}/opencode/"
)
for marker in "$identity_user" "$identity_host" "${HOME:-}" "${HOME##*/}" \
  "$LIVE_BASE" "$LIVE_HOME" "$LIVE_PROJECT"; do
  if [[ -n "$marker" && ${#marker} -ge 3 ]]; then
    privacy_forbid+=(--forbid "$marker")
  fi
done
render_image() {
  local name="$1" source="$2" font="$3" crop="${4:-}"
  local args=(
    image
    --input "$LIVE_BASE/frames/$source.ansi"
    --output "$MEDIA_DIR/$name"
    --cols 140
    --rows 40
    --font-size "$font"
    --replace "${replace_args[0]}"
    --replace "${replace_args[1]}"
    --forbid "/home/"
    --forbid "/tmp/opencode/"
    --forbid "fake-rich-fixture"
    --forbid "RICH_CODE_MARKER"
    --forbid "fake-ask-person"
    "${privacy_forbid[@]}"
  )
  if [[ -n "$crop" ]]; then args+=(--crop "$crop"); fi
  python3 "$SCRIPT_DIR/docs-media-render.py" "${args[@]}"
}

render_image workspace-shell.png work-active 16
render_image work-active.png work-active 16
render_image work-history.png work-history 16
render_image approvals.png approvals 16
render_image settings.png settings 16
render_image native-session.png native 16

cat >"$LIVE_BASE/frames/hero.json" <<EOF
[
  {"time": 0, "ansi": "$LIVE_BASE/frames/hero-install.ansi"},
  {"time": 2.5, "ansi": "$LIVE_BASE/frames/hero-launch.ansi"},
  {"time": 5, "ansi": "$LIVE_BASE/frames/shell.ansi"},
  {"time": 7.5, "ansi": "$LIVE_BASE/frames/hero-message.ansi"},
  {"time": 10.5, "ansi": "$LIVE_BASE/frames/work-active.ansi"},
  {"time": 13.5, "ansi": "$LIVE_BASE/frames/native.ansi"}
]
EOF
python3 "$SCRIPT_DIR/docs-media-render.py" cast \
  --frames "$LIVE_BASE/frames/hero.json" \
  --output "$MEDIA_DIR/hero-terminal.cast" \
  --cols 140 --rows 40 \
  --title "Ensemble synthetic Acme Notes replay" \
  --replace "${replace_args[0]}" \
  --replace "${replace_args[1]}" \
  --forbid "/home/" \
  --forbid "/tmp/opencode/" \
  --forbid "fake-rich-fixture" \
  --forbid "RICH_CODE_MARKER" \
  --forbid "fake-ask-person" \
  "${privacy_forbid[@]}"

"$LIVE_NODE_BIN" "$SCRIPT_DIR/docs-media-manifest.mjs" --media "$MEDIA_DIR"
live_log "docs media regenerated in docs/public/media"
