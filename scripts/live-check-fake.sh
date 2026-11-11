#!/usr/bin/env bash
set -euo pipefail
if [[ "${ENSEMBLE_LIVE_TRACE_ERR:-0}" == "1" ]]; then
  trap 'printf "live: command failed at line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
fi

# Deterministic live TUI check. Starts a dependency-free OpenAI-compatible fake
# provider, points an isolated OpenCode configuration at it, then verifies rich
# Markdown streaming/finalization, the absence of stale transcript lines, and
# searchable shortcut help. It never calls a real model and needs no API key.

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
source "$SCRIPT_DIR/lib/live-harness.sh"

# The canonical team contract version is owned by the source, not this script.
ENSEMBLE_BLOCK_VERSION=$(sed -n 's/^export const ENSEMBLE_BLOCK_VERSION = \([0-9][0-9]*\)$/\1/p' "$REPO_ROOT/src/v2/init-block.ts" | head -n 1)
[[ -n "$ENSEMBLE_BLOCK_VERSION" ]] || { echo "could not read ENSEMBLE_BLOCK_VERSION from src/v2/init-block.ts" >&2; exit 1; }

live_require_runtime
live_require_node
live_setup "fake"

# Ticket #167/#176: composer file references resolve untracked and spaced
# paths, and the cached index must not spawn `fd` on every keystroke. A counting
# wrapper on PATH records discoveries without changing the search semantics.
FD_REAL=$(command -v fd 2>/dev/null || true)
FD_AVAILABLE=0
if [[ -n "$FD_REAL" ]]; then
  FD_AVAILABLE=1
  mkdir -p "$LIVE_BASE/bin"
  cat >"$LIVE_BASE/bin/fd" <<EOF
#!/usr/bin/env bash
printf 'x\n' >>"$LIVE_BASE/fd-invocations"
exec "$FD_REAL" "\$@"
EOF
  chmod +x "$LIVE_BASE/bin/fd"
  live_tmux_env_add "PATH=$LIVE_BASE/bin:$PATH"
fi
printf 'handover fixture\n' >"$LIVE_PROJECT/handover.md"
mkdir -p "$LIVE_PROJECT/docs"
printf 'spaced path fixture\n' >"$LIVE_PROJECT/docs/my notes.md"

# Ticket #172/#177: Work is the right pane (or the 80x24 drawer), with its own
# ACTIVE/HISTORY header. A "work is active" wait must assert a non-zero active
# count in that header; a complete group leaves ACTIVE immediately and remains
# in HISTORY.
live_capture_active_work() {
  local session="$1"
  live_capture "$session" | grep -Eq 'WORK (ACTIVE|HISTORY) │ [0-9]+ groups? · [1-9][0-9]* active'
}

live_require_active_work() {
  local session="$1" seconds="${2:-$LIVE_STEP_TIMEOUT}" description="${3:-active work}"
  live_wait_for "$seconds" "$description" live_capture_active_work "$session" \
    || live_fail "TUI did not show: $description"
}

live_capture_no_active_work() {
  local session="$1"
  live_capture "$session" | grep -Eq 'WORK ACTIVE │ none yet|WORK ACTIVE │ 0 groups'
}

live_require_no_active_work() {
  local session="$1" seconds="${2:-$LIVE_STEP_TIMEOUT}" description="${3:-no active work}"
  live_wait_for "$seconds" "$description" live_capture_no_active_work "$session" \
    || live_fail "TUI still shows: $description"
}

# Focus the Work pane from any Normal surface with the ticket #180 model:
# Escape settles into pane selection, `l` selects the right column, and Enter
# enters it. The Work pane may be a closed column; #183's Space b r reopens it.
live_focus_work() {
  local session="${1:-$LIVE_TUI_SESSION}"
  live_focus_work_interact "$session"
  live_require_text "$session" "NORMAL  │ Work list" 10 "Work list focus"
}

live_assert_history_has() {
  local session="$1" text="$2" description="${3:-history contains $text}"
  live_focus_work "$session"
  live_key "$session" "f"
  live_require_text "$session" "WORK HISTORY │" 10 "$description"
  live_require_text "$session" "$text" 10 "$description"
  live_key "$session" "f"
  live_require_text "$session" "WORK ACTIVE │" 10 "history toggled back to ACTIVE"
}

# Ticket #137: a Work card header reads `NAME<pad>GLYPH STATUS`; green is
# reserved for REPLIED and the name may truncate before the status word.
live_capture_work_card() {
  local session="$1" agent="$2" status="$3"
  # The header may carry a dispatch-budget label between the agent name and
  # the glyph/status block (#160). Allow any number of budget tokens there.
  live_capture "$session" | grep -Eq "${agent} +([^ ]+ +)*[^ ]+ ${status}"
}

live_require_work_card() {
  local session="$1" agent="$2" status="$3" seconds="${4:-$LIVE_STEP_TIMEOUT}" description="${5:-$agent $status card}"
  live_wait_for "$seconds" "$description" live_capture_work_card "$session" "$agent" "$status" \
    || live_fail "TUI did not show: $description"
}

live_assert_absence_work_card() {
  local session="$1" agent="$2" status="$3" description="${4:-absence of $agent $status card}"
  live_capture_work_card "$session" "$agent" "$status" && live_fail "TUI unexpectedly shows: $description"
  return 0
}

live_count_work_card() {
  local session="$1" agent="$2" status="$3"
  live_capture "$session" | { grep -oE "${agent} +([^ ]+ +)*[^ ]+ ${status}" || true; } | wc -l | tr -d ' '
}

# v5.8 T2/T3: deterministic project skills give the composer palette real
# host catalog rows to assign and invoke. OpenCode discovers project skills
# from .opencode/skills/<name>/SKILL.md before the server starts.
mkdir -p "$LIVE_PROJECT/.opencode/skills/ensemble-live-skill"
cat >"$LIVE_PROJECT/.opencode/skills/ensemble-live-skill/SKILL.md" <<'EOF'
---
name: ensemble-live-skill
description: Deterministic Ensemble live skill for composer invocation.
---

# Ensemble live skill

Use this fixture only to verify deliberate skill routing in the fake live
harness. It contains no project instructions.
EOF
mkdir -p "$LIVE_PROJECT/.opencode/skills/ensemble-live-skill-two"
cat >"$LIVE_PROJECT/.opencode/skills/ensemble-live-skill-two/SKILL.md" <<'EOF'
---
name: ensemble-live-skill-two
description: Second deterministic Ensemble live skill for multi-anchor routing.
---

# Ensemble live skill two

Use this fixture only to verify grouped and multi-agent skill routing in the
fake live harness. It contains no project instructions.
EOF
mkdir -p "$LIVE_PROJECT/.opencode/skills/ensemble-live-skill-general"
cat >"$LIVE_PROJECT/.opencode/skills/ensemble-live-skill-general/SKILL.md" <<'EOF'
---
name: ensemble-live-skill-general
description: Unassigned General skill for leader-triage routing.
---

# Ensemble live general skill

Use this fixture only to verify General-skill leader triage. It is assigned to
no agent, so the planner routes it to the workspace leader.
EOF
mkdir -p "$LIVE_PROJECT/.opencode/skills/ensemble-live-skill-helper"
cat >"$LIVE_PROJECT/.opencode/skills/ensemble-live-skill-helper/SKILL.md" <<'EOF'
---
name: ensemble-live-skill-helper
description: Helper-only assigned skill for the owner-picker probe.
---

# Ensemble live helper skill

Use this fixture only to verify the message-start owner picker when the leader
does not own the skill.
EOF

# Ticket #77: keep fake streams long enough that the parked-queue probe is
# deterministic — the queued line must still be parked when the removal key
# is pressed. This only slows the fake harness; the real provider is untouched.
export ENSEMBLE_FAKE_CHUNK_DELAY_MS="${ENSEMBLE_FAKE_CHUNK_DELAY_MS:-60}"

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
# Ticket #240: this broad walkthrough predates native-first default-on and
# asserts the legacy direct, DM-queue, and statusline surfaces. Run it on the
# explicit legacy path; the Vera regression (#241) covers the default-on
# cutover, and the unit/service suites cover the default itself.
live_invoke settings.update '{"nativeFirst":"off"}' >/dev/null
live_start_tui
live_wait_for_native_tui
live_open_ensemble

live_require_text "$LIVE_TUI_SESSION" "ENSEMBLE" 15 "Ensemble page"
live_require_text "$LIVE_TUI_SESSION" "No currently opened session" 10 "empty chat state"
live_assert_text "$LIVE_TUI_SESSION" "○───○───○" "one-shot empty-state mark"
# Ticket #180: a fresh page opens in pane selection with Agents selected. The
# select-mode hint proves no pane content owns the keyboard yet.
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Agents" 10 "initial pane selection"
live_assert_text "$LIVE_TUI_SESSION" "h/l column" "select mode teaches h/l columns"
live_assert_text "$LIVE_TUI_SESSION" "enter enter" "select mode teaches Enter"
# Ticket #56: the right-hand task board is retired; nothing renders it.
live_assert_absence "$LIVE_TUI_SESSION" "SUBTASKS" "right-hand task board retired"
# `I init` is a roster key; Enter the selected Agents pane first.
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Agents" 10 "Agents interaction"
live_require_text "$LIVE_TUI_SESSION" "I init" 10 "I init shortcut"
live_require_text "$LIVE_TUI_SESSION" "git:(" 10 "git metadata"
live_check_help

# Ticket #145: the logs viewer reads the service ring over RPC, shows sink
# state, and closes without disturbing the surface underneath.
live_type "$LIVE_TUI_SESSION" ":logs"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Logs · recent" 10 "logs viewer"
live_require_text "$LIVE_TUI_SESSION" "service.start" 10 "service log line in the viewer"
live_assert_text "$LIVE_TUI_SESSION" "content=off" "content logging is off by default"
live_key "$LIVE_TUI_SESSION" Escape
live_require_absence "$LIVE_TUI_SESSION" "Logs · recent" 10 "logs viewer closed"

# The fake catalog contains one model with variants, so the agent wizard always
# offers a Reasoning effort step. T2: a text step keeps the mode it arrived
# with (Normal from the roster); `i` is the explicit Insert entry.
live_key "$LIVE_TUI_SESSION" "a"
live_require_text "$LIVE_TUI_SESSION" "Agent name" 10 "agent wizard"
live_assert_text "$LIVE_TUI_SESSION" "NORMAL  │ Wizard" "wizard text keeps the arrival mode"
# Ticket #125/#127: the wizard header carries a one-cell step rail; the
# current step is `▣`, completed steps are `▪`, and upcoming steps are `▫`.
live_assert_text "$LIVE_TUI_SESSION" "▣ ▫ ▫" "wizard rail marks the current and upcoming steps"
live_assert_text "$LIVE_TUI_SESSION" "i/a insert" "field Normal teaches the Vim entries"
live_key "$LIVE_TUI_SESSION" "i"
live_require_text "$LIVE_TUI_SESSION" "INSERT  │ Wizard" 10 "i enters Insert in the wizard field"
live_assert_text "$LIVE_TUI_SESSION" "enter next │ esc normal" "Insert field teaches its ladder"
live_type "$LIVE_TUI_SESSION" "FakeAgent"
sleep 0.25
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Wizard" 10 "first Esc goes to field Normal"
live_assert_text "$LIVE_TUI_SESSION" "i/a insert" "field Normal teaches the Vim entries"
live_assert_text "$LIVE_TUI_SESSION" "esc cancel" "field Normal Esc cancels the wizard"
# T4: a dirty cancel asks first; n keeps the draft, the second Esc confirms.
sleep 0.3
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "discard draft?" 10 "dirty Esc asks before discarding"
live_assert_text "$LIVE_TUI_SESSION" "y/enter discard" "discard confirm teaches y/Enter"
live_key "$LIVE_TUI_SESSION" "n"
live_require_absence "$LIVE_TUI_SESSION" "discard draft?" 10 "n keeps the wizard draft"
live_require_text "$LIVE_TUI_SESSION" "Agent name" 10 "the draft stays on the step"
live_assert_text "$LIVE_TUI_SESSION" "NORMAL  │ Wizard" "keeping the draft keeps the mode"
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "discard draft?" 10 "cancel confirm reopened"
live_key "$LIVE_TUI_SESSION" "y"
live_require_absence "$LIVE_TUI_SESSION" "Agent name" 10 "y discarded the wizard"
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Agents" 10 "cancel returns to Agents Normal"
# Reopen and walk the fields: N goes back to Agent name and n returns; the
# title draft survives the round trip.
live_key "$LIVE_TUI_SESSION" "a"
live_require_text "$LIVE_TUI_SESSION" "Agent name" 10 "agent wizard reopened"
live_key "$LIVE_TUI_SESSION" "i"
live_type "$LIVE_TUI_SESSION" "FakeAgent"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Agent title" 10 "agent title step"
live_assert_text "$LIVE_TUI_SESSION" "▪ ▣" "wizard rail marks the completed first step"
live_type "$LIVE_TUI_SESSION" "Engineering"
sleep 0.25
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Wizard" 10 "title Esc goes to field Normal"
live_key "$LIVE_TUI_SESSION" "N"
live_require_text "$LIVE_TUI_SESSION" "Agent name" 10 "N goes back one step"
live_assert_text "$LIVE_TUI_SESSION" "NORMAL  │ Wizard" "the previous text step keeps Normal"
live_key "$LIVE_TUI_SESSION" "n"
live_require_text "$LIVE_TUI_SESSION" "Agent title" 10 "n returns to the next step"
live_require_text "$LIVE_TUI_SESSION" "Engineering" 10 "title draft survived the back step"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Agent role" 10 "agent role step"
live_key "$LIVE_TUI_SESSION" "i"
live_type "$LIVE_TUI_SESSION" "Renders deterministic Markdown."
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Agent memories (optional)" 10 "agent memories step"
# T4: the memories step is an ordered one-by-one list. Insert arrival stays
# Insert with no text target; Esc returns to Normal before list keys act.
live_assert_text "$LIVE_TUI_SESSION" "INSERT  │ Wizard" "the memories step keeps Insert"
live_assert_text "$LIVE_TUI_SESSION" "no text target │ Esc normal" "the memories step has no text target and keeps its core segments"
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Wizard" 10 "Esc leaves Insert on the memory list"
live_assert_text "$LIVE_TUI_SESSION" "j/k select" "the memory list uses j/k"
live_assert_text "$LIVE_TUI_SESSION" "a add" "the memory list teaches add"
live_assert_text "$LIVE_TUI_SESSION" "e edit" "the memory list teaches edit"
live_assert_text "$LIVE_TUI_SESSION" "x delete" "the memory list teaches delete"
live_assert_text "$LIVE_TUI_SESSION" "n next" "the memory list teaches n next"
live_assert_text "$LIVE_TUI_SESSION" "N previous" "the memory list teaches N previous"
live_assert_text "$LIVE_TUI_SESSION" "esc cancel" "the memory list teaches cancel"
live_require_text "$LIVE_TUI_SESSION" "No memories yet. a adds one." 10 "the empty memory list names add"
live_key "$LIVE_TUI_SESSION" "a"
live_require_text "$LIVE_TUI_SESSION" "INSERT  │ Wizard" 10 "a opens the memory field in Insert"
live_assert_text "$LIVE_TUI_SESSION" "enter save │ esc list" "the memory field teaches its persistent ladder"
live_require_text "$LIVE_TUI_SESSION" "The team uses pnpm." 10 "the memory input is mounted"
sleep 0.2
live_type "$LIVE_TUI_SESSION" "Likes deterministic fixtures"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "memories: 1" 10 "the first memory joined the list"
live_require_text "$LIVE_TUI_SESSION" "The team uses pnpm." 10 "the add field cleared after Enter"
live_assert_text "$LIVE_TUI_SESSION" "INSERT  │ Wizard" "the add field stayed in Insert"
sleep 0.2
live_type "$LIVE_TUI_SESSION" "Never edit generated files"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "memories: 2" 10 "the second memory joined the list"
live_require_text "$LIVE_TUI_SESSION" "The team uses pnpm." 10 "the second entry cleared for the next one"
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Wizard" 10 "Esc returns the memory field to the list"
sleep 0.25
# e opens the selected memory in Insert; Enter saves in place and keeps it.
live_key "$LIVE_TUI_SESSION" "k"
live_key "$LIVE_TUI_SESSION" "e"
live_require_text "$LIVE_TUI_SESSION" "INSERT  │ Wizard" 10 "e opens the memory in Insert"
sleep 0.2
live_type "$LIVE_TUI_SESSION" " v2"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "INSERT  │ Wizard" 10 "edit Enter saves and keeps the field"
live_require_count "$LIVE_TUI_SESSION" "Likes deterministic fixtures v2" 2 10 "edited text is in the field and the list"
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "memories: 2" 10 "the edit field returned to the list"
sleep 0.25
# x deletes the selected memory; the remaining list stays intact.
live_key "$LIVE_TUI_SESSION" "j"
live_key "$LIVE_TUI_SESSION" "x"
live_require_text "$LIVE_TUI_SESSION" "memories: 1" 10 "x deletes the selected memory"
live_require_absence "$LIVE_TUI_SESSION" "Never edit generated files" 10 "the deleted memory leaves the list"
# Add another entry so creation saves a multi-item list one by one.
live_key "$LIVE_TUI_SESSION" "a"
live_require_text "$LIVE_TUI_SESSION" "INSERT  │ Wizard" 10 "the add field reopens in Insert"
sleep 0.2
live_type "$LIVE_TUI_SESSION" "Uses pnpm"
live_key "$LIVE_TUI_SESSION" Enter
live_key "$LIVE_TUI_SESSION" Escape
sleep 0.25
live_require_text "$LIVE_TUI_SESSION" "memories: 2" 10 "the final memory list has two entries"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Main model" 10 "Enter advances from the memory list"
# A list step arrives in Normal; `/` owns filtering on option steps. `:` and
# Space never open the command line or the leader.
live_assert_text "$LIVE_TUI_SESSION" "NORMAL  │ Wizard" "the model step keeps the arrival mode"
live_assert_text "$LIVE_TUI_SESSION" "j/k select" "wizard list uses the shared navigation"
live_assert_text "$LIVE_TUI_SESSION" "/ filter" "wizard list names the filter key"
live_assert_text "$LIVE_TUI_SESSION" "esc cancel" "wizard list names the cancel key"
live_key "$LIVE_TUI_SESSION" ":"
sleep 0.25
live_assert_absence "$LIVE_TUI_SESSION" "COMMAND  │" "colon is disabled in a wizard"
live_assert_text "$LIVE_TUI_SESSION" "Main model" "the wizard stayed open after colon"
live_key "$LIVE_TUI_SESSION" Space
sleep 0.25
live_assert_absence "$LIVE_TUI_SESSION" "LEADER" "Space never opens the leader in a wizard"
live_key "$LIVE_TUI_SESSION" "/"
live_require_text "$LIVE_TUI_SESSION" "type to filter │ enter done │ esc clear" 10 "wizard filter enters the shared filter mode"
live_type "$LIVE_TUI_SESSION" "zzz-no-model"
live_require_text "$LIVE_TUI_SESSION" "filter: zzz-no-model" 10 "wizard filter follows typing"
sleep 0.25
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "filter: (none)" 10 "first Esc cleared the wizard filter"
live_assert_text "$LIVE_TUI_SESSION" "Main model" "clearing the filter kept the wizard step"
sleep 0.3
live_key "$LIVE_TUI_SESSION" Enter
live_require_any_text "$LIVE_TUI_SESSION" 15 "reasoning step or direct chat" "Reasoning effort" "FakeAgent │ direct"
if live_capture_contains "$LIVE_TUI_SESSION" "Reasoning effort"; then
  live_key "$LIVE_TUI_SESSION" Enter
fi
live_require_text "$LIVE_TUI_SESSION" "FakeAgent │ direct" 20 "direct chat opened"
agent_memories=$(live_snapshot_value 'Object.values(output.state.memories).filter(function (m) { return !m.deletedAt }).map(function (m) { return m.text })')
[[ "$agent_memories" == '["Likes deterministic fixtures v2","Uses pnpm"]' ]] || live_fail "wizard memories did not persist one by one (got $agent_memories)"
# Clear them so later memory-count probes stay meaningful.
for _ in $(seq 1 2); do
  wizard_memory_id=$(live_snapshot_value 'Object.values(output.state.memories).filter(function (m) { return !m.deletedAt })[0]?.id' | tr -d '"')
  [[ -n "$wizard_memory_id" ]] || break
  live_invoke memory.delete "{\"id\":\"$wizard_memory_id\"}" >/dev/null
done
live_require_text "$LIVE_TUI_SESSION" "FakeAgent" 10 "agent roster entry"
live_require_text "$LIVE_TUI_SESSION" "Onboarding complete. I am ready." 20 "fake onboarding reply"
live_require_absence "$LIVE_TUI_SESSION" "streaming…" 15 "onboarding finalization"

# Send the marker that makes the fake provider stream the rich Markdown
# fixture, then observe the live block before it is finalized in place.
live_key "$LIVE_TUI_SESSION" "i"
live_require_text "$LIVE_TUI_SESSION" "COMPOSER" 10 "composer focus"
# v5.6 T1: Insert mode, context, and the new Esc ladder are visible in the bar.
live_assert_text "$LIVE_TUI_SESSION" "INSERT  │ COMPOSER │ Direct conversation" "statusline names Insert and context"
live_assert_text "$LIVE_TUI_SESSION" "enter send │ esc normal │ ctrl+g leave" "statusline names the composer ladder"
# Slice B: the COMPOSER hint is focus-border-only — no blink glyph anywhere.
live_assert_absence "$LIVE_TUI_SESSION" "▌" "no composer blink glyph"
live_type "$LIVE_TUI_SESSION" "fake-rich-fixture"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Working…" 15 "one-line aggregate activity while live"
live_assert_absence "$LIVE_TUI_SESSION" "streaming…" "raw streaming dump removed"
live_require_text "$LIVE_TUI_SESSION" "Rich Markdown Fixture" 20 "finalized rich reply"
live_require_text "$LIVE_TUI_SESSION" "table cell marker" 20 "final table row"
live_require_absence "$LIVE_TUI_SESSION" "streaming…" 20 "in-place finalization"
live_require_absence "$LIVE_TUI_SESSION" "Working…" 20 "aggregate activity line unmounts after finalize"
# v5.6 T1: Enter keeps Insert focus; Esc goes composer Insert -> composer
# Normal -> chat Normal, and never leaves Ensemble.
live_require_text "$LIVE_TUI_SESSION" "Message…" 10 "composer cleared after send but still focused"
live_assert_text "$LIVE_TUI_SESSION" "INSERT  │ COMPOSER" "composer keeps Insert focus after Enter send"
sleep 0.25
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ COMPOSER" 10 "first Esc goes to composer Normal"
live_assert_text "$LIVE_TUI_SESSION" "i insert │ h/j/k/l │ x/d" "composer Normal hints name the Vim keys"
live_assert_text "$LIVE_TUI_SESSION" "enter send │ esc chat" "composer Normal hints name the ladder"
live_key "$LIVE_TUI_SESSION" Escape
live_require_absence "$LIVE_TUI_SESSION" "COMPOSER" 10 "second Esc returns to chat Normal"
live_assert_text "$LIVE_TUI_SESSION" "NORMAL  │ Direct conversation" "chat stays in Normal mode"

# Ticket #70 determinism: rich Markdown lays out over several frames, so an
# instant assert can catch a partial render — a different missing element per
# run. Settle with a bounded poll until every marker co-occurs in one
# capture; the asserts below are unchanged, only the observation is stable.
live_require_all_text "$LIVE_TUI_SESSION" 20 "settled rich reply" \
  "Rich Markdown Fixture" "bold text" "italic text" "alpha item" "ordered one" \
  "quoted line one" "inline code" "RICH_CODE_MARKER" "Ensemble repository" "table cell marker"

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

# Finalization must fold the live row into the transcript, not leave a duplicate behind.
live_assert_count "$LIVE_TUI_SESSION" "Rich Markdown Fixture" 1 "rich reply heading"
live_assert_count "$LIVE_TUI_SESSION" "RICH_CODE_MARKER" 1 "fenced code marker"
live_assert_count "$LIVE_TUI_SESSION" "quoted line one" 1 "quoted line"
live_assert_count "$LIVE_TUI_SESSION" "table cell marker" 1 "table cell"
live_assert_absence "$LIVE_TUI_SESSION" "streaming…" "streaming block after finalization"

# The durable direct-message user line renders exactly once next to the reply.
live_assert_text "$LIVE_TUI_SESSION" "fake-rich-fixture" "DM user line"
live_assert_count "$LIVE_TUI_SESSION" "fake-rich-fixture" 1 "DM user line exactly once"

# Ticket #80 command and search. `/` filters the focused roster, `:` opens a
# command line with Tab completion and per-kind history, and `/` searches the
# loaded transcript with n/N match navigation and visible row highlighting.
# Ticket #180: Agents is a distinct pane; Escape + h selects it, Enter enters
# the roster grammar.
live_escape_to_pane_select "$LIVE_TUI_SESSION"
live_key "$LIVE_TUI_SESSION" "h"
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Agents" 10 "Agents pane selected before search"
live_assert_text "$LIVE_TUI_SESSION" "h/l column" "h selects the pane, not roster rows"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Agents" 10 "roster focus before search"
live_require_text "$LIVE_TUI_SESSION" "AGENTS (1)" 10 "unfiltered roster count"
live_key "$LIVE_TUI_SESSION" "/"
live_require_text "$LIVE_TUI_SESSION" "COMMAND  │ Agents" 10 "search opens the command line on the roster"
live_require_text "$LIVE_TUI_SESSION" "enter search │ esc cancel" 10 "search hint names Enter and Esc"
live_type "$LIVE_TUI_SESSION" "zzz-no-roster-match"
live_require_text "$LIVE_TUI_SESSION" "/zzz-no-roster-match" 10 "roster query renders in the bottom bar"
live_require_absence "$LIVE_TUI_SESSION" "AGENTS (1)" 10 "roster filter hid the agent row"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "0 roster matches" 10 "committed roster search names its match count"
live_require_text "$LIVE_TUI_SESSION" "filter “zzz-no-roster-match”" 10 "roster filter hint survives the committed search"
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "AGENTS (1)" 10 "Esc restored the unfiltered roster"
live_require_absence "$LIVE_TUI_SESSION" "filter “zzz-no-roster-match”" 10 "roster filter hint cleared"

live_focus_chat_interact "$LIVE_TUI_SESSION"
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Direct conversation" 10 "chat focus before transcript search"
live_key "$LIVE_TUI_SESSION" "/"
live_require_text "$LIVE_TUI_SESSION" "COMMAND  │ Direct conversation" 10 "search opens on the transcript"
live_type "$LIVE_TUI_SESSION" "text"
live_require_text "$LIVE_TUI_SESSION" "/text" 10 "transcript query renders in the bottom bar"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Match 1/2" 10 "first transcript match"
live_require_text "$LIVE_TUI_SESSION" "▶ FakeAgent · /text" 10 "matching row is highlighted"
live_require_text "$LIVE_TUI_SESSION" "match 1/2 │ n next │ N previous │ esc clear" 10 "search statusline names n/N"
live_key "$LIVE_TUI_SESSION" "n"
live_require_text "$LIVE_TUI_SESSION" "Match 2/2" 10 "n moves to the next match"
live_key "$LIVE_TUI_SESSION" "N"
live_require_text "$LIVE_TUI_SESSION" "Match 1/2" 10 "N moves back to the previous match"
live_key "$LIVE_TUI_SESSION" Escape
live_require_absence "$LIVE_TUI_SESSION" "▶ FakeAgent · /text" 10 "Esc cleared transcript search highlighting"
# Search may have scrolled to an older match; return to the newest line so the
# rest of the walkthrough observes the live transcript again.
live_key "$LIVE_TUI_SESSION" End
sleep 0.25
live_require_text "$LIVE_TUI_SESSION" "table cell marker" 10 "End returned the transcript to the newest content"

live_type "$LIVE_TUI_SESSION" ":"
live_require_text "$LIVE_TUI_SESSION" "COMMAND  │ Direct conversation" 10 "colon opens Command mode"
live_require_text "$LIVE_TUI_SESSION" "enter run │ esc cancel" 10 "command hint names Enter and Esc"
live_type "$LIVE_TUI_SESSION" "set"
live_key "$LIVE_TUI_SESSION" Tab
live_require_text "$LIVE_TUI_SESSION" ":settings" 10 "Tab completed the command"
live_key "$LIVE_TUI_SESSION" Escape
live_require_absence "$LIVE_TUI_SESSION" ":settings" 10 "Esc cancelled the command line"
live_assert_text "$LIVE_TUI_SESSION" "NORMAL  │ Direct conversation" "cancel restored Normal mode"
live_assert_absence "$LIVE_TUI_SESSION" "FakeAgent │ settings" "cancel never ran the completed command"

# Review fix: the command line has a real cursor. Insert a missing letter in
# the middle, then prove Home/End and Delete also edit at the cursor.
live_type "$LIVE_TUI_SESSION" ":setings"
live_key "$LIVE_TUI_SESSION" Left
live_key "$LIVE_TUI_SESSION" Left
live_key "$LIVE_TUI_SESSION" Left
live_key "$LIVE_TUI_SESSION" Left
live_type "$LIVE_TUI_SESSION" "t"
live_key "$LIVE_TUI_SESSION" End
live_require_text "$LIVE_TUI_SESSION" ":settings" 10 "Left and insertion edit at the command cursor"
live_key "$LIVE_TUI_SESSION" BSpace
live_require_text "$LIVE_TUI_SESSION" ":setting" 10 "Backspace removes the character before the cursor"
live_type "$LIVE_TUI_SESSION" "s"
live_key "$LIVE_TUI_SESSION" Home
live_key "$LIVE_TUI_SESSION" Delete
live_key "$LIVE_TUI_SESSION" End
live_require_text "$LIVE_TUI_SESSION" ":ettings" 10 "Delete removes the character under the cursor"
live_key "$LIVE_TUI_SESSION" Home
live_type "$LIVE_TUI_SESSION" "s"
live_key "$LIVE_TUI_SESSION" End
live_require_text "$LIVE_TUI_SESSION" ":settings" 10 "Home and insertion restore the command"
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Direct conversation" 10 "command editing canceled back to Normal"

live_type "$LIVE_TUI_SESSION" ":"
live_type "$LIVE_TUI_SESSION" "help"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Keyboard shortcuts" 15 "command ran help"
live_key "$LIVE_TUI_SESSION" Escape
live_require_absence "$LIVE_TUI_SESSION" "Keyboard shortcuts" 10 "help closed after the command"
sleep 0.25
live_type "$LIVE_TUI_SESSION" ":"
live_key "$LIVE_TUI_SESSION" Up
live_require_text "$LIVE_TUI_SESSION" ":help" 10 "Up recalled the command history"
live_key "$LIVE_TUI_SESSION" Escape
sleep 0.25
live_type "$LIVE_TUI_SESSION" ":"
live_key "$LIVE_TUI_SESSION" Up
live_require_text "$LIVE_TUI_SESSION" ":help" 10 "command history survives cancellation and reuse"
live_key "$LIVE_TUI_SESSION" Escape
sleep 0.25

live_type "$LIVE_TUI_SESSION" ":"
live_type "$LIVE_TUI_SESSION" "approvals"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "APPROVALS 0 pending" 15 "command opened full approvals"
live_require_text "$LIVE_TUI_SESSION" "Nothing waits for you." 10 "the empty inbox names no waiting decision"
live_key "$LIVE_TUI_SESSION" Escape
live_require_absence "$LIVE_TUI_SESSION" "APPROVALS 0 pending" 10 "approvals returned to split"
live_log "ticket #80 command line, completion, history, and transcript search verified"

# Workspace wizard: list steps use j/k, gg/G, Enter, Space multi-select, /,
# and Esc; text steps enter Insert; confirms accept y/Enter and reject n/Esc.
live_key "$LIVE_TUI_SESSION" "n"
live_require_text "$LIVE_TUI_SESSION" "New workspace" 10 "workspace wizard"
live_require_text "$LIVE_TUI_SESSION" "Workspace directory" 10 "directory step"
live_assert_text "$LIVE_TUI_SESSION" "NORMAL  │ Wizard" "wizard list step is Normal"
live_assert_text "$LIVE_TUI_SESSION" "j/k select" "directory step names j/k"
live_assert_text "$LIVE_TUI_SESSION" "/ filter" "directory step names the filter key"
live_assert_text "$LIVE_TUI_SESSION" "esc cancel" "directory step names the cancel key"
live_key "$LIVE_TUI_SESSION" ":"
sleep 0.25
live_assert_absence "$LIVE_TUI_SESSION" "COMMAND  │" "colon never opens Command inside a wizard"
live_assert_text "$LIVE_TUI_SESSION" "Workspace directory" "the wizard stayed on its step after colon"
live_key "$LIVE_TUI_SESSION" Space
sleep 0.25
live_assert_absence "$LIVE_TUI_SESSION" "LEADER" "Space never opens the leader in a wizard"
live_assert_text "$LIVE_TUI_SESSION" "Workspace directory" "the wizard stayed on its step after Space"
live_key "$LIVE_TUI_SESSION" "/"
live_require_text "$LIVE_TUI_SESSION" "type to filter │ enter done │ esc clear" 10 "wizard filter mode shares its hints"
live_type "$LIVE_TUI_SESSION" "zzz-no-dir"
live_require_text "$LIVE_TUI_SESSION" "filter: zzz-no-dir" 10 "wizard filter follows typing"
sleep 0.25
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "filter: (none)" 10 "first Esc clears the wizard filter"
live_assert_text "$LIVE_TUI_SESSION" "Workspace directory" "filter Esc stays on the step"
sleep 0.3
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Workspace name" 10 "workspace name step"
live_assert_text "$LIVE_TUI_SESSION" "NORMAL  │ Wizard" "the name step keeps the arrival mode"
live_key "$LIVE_TUI_SESSION" "i"
live_require_text "$LIVE_TUI_SESSION" "INSERT  │ Wizard" 10 "i enters Insert for the name"
live_type "$LIVE_TUI_SESSION" "LiveSite"
sleep 0.25
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Wizard" 10 "name step Esc goes to field Normal"
sleep 0.3
live_key "$LIVE_TUI_SESSION" "i"
live_require_text "$LIVE_TUI_SESSION" "INSERT  │ Wizard" 10 "i re-enters Insert"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Workspace members" 10 "members step"
live_assert_text "$LIVE_TUI_SESSION" "INSERT  │ Wizard" "a list step keeps Insert"
live_assert_text "$LIVE_TUI_SESSION" "no text target │ Esc normal" "a list step reports Insert with no target and keeps its core segments"
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Wizard" 10 "Esc returns the list step to Normal"
live_assert_text "$LIVE_TUI_SESSION" "space toggle" "members step names the multi-select key"
live_require_text "$LIVE_TUI_SESSION" "[x]" 10 "the first member starts selected"
live_key "$LIVE_TUI_SESSION" Space
sleep 0.25
live_require_text "$LIVE_TUI_SESSION" "[ ]" 10 "Space toggled the member off"
live_key "$LIVE_TUI_SESSION" Space
sleep 0.25
live_require_text "$LIVE_TUI_SESSION" "[x]" 10 "Space toggled the member back on"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Workspace leader" 10 "leader step"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Leader synthesis" 10 "synthesis choice step"
live_assert_text "$LIVE_TUI_SESSION" "Yes — let the leader synthesize" "synthesis yes option"
live_key "$LIVE_TUI_SESSION" Enter
live_assert_absence "$LIVE_TUI_SESSION" "\$ agents" "no completion popup from wizard Enter"
live_require_text "$LIVE_TUI_SESSION" "Move FakeAgent into" 15 "move-home confirm"
live_assert_text "$LIVE_TUI_SESSION" "y/enter yes │ n/esc no" "confirm shares y/n and Enter/Esc"
sleep 0.25
live_key "$LIVE_TUI_SESSION" "n"
live_require_text "$LIVE_TUI_SESSION" "#LiveSite" 20 "n rejected the confirm and created the workspace"
live_require_text "$LIVE_TUI_SESSION" "leader FakeAgent" 15 "leader visible on group surface"
synthesis=$(live_snapshot_value 'Object.values(output.state.workspaces)[0].synthesis')
[[ "$synthesis" == "true" ]] || live_fail "synthesis choice did not persist as Yes (got $synthesis)"
leader_name=$(live_snapshot_value 'Object.values(output.state.agents).filter(function (agent) { return !agent.archived })[0].name')
[[ "$leader_name" == '"FakeAgent"' ]] || live_fail "unexpected roster leader (got $leader_name)"
# v5.7 T3 follow-up: LEADER is inline colored text after a chrome separator,
# not a boxed cutout. The name row carries `FakeAgent │ LEADER`; the title
# branch stays on the next row.
live_require_text "$LIVE_TUI_SESSION" "LEADER" 10 "leader label visible in the rail"
live_assert_text "$LIVE_TUI_SESSION" "FakeAgent │ LEADER" "leader label shares the name row after a separator"
pane_leader=$(live_capture "$LIVE_TUI_SESSION")
leader_at=$(grep -nF "LEADER" <<<"$pane_leader" | head -1 | cut -d: -f1)
title_at=$(grep -nF "Engineering" <<<"$pane_leader" | head -1 | cut -d: -f1)
[[ -n "$leader_at" && -n "$title_at" ]] || live_fail "leader label or title branch missing (leader @$leader_at title @$title_at)"
[[ "$title_at" -eq "$((leader_at + 1))" ]] || live_fail "title branch must follow the leader name row (leader @$leader_at title @$title_at)"
live_log "inline leader label visible on the name row"

# Prose `/init` is ordinary group text, and a `:init` command with an extra
# mention is rejected instead of silently discarding it.
live_key "$LIVE_TUI_SESSION" "i"
live_require_text "$LIVE_TUI_SESSION" "COMPOSER" 10 "composer focus for prose /init"
live_type "$LIVE_TUI_SESSION" "hello /init prose-check"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "→ Assigned to \$FakeAgent: hello /init prose-check" 20 "prose /init becomes ordinary group text"
prose_init_jobs=$(live_snapshot_value 'Object.values(output.state.initJobs).length')
[[ "$prose_init_jobs" == "0" ]] || live_fail "prose /init started an init job (got $prose_init_jobs)"
live_key "$LIVE_TUI_SESSION" C-g
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Group chat" 10 "prose send leaves the composer for the command line"
live_key "$LIVE_TUI_SESSION" ":"
live_type "$LIVE_TUI_SESSION" "init !Helper"
sleep 0.3
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Init is solo-only." 10 "an :init mention is rejected"
mention_init_jobs=$(live_snapshot_value 'Object.values(output.state.initJobs).length')
[[ "$mention_init_jobs" == "0" ]] || live_fail ":init with a mention started an init job (got $mention_init_jobs)"
live_log "v5.8 init prose and extra-mention guards verified"

# v5.8 T1: every init trigger appends a visible /init audit line and starts a
# System Agent job. The job owns a temporary native session, runs native
# /init internally, streams progress, and finalizes the canonical block plus
# init metadata only on success. `I`, `:init`, and composer `/init` must all
# produce the same visible line.
wait_for_init_successes() {
  local expected="$1" succeeded
  for _ in $(seq 1 120); do
    succeeded=$(live_snapshot_value 'Object.values(output.state.initJobs).filter(function (job) { return job.state === "succeeded" }).length')
    [[ "$succeeded" == "$expected" ]] && return 0
    sleep 0.4
  done
  live_fail "expected $expected successful init job(s), found $succeeded"
}
live_key "$LIVE_TUI_SESSION" "I"
live_require_text "$LIVE_TUI_SESSION" "System Agent" 20 "I starts a visible System Agent init"
# Ticket #118: the live row names the current stage. Running is explicitly
# indeterminate because native /init is opaque; there is no fabricated
# percentage. The right Work pane narrows the chat column, so the one-line row
# middle-elides the stage marks at 160 columns; the exact stage indicator is
# pinned by initrow.test.ts, and the live check asserts the honest running
# label plus its indeterminate detail.
live_require_text "$LIVE_TUI_SESSION" "System Agent │ running" 20 "init row labels the opaque native run"
live_require_text "$LIVE_TUI_SESSION" "progress is indeterminate" 20 "init row explains the indeterminate stage"
wait_for_init_successes 1
init_first_phases=$(live_snapshot_value 'Object.values(output.state.initJobs)[0].phases.join(">")')
[[ "$init_first_phases" == '"starting>running>writing>reporting"' ]] || live_fail "I init did not carry the four phases in order (got $init_first_phases)"
live_key "$LIVE_TUI_SESSION" ":"
live_type "$LIVE_TUI_SESSION" "init"
live_key "$LIVE_TUI_SESSION" Enter
wait_for_init_successes 2
live_key "$LIVE_TUI_SESSION" "i"
live_require_text "$LIVE_TUI_SESSION" "COMPOSER" 10 "composer focus for /init"
live_type "$LIVE_TUI_SESSION" "/init"
live_key "$LIVE_TUI_SESSION" Enter
wait_for_init_successes 3
init_phase_order=$(live_snapshot_value 'Object.values(output.state.initJobs).map(function (job) { return (job.phases || []).join(">") }).join(",")')
expected_init_phases="starting>running>writing>reporting"
expected_init_order="\"$expected_init_phases,$expected_init_phases,$expected_init_phases\""
[[ "$init_phase_order" == "$expected_init_order" ]] || live_fail "all init triggers did not carry the four phases in order (got $init_phase_order)"
init_audit=$(live_snapshot_value '(function () { var ws = Object.values(output.state.workspaces)[0]; return (output.state.messages[ws.id] || []).filter(function (m) { return m.author === "user" && m.text === "/init" }).length })()')
[[ "$init_audit" == "3" ]] || live_fail "expected three visible /init audit lines, found $init_audit"
init_reports=$(live_snapshot_value '(function () { var ws = Object.values(output.state.workspaces)[0]; return (output.state.messages[ws.id] || []).filter(function (m) { return m.displayAuthor === "System Agent" && !m.streaming && /Ensemble init complete/.test(m.text) }).length })()')
[[ "$init_reports" == "3" ]] || live_fail "expected three finalized System Agent reports, found $init_reports"
init_sessions=$(live_snapshot_value 'Object.values(output.state.initJobs).map(function (job) { return job.sessionID }).join(",")')
[[ "$init_sessions" == *,* ]] || live_fail "init jobs did not record their temporary native sessions (got $init_sessions)"
live_require_text "$LIVE_TUI_SESSION" "Ensemble init complete" 20 "System Agent final report is visible"
live_assert_text "$LIVE_TUI_SESSION" "/init" "every init trigger leaves a visible audit line"
live_assert_text "$LIVE_TUI_SESSION" "System Agent" "the System Agent authors the init report"
grep -qF -- "<!-- ensemble:start v${ENSEMBLE_BLOCK_VERSION} -->" "$LIVE_PROJECT/AGENTS.md" || live_fail "canonical AGENTS.md block was not written"
init_block_count=$(grep -oF -- "<!-- ensemble:start" "$LIVE_PROJECT/AGENTS.md" | wc -l | tr -d ' ')
[[ "$init_block_count" == "1" ]] || live_fail "AGENTS.md carries $init_block_count Ensemble blocks"
grep -qF -- "\"version\": ${ENSEMBLE_BLOCK_VERSION}" "$LIVE_PROJECT/.ensemble/init.json" || live_fail "init metadata version was not recorded"
live_log "I, :init, and /init produced visible System Agent jobs and reports"

# Inline work progress at this layer (ticket #56, slice A ticket #64): group
# messages create leader work that starts with no further TUI action — no
# navigation, no native session — and runs to replied. While active, the
# ephemeral WORK block lists exactly the active rows with the assigned agent,
# and a per-agent activity line shows what each agent is doing; no raw
# streamed body text appears anywhere. Each terminal outcome is announced
# once as a transcript system line, finished rows stay inside their dispatch
# group as display-only cards, and the block unmounts after the shared 1.2 s
# group hold. A second message proves multiple live items each finalize
# without duplicates or stale lines.
live_key "$LIVE_TUI_SESSION" "i"
live_require_text "$LIVE_TUI_SESSION" "COMPOSER" 10 "composer focus on group surface"
live_type "$LIVE_TUI_SESSION" "fake-queue-alpha"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "fake-queue-alpha" 15 "group message posted"
sleep 0.25
live_key "$LIVE_TUI_SESSION" Escape
live_require_active_work "$LIVE_TUI_SESSION" 15 "ephemeral work block mounts while active"
live_require_work_card "$LIVE_TUI_SESSION" "FAKEAGENT" "WORKING" 15 "work card loading state with assignee"
live_assert_absence "$LIVE_TUI_SESSION" "streaming…" "raw streaming dump removed"
# Slice B: live activity lines animate across the approved ten-frame Braille
# working set (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏). Bursts finalize in about half a second on this
# fixture, so a slow capture cadence after further requires observes a single
# tick. Collect at 0.15 s from the moment live work is known (the WORK row)
# across both delegation bursts instead: the loop subsumes the "activity line
# while live" wait, and zero frames means the line never rendered.
live_log "observing working-frame animation and tide motion across ticks"
seen_frames=0
seen_which=""
seen_tides=0
seen_tide_rows=""
seen_work_sample=""
collect_work_frames() {
  local rounds="${1:-40}" _ pane frame tide_row work_sample
  for _ in $(seq 1 "$rounds"); do
    pane=$(live_capture "$LIVE_TUI_SESSION")
    work_sample=$(grep -n -A 4 -E 'FAKEAGENT.*WORKING' <<<"$pane" | head -n 12 || true)
    [[ -n "$work_sample" ]] && seen_work_sample="$work_sample"
    for frame in "⠋" "⠙" "⠹" "⠸" "⠼" "⠴" "⠦" "⠧" "⠇" "⠏"; do
      if grep -qE "FAKEAGENT.*${frame} WORKING" <<<"$pane" && [[ "$seen_which" != *"$frame"* ]]; then
        seen_which="${seen_which}${frame}"
        seen_frames=$((seen_frames + 1))
      fi
    done
    # Ticket #116/#127: the Work card tide row is a full-width one-row strip
    # of block glyphs inside the chat border. Distinct captures prove the
    # 10 fps tide advances.
    # Ticket #137: the default 160-wide card interior yields 15 sampled
    # columns (tideColumns clamps to 8–64), so require the documented minimum
    # rather than a 16-pair floor that no approved card width reaches here.
    tide_row=$(grep -oE '([▁▂▃▄▅▆▇█] ?){8,}' <<<"$pane" | tr '\n' '|' || true)
    if [[ -n "$tide_row" && "$seen_tide_rows" != *"$tide_row"* ]]; then
      seen_tide_rows="${seen_tide_rows}${tide_row}"$'\n'
      seen_tides=$((seen_tides + 1))
    fi
    [[ "$seen_frames" -ge 2 && "$seen_tides" -ge 2 ]] && return 0
    sleep 0.04
  done
  return 1
}
collect_work_frames 40 || true
live_assert_absence "$LIVE_TUI_SESSION" "▌" "no blink glyph while work is live"
# Slice C: the assignment event is a durable transcript line, so it is
# asserted after the timing-sensitive animation observation, not before it.
live_require_text "$LIVE_TUI_SESSION" "→ Assigned to \$FakeAgent: fake-queue-alpha" 15 "assignment line for the delegation"
live_assert_count "$LIVE_TUI_SESSION" "→ Assigned to \$FakeAgent: fake-queue-alpha" 1 "assignment emitted exactly once"
live_key "$LIVE_TUI_SESSION" "i"
live_require_text "$LIVE_TUI_SESSION" "COMPOSER" 10 "composer focus for second message"
live_type "$LIVE_TUI_SESSION" "fake-queue-beta"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "fake-queue-beta" 15 "second group message posted"
# Second burst, same collector: combined frames across both bursts must show
# the clock ticking; a single static frame in both fails below.
collect_work_frames 40 || true
[[ "$seen_frames" -ge 2 ]] || live_fail "activity line did not animate across working frames (saw: $seen_which)"
if [[ "$seen_tides" -lt 2 ]]; then
  printf 'live: tide diagnostics (work sample: %q)\n' "$seen_work_sample" >&2
  live_fail "Work card tide strip did not advance across working frames"
fi
live_log "activity line and tide strip animated across working frames ($seen_which; $seen_tides tide frames)"
# Count only the two named group work items; init jobs are separate subtasks.
queue_replied=0
for _ in $(seq 1 120); do
  queue_replied=$(live_snapshot_value 'Object.values(output.state.subtasks).filter(function (t) { return t.state === "replied" && (t.title === "fake-queue-alpha" || t.title === "fake-queue-beta") }).length')
  [[ "$queue_replied" == "2" ]] && break
  sleep 0.5
done
[[ "$queue_replied" == "2" ]] || live_fail "group work did not run to replied with no further action (got $queue_replied replied)"
live_require_text "$LIVE_TUI_SESSION" "● FakeAgent finished: fake-queue-alpha" 15 "terminal announcement for first work"
live_require_text "$LIVE_TUI_SESSION" "● FakeAgent finished: fake-queue-beta" 15 "terminal announcement for second work"
live_assert_count "$LIVE_TUI_SESSION" "● FakeAgent finished:" 2 "each terminal outcome announced exactly once"
live_require_no_active_work "$LIVE_TUI_SESSION" 15 "ACTIVE clears completed group work"
live_assert_absence_work_card "$LIVE_TUI_SESSION" "FAKEAGENT" "WORKING" "no active cards remain in ACTIVE"
live_assert_absence_work_card "$LIVE_TUI_SESSION" "FAKEAGENT" "REPLIED" "finished cards stay out of ACTIVE"
# Ticket #172: completed groups are retained in HISTORY, not discarded.
live_key "$LIVE_TUI_SESSION" C-g
live_focus_work
live_key "$LIVE_TUI_SESSION" "f"
live_require_text "$LIVE_TUI_SESSION" "WORK HISTORY │" 10 "f toggles HISTORY"
live_assert_text "$LIVE_TUI_SESSION" "fake-queue-alpha" "first completed card is retained in HISTORY"
live_assert_text "$LIVE_TUI_SESSION" "fake-queue-beta" "second completed card is retained in HISTORY"
live_assert_text "$LIVE_TUI_SESSION" "REPLIED" "HISTORY renders the completed card state"
live_key "$LIVE_TUI_SESSION" "f"
live_require_text "$LIVE_TUI_SESSION" "WORK ACTIVE │" 10 "f toggles back to ACTIVE"
live_focus_chat "$LIVE_TUI_SESSION"
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Group chat" 10 "pane selection returns to chat after the history probe"
live_assert_absence "$LIVE_TUI_SESSION" "Working…" "no aggregate activity line when idle"
# Review fixes (findings 2–3): no interim label can stick after completion,
# and no needs-you marker appears without user-blocked work in this flow.
live_assert_absence "$LIVE_TUI_SESSION" "Stopping…" "no stuck stop label after terminal"
live_assert_absence "$LIVE_TUI_SESSION" "Cancelling…" "no stuck cancel label after terminal"
live_assert_absence "$LIVE_TUI_SESSION" "Retrying…" "no stuck retry label after terminal"
live_assert_absence "$LIVE_TUI_SESSION" "Restarting…" "no stuck restart label after terminal"
live_assert_absence "$LIVE_TUI_SESSION" "NEEDS YOU" "no needs-you marker without blocked work"
# Review fix (finding 4): stagger is glyph/color-only with no text marker, so
# text anchors stay stable; finalization order is unaffected and each row
# renders exactly once (no per-chunk re-animation duplicates). Deterministic
# pane-order check — no timing involved.
pane_order=$(live_capture "$LIVE_TUI_SESSION")
alpha_at=$(grep -nF "fake-queue-alpha" <<<"$pane_order" | head -1 | cut -d: -f1)
beta_at=$(grep -nF "fake-queue-beta" <<<"$pane_order" | head -1 | cut -d: -f1)
[[ -n "$alpha_at" && -n "$beta_at" && "$alpha_at" -lt "$beta_at" ]] || live_fail "transcript order changed by stagger (alpha @$alpha_at beta @$beta_at)"
live_require_absence "$LIVE_TUI_SESSION" "streaming…" 20 "in-place finalization of group work"
queue_status=$(live_snapshot_value 'Object.values(output.state.subtasks).map(function (t) { return t.status })')
[[ "$queue_status" == *replied* ]] || live_fail "derived work status not exposed in snapshot (got $queue_status)"
queue_key=$(live_snapshot_value 'Object.values(output.state.subtasks).map(function (t) { return typeof t.queueKey })')
[[ "$queue_key" == *string* ]] || live_fail "idempotency key not exposed in snapshot (got $queue_key)"
live_log "group work ran to replied with derived status ($queue_status)"

# Peer turn at this layer (ticket #57, slice A ticket #64): a `$Name` group
# mention creates a durable peer turn through the same queue — queued,
# working, then replied — with the asking mention and the answering agent
# both visible in order. The new burst mounts a fresh WORK block with only
# its own row; the terminal outcome is announced once and the block settles
# through the shared group hold. The recipient's reply is the relay:
# exactly one answer row, no second leg.
live_key "$LIVE_TUI_SESSION" C-g
live_key "$LIVE_TUI_SESSION" "i"
live_require_text "$LIVE_TUI_SESSION" "COMPOSER" 10 "composer focus for peer turn"
live_type "$LIVE_TUI_SESSION" "$"
live_require_text "$LIVE_TUI_SESSION" "\$ agents" 10 "agent completion for mention"
live_key "$LIVE_TUI_SESSION" Enter
live_require_absence "$LIVE_TUI_SESSION" "\$ agents" 10 "completion accepted"
live_type "$LIVE_TUI_SESSION" "peer-check"
live_key "$LIVE_TUI_SESSION" Enter
# Slice C: the assignment event names the owner; while the peer turn is in
# flight the one-line chat summary reads `Asking $Name…` instead of the
# generic verb. Read the transient label before the assignment wait can
# consume its window.
live_require_joined_single_text "$LIVE_TUI_SESSION" "Asking \$FakeAgent…" 15 "asking aggregate line renders once in chat"
live_assert_absence "$LIVE_TUI_SESSION" "FakeAgent │ Asking" "the asking label is not a per-agent activity row"
live_require_text "$LIVE_TUI_SESSION" "peer-check" 15 "peer mention posted"
live_require_text "$LIVE_TUI_SESSION" "→ Assigned to \$FakeAgent: \$FakeAgent peer-check" 15 "assignment line for the peer turn"
live_assert_count "$LIVE_TUI_SESSION" "→ Assigned to \$FakeAgent: \$FakeAgent peer-check" 1 "peer assignment emitted exactly once"
live_require_active_work "$LIVE_TUI_SESSION" 15 "work block mounts fresh for the new burst"
[[ "$(live_count_work_card "$LIVE_TUI_SESSION" "FAKEAGENT" "WORKING")" == "1" ]] || live_fail "fresh burst lists only its own active card"
live_assert_absence "$LIVE_TUI_SESSION" "streaming…" "raw streaming dump removed for peer turn"
# Review fix (finding 1): queued rows are DM-only by construction, so the
# group surface never offers `[x remove]` — `x` there keeps cancelling work.
live_assert_absence "$LIVE_TUI_SESSION" "[x remove]" "no dead remove affordance on the group surface"
peer_replied=0
for _ in $(seq 1 120); do
  peer_replied=$(live_snapshot_value 'Object.values(output.state.subtasks).filter(function (t) { return t.workKind === "turn" && t.state === "replied" }).length')
  [[ "$peer_replied" == "1" ]] && break
  sleep 0.5
done
[[ "$peer_replied" == "1" ]] || live_fail "peer turn did not run to replied with no further action (got $peer_replied replied)"
live_require_text "$LIVE_TUI_SESSION" "● FakeAgent finished:" 15 "peer turn announced once"
live_assert_count "$LIVE_TUI_SESSION" "● FakeAgent finished:" 3 "two delegation rows plus one peer row, no duplicates"
live_require_no_active_work "$LIVE_TUI_SESSION" 15 "ACTIVE clears the peer burst"
live_assert_absence_work_card "$LIVE_TUI_SESSION" "FAKEAGENT" "WORKING" "no active cards remain after the peer burst"
live_assert_text "$LIVE_TUI_SESSION" "peer-check" "peer ask visible"
# Slice C: the relayed answer lands headed `Answer from $Name` (correlation
# link, not a second independent turn); the asking row is gone with it, and
# the transcript carries no per-message timestamps.
live_require_text "$LIVE_TUI_SESSION" "Answer from \$FakeAgent" 15 "relayed answer headed Answer from"
live_assert_count "$LIVE_TUI_SESSION" "Answer from \$FakeAgent" 1 "relay answer rendered once, not duplicated"
live_assert_absence "$LIVE_TUI_SESSION" "Asking \$FakeAgent…" "asking row unmounts when the answer lands"
live_capture_matches "$LIVE_TUI_SESSION" "[0-9]{2}:[0-9]{2}" && live_fail "transcript shows per-message timestamps"
live_assert_absence "$LIVE_TUI_SESSION" "Peer turn refused" "no refusal for the valid mention"
live_assert_absence "$LIVE_TUI_SESSION" "@FakeAgent" "agent addressing stays \$Name, never @Name"
live_require_absence "$LIVE_TUI_SESSION" "streaming…" 20 "in-place finalization of peer turn"
# Slice B idle-quiescence: nothing is busy/live/composing now, so no motion
# timers run — two captures 1.5 s apart must be byte-identical still frames.
# The transient statusline message lives for 3 s; let it expire first so the
# quiescence window cannot straddle its removal.
sleep 3.2
idle_first=$(live_capture "$LIVE_TUI_SESSION")
sleep 1.5
idle_second=$(live_capture "$LIVE_TUI_SESSION")
[[ "$idle_first" == "$idle_second" ]] || live_fail "idle TUI kept ticking between captures"
live_log "idle screen is quiescent across 1.5 s"
peer_attr=$(live_snapshot_value '(function () { var ws = Object.values(output.state.workspaces)[0]; var turn = Object.values(output.state.subtasks).find(function (t) { return t.workKind === "turn" }); if (!turn || !turn.turn) return "no-turn"; var answers = (output.state.messages[ws.id] || []).filter(function (m) { return m.correlationID === turn.turn.correlationID && m.agentID === turn.assigneeID }); return turn.turn.askerKind + "|" + (turn.turn.answeredByID === turn.assigneeID) + "|" + answers.length })()')
[[ "$peer_attr" == '"user|true|1"' ]] || live_fail "peer turn attribution wrong (got $peer_attr)"
live_log "peer turn ran to completed with asking/answered attribution ($peer_attr)"

# Ticket #67 bubbles: agent messages read left-aligned in filled bubbles,
# user messages read right-aligned inside the bounded width. Text capture
# cannot see fills, but the box structure is observable: every row opens
# with the rail/chat borders, so the user line carries a deep space run
# while the agent reply starts at the left margin behind its accent edge.
pane_bubbles=$(live_capture "$LIVE_TUI_SESSION")
# Rounded bubbles put the border glyph before the content; assert the user
# text sits deep into the chat column (right-aligned) instead of matching a
# space run that the border now interrupts.
echo "$pane_bubbles" | awk 'index($0,"fake-queue-alpha")>50 {found=1} END{exit !found}' || live_fail "user bubble not right-aligned in text capture"
echo "$pane_bubbles" | grep -qF "│ │ │ Onboarding complete. I am ready." || live_fail "agent bubble not left-aligned with accent edge in text capture"
live_log "bubble layout observable in text capture (user right, agent left with edge)"
# Ticket #67 inline completions: both delegation outcomes finished before
# the peer ask, so they render above it — never in a trailing feed.
pane_inline=$(live_capture "$LIVE_TUI_SESSION")
first_done=$(grep -nF "● FakeAgent finished:" <<<"$pane_inline" | head -1 | cut -d: -f1)
peer_at=$(grep -nF "peer-check" <<<"$pane_inline" | head -1 | cut -d: -f1)
[[ -n "$first_done" && -n "$peer_at" && "$first_done" -lt "$peer_at" ]] || live_fail "completion not inline at finish position (done @$first_done peer @$peer_at)"
live_log "completions render inline at finish position (done @$first_done before peer @$peer_at)"

# Slice C second probe (asking exactly-once): another mention proves the
# assignment → asking → answer flow repeats with one line per leg and no
# duplicates across bursts. The `fake-rich-fixture` trigger makes this turn's
# reply stream the long fixture, widening the live window for the asserts.
live_key "$LIVE_TUI_SESSION" C-g
live_key "$LIVE_TUI_SESSION" "i"
live_require_text "$LIVE_TUI_SESSION" "COMPOSER" 10 "composer focus for attribution probe"
live_type "$LIVE_TUI_SESSION" "$"
live_require_text "$LIVE_TUI_SESSION" "\$ agents" 10 "agent completion for attribution probe"
live_key "$LIVE_TUI_SESSION" Enter
live_require_absence "$LIVE_TUI_SESSION" "\$ agents" 10 "attribution completion accepted"
live_type "$LIVE_TUI_SESSION" "peer-asking-probe fake-rich-fixture"
live_key "$LIVE_TUI_SESSION" Enter
# The asking label is the pre-stream activity window; observe it before the
# slower joined transcript assertion so a fast first delta cannot hide it.
live_require_joined_single_text "$LIVE_TUI_SESSION" "Asking \$FakeAgent…" 15 "probe asking aggregate line renders once in chat"
live_require_joined_text "$LIVE_TUI_SESSION" "→ Assigned to \$FakeAgent: \$FakeAgent peer-asking-probe fake-rich-fixture" 15 "assignment line for the attribution probe"
live_assert_joined_count "$LIVE_TUI_SESSION" "→ Assigned to \$FakeAgent: \$FakeAgent peer-asking-probe fake-rich-fixture" 1 "probe assignment emitted exactly once"
# v5.6 T3: a fresh long-running turn keeps the work zone live while Tab
# focuses it. This turn has no durable result yet, so Ticket #173 hides Enter
# and advertises the live-card actions instead.
live_key "$LIVE_TUI_SESSION" C-g
tab_ws=$(live_snapshot_value 'Object.keys(output.state.workspaces)[0]' | tr -d '"')
[[ -n "$tab_ws" && "$tab_ws" != "null" ]] || live_fail "active workspace id is missing for the Work focus probe"
tab_agent=$(live_snapshot_value 'Object.values(output.state.agents).find(function (agent) { return agent.name === "FakeAgent" }).id' | tr -d '"')
[[ -n "$tab_agent" && "$tab_agent" != "null" ]] || live_fail "FakeAgent id is missing for the Work focus probe"
live_invoke "message.send" "{\"workspaceID\":\"$tab_ws\",\"text\":\"tab-focus-hold fake-queue-hold-long\",\"recipientIDs\":[\"$tab_agent\"]}" >/dev/null
live_require_active_work "$LIVE_TUI_SESSION" 15 "fresh live turn for the Work focus probe"
live_focus_work
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Work list" 10 "Tab focuses the work list"
live_require_text "$LIVE_TUI_SESSION" "d delegate" 10 "work list names its live-card actions"
live_assert_absence "$LIVE_TUI_SESSION" "enter result" "a card without a durable result hides Enter"
tab_hold_id=$(live_snapshot_value 'Object.values(output.state.subtasks).filter(function (task) { return task.title === "tab-focus-hold fake-queue-hold-long" })[0]?.id' | tr -d '"')
[[ -n "$tab_hold_id" && "$tab_hold_id" != "null" ]] || live_fail "tab-focus hold task id is missing"
live_invoke "task.cancel" "{\"id\":\"$tab_hold_id\"}" >/dev/null
live_require_no_active_work "$LIVE_TUI_SESSION" 15 "tab-focus hold cleaned up"
live_focus_chat "$LIVE_TUI_SESSION"
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Group chat" 10 "pane selection returns to the transcript"
# Slice C third probe (direct surface): the `!Name` alias needs no completion
# popup, so it posts in one shot while the probe turn is still streaming its
# long reply — per-agent serialization parks it as pending, giving a wide,
# race-free window for the direct-surface check.
live_key "$LIVE_TUI_SESSION" C-g
live_key "$LIVE_TUI_SESSION" "i"
live_require_text "$LIVE_TUI_SESSION" "COMPOSER" 10 "composer focus for direct-surface probe"
live_type "$LIVE_TUI_SESSION" "!FakeAgent peer-direct-probe fake-rich-fixture"
live_key "$LIVE_TUI_SESSION" Enter
live_require_joined_text "$LIVE_TUI_SESSION" "→ Assigned to \$FakeAgent: !FakeAgent peer-direct-probe fake-rich-fixture" 20 "assignment line for the direct-surface probe"
live_assert_joined_count "$LIVE_TUI_SESSION" "→ Assigned to \$FakeAgent: !FakeAgent peer-direct-probe fake-rich-fixture" 1 "direct probe assignment emitted exactly once"
# Esc can be swallowed by the host while a native run is active; Ctrl+G is
# the reliable leave-composer chord and is asserted here.
live_key "$LIVE_TUI_SESSION" C-g
live_require_absence "$LIVE_TUI_SESSION" "COMPOSER" 10 "Ctrl+G leaves the composer"
live_key "$LIVE_TUI_SESSION" "z"
live_require_text "$LIVE_TUI_SESSION" "FakeAgent │ direct" 10 "direct surface for the assignment check"
# Switching surfaces lands in chat selection; Enter resumes transcript
# navigation before `w` switches back.
live_focus_chat_interact "$LIVE_TUI_SESSION"
live_key "$LIVE_TUI_SESSION" "w"
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Group chat" 20 "back on the group surface"
live_focus_chat_interact "$LIVE_TUI_SESSION"
# Both probes run to replied with no further action. The long fixture replies
# scroll older headers out of the viewport, so the exactly-once proof is the
# snapshot (three turns, three correlation-linked answers) plus the durable
# per-assignment counts above; the pane proves the latest header renders.
probe_replied=0
for _ in $(seq 1 120); do
  probe_replied=$(live_snapshot_value 'Object.values(output.state.subtasks).filter(function (t) { return t.workKind === "turn" && t.state === "replied" }).length')
  [[ "$probe_replied" == "3" ]] && break
  sleep 0.5
done
[[ "$probe_replied" == "3" ]] || live_fail "probe turns did not run to replied (got $probe_replied replied)"
live_require_text "$LIVE_TUI_SESSION" "Answer from \$FakeAgent" 15 "latest relayed answer headed Answer from"
relay_answers=$(live_snapshot_value '(function () { var turns = Object.values(output.state.subtasks).filter(function (t) { return t.workKind === "turn" }); var n = 0; for (var i = 0; i < turns.length; i++) { var c = turns[i].turn && turns[i].turn.correlationID; if (!c) continue; var ws = output.state.messages[turns[i].workspaceID] || []; for (var j = 0; j < ws.length; j++) { if (ws[j].correlationID === c && ws[j].agentID === turns[i].assigneeID) n++; } } return turns.length + "|" + n })()')
[[ "$relay_answers" == '"3|3"' ]] || live_fail "relay answers not exactly one per turn (got $relay_answers)"
live_assert_absence "$LIVE_TUI_SESSION" "Asking \$FakeAgent…" "asking row unmounts when the answers land"
# Ticket #67: inline completions scroll with the conversation, so after the
# long fixture replies only the tail is visible in the pane. Exactly-once is
# proven two ways on the settled layout: every completion line visible in
# one pane capture occurs exactly once there (a duplicated inline line
# fails), and the snapshot terminal total matches all five outcomes (a
# missing outcome fails). One capture feeds every count below, so the
# asserts cannot race each other.
live_require_joined_text "$LIVE_TUI_SESSION" "● FakeAgent finished: !FakeAgent peer-direct-probe fake-rich-fixture" 15 "latest outcome announced inline at the tail"
pane_done=$(live_capture "$LIVE_TUI_SESSION")
visible_done=$(grep -oF "● FakeAgent finished:" <<<"$pane_done" | wc -l | tr -d ' ')
[[ "$visible_done" -ge 1 ]] || live_fail "expected at least one visible completion line (got $visible_done)"
while IFS= read -r done_line; do
  [[ -z "$done_line" ]] && continue
  done_count=$(grep -cF -- "$done_line" <<<"$pane_done" || true)
  [[ "$done_count" == "1" ]] || live_fail "completion line not exactly once in pane (got $done_count): $done_line"
done <<<"$(grep -F "● FakeAgent finished:" <<<"$pane_done" | sort -u)"
live_log "$visible_done visible completion line(s), each exactly once in the pane"
terminal_total=$(live_snapshot_value 'Object.values(output.state.subtasks).filter(function (t) { return t.state === "replied" }).length')
subtask_total=$(live_snapshot_value 'Object.values(output.state.subtasks).length')
[[ "$subtask_total" -ge 6 ]] || live_fail "expected at least six subtasks in this block (got $subtask_total)"
[[ "$terminal_total" == "$subtask_total" ]] || live_fail "not every subtask is terminal (got $terminal_total/$subtask_total)"
live_log "probes repeated assignment, asking, and answer exactly once each ($relay_answers)"

# Ticket #67: the floating back-to-bottom control is a bare ↓ glyph — no
# words, no pill text. The long fixture replies above guarantee the
# transcript overflows the viewport, so PageUp provably scrolls; End still
# jumps back to the bottom.
# v5.6 T3: the transcript is a calm scroller — j/k move by line, gg/G go to
# the ends, Ctrl+d/u move half a page, and no message cursor appears.
live_key "$LIVE_TUI_SESSION" G
sleep 0.5
live_key "$LIVE_TUI_SESSION" "g"
live_key "$LIVE_TUI_SESSION" "g"
sleep 0.5
pane_top=$(live_capture "$LIVE_TUI_SESSION")
live_require_text "$LIVE_TUI_SESSION" "↓" 10 "gg scrolls to the first message"
live_key "$LIVE_TUI_SESSION" "j"
sleep 0.5
pane_line=$(live_capture "$LIVE_TUI_SESSION")
[[ "$pane_top" != "$pane_line" ]] || live_fail "j did not scroll the transcript by line"
live_key "$LIVE_TUI_SESSION" "k"
sleep 0.5
pane_line_back=$(live_capture "$LIVE_TUI_SESSION")
[[ "$pane_line" != "$pane_line_back" ]] || live_fail "k did not scroll the transcript back by line"
live_key "$LIVE_TUI_SESSION" C-d
sleep 0.5
pane_half=$(live_capture "$LIVE_TUI_SESSION")
[[ "$pane_line_back" != "$pane_half" ]] || live_fail "Ctrl+d did not move the transcript half a page"
live_key "$LIVE_TUI_SESSION" C-u
sleep 0.5
pane_half_back=$(live_capture "$LIVE_TUI_SESSION")
[[ "$pane_half" != "$pane_half_back" ]] || live_fail "Ctrl+u did not move the transcript back"
live_assert_absence "$LIVE_TUI_SESSION" "› FakeAgent" "no message cursor in the transcript"
live_key "$LIVE_TUI_SESSION" G
sleep 0.5
live_key "$LIVE_TUI_SESSION" PageUp
sleep 1
pane_scrolled=$(live_capture "$LIVE_TUI_SESSION")
[[ "$pane_half_back" != "$pane_scrolled" ]] || live_fail "PageUp did not scroll the transcript"
live_require_text "$LIVE_TUI_SESSION" "↓" 10 "bare back-to-bottom glyph when scrolled up"
live_assert_absence "$LIVE_TUI_SESSION" "↓ bottom" "no pill words on the jump control"
live_assert_absence "$LIVE_TUI_SESSION" "bottom · end" "no key label on the jump control"
live_key "$LIVE_TUI_SESSION" End
live_require_text "$LIVE_TUI_SESSION" "Answer from \$FakeAgent" 10 "End jumps back to the bottom"
live_log "bare ↓ jump control with working End key"

# Ticket #72 long/multi-element bubble fixture: the agent reply carries a
# long wrapping heading, a wrapping paragraph, a list, fenced code, and a
# table inside one bubble. Settle with a bounded poll until every marker
# co-occurs in one capture (rich Markdown lays out over several frames),
# then prove each marker renders exactly once — no clipped/overlapping lines
# when the fallback and Markdown paths swap at finalize.
live_key "$LIVE_TUI_SESSION" C-g
live_key "$LIVE_TUI_SESSION" "i"
live_require_text "$LIVE_TUI_SESSION" "COMPOSER" 10 "composer focus for bubble fixture"
live_type "$LIVE_TUI_SESSION" "fake-bubble-fixture"
sleep 0.6
live_key "$LIVE_TUI_SESSION" Enter
live_require_joined_all_text "$LIVE_TUI_SESSION" 20 "settled bubble reply" \
  "Bubble Long Heading Marker" "bubble list alpha" "BUBBLE_CODE_MARKER" "bubble wrap ok"
live_assert_joined_text "$LIVE_TUI_SESSION" "Bubble Long Heading Marker" "long wrapping heading"
live_assert_joined_text "$LIVE_TUI_SESSION" "bubble list alpha" "bubble list"
live_assert_joined_text "$LIVE_TUI_SESSION" "BUBBLE_CODE_MARKER" "bubble fenced code"
live_assert_joined_text "$LIVE_TUI_SESSION" "bubble wrap ok" "bubble table cell"
live_assert_joined_count "$LIVE_TUI_SESSION" "Bubble Long Heading Marker" 1 "long heading exactly once, no overlap duplication"
live_assert_joined_count "$LIVE_TUI_SESSION" "BUBBLE_CODE_MARKER" 1 "fenced code marker exactly once"
live_assert_joined_count "$LIVE_TUI_SESSION" "bubble wrap ok" 1 "table cell exactly once"
live_require_absence "$LIVE_TUI_SESSION" "streaming…" 20 "bubble reply finalized in place"
live_require_text "$LIVE_TUI_SESSION" "Message…" 10 "composer cleared after the bubble fixture"
live_log "long multi-element bubble reply verified with no clipped markers"

# Slice C direct surface (verbatim + queued): user text renders literally
# while agent text stays Markdown, and parked user-owned input shows
# `· queued · [x remove]` with removal by key.
live_key "$LIVE_TUI_SESSION" C-g
live_key "$LIVE_TUI_SESSION" "z"
live_require_text "$LIVE_TUI_SESSION" "FakeAgent │ direct" 10 "direct surface for verbatim probe"
live_key "$LIVE_TUI_SESSION" C-g
live_key "$LIVE_TUI_SESSION" "i"
live_require_text "$LIVE_TUI_SESSION" "COMPOSER" 10 "composer focus on DM surface"
live_type "$LIVE_TUI_SESSION" "verbatim *stars* [brackets](http://x)"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "verbatim *stars* [brackets](http://x)" 15 "DM user text rendered verbatim"
live_assert_count "$LIVE_TUI_SESSION" "verbatim *stars* [brackets](http://x)" 1 "verbatim line exactly once, no Markdown rewrite"
live_require_absence "$LIVE_TUI_SESSION" "Working…" 20 "verbatim reply finalized in place"
live_require_text "$LIVE_TUI_SESSION" "Message…" 10 "composer cleared after the verbatim send"

live_key "$LIVE_TUI_SESSION" C-g
live_key "$LIVE_TUI_SESSION" "i"
live_require_text "$LIVE_TUI_SESSION" "INSERT  │ COMPOSER" 10 "composer focus for queue dance"
# Deterministic queue window: the hold fixture streams for several seconds
# (fake-queue-hold), so the second message stays parked while the harness
# observes the queued row and removes it. It is one-shot and never leaks into
# later replies through session history. Wait until the fake provider has
# actually received the hold request; only then is the native session busy and
# the next send parks instead of racing the run start.
hold_requests_before=$(grep -c '"hold":true' "$LIVE_LOGS/fake.log" 2>/dev/null || true)
hold_requests_before=${hold_requests_before:-0}
hold_request_started() {
  local count
  count=$(grep -c '"hold":true' "$LIVE_LOGS/fake.log" 2>/dev/null || true)
  (( ${count:-0} > hold_requests_before ))
}
live_type "$LIVE_TUI_SESSION" "fake-queue-hold"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Working…" 10 "one-line aggregate activity while streaming"
live_wait_for 15 "hold stream request started" hold_request_started \
  || live_fail "the fake provider never started the hold stream"
live_require_text "$LIVE_TUI_SESSION" "Message…" 10 "composer cleared after the live DM send"
live_key "$LIVE_TUI_SESSION" C-g
live_key "$LIVE_TUI_SESSION" "i"
live_require_text "$LIVE_TUI_SESSION" "INSERT  │ COMPOSER" 10 "composer focus for queued probe"
live_type "$LIVE_TUI_SESSION" "fake-queued-probe"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Message…" 10 "composer cleared after queued probe"
live_require_text "$LIVE_TUI_SESSION" "· queued" 15 "parked user line flagged queued"
live_require_text "$LIVE_TUI_SESSION" "[x remove]" 15 "remove affordance on the parked line"
live_assert_count "$LIVE_TUI_SESSION" "fake-queued-probe" 1 "queued line rendered exactly once"
live_key "$LIVE_TUI_SESSION" C-g
live_key "$LIVE_TUI_SESSION" "x"
live_require_absence "$LIVE_TUI_SESSION" "fake-queued-probe" 15 "queued line removed by key"
live_require_absence "$LIVE_TUI_SESSION" "[x remove]" 10 "affordance gone with the line"
live_require_absence "$LIVE_TUI_SESSION" "Working…" 30 "queue hold reply finalized"
live_log "verbatim user text and queued-line removal verified on the direct surface"
live_key "$LIVE_TUI_SESSION" C-g
live_key "$LIVE_TUI_SESSION" "w"
live_require_text "$LIVE_TUI_SESSION" "#LiveSite" 20 "group surface restored after DM probes"

# v5.6 T4: the work list shares the Normal grammar and carries the task
# actions. Each probe uses a fresh delegated hold task: the fake provider
# streams the long fixture, and a fresh task is the only way to observe a
# cancellation announcement (terminal outcomes are announced once per task).
# Picker titles render word gaps as non-breaking spaces.
NBSP=$'\u00a0'
t4_ws=$(live_snapshot_value 'Object.values(output.state.workspaces)[0]?.id' | tr -d '"')
t4_agent=$(live_snapshot_value 'Object.values(output.state.agents).filter(function (agent) { return !agent.archived })[0]?.id' | tr -d '"')
t4_delegate() {
  live_invoke task.delegate "{\"workspaceID\":\"$t4_ws\",\"assigneeID\":\"$t4_agent\",\"title\":\"$1\",\"instruction\":\"fake-queue-hold\",\"mode\":\"research\"}" >/dev/null
}
t4_id_for() {
  live_snapshot_value "Object.values(output.state.subtasks).filter(function (task) { return task.title === \"$1\" })[0]?.id" | tr -d '"'
}

# Result and picker actions: retry retains the prior result, so Enter opens a
# real result while the long fixture streams again. The scheduling timeout is
# deliberately long: under load a delegated row can sit pending for a while.
# A timeout prints the task snapshot diagnostic and fails; there is no retry
# loop that would hide a genuine scheduling failure.
T4_REPLY_TIMEOUT="${ENSEMBLE_LIVE_T4_TIMEOUT:-180}"
t4_delegate "T4 work action probe"
if ! live_wait_for_subtask_status "T4 work action probe" replied "$T4_REPLY_TIMEOUT"; then
  live_fail "T4 work fixture did not reply within ${T4_REPLY_TIMEOUT}s"
fi
t4_id=$(t4_id_for "T4 work action probe")
live_invoke task.retry "{\"id\":\"$t4_id\"}" >/dev/null
live_require_active_work "$LIVE_TUI_SESSION" 15 "retried T4 work row mounts"
live_focus_work
live_require_text "$LIVE_TUI_SESSION" "enter result" 10 "work list names its open action"
live_assert_text "$LIVE_TUI_SESSION" "d delegate │ t reassign" "work footer names delegate and reassign"
# The 160-column statusline drops hints from the right; the longer #184
# `enter result/toggle` label leaves `R restart` visible and may omit x/o.
# Both keys are exercised by name below and by the native-session probe.
live_assert_text "$LIVE_TUI_SESSION" "R restart" "work footer names restart"
live_assert_absence "$LIVE_TUI_SESSION" "r retry" "an actively running card does not advertise retry"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "enter/esc close" 10 "Enter opens the selected work result"
live_key "$LIVE_TUI_SESSION" Escape
live_require_absence "$LIVE_TUI_SESSION" "enter/esc close" 10 "result modal closes"
# d is delegate in the work list, never the text delete operator.
live_key "$LIVE_TUI_SESSION" "d"
live_require_text "$LIVE_TUI_SESSION" "Delegate${NBSP}subtask" 10 "d opens the delegate picker"
live_key "$LIVE_TUI_SESSION" Escape
live_require_absence "$LIVE_TUI_SESSION" "Delegate${NBSP}subtask" 10 "delegate picker cancels"
live_key "$LIVE_TUI_SESSION" "t"
live_require_text "$LIVE_TUI_SESSION" "Reassign${NBSP}subtask" 10 "t opens the reassign picker"
live_key "$LIVE_TUI_SESSION" Escape
live_require_absence "$LIVE_TUI_SESSION" "Reassign${NBSP}subtask" 10 "reassign picker cancels"
# Cancel the row out of band; its terminal outcome was already announced.
live_invoke task.cancel "{\"id\":\"$t4_id\"}" >/dev/null
live_require_no_active_work "$LIVE_TUI_SESSION" 15 "T4 result probe cleaned up"
# Ticket #173/#184: retry is offered on a terminal history card. Toggle
# HISTORY, expand the newest finished group (the cancelled probe), focus its
# card below the rollup row, and retry it.
live_key "$LIVE_TUI_SESSION" "f"
live_require_text "$LIVE_TUI_SESSION" "WORK HISTORY │" 10 "cancelled probe is retained in HISTORY"
live_require_text "$LIVE_TUI_SESSION" "T4 work action probe" 10 "cancelled probe card is visible in HISTORY"
live_require_text "$LIVE_TUI_SESSION" "CANCELLED" 10 "cancelled probe keeps its explicit state"
live_key "$LIVE_TUI_SESSION" "g"
live_key "$LIVE_TUI_SESSION" "g"
live_key "$LIVE_TUI_SESSION" "j"
live_require_text "$LIVE_TUI_SESSION" "r retry" 10 "a cancelled history card advertises retry"
live_key "$LIVE_TUI_SESSION" "r"
sleep 0.5
live_key "$LIVE_TUI_SESSION" "f"
live_require_text "$LIVE_TUI_SESSION" "WORK ACTIVE │" 10 "requeued work returns to ACTIVE"
live_require_active_work "$LIVE_TUI_SESSION" 15 "r requeues the cancelled history card"
live_require_text "$LIVE_TUI_SESSION" "T4 work action probe" 10 "requeued card is visible in ACTIVE"
# The retry/RESTART labels were proved above. Settle this previously-terminal
# row out of band: its completion announcement is deduped per task and would
# not provide a fresh cancel event.
t4_retried_id=$(t4_id_for "T4 work action probe")
live_invoke "task.cancel" "{\"id\":\"$t4_retried_id\"}" >/dev/null
live_require_no_active_work "$LIVE_TUI_SESSION" 15 "requeued probe settled"
# Restart then cancel a fresh long-running row. Both actions produce one
# canonical terminal event because this task never finished before.
t4_delegate "T4 cancel probe"
live_require_active_work "$LIVE_TUI_SESSION" 15 "cancel-probe work row mounts"
live_key "$LIVE_TUI_SESSION" "g"
live_key "$LIVE_TUI_SESSION" "g"
live_key "$LIVE_TUI_SESSION" "R"
live_require_text "$LIVE_TUI_SESSION" "Restarting work: T4 cancel probe" 10 "R restarts the selected work"
sleep 1
live_require_active_work "$LIVE_TUI_SESSION" 5 "restarted work row stays live"
# A restart repaints the row; re-establish card focus before the cancel key.
live_key "$LIVE_TUI_SESSION" "g"
live_key "$LIVE_TUI_SESSION" "g"
sleep 0.3
live_key "$LIVE_TUI_SESSION" "x"
live_require_text "$LIVE_TUI_SESSION" "⊘ T4 cancel probe cancelled" 15 "x cancels the selected work"
live_assert_count "$LIVE_TUI_SESSION" "⊘ T4 cancel probe cancelled" 1 "cancelled probe emits exactly one terminal event"
live_require_no_active_work "$LIVE_TUI_SESSION" 15 "x removes the restarted work from ACTIVE"
live_focus_chat "$LIVE_TUI_SESSION"
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Group chat" 10 "pane selection returns to chat after cancel"

live_log "work-list actions verified: enter, d, t, r, R, x, and Esc/pane focus"

# Slice E (ticket #65) chrome walkthrough: one focus owner at a time, proven
# through the context footer. Border colors do not survive `capture-pane`
# text capture, so the footer — driven by the same single-owner resolver —
# is the text-observable proxy; the exactly-one invariant itself is
# unit-pinned in chrome.test.ts across all 8 focus/composer/overlay states.
# Ticket #180: h selects Agents first; Enter starts roster interaction.
live_escape_to_pane_select "$LIVE_TUI_SESSION"
live_key "$LIVE_TUI_SESSION" "h"
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Agents" 10 "h selects the Agents pane"
live_assert_text "$LIVE_TUI_SESSION" "h/l column" "h lands in select mode, not row navigation"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "enter open" 10 "Agents interaction footer names the open action"
live_assert_absence "$LIVE_TUI_SESSION" "enter result" "idle rail footer hides work results"

# v5.7 T2 / ticket #180: Enter selects the pane, not its content; chat Enter
# enters transcript navigation, and `i` is the deliberate composer entry.
# Rail order is Agents then Workspaces, so Escape + j selects #LiveSite.
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Agents" 10 "roster uses Normal grammar"
live_escape_to_pane_select "$LIVE_TUI_SESSION"
live_key "$LIVE_TUI_SESSION" "j"
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Workspaces" 10 "j selects the Workspaces pane"
live_assert_text "$LIVE_TUI_SESSION" "h/l column" "j stays in pane selection"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Workspaces" 15 "Enter enters the Workspaces pane"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Group chat" 15 "roster Enter opens the target and keeps Normal"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Group chat" 10 "chat Enter stays in transcript navigation"
live_require_text "$LIVE_TUI_SESSION" "j/k scroll" 10 "chat interaction owns transcript scrolling"
live_assert_absence "$LIVE_TUI_SESSION" "COMPOSER" "chat Enter never steals composer focus"
live_key "$LIVE_TUI_SESSION" "i"
live_require_text "$LIVE_TUI_SESSION" "INSERT  │ COMPOSER" 10 "i enters the composer deliberately"
sleep 0.25
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ COMPOSER" 10 "first Esc returns the composer to Normal"
sleep 0.25
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Group chat" 10 "second Esc returns to the transcript"
# Space opens the which-key leader; the retired tilde prefix is gone.
live_key "$LIVE_TUI_SESSION" Space
live_require_text "$LIVE_TUI_SESSION" "LEADER │ which-key" 10 "Space opens the which-key leader"
live_require_text "$LIVE_TUI_SESSION" "Leave Ensemble" 10 "which-key lists leader actions"
live_key "$LIVE_TUI_SESSION" Escape
live_require_absence "$LIVE_TUI_SESSION" "which-key" 10 "Esc closes the leader"
live_key "$LIVE_TUI_SESSION" "i"
live_require_text "$LIVE_TUI_SESSION" "enter send │ esc normal │ ctrl+g leave" 10 "composer Insert hints name the ladder"
live_assert_absence "$LIVE_TUI_SESSION" "enter result" "composer footer hides dead work keys"
sleep 0.25
live_key "$LIVE_TUI_SESSION" Escape
live_require_absence "$LIVE_TUI_SESSION" "enter send │ esc normal │ ctrl+g leave" 10 "Insert hints replaced by Normal hints"
live_key "$LIVE_TUI_SESSION" Escape
live_require_absence "$LIVE_TUI_SESSION" "COMPOSER" 10 "second Esc returns to chat Normal"
live_log "slice E focus walkthrough shows context footers with no hidden-work hints"

# Slice E help: tone-down keeps every shortcut searchable; the zero state
# names the fix. v5.6 T10 filters through the shared `/` grammar.
live_key "$LIVE_TUI_SESSION" Space
live_require_text "$LIVE_TUI_SESSION" "LEADER" 10 "leader mode before help"
live_key "$LIVE_TUI_SESSION" '?'
live_require_text "$LIVE_TUI_SESSION" "Keyboard shortcuts" 15 "searchable shortcut help"
live_key "$LIVE_TUI_SESSION" "/"
live_type "$LIVE_TUI_SESSION" "zzz-no-shortcut"
live_require_text "$LIVE_TUI_SESSION" "No matching shortcuts" 10 "help zero state names the miss"
live_assert_absence "$LIVE_TUI_SESSION" "Delete workspace" "help filter hid unrelated shortcuts"
live_key_repeat "$LIVE_TUI_SESSION" "BSpace" 20
live_require_text "$LIVE_TUI_SESSION" "Modes and Esc ladder" 10 "help filter cleared"
live_key "$LIVE_TUI_SESSION" Enter
sleep 0.25
live_key "$LIVE_TUI_SESSION" Escape
live_require_absence "$LIVE_TUI_SESSION" "Keyboard shortcuts" 10 "help closed"

# Slice E settings frame: tab line keeps the live unfiltered memory total
# with the active cursor (zero here — the memories flow below proves the
# count at one plus edit and filter). v5.6 T5 (#83) also proves the shared
# modal grammar: tabs, rows, action hints, and the statusline mode/context.
live_key "$LIVE_TUI_SESSION" "s"
live_require_text "$LIVE_TUI_SESSION" "FakeAgent │ settings" 10 "agent settings for tab check"
live_assert_text "$LIVE_TUI_SESSION" "NORMAL  │ Settings" "statusline names Normal and the settings context"
live_assert_text "$LIVE_TUI_SESSION" "h/l tabs" "settings teaches h/l tabs"
live_assert_text "$LIVE_TUI_SESSION" "j/k rows" "settings teaches j/k rows"
live_assert_text "$LIVE_TUI_SESSION" "enter edit" "settings teaches Enter"
live_assert_text "$LIVE_TUI_SESSION" "s save" "settings teaches save"
live_assert_text "$LIVE_TUI_SESSION" "esc close" "settings teaches the close step"
live_assert_absence "$LIVE_TUI_SESSION" "a add │" "the general tab does not promise an add row"
live_assert_text "$LIVE_TUI_SESSION" "› Name" "the general tab starts on the first row"
live_assert_text "$LIVE_TUI_SESSION" "› General" "settings tab cursor"
live_assert_text "$LIVE_TUI_SESSION" "Memories (0)" "settings tab keeps the live memory total"
live_key "$LIVE_TUI_SESSION" "j"
live_require_text "$LIVE_TUI_SESSION" "› Title" 10 "j moves to the next row"
live_key "$LIVE_TUI_SESSION" "G"
live_require_text "$LIVE_TUI_SESSION" "› Native mirror" 10 "G jumps to the last General row"
live_key "$LIVE_TUI_SESSION" "g"
live_key "$LIVE_TUI_SESSION" "g"
live_require_text "$LIVE_TUI_SESSION" "› Name" 10 "gg jumps back to the first row"
live_key "$LIVE_TUI_SESSION" "l"
live_require_text "$LIVE_TUI_SESSION" "› Models" 10 "l switches to the next tab"
live_require_text "$LIVE_TUI_SESSION" "a add │ s save" 10 "models teaches add; no backup exists to delete"
live_key "$LIVE_TUI_SESSION" "h"
live_require_text "$LIVE_TUI_SESSION" "› General" 10 "h switches back to the previous tab"
live_key "$LIVE_TUI_SESSION" "Tab"
live_require_text "$LIVE_TUI_SESSION" "› Models" 10 "Tab also switches tabs"
sleep 0.25
live_key "$LIVE_TUI_SESSION" Escape
live_require_absence "$LIVE_TUI_SESSION" "FakeAgent │ settings" 10 "settings closed"

# Slice E approvals: v opens the full-height right column even when the inbox
# is empty; the small summary only exists while rows are pending.
live_key "$LIVE_TUI_SESSION" "v"
live_require_text "$LIVE_TUI_SESSION" "APPROVALS 0 pending" 10 "v opens the full approvals surface"
live_require_text "$LIVE_TUI_SESSION" "Nothing waits for you." 10 "approvals empty state"
sleep 0.25
live_key "$LIVE_TUI_SESSION" Escape
live_require_absence "$LIVE_TUI_SESSION" "APPROVALS 0 pending" 10 "Esc returns full approvals to split"
live_log "slice E help/settings/approvals chrome verified"

# In-house pickers and confirms still back model choices and destructive
# confirmations. Settings text fields now use the shared modal grammar
# (#83): Insert -> field Normal -> settings Normal -> close. This proves the
# ladder, the dirty mark, and the discard confirm; the memories flow below
# proves field commits persist end to end. (The picker overlay renders word
# gaps as non-breaking spaces, hence NBSP.)
NBSP=$'\u00a0'
live_key "$LIVE_TUI_SESSION" "s"
live_require_text "$LIVE_TUI_SESSION" "FakeAgent │ settings" 10 "agent settings"
live_key "$LIVE_TUI_SESSION" "e"
live_require_text "$LIVE_TUI_SESSION" "Name │ NORMAL" 10 "e opens the Name field in the current Normal mode"
live_key "$LIVE_TUI_SESSION" "A"
live_require_text "$LIVE_TUI_SESSION" "Name │ INSERT" 10 "A enters Insert at the line end in the settings field"
live_require_text "$LIVE_TUI_SESSION" "INSERT  │ Settings" 10 "the statusline names the field mode and context"
live_assert_text "$LIVE_TUI_SESSION" "enter done │ esc field normal" "the field teaches its first Esc"
live_type "$LIVE_TUI_SESSION" "X"
live_require_text "$LIVE_TUI_SESSION" "FakeAgentX" 10 "typing edits the field buffer"
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "Name │ NORMAL" 10 "the first Esc returns to field Normal"
live_assert_text "$LIVE_TUI_SESSION" "NORMAL  │ Settings" "field Normal still reports the settings context"
live_assert_text "$LIVE_TUI_SESSION" "esc settings" "field Normal teaches the next Esc"
live_key "$LIVE_TUI_SESSION" Escape
live_require_absence "$LIVE_TUI_SESSION" "Name │ NORMAL" 10 "the second Esc returns to settings Normal"
live_require_text "$LIVE_TUI_SESSION" "UNSAVED" 10 "draft marked unsaved"
sleep 0.25
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "Discard changes?" 10 "in-house confirm modal"
live_assert_text "$LIVE_TUI_SESSION" "y/enter yes │ n/esc no" "confirm footer shares y/n and Enter/Esc"
live_key "$LIVE_TUI_SESSION" "n"
live_require_absence "$LIVE_TUI_SESSION" "Discard changes?" 10 "n rejected the confirm"
live_require_text "$LIVE_TUI_SESSION" "FakeAgentX │ settings" 10 "rejected discard keeps settings open"
sleep 0.25
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "Discard changes?" 10 "confirm reopened"
live_key "$LIVE_TUI_SESSION" "y"
live_require_absence "$LIVE_TUI_SESSION" "Discard changes?" 10 "y accepted the confirm"
live_require_absence "$LIVE_TUI_SESSION" "FakeAgent │ settings" 10 "settings closed after discard"

live_key "$LIVE_TUI_SESSION" "s"
live_require_text "$LIVE_TUI_SESSION" "FakeAgent │ settings" 10 "agent settings reopened"
live_key "$LIVE_TUI_SESSION" "Tab"
live_key "$LIVE_TUI_SESSION" "Tab"
live_require_text "$LIVE_TUI_SESSION" "No memories yet. a adds one." 10 "memories empty state names the add key"
live_assert_text "$LIVE_TUI_SESSION" "Memories (0)" "memories count renders at zero"
live_assert_text "$LIVE_TUI_SESSION" "a add │ s save" "memories teaches the add row before any row exists"
live_key "$LIVE_TUI_SESSION" "a"
live_require_text "$LIVE_TUI_SESSION" "New memory │ NORMAL" 10 "a opens a new memory field in Normal"
sleep 0.25
live_key "$LIVE_TUI_SESSION" "i"
live_require_text "$LIVE_TUI_SESSION" "New memory │ INSERT" 10 "i enters the new memory field"
live_type "$LIVE_TUI_SESSION" "fake-live-memory"
live_require_text "$LIVE_TUI_SESSION" "fake-live-memory" 10 "the memory text reached the field"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "New memory │ INSERT" 10 "Enter saves the memory and keeps the add field in Insert"
live_assert_text "$LIVE_TUI_SESSION" "enter save │ esc field normal" "the persistent memory field teaches Enter and Esc"
live_require_text "$LIVE_TUI_SESSION" "Memories (1)" 10 "memories count renders the live total while the field stays open"
# Race probe: the created id must select its row even if the event refresh
# lands after the mutation refresh. No sleep: the cursor resolves by id.
live_require_text "$LIVE_TUI_SESSION" "› fake-live-memory" 10 "the newly saved memory row holds the cursor"
sleep 0.15
live_assert_count "$LIVE_TUI_SESSION" "fake-live-memory" 1 "the add field cleared for the next memory"
# A second memory proves the same field stays focused and clears again.
live_type "$LIVE_TUI_SESSION" "fake-live-memory-two"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Memories (2)" 10 "the second memory joined the list"
live_require_text "$LIVE_TUI_SESSION" "› fake-live-memory-two" 10 "the second saved row also holds the cursor"
sleep 0.15
live_assert_count "$LIVE_TUI_SESSION" "fake-live-memory-two" 1 "the second entry cleared for the next one"
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "New memory │ NORMAL" 10 "Esc returns the persistent field to Normal"
live_key "$LIVE_TUI_SESSION" Escape
live_require_absence "$LIVE_TUI_SESSION" "New memory │ NORMAL" 10 "the second Esc closes the memory field"
live_require_text "$LIVE_TUI_SESSION" "Memories (2)" 10 "both memories persisted"
sleep 0.25
# x deletes the selected row; the cursor stays deterministic after the add.
live_key "$LIVE_TUI_SESSION" "x"
live_require_text "$LIVE_TUI_SESSION" "Memories (1)" 10 "x deletes the selected memory"
live_require_absence "$LIVE_TUI_SESSION" "fake-live-memory-two" 10 "the deleted memory leaves the list"
# Slice D edit-in-place through the shared Vim adapter: e opens the fact,
# A enters Insert at the line end, append, Enter saves persistently. One row
# keeps its origin and history (no delete/re-add).
live_key "$LIVE_TUI_SESSION" "e"
live_require_text "$LIVE_TUI_SESSION" "Edit memory │ NORMAL" 10 "e opens the selected memory field in Normal"
# p in a field is Vim paste, never the row promote action; undo any clipboard
# content so the append below starts from the saved text.
live_key "$LIVE_TUI_SESSION" "p"
live_key "$LIVE_TUI_SESSION" "u"
live_key "$LIVE_TUI_SESSION" "$"
live_key "$LIVE_TUI_SESSION" "A"
live_require_text "$LIVE_TUI_SESSION" "INSERT  │ Settings" 10 "A returns the field to Insert at the line end"
live_type "$LIVE_TUI_SESSION" " v2"
live_key "$LIVE_TUI_SESSION" Enter
memory_edited=""
for _ in $(seq 1 25); do
  memory_edited=$(live_snapshot_value 'Object.values(output.state.memories).filter(function (m) { return !m.deletedAt }).map(function (m) { return m.text })')
  [[ "$memory_edited" == '["fake-live-memory v2"]' ]] && break
  sleep 0.2
done
[[ "$memory_edited" == '["fake-live-memory v2"]' ]] || live_fail "memory edit did not persist (got $memory_edited)"
live_require_text "$LIVE_TUI_SESSION" "Edit memory │ INSERT" 10 "edit Enter saves and keeps the field open"
sleep 0.25
live_require_count "$LIVE_TUI_SESSION" "fake-live-memory v2" 2 10 "the edit kept the field text and updated the row"
memory_rows=$(live_snapshot_value 'Object.values(output.state.memories).filter(function (m) { return !m.deletedAt }).length')
[[ "$memory_rows" == '1' ]] || live_fail "edit re-added instead of updating in place (got $memory_rows rows)"
memory_prov=$(live_snapshot_value '(function () { var m = Object.values(output.state.memories).filter(function (x) { return !x.deletedAt })[0]; return m.origin + "|" + m.scope + "|" + m.history.map(function (h) { return h.action }).join(",") })()')
[[ "$memory_prov" == '"manual|project|created,edited"' ]] || live_fail "edit lost provenance history (got $memory_prov)"
live_require_text "$LIVE_TUI_SESSION" "fake-live-memory v2" 10 "edited fact renders"
live_assert_text "$LIVE_TUI_SESSION" "Memories (1)" "count unchanged after edit"
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "Edit memory │ NORMAL" 10 "edit field Normal before closing"
live_key "$LIVE_TUI_SESSION" Escape
live_require_absence "$LIVE_TUI_SESSION" "Edit memory │ NORMAL" 10 "edit memory field closed"
sleep 0.25
# x deletes the selected memory row without a dialog. Add a scratch row so the
# original fact survives for the later tabs.
live_key "$LIVE_TUI_SESSION" "a"
live_require_text "$LIVE_TUI_SESSION" "New memory │ NORMAL" 10 "second memory field opens in Normal"
sleep 0.25
live_key "$LIVE_TUI_SESSION" "i"
live_type "$LIVE_TUI_SESSION" "scratch-memory"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "New memory │ INSERT" 10 "scratch memory saved persistently"
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "New memory │ NORMAL" 10 "scratch field Normal"
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "Memories (2)" 10 "scratch memory persisted"
live_require_text "$LIVE_TUI_SESSION" "› scratch-memory" 10 "the new memory row holds the cursor"
sleep 0.25
live_key "$LIVE_TUI_SESSION" "x"
live_require_text "$LIVE_TUI_SESSION" "Memories (1)" 10 "x deletes the selected memory"
live_require_absence "$LIVE_TUI_SESSION" "scratch-memory" 10 "deleted memory leaves the list"
memory_left=$(live_snapshot_value 'Object.values(output.state.memories).filter(function (m) { return !m.deletedAt }).map(function (m) { return m.text })')
[[ "$memory_left" == '["fake-live-memory v2"]' ]] || live_fail "delete removed the wrong memory (got $memory_left)"
# p promotes the selected memory into a pending approval. It is a memory-row
# action, not row paste; paste stays inside text fields.
live_key "$LIVE_TUI_SESSION" "p"
sleep 0.5
promotion=$(live_snapshot_value '(function () { var a = Object.values(output.state.approvals).filter(function (x) { return x.status === "pending" && x.kind === "promote_memory" }); return a.length + ":" + (a[0] ? a[0].detail : "") })()')
[[ "$promotion" == '"1:fake-live-memory v2"' ]] || live_fail "p did not request a memory promotion (got $promotion)"
# Ticket #126/#127: resolve through the inbox itself. The row leaves the
# pending list and settles once as `✓ Resolved`; the short resolving frame is
# covered by approvals.test.ts because the fake RPC returns too fast to
# capture reliably.
live_key "$LIVE_TUI_SESSION" Escape
live_require_absence "$LIVE_TUI_SESSION" "FakeAgent │ settings" 10 "settings closed for the approvals surface"
live_key "$LIVE_TUI_SESSION" "v"
live_require_text "$LIVE_TUI_SESSION" "APPROVALS 1 pending" 10 "full approvals opens for the promotion"
live_require_text "$LIVE_TUI_SESSION" "Promote memory for FakeAgent" 10 "the promotion row is visible"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Approve" 10 "the resolution choice opens"
live_key "$LIVE_TUI_SESSION" Down
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "✓ Resolved" 10 "the resolved row settles once"
promotions_left=$(live_snapshot_value 'Object.values(output.state.approvals).filter(function (x) { return x.status === "pending" && x.kind === "promote_memory" }).length')
[[ "$promotions_left" == '0' ]] || live_fail "promotion approval was not cleaned up (got $promotions_left)"
live_key "$LIVE_TUI_SESSION" Escape
live_require_absence "$LIVE_TUI_SESSION" "Promote memory for FakeAgent" 10 "approvals returned to split after resolving"
live_log "settings p promoted the selected memory through the full approvals surface"
# Slice D inline filter (ticket #80): / opens the shared command-line search
# and filters the focused settings tab live; Enter commits, Esc would restore
# the prior filter. Resolving through the inbox closed Settings, so reopen it
# on the memories tab first.
live_key "$LIVE_TUI_SESSION" "s"
live_require_text "$LIVE_TUI_SESSION" "FakeAgent │ settings" 10 "settings reopened for the memory filter"
live_key "$LIVE_TUI_SESSION" "Tab"
live_key "$LIVE_TUI_SESSION" "Tab"
live_require_text "$LIVE_TUI_SESSION" "Saved knowledge — Memories (1)" 10 "memories tab reopened for the filter"
live_key "$LIVE_TUI_SESSION" "/"
live_require_text "$LIVE_TUI_SESSION" "enter search │ esc cancel" 10 "settings search opens in the command line"
live_type "$LIVE_TUI_SESSION" "zzz-no-match"
live_require_text "$LIVE_TUI_SESSION" "Filter: zzz-no-match" 10 "settings filter follows the search line"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "No matching memories" 10 "memory filter zero state"
live_key "$LIVE_TUI_SESSION" "/"
live_require_text "$LIVE_TUI_SESSION" "enter search │ esc cancel" 10 "settings search reopens"
live_require_text "$LIVE_TUI_SESSION" "manual │ project │ reviewed" 10 "opening a new search clears the filter preview"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "manual │ project │ reviewed" 10 "provenance line restored after clearing filter"
live_assert_text "$LIVE_TUI_SESSION" "Memories (1)" "count survives filtering"
sleep 0.25
live_key "$LIVE_TUI_SESSION" Escape
live_require_absence "$LIVE_TUI_SESSION" "FakeAgent │ settings" 10 "settings closed"

# Slice D (ticket #61): the Skillbox tab is a searchable skill palette with
# `name — description` rows, inline filtering, fill-not-tick assignment, and
# an explicit overflow line past the viewport cap (cap overflow itself is
# unit-covered: the host catalog here is too small to page).
live_key "$LIVE_TUI_SESSION" "s"
live_require_text "$LIVE_TUI_SESSION" "FakeAgent │ settings" 10 "agent settings reopened for skillbox"
live_key "$LIVE_TUI_SESSION" "Tab"
live_key "$LIVE_TUI_SESSION" "Tab"
live_key "$LIVE_TUI_SESSION" "Tab"
live_require_text "$LIVE_TUI_SESSION" "› Skillbox" 10 "skillbox tab active with cursor"
live_assert_text "$LIVE_TUI_SESSION" "space toggle" "skillbox teaches Space"
live_assert_text "$LIVE_TUI_SESSION" "/ filter" "skillbox teaches / filter"
live_key "$LIVE_TUI_SESSION" "/"
live_require_text "$LIVE_TUI_SESSION" "enter search │ esc cancel" 10 "skill filter opens in the command line"
live_type "$LIVE_TUI_SESSION" "zzz-no-such-skill"
live_require_text "$LIVE_TUI_SESSION" "No matching skills" 10 "empty palette names the miss"
live_key "$LIVE_TUI_SESSION" Enter
live_key "$LIVE_TUI_SESSION" "/"
live_require_text "$LIVE_TUI_SESSION" "enter search │ esc cancel" 10 "skill filter search reopens"
live_require_absence "$LIVE_TUI_SESSION" "No matching skills" 10 "opening a new search clears the prior filter"
live_key "$LIVE_TUI_SESSION" Enter
live_require_absence "$LIVE_TUI_SESSION" "enter search │ esc cancel" 10 "filter search submitted"
if live_capture_contains "$LIVE_TUI_SESSION" "[ ]"; then
  live_key "$LIVE_TUI_SESSION" "Space"
  live_require_text "$LIVE_TUI_SESSION" "[x]" 10 "fill mark shows the assignment"
  live_require_text "$LIVE_TUI_SESSION" "UNSAVED" 10 "skill toggle dirties the draft"
  sleep 0.25
live_key "$LIVE_TUI_SESSION" Escape
  live_require_text "$LIVE_TUI_SESSION" "Discard changes?" 10 "skill draft discards via confirm"
  live_key "$LIVE_TUI_SESSION" Enter
  live_require_absence "$LIVE_TUI_SESSION" "FakeAgent │ settings" 10 "settings closed after skill discard"
else
  live_log "host skill catalog is empty; toggle covered by unit tests"
  sleep 0.25
live_key "$LIVE_TUI_SESSION" Escape
  live_require_absence "$LIVE_TUI_SESSION" "FakeAgent │ settings" 10 "settings closed"
fi

# Slice G (ticket #69) settings stylization: one designed language across all
# four tabs — section header, aligned label/value columns, descriptions and
# counts, selection marker, action footer — plus the agent list and the
# model picker. Earlier blocks prove save/dirty and approval flows; this
# block proves the styled grammar with no behavior change.
live_key "$LIVE_TUI_SESSION" "s"
live_require_text "$LIVE_TUI_SESSION" "FakeAgent │ settings" 10 "settings header names the agent"
live_assert_text "$LIVE_TUI_SESSION" "AGENTS (1)" "agent list names its count"
live_assert_text "$LIVE_TUI_SESSION" "WORKSPACES (1)" "workspace list names its count"
live_assert_text "$LIVE_TUI_SESSION" "FakeAgent" "agent list names the agent"
live_assert_text "$LIVE_TUI_SESSION" "Engineering" "agent list names the title description"
live_assert_text "$LIVE_TUI_SESSION" "Identity — name" "general section header"
live_assert_text "$LIVE_TUI_SESSION" "Name       FakeAgent" "general label/value alignment"
live_assert_text "$LIVE_TUI_SESSION" "Title      Engineering" "title row aligns with name row"
live_assert_text "$LIVE_TUI_SESSION" "Model      ensemble-fake/ensemble-fake-model" "general model summary"
live_assert_text "$LIVE_TUI_SESSION" "› General" "settings tab cursor"
live_assert_text "$LIVE_TUI_SESSION" "enter edit" "general statusline teaches Enter"
live_assert_text "$LIVE_TUI_SESSION" "s save" "general statusline teaches save"
live_key "$LIVE_TUI_SESSION" "Tab"
live_require_text "$LIVE_TUI_SESSION" "Main + backups — main + 0 backups" 10 "models section header with counts"
live_assert_text "$LIVE_TUI_SESSION" "(•)" "main slot fill mark"
# The narrowed chat cell truncates the model id after the aligned label; the
# full id is asserted on the General tab and by the model picker below.
live_assert_text "$LIVE_TUI_SESSION" "Main       ensemble-fake/" "main row aligns and names provider/model"
live_assert_text "$LIVE_TUI_SESSION" "No backups yet. a adds one." "models empty state names the add key"
live_assert_text "$LIVE_TUI_SESSION" "a add" "models statusline teaches add"
# Model picker from the models tab: provider grouping, variant info, search
# with a match count, and the current-selection fill mark. (The picker
# overlay renders word gaps as non-breaking spaces, hence NBSP.)
live_key "$LIVE_TUI_SESSION" "e"
live_require_text "$LIVE_TUI_SESSION" "3${NBSP}variants" 10 "model picker names variant depth"
live_assert_text "$LIVE_TUI_SESSION" "Ensemble${NBSP}Fake${NBSP}Model${NBSP}—${NBSP}ensemble-fake/ensemble-fake-model" "model picker groups provider/model"
live_assert_text "$LIVE_TUI_SESSION" "1${NBSP}matches" "model picker names its search count"
live_assert_text "$LIVE_TUI_SESSION" "(•)${NBSP}Ensemble" "model picker marks the current selection"
sleep 0.25
live_key "$LIVE_TUI_SESSION" Escape
live_require_absence "$LIVE_TUI_SESSION" "3${NBSP}variants" 10 "model picker closed"
live_require_text "$LIVE_TUI_SESSION" "FakeAgent │ settings" 10 "settings kept with no dirty draft"
live_key "$LIVE_TUI_SESSION" "Tab"
live_require_text "$LIVE_TUI_SESSION" "Saved knowledge — Memories (1)" 10 "memories section header with count"
live_assert_text "$LIVE_TUI_SESSION" "› fake-live-memory v2" "memories selection marker on the row"
live_assert_text "$LIVE_TUI_SESSION" "manual │ project │ reviewed" "memories provenance line kept"
live_assert_text "$LIVE_TUI_SESSION" "x delete" "memories statusline teaches delete"
live_key "$LIVE_TUI_SESSION" "Tab"
live_require_text "$LIVE_TUI_SESSION" "› Skillbox" 10 "skillbox tab active with cursor"
live_assert_text "$LIVE_TUI_SESSION" "Optional skills — Skillbox (" "skillbox section header with counts"
live_assert_text "$LIVE_TUI_SESSION" "space toggle" "skillbox statusline teaches toggle"
if live_capture_contains "$LIVE_TUI_SESSION" "[ ]"; then
  live_assert_text "$LIVE_TUI_SESSION" "[ ]" "skillbox fill-not-tick rows kept"
else
  live_assert_text "$LIVE_TUI_SESSION" "No skills available from the host." "skillbox unavailable state names the catalog miss"
fi
sleep 0.25
live_key "$LIVE_TUI_SESSION" Escape
live_require_absence "$LIVE_TUI_SESSION" "FakeAgent │ settings" 10 "settings closed with bindings intact"
live_log "slice G settings stylization verified across all four tabs"

# v5.6 T5 follow-up: backup reorder keeps j/k on the row cursor. Add two
# backups with distinct variants, move the selected one up with K, save, and
# inspect the persisted order.
live_key "$LIVE_TUI_SESSION" "s"
live_require_text "$LIVE_TUI_SESSION" "FakeAgent │ settings" 10 "settings reopened for backup reorder"
live_key "$LIVE_TUI_SESSION" "Tab"
live_require_text "$LIVE_TUI_SESSION" "Main + backups — main + 0 backups" 10 "models tab before adding backups"
live_key "$LIVE_TUI_SESSION" "a"
live_require_text "$LIVE_TUI_SESSION" "3${NBSP}variants" 10 "first backup model picker"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Reasoning${NBSP}effort" 10 "first backup variant picker"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "› ( ) Backup 1" 10 "first backup selected after add"
live_require_text "$LIVE_TUI_SESSION" "J/K reorder" 10 "models teaches reorder once a backup row is selected"
live_key "$LIVE_TUI_SESSION" "a"
live_require_text "$LIVE_TUI_SESSION" "3${NBSP}variants" 10 "second backup model picker"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Reasoning${NBSP}effort" 10 "second backup variant picker"
live_key "$LIVE_TUI_SESSION" Down
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "› ( ) Backup 2" 10 "second backup selected after add"
live_key "$LIVE_TUI_SESSION" "K"
live_require_text "$LIVE_TUI_SESSION" "› ( ) Backup 1" 10 "K moves the selected backup up"
# Ticket #124/#127: save closes the surface and confirms through one app
# toast. No header Saved state and no statusline duplicate compete with it.
live_key "$LIVE_TUI_SESSION" "s"
live_require_absence "$LIVE_TUI_SESSION" "FakeAgent │ settings" 10 "save closes the settings surface"
live_require_text "$LIVE_TUI_SESSION" "Saved FakeAgent." 5 "save confirms once in the app toast"
save_toast_cell=$(live_capture "$LIVE_TUI_SESSION" | awk 'index($0, "Saved FakeAgent.") { print NR " " index($0, "Saved FakeAgent."); exit }')
[[ -n "$save_toast_cell" ]] || live_fail "save toast disappeared before its placement could be read"
read -r save_toast_row save_toast_col <<<"$save_toast_cell"
save_toast_width="${ENSEMBLE_LIVE_TUI_WIDTH:-160}"
[[ "$save_toast_row" -le 8 ]] || live_fail "save toast is not near the top (row $save_toast_row)"
[[ "$save_toast_col" -gt $((save_toast_width / 2)) ]] || live_fail "save toast is not in the right half at ${save_toast_width} columns (column $save_toast_col)"
live_assert_absence "$LIVE_TUI_SESSION" "UNSAVED" "a closed save leaves no dirty mark"
backup_order=$(live_snapshot_value '(function () { var a = Object.values(output.state.agents).filter(function (x) { return x.name === "FakeAgent" })[0]; return a.backupModels.map(function (m) { return m.variant }) })()')
[[ "$backup_order" == '["medium","low"]' ]] || live_fail "K did not reorder the backups before save (got $backup_order)"
live_log "settings J/K reordered backups and saved the persisted order"

# v5.6 T7: composer Normal runs Vim motions, x/u/Ctrl+r, A, yy/p, dd, and
# Enter sends from Normal. The statusline position is the text-observable
# cursor, so motions are proven without reading private state.
live_key "$LIVE_TUI_SESSION" "i"
live_require_text "$LIVE_TUI_SESSION" "COMPOSER" 10 "composer focus for Vim probe"
live_type "$LIVE_TUI_SESSION" "vim alpha beta"
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ COMPOSER" 10 "Vim probe starts in composer Normal"
live_require_text "$LIVE_TUI_SESSION" "vim alpha beta" 10 "Esc keeps the typed text"
live_key "$LIVE_TUI_SESSION" "0"
live_require_text "$LIVE_TUI_SESSION" " │ 1:1 │ " 10 "0 goes to the line start"
live_key "$LIVE_TUI_SESSION" "w"
live_require_text "$LIVE_TUI_SESSION" " │ 1:5 │ " 10 "w goes to the next word start"
live_key "$LIVE_TUI_SESSION" '$'
live_require_text "$LIVE_TUI_SESSION" " │ 1:14 │ " 10 "$ goes to the last character"
live_key "$LIVE_TUI_SESSION" "b"
live_require_text "$LIVE_TUI_SESSION" " │ 1:11 │ " 10 "b goes back to the word start"
live_key "$LIVE_TUI_SESSION" "0"
live_key "$LIVE_TUI_SESSION" "x"
live_require_text "$LIVE_TUI_SESSION" "im alpha beta" 10 "x cuts the character at the cursor"
live_key "$LIVE_TUI_SESSION" "u"
live_require_text "$LIVE_TUI_SESSION" "vim alpha beta" 10 "u restores the cut character"
live_key "$LIVE_TUI_SESSION" "C-r"
live_require_text "$LIVE_TUI_SESSION" "im alpha beta" 10 "Ctrl+r redoes the cut"
live_key "$LIVE_TUI_SESSION" "u"
live_require_text "$LIVE_TUI_SESSION" "vim alpha beta" 10 "u restores the line for the paste probe"
live_key "$LIVE_TUI_SESSION" "A"
live_type "$LIVE_TUI_SESSION" "!"
sleep 0.25
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ COMPOSER" 10 "A returns to composer Normal"
live_require_text "$LIVE_TUI_SESSION" "vim alpha beta!" 10 "A appends at the line end"
live_key "$LIVE_TUI_SESSION" "y"
sleep 0.25
live_key "$LIVE_TUI_SESSION" "y"
sleep 0.25
live_key "$LIVE_TUI_SESSION" "p"
sleep 0.5
live_assert_count "$LIVE_TUI_SESSION" "vim alpha beta!" 2 "yy and p paste the line below"
live_key "$LIVE_TUI_SESSION" "u"
sleep 0.5
live_assert_count "$LIVE_TUI_SESSION" "vim alpha beta!" 1 "u undoes the linewise paste"
live_key "$LIVE_TUI_SESSION" "d"
sleep 0.25
live_key "$LIVE_TUI_SESSION" "d"
live_require_text "$LIVE_TUI_SESSION" "Message…" 10 "dd clears the composer line"
live_key "$LIVE_TUI_SESSION" "i"
live_require_text "$LIVE_TUI_SESSION" "INSERT  │ COMPOSER" 10 "Insert focus before the Enter-send probe"
live_type "$LIVE_TUI_SESSION" "vim-enter-check"
sleep 0.25
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ COMPOSER" 10 "Normal before Enter send"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "vim-enter-check" 15 "Enter sends from Normal"
live_assert_text "$LIVE_TUI_SESSION" "NORMAL  │ COMPOSER" "send from Normal keeps the composer focused"
sleep 0.25
live_key "$LIVE_TUI_SESSION" C-g
live_require_absence "$LIVE_TUI_SESSION" "COMPOSER" 10 "Ctrl+G leaves the composer from Normal"
live_assert_text "$LIVE_TUI_SESSION" "NORMAL  │ Group chat" "Ctrl+G returns to chat Normal"

# v5.6 T8: Visual and Visual-Line. `v`/`V` select, motions extend, y copies,
# d cuts, p pastes, and Esc cancels to Normal. The statusline names the kind
# and the selection size, so the probe never reads private state.
live_key "$LIVE_TUI_SESSION" "i"
live_require_text "$LIVE_TUI_SESSION" "COMPOSER" 10 "composer focus for the Visual probe"
live_type "$LIVE_TUI_SESSION" "vim visual line"
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ COMPOSER" 10 "Visual probe starts in composer Normal"
live_key "$LIVE_TUI_SESSION" "V"
live_require_text "$LIVE_TUI_SESSION" "V-LINE  │ COMPOSER" 10 "V enters Visual Line"
live_require_text "$LIVE_TUI_SESSION" "1 line" 10 "the statusline names the line selection size"
live_key "$LIVE_TUI_SESSION" '$'
live_assert_text "$LIVE_TUI_SESSION" "V-LINE  │ COMPOSER" "motions keep Visual Line active"
live_key "$LIVE_TUI_SESSION" "y"
# Ticket #119: copy feedback is the app-owned toast, anchored top-right, and
# it never takes focus. The normal-mode statusline stays unchanged and the
# following `p` still pastes before the toast auto-dismisses.
live_require_text "$LIVE_TUI_SESSION" "Clipboard" 5 "copy feedback uses the app toast"
toast_cell=$(live_capture "$LIVE_TUI_SESSION" | awk 'index($0, "Clipboard") { print NR " " index($0, "Clipboard"); exit }')
[[ -n "$toast_cell" ]] || live_fail "copy toast disappeared before its placement could be read"
read -r toast_row toast_col <<<"$toast_cell"
# Ticket #127: the fake scenario is size-parameterized, so "right-aligned"
# must be relative to the configured width instead of the 160-column default.
toast_width="${ENSEMBLE_LIVE_TUI_WIDTH:-160}"
[[ "$toast_row" -le 8 ]] || live_fail "copy toast is not near the top (row $toast_row)"
[[ "$toast_col" -gt $((toast_width / 2)) ]] \
  || live_fail "copy toast is not in the right half at ${toast_width} columns (column $toast_col)"
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ COMPOSER" 10 "copy toast does not steal composer focus"
live_log "ticket #119 copy toast is top-right and leaves keys with the composer"
live_key "$LIVE_TUI_SESSION" "p"
sleep 0.5
live_assert_count "$LIVE_TUI_SESSION" "vim visual line" 2 "a V-LINE yank pastes as whole lines"
live_key "$LIVE_TUI_SESSION" "u"
sleep 0.5
live_assert_count "$LIVE_TUI_SESSION" "vim visual line" 1 "u undoes the Visual Line paste"
# Character Visual, a motion, and the `o` end swap.
live_key "$LIVE_TUI_SESSION" "v"
live_require_text "$LIVE_TUI_SESSION" "VISUAL  │ COMPOSER" 10 "v enters Character Visual"
live_key "$LIVE_TUI_SESSION" "0"
live_require_text "$LIVE_TUI_SESSION" "chars" 10 "motions extend the character selection"
live_key "$LIVE_TUI_SESSION" "o"
live_assert_text "$LIVE_TUI_SESSION" "VISUAL  │ COMPOSER" "o swaps the ends without leaving Visual"
live_key "$LIVE_TUI_SESSION" '$'
live_assert_text "$LIVE_TUI_SESSION" "VISUAL  │ COMPOSER" "a motion after o keeps the selection active"
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ COMPOSER" 10 "Esc cancels Visual to Normal"
# V then d cuts the whole line; p pastes it back as a line.
live_key "$LIVE_TUI_SESSION" "V"
live_key "$LIVE_TUI_SESSION" "d"
sleep 0.5
live_assert_count "$LIVE_TUI_SESSION" "vim visual line" 0 "V d cuts the selected line"
live_key "$LIVE_TUI_SESSION" "p"
sleep 0.5
live_assert_count "$LIVE_TUI_SESSION" "vim visual line" 1 "the cut line pastes back as a line"
live_key "$LIVE_TUI_SESSION" "u"
sleep 0.5
live_key "$LIVE_TUI_SESSION" C-g
live_require_absence "$LIVE_TUI_SESSION" "COMPOSER" 10 "Ctrl+G leaves after the Visual probe"

live_check_help

# Ticket #77d / #80: Escape must never leave Ensemble; `:q` and `Space q` do.
live_key "$LIVE_TUI_SESSION" Escape
sleep 0.5
live_assert_text "$LIVE_TUI_SESSION" "ENSEMBLE" "Escape never quits Ensemble"
# Ticket #80: `:q` is the deliberate command-line quit.
live_type "$LIVE_TUI_SESSION" ":"
live_require_text "$LIVE_TUI_SESSION" "COMMAND  │ " 10 "colon opens Command mode"
live_type "$LIVE_TUI_SESSION" "q"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Ask anything" 15 "native TUI after :q"
# Ticket #91: the mounted Ensemble page must not consume native keys after
# leaving. Type immediately without an Esc, then prove `/` reaches the native
# prompt (the slash menu) and the command text follows it.
live_type "$LIVE_TUI_SESSION" "native-after-quit"
live_require_text "$LIVE_TUI_SESSION" "native-after-quit" 10 "native prompt accepts letters immediately after :q"
live_key "$LIVE_TUI_SESSION" C-u
live_require_text "$LIVE_TUI_SESSION" "Ask anything" 10 "native prompt cleared for the slash probe"
live_type "$LIVE_TUI_SESSION" "/"
live_require_text "$LIVE_TUI_SESSION" "Switch agent" 10 "slash reaches the native prompt and opens its command menu"
live_key "$LIVE_TUI_SESSION" Escape
sleep 0.25
live_type "$LIVE_TUI_SESSION" "agents"
live_require_text "$LIVE_TUI_SESSION" "/agents" 10 "native command text follows the slash"
live_key "$LIVE_TUI_SESSION" C-u
live_require_text "$LIVE_TUI_SESSION" "Ask anything" 10 "native prompt cleared after the slash probe"
# Ticket #77d: F2 returns to Ensemble from any native session. Keys only
# after the round-trip, so the check does not depend on editor focus.
live_key "$LIVE_TUI_SESSION" F2
live_require_text "$LIVE_TUI_SESSION" "ENSEMBLE" 15 "F2 opens Ensemble from the native session"
# v5.6 T3: the Space leader remains a deliberate quit path.
live_key "$LIVE_TUI_SESSION" Space
live_require_text "$LIVE_TUI_SESSION" "LEADER" 10 "leader mode after F2 round-trip"
live_key "$LIVE_TUI_SESSION" 'q'
live_require_text "$LIVE_TUI_SESSION" "Ask anything" 15 "native TUI after F2 round-trip"
live_assert_absence "$LIVE_TUI_SESSION" "Rich Markdown Fixture" "stale heading after leaving Ensemble"
live_assert_absence "$LIVE_TUI_SESSION" "RICH_CODE_MARKER" "stale code after leaving Ensemble"
live_assert_absence "$LIVE_TUI_SESSION" "fake-queue-beta" "stale work row after leaving Ensemble"
live_assert_absence "$LIVE_TUI_SESSION" "WORK ACTIVE" "stale Work pane after leaving Ensemble"

# v5.6 T11: `:` and `/` still open Command mode after the native F2
# round-trip; the visible page owns the key, not a stale stacked page.
live_key "$LIVE_TUI_SESSION" F2
live_require_text "$LIVE_TUI_SESSION" "ENSEMBLE" 15 "F2 returns before the command probes"
live_type "$LIVE_TUI_SESSION" ":"
live_require_text "$LIVE_TUI_SESSION" "COMMAND  │ " 10 "colon opens Command mode after F2 round-trip"
live_key "$LIVE_TUI_SESSION" Escape
live_type "$LIVE_TUI_SESSION" "/"
live_require_text "$LIVE_TUI_SESSION" "COMMAND  │ " 10 "slash opens Command search after F2 round-trip"
live_key "$LIVE_TUI_SESSION" Escape

# v5.6 T4: `o` opens the selected work's native session.
t4_delegate "T4 native probe"
live_require_active_work "$LIVE_TUI_SESSION" 15 "native-probe work row mounts"
live_focus_work
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Work list" 10 "Tab reaches the work list for the native probe"
live_key "$LIVE_TUI_SESSION" "o"
# The host native TUI footer is the stable marker here; its `ctrl+p commands`
# label is host-owned, not an Ensemble app binding.
live_require_text "$LIVE_TUI_SESSION" "ctrl+p commands" 15 "o opens the selected work's native session"
t4_native_id=$(t4_id_for "T4 native probe")
live_invoke task.cancel "{\"id\":\"$t4_native_id\"}" >/dev/null
live_log "work-list o opens the selected work's native session"

# Slice B reduced-motion run: restart the TUI with ENSEMBLE_REDUCED_MOTION=1
# and prove live work renders static frame-0 glyphs only — the Work card stays
# on ⠋ and no non-zero motion codepoint
# (⠙⠹⠸⠼⠴⠦⠧⠇⠏▪▹▌) appears across sustained captures while work is in flight.
live_log "restarting TUI under ENSEMBLE_REDUCED_MOTION=1"
"$LIVE_TMUX_BIN" kill-session -t "$LIVE_TUI_SESSION" 2>/dev/null || true
live_tmux_env_add "ENSEMBLE_REDUCED_MOTION=1"
live_start_tui
live_wait_for_native_tui
live_open_ensemble
live_require_text "$LIVE_TUI_SESSION" "ENSEMBLE" 15 "Ensemble page under reduced motion"
live_require_text "$LIVE_TUI_SESSION" "#LiveSite" 20 "group surface restored under reduced motion"
# Persisted focus can restore a completed History card, which opens HISTORY.
# Normalize to ACTIVE before composing; the new turn must appear in ACTIVE.
live_focus_work
if live_capture "$LIVE_TUI_SESSION" | grep -qF "WORK HISTORY │"; then
  live_key "$LIVE_TUI_SESSION" "f"
fi
live_require_text "$LIVE_TUI_SESSION" "WORK ACTIVE │" 10 "ACTIVE view before the reduced-motion turn"
live_focus_chat "$LIVE_TUI_SESSION"
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Group chat" 10 "pane selection returns to the transcript from restored Work focus"
live_key "$LIVE_TUI_SESSION" "i"
live_require_text "$LIVE_TUI_SESSION" "enter send │ esc normal │ ctrl+g leave" 10 "static composer hint under reduced motion"
live_assert_absence "$LIVE_TUI_SESSION" "▌" "no blink glyph under reduced motion"
live_type "$LIVE_TUI_SESSION" "fake-motion-static"
live_key "$LIVE_TUI_SESSION" Enter
live_require_work_card "$LIVE_TUI_SESSION" "FAKEAGENT" "WORKING" 15 "frame-0 Work card under reduced motion"
live_capture_matches "$LIVE_TUI_SESSION" "FAKEAGENT.*⠋ WORKING" || live_fail "reduced-motion Work card is not on frame 0"
sleep 0.25
live_key "$LIVE_TUI_SESSION" Escape
for _ in $(seq 1 8); do
  pane=$(live_capture "$LIVE_TUI_SESSION")
  for glyph in "⠙" "⠹" "⠸" "⠼" "⠴" "⠦" "⠧" "⠇" "⠏" "▪" "▹" "▌"; do
    grep -qF -- "$glyph" <<<"$pane" && live_fail "reduced-motion run animated (saw $glyph)"
  done
  sleep 0.3
done
live_log "reduced-motion run stayed on frame-0 glyphs while live"
live_require_text "$LIVE_TUI_SESSION" "● FakeAgent finished: fake-motion-static" 30 "reduced-motion work announced once"
live_assert_count "$LIVE_TUI_SESSION" "● FakeAgent finished: fake-motion-static" 1 "reduced-motion completion exactly once, no duplicate inline line"
live_require_no_active_work "$LIVE_TUI_SESSION" 15 "ACTIVE clears under reduced motion"
# Let the 3 s "Message sent" transient expire before sampling quiescence.
sleep 3.2
reduced_idle_first=$(live_capture "$LIVE_TUI_SESSION")
sleep 1.5
reduced_idle_second=$(live_capture "$LIVE_TUI_SESSION")
[[ "$reduced_idle_first" == "$reduced_idle_second" ]] || live_fail "reduced-motion idle TUI kept ticking between captures"
live_log "reduced-motion idle screen is quiescent across 1.5 s"

# Ticket #71: mandatory completion handoff plus batched review. Two
# non-leader members do parallel peer turns; each finished turn hands to the
# workspace leader automatically (`Handed to $FakeAgent`), and the two
# pending completions coalesce into one `Review 2 completions` batch turn.
live_invoke "agent.create" '{"name":"Helper"}' >/dev/null
live_invoke "agent.create" '{"name":"Scout"}' >/dev/null
fake_id=$(live_snapshot_value 'Object.values(output.state.agents).find(function (a) { return a.name === "FakeAgent" }).id' | tr -d '"')
helper_id=$(live_snapshot_value 'Object.values(output.state.agents).find(function (a) { return a.name === "Helper" }).id' | tr -d '"')
scout_id=$(live_snapshot_value 'Object.values(output.state.agents).find(function (a) { return a.name === "Scout" }).id' | tr -d '"')
ws_id=$(live_snapshot_value 'Object.keys(output.state.workspaces)[0]' | tr -d '"')
[[ -n "$fake_id" && -n "$helper_id" && -n "$scout_id" && -n "$ws_id" ]] || live_fail "ticket #71 setup did not create both members (got $fake_id/$helper_id/$scout_id/$ws_id)"
live_invoke "workspace.update" "{\"id\":\"$ws_id\",\"memberIDs\":[\"$fake_id\",\"$helper_id\",\"$scout_id\"]}" >/dev/null
members=$(live_snapshot_value 'Object.values(output.state.workspaces)[0].memberIDs.length')
[[ "$members" == "3" ]] || live_fail "ticket #71 workspace update did not add both members (got $members)"
# The `!Name` alias posts without a completion popup. One message names both
# members, so a single fan-out creates both peer turns atomically and they
# run in parallel on their own agents — both completions land inside the
# batch quiet window instead of racing it.
live_key "$LIVE_TUI_SESSION" C-g
live_key "$LIVE_TUI_SESSION" "i"
live_require_text "$LIVE_TUI_SESSION" "COMPOSER" 10 "composer focus for completion probes"
live_type "$LIVE_TUI_SESSION" "!Helper !Scout joint-task"
live_key "$LIVE_TUI_SESSION" Enter
live_require_joined_text "$LIVE_TUI_SESSION" "→ Assigned to \$Helper: !Helper !Scout joint-task" 15 "assignment line for the Helper turn"
live_require_joined_text "$LIVE_TUI_SESSION" "→ Assigned to \$Scout: !Helper !Scout joint-task" 15 "assignment line for the Scout turn"
sleep 0.25
live_key "$LIVE_TUI_SESSION" Escape
# Each finished non-leader turn hands to the leader automatically.
live_require_text "$LIVE_TUI_SESSION" "Handed to \$FakeAgent" 30 "completion handoff to the leader"
handed=0
for _ in $(seq 1 60); do
  handed=$(live_capture "$LIVE_TUI_SESSION" | grep -cF 'Handed to $FakeAgent' || true)
  [[ "$handed" == "2" ]] && break
  sleep 0.5
done
[[ "$handed" == "2" ]] || live_fail "expected one completion handoff per finished turn (got $handed)"
live_log "both non-leader turns handed to the leader"
# Ticket #73: the group ack is a concise system line — the waiting policy
# and correlation ref stay in the tool result, never in an agent bubble.
live_require_text "$LIVE_TUI_SESSION" "Handed to \$FakeAgent ·" 15 "concise handoff ack without policy text"
live_assert_absence "$LIVE_TUI_SESSION" "do not call ensemble_delegate" "no policy text in the transcript"
# Both pending completions coalesce into a single batch review turn.
live_require_joined_text "$LIVE_TUI_SESSION" "→ Assigned to \$FakeAgent: Review 2 completions" 30 "batch review assigned to the leader"
batch_items=$(live_snapshot_value '(function () { var tasks = Object.values(output.state.subtasks); var batch = tasks.find(function (t) { return t.handoff && t.handoff.batch === true; }); return batch ? batch.handoff.itemIDs.length : 0 })()')
[[ "$batch_items" == "2" ]] || live_fail "batch review did not consolidate both completions (got $batch_items)"
batch_listing=$(live_snapshot_value '(function () { var tasks = Object.values(output.state.subtasks); var batch = tasks.find(function (t) { return t.handoff && t.handoff.batch === true; }); return batch ? batch.instruction : "" })()')
[[ "$batch_listing" == *"joint-task"* ]] || live_fail "batch review listing misses the completed task"
[[ "$batch_listing" == *'$Helper'* && "$batch_listing" == *'$Scout'* ]] || live_fail "batch review listing misses a sender"
live_require_text "$LIVE_TUI_SESSION" "Review 2 completions" 30 "batch review presented in the transcript"
live_assert_absence "$LIVE_TUI_SESSION" "@Helper" "completion addressing stays \$Name, never @Name"
live_assert_absence "$LIVE_TUI_SESSION" "@Scout" "completion addressing stays \$Name, never @Name"
live_assert_absence "$LIVE_TUI_SESSION" "@FakeAgent" "completion addressing stays \$Name, never @Name"
live_log "ticket #71 completion handoff and batch review verified live"
# Ticket #74: after both handoffs/completions, no generic checking ghost may remain.
live_require_absence "$LIVE_TUI_SESSION" "checking the details…" 15 "no ghost checking line after completions"

# v5.8 T2 (ticket #101): the composer `/` palette lists commands and the
# owner's assigned skills with `Command` / `Skill | Owner` flags, agent-scoped
# `/` lists only that agent's skills, selection inserts the template, exact
# text reaches the owner as one peer turn, and an invalid owner rejects before
# sending while the draft stays.
skill_found=0
for _ in $(seq 1 40); do
  skill_found=$(live_snapshot_value 'output.skills.filter(function (s) { return s.id === "ensemble-live-skill" }).length')
  [[ "$skill_found" == "1" ]] && break
  sleep 0.25
done
[[ "$skill_found" == "1" ]] || live_fail "project skill fixture missing from the host catalog"
skill_two_found=0
for _ in $(seq 1 20); do
  skill_two_found=$(live_snapshot_value 'output.skills.filter(function (s) { return s.id === "ensemble-live-skill-two" }).length')
  [[ "$skill_two_found" == "1" ]] && break
  sleep 0.25
done
[[ "$skill_two_found" == "1" ]] || live_fail "second project skill fixture missing from the host catalog"
for name in ensemble-live-skill-general ensemble-live-skill-helper; do
  found=0
  for _ in $(seq 1 40); do
    found=$(live_snapshot_value "output.skills.filter(function (s) { return s.id === \"$name\" }).length")
    [[ "$found" == "1" ]] && break
    sleep 0.25
  done
  [[ "$found" == "1" ]] || live_fail "ticket #103 skill fixture missing from the host catalog: $name"
done

# The composer has no Ctrl+U clear binding; enter the editor and erase the
# draft so the next probe starts clean even after an error preserved it.
clear_composer_text() {
  live_key "$LIVE_TUI_SESSION" C-g
  live_key "$LIVE_TUI_SESSION" "i"
  sleep 0.2
  # The cursor can sit inside an earlier draft (for example before a preserved
  # suffix); clear from the end so no trailing text survives.
  live_key "$LIVE_TUI_SESSION" End
  live_key_repeat "$LIVE_TUI_SESSION" BSpace 160
  sleep 0.5
}

fake_id=$(live_snapshot_value 'Object.values(output.state.agents).find(function (a) { return a.name === "FakeAgent" }).id' | tr -d '"')
live_invoke "agent.update" "{\"id\":\"$fake_id\",\"skillbox\":[\"ensemble-live-skill\",\"ensemble-live-skill-two\"]}" >/dev/null
live_invoke "agent.update" "{\"id\":\"$helper_id\",\"skillbox\":[\"ensemble-live-skill-two\",\"ensemble-live-skill-helper\"]}" >/dev/null
sleep 0.5
assigned=$(live_snapshot_value 'Object.values(output.state.agents).find(function (a) { return a.name === "FakeAgent" }).skillbox.join(",")' | tr -d '"')
[[ "$assigned" == "ensemble-live-skill,ensemble-live-skill-two" ]] || live_fail "skill assignment did not persist (got $assigned)"

live_key "$LIVE_TUI_SESSION" C-g
live_key "$LIVE_TUI_SESSION" "i"
live_require_text "$LIVE_TUI_SESSION" "COMPOSER" 10 "composer focus for skill palette"
live_type "$LIVE_TUI_SESSION" "/"
live_require_text "$LIVE_TUI_SESSION" "/ commands │ skills" 10 "message-start palette title"
live_require_text "$LIVE_TUI_SESSION" "Command" 10 "command rows carry the Command flag"
live_type "$LIVE_TUI_SESSION" "ensemble-live"
live_require_text "$LIVE_TUI_SESSION" "Skill | FakeAgent" 10 "assigned skill row carries the owner flag"
live_require_text "$LIVE_TUI_SESSION" "Skill | General" 10 "unassigned skill row carries the General flag"
live_assert_absence "$LIVE_TUI_SESSION" "Skill ·" "skill flags never use a middle dot"
live_assert_absence "$LIVE_TUI_SESSION" "Command ·" "command flags never use a middle dot"
live_key "$LIVE_TUI_SESSION" Enter
live_require_absence "$LIVE_TUI_SESSION" "Skill | FakeAgent" 10 "skill selection closes the palette"
live_assert_text "$LIVE_TUI_SESSION" "/ensemble-live-skill" "leader-owned skill inserts the bare template"
live_type "$LIVE_TUI_SESSION" "palette-check"
live_key "$LIVE_TUI_SESSION" Enter
live_require_joined_text "$LIVE_TUI_SESSION" "→ Assigned to \$FakeAgent: /ensemble-live-skill — /ensemble-live-skill palette-check" 20 "skill turn assigned to its owner"
skill_exact=$(live_snapshot_value '(function () { var task = Object.values(output.state.subtasks).filter(function (t) { return t.creatorType === "user" && t.instruction === "/ensemble-live-skill palette-check" }).pop(); return task ? task.instruction : "missing" })()')
[[ "$skill_exact" == '"/ensemble-live-skill palette-check"' ]] || live_fail "skill turn did not keep the exact user text (got $skill_exact)"

# The built-in Ensemble init skill is General in the palette but executes the
# System Agent init job; it is not a host skill row and remains solo-only.
live_key "$LIVE_TUI_SESSION" C-g
live_key "$LIVE_TUI_SESSION" "i"
live_require_text "$LIVE_TUI_SESSION" "COMPOSER" 10 "composer focus for the built-in init skill"
live_type "$LIVE_TUI_SESSION" "/init"
live_require_text "$LIVE_TUI_SESSION" "Skill | General" 10 "the built-in init skill carries the General flag"
live_require_text "$LIVE_TUI_SESSION" "/init" 10 "the built-in init skill keeps the /init alias"
live_key "$LIVE_TUI_SESSION" Escape
clear_composer_text
live_log "ticket #103 built-in init skill is a General system executor"

live_key "$LIVE_TUI_SESSION" C-g
live_key "$LIVE_TUI_SESSION" "i"
live_require_text "$LIVE_TUI_SESSION" "COMPOSER" 10 "composer focus for agent-scoped skill palette"
live_type "$LIVE_TUI_SESSION" "$"
live_require_text "$LIVE_TUI_SESSION" "\$ agents" 10 "agent completion opens for the skill anchor"
live_key "$LIVE_TUI_SESSION" Enter
live_require_absence "$LIVE_TUI_SESSION" "\$ agents" 10 "agent anchor accepted"
live_type "$LIVE_TUI_SESSION" "/ens"
live_require_text "$LIVE_TUI_SESSION" "\$FakeAgent / │ skills" 10 "agent-scoped palette title"
live_require_text "$LIVE_TUI_SESSION" "Skill | FakeAgent" 10 "agent-scoped palette lists its assigned skill"
live_assert_absence "$LIVE_TUI_SESSION" "Skill | General" "agent-scoped palette hides General skills"
live_assert_absence "$LIVE_TUI_SESSION" "/ commands" "agent-scoped palette hides commands"
live_key "$LIVE_TUI_SESSION" Enter
live_require_absence "$LIVE_TUI_SESSION" "Skill | FakeAgent" 10 "agent-scoped selection closes the palette"
live_assert_text "$LIVE_TUI_SESSION" "\$FakeAgent /ensemble-live-skill" "anchored selection keeps the agent anchor"
sleep 0.4
live_type "$LIVE_TUI_SESSION" "anchored-check"
live_key "$LIVE_TUI_SESSION" Enter
live_require_joined_text "$LIVE_TUI_SESSION" "→ Assigned to \$FakeAgent: /ensemble-live-skill — \$FakeAgent /ensemble-live-skill anchored-check" 20 "anchored skill turn assigned to the owner"
anchored_exact=$(live_snapshot_value '(function () { var task = Object.values(output.state.subtasks).filter(function (t) { return t.creatorType === "user" && t.instruction === "$FakeAgent /ensemble-live-skill anchored-check" }).pop(); return task ? task.instruction : "missing" })()')
[[ "$anchored_exact" == '"$FakeAgent /ensemble-live-skill anchored-check"' ]] || live_fail "anchored skill turn did not keep the exact user text (got $anchored_exact)"

# v5.8 T3 (ticket #102): multiple skills under one anchor group into one
# prompt, multiple anchors create one work row per unique agent, a normal-only
# anchor keeps a normal peer turn, the exact text reaches every recipient, and
# each reply stays attributed to its own agent.
multi_text='$FakeAgent /ensemble-live-skill /ensemble-live-skill-two multi-skill-check'
live_key "$LIVE_TUI_SESSION" C-g
live_key "$LIVE_TUI_SESSION" "i"
live_require_text "$LIVE_TUI_SESSION" "COMPOSER" 10 "composer focus for grouped skills"
live_type "$LIVE_TUI_SESSION" "$multi_text"
live_key "$LIVE_TUI_SESSION" Escape
sleep 0.3
live_key "$LIVE_TUI_SESSION" Enter
live_require_joined_text "$LIVE_TUI_SESSION" "→ Assigned to \$FakeAgent: /ensemble-live-skill /ensemble-live-skill-two —" 20 "grouped skills share one assignment row"
multi_state=""
for _ in $(seq 1 40); do
  multi_state=$(live_snapshot_value '(function () { var tasks = Object.values(output.state.subtasks).filter(function (t) { return t.workKind === "turn" && t.instruction.indexOf("multi-skill-check") >= 0 }); return tasks.length + ":" + (tasks[0] ? tasks[0].state : "missing") })()')
  [[ "$multi_state" == '"1:replied"' ]] && break
  sleep 0.5
done
[[ "$multi_state" == '"1:replied"' ]] || live_fail "grouped skill message did not produce one replied turn (got $multi_state)"
multi_instruction=$(live_snapshot_value '(function () { var task = Object.values(output.state.subtasks).filter(function (t) { return t.workKind === "turn" && t.instruction.indexOf("multi-skill-check") >= 0 })[0]; return task ? task.instruction : "missing" })()')
[[ "$multi_instruction" == "\"$multi_text\"" ]] || live_fail "grouped skill turn lost the exact user text (got $multi_instruction)"
multi_title=$(live_snapshot_value '(function () { var task = Object.values(output.state.subtasks).filter(function (t) { return t.workKind === "turn" && t.instruction.indexOf("multi-skill-check") >= 0 })[0]; return task ? task.title : "missing" })()')
multi_expected=$(printf '/ensemble-live-skill /ensemble-live-skill-two — %s' "$multi_text")
[[ "$multi_title" == "\"$multi_expected\"" ]] || live_fail "grouped skill title missed the resolved skills (got $multi_title)"
multi_reply=$(live_snapshot_value '(function () { var task = Object.values(output.state.subtasks).filter(function (t) { return t.workKind === "turn" && t.instruction.indexOf("multi-skill-check") >= 0 })[0]; if (!task) return "missing"; var messages = output.state.messages[task.workspaceID] || []; var replies = messages.filter(function (m) { return m.author === "agent" && m.agentID === task.assigneeID && m.taskID === task.id }); return task.state + ":" + task.assigneeID + ":" + replies.length })()')
[[ "$multi_reply" == "\"replied:$fake_id:1\"" ]] || live_fail "grouped skill reply was not attributed to its agent (got $multi_reply)"

anchor_text='$FakeAgent /ensemble-live-skill !Helper /ensemble-live-skill-two multi-anchor'
live_key "$LIVE_TUI_SESSION" C-g
live_key "$LIVE_TUI_SESSION" "i"
live_require_text "$LIVE_TUI_SESSION" "COMPOSER" 10 "composer focus for multiple anchors"
live_type "$LIVE_TUI_SESSION" "$anchor_text"
live_key "$LIVE_TUI_SESSION" Escape
sleep 0.3
live_key "$LIVE_TUI_SESSION" Enter
live_require_joined_text "$LIVE_TUI_SESSION" "→ Assigned to \$FakeAgent: /ensemble-live-skill —" 20 "first anchor assigned to its owner"
live_require_joined_text "$LIVE_TUI_SESSION" "→ Assigned to \$Helper: /ensemble-live-skill-two —" 20 "second anchor assigned to its owner"
anchor_state=""
for _ in $(seq 1 40); do
  anchor_state=$(live_snapshot_value '(function () { var tasks = Object.values(output.state.subtasks).filter(function (t) { return t.workKind === "turn" && t.instruction.indexOf("multi-anchor") >= 0 }); var replied = tasks.filter(function (t) { return t.state === "replied" }).length; return tasks.length + ":" + replied })()')
  [[ "$anchor_state" == '"2:2"' ]] && break
  sleep 0.5
done
[[ "$anchor_state" == '"2:2"' ]] || live_fail "multi-anchor message did not produce two replied turns (got $anchor_state)"
fake_anchor_title=$(live_snapshot_value "(function () { var task = Object.values(output.state.subtasks).filter(function (t) { return t.workKind === \"turn\" && t.instruction.indexOf(\"multi-anchor\") >= 0 && t.assigneeID === \"$fake_id\" })[0]; return task ? task.title : \"missing\" })()")
helper_anchor_title=$(live_snapshot_value "(function () { var task = Object.values(output.state.subtasks).filter(function (t) { return t.workKind === \"turn\" && t.instruction.indexOf(\"multi-anchor\") >= 0 && t.assigneeID === \"$helper_id\" })[0]; return task ? task.title : \"missing\" })()")
[[ "$fake_anchor_title" == "\"$(printf '/ensemble-live-skill — %s' "$anchor_text")\"" ]] || live_fail "first anchor title missed its resolved skill (got $fake_anchor_title)"
[[ "$helper_anchor_title" == "\"$(printf '/ensemble-live-skill-two — %s' "$anchor_text")\"" ]] || live_fail "second anchor title missed its resolved skill (got $helper_anchor_title)"
anchor_fake_reply=$(live_snapshot_value "(function () { var task = Object.values(output.state.subtasks).filter(function (t) { return t.workKind === \"turn\" && t.instruction.indexOf(\"multi-anchor\") >= 0 && t.assigneeID === \"$fake_id\" })[0]; if (!task) return \"missing\"; var messages = output.state.messages[task.workspaceID] || []; var replies = messages.filter(function (m) { return m.author === \"agent\" && m.agentID === task.assigneeID && m.taskID === task.id }); return task.state + \":\" + replies.length })()")
anchor_helper_reply=$(live_snapshot_value "(function () { var task = Object.values(output.state.subtasks).filter(function (t) { return t.workKind === \"turn\" && t.instruction.indexOf(\"multi-anchor\") >= 0 && t.assigneeID === \"$helper_id\" })[0]; if (!task) return \"missing\"; var messages = output.state.messages[task.workspaceID] || []; var replies = messages.filter(function (m) { return m.author === \"agent\" && m.agentID === task.assigneeID && m.taskID === task.id }); return task.state + \":\" + replies.length })()")
[[ "$anchor_fake_reply" == '"replied:1"' ]] || live_fail "first anchor reply was not independently attributed (got $anchor_fake_reply)"
[[ "$anchor_helper_reply" == '"replied:1"' ]] || live_fail "second anchor reply was not independently attributed (got $anchor_helper_reply)"

mixed_text='$FakeAgent /ensemble-live-skill !Helper mixed-anchor'
live_key "$LIVE_TUI_SESSION" C-g
live_key "$LIVE_TUI_SESSION" "i"
live_require_text "$LIVE_TUI_SESSION" "COMPOSER" 10 "composer focus for mixed anchors"
live_type "$LIVE_TUI_SESSION" "$mixed_text"
live_key "$LIVE_TUI_SESSION" Escape
sleep 0.3
live_key "$LIVE_TUI_SESSION" Enter
live_require_joined_text "$LIVE_TUI_SESSION" "→ Assigned to \$FakeAgent: /ensemble-live-skill —" 20 "mixed skill anchor keeps its resolved skill"
live_require_joined_text "$LIVE_TUI_SESSION" "→ Assigned to \$Helper: $mixed_text" 20 "normal anchor keeps a normal peer turn"
mixed_state=""
for _ in $(seq 1 40); do
  mixed_state=$(live_snapshot_value '(function () { var tasks = Object.values(output.state.subtasks).filter(function (t) { return t.workKind === "turn" && t.instruction.indexOf("mixed-anchor") >= 0 }); var replied = tasks.filter(function (t) { return t.state === "replied" }).length; return tasks.length + ":" + replied })()')
  [[ "$mixed_state" == '"2:2"' ]] && break
  sleep 0.5
done
[[ "$mixed_state" == '"2:2"' ]] || live_fail "mixed anchors did not produce two replied turns (got $mixed_state)"
mixed_helper_title=$(live_snapshot_value "(function () { var task = Object.values(output.state.subtasks).filter(function (t) { return t.workKind === \"turn\" && t.instruction.indexOf(\"mixed-anchor\") >= 0 && t.assigneeID === \"$helper_id\" })[0]; return task ? task.title : \"missing\" })()")
[[ "$mixed_helper_title" == "\"$mixed_text\"" ]] || live_fail "normal-only work row did not keep the request snippet (got $mixed_helper_title)"
mixed_exact=$(live_snapshot_value '(function () { var tasks = Object.values(output.state.subtasks).filter(function (t) { return t.workKind === "turn" && t.instruction.indexOf("mixed-anchor") >= 0 }); return tasks.length === 2 && tasks.every(function (t) { return t.instruction === tasks[0].instruction }) ? tasks[0].instruction : "mismatch" })()')
[[ "$mixed_exact" == "\"$mixed_text\"" ]] || live_fail "mixed anchors did not deliver the same exact text (got $mixed_exact)"
live_log "ticket #102 multi-skill grouping, multi-anchor routing, mixed anchors, work rows, and replies verified"

# Validation is atomic and preserves the draft. Helper is a workspace member
# with no assigned first skill, so the planner names both the skill and its owner.
live_key "$LIVE_TUI_SESSION" C-g
live_key "$LIVE_TUI_SESSION" "i"
live_require_text "$LIVE_TUI_SESSION" "COMPOSER" 10 "composer focus for skill validation"
live_type "$LIVE_TUI_SESSION" "!Helper /ensemble-live-skill wrong-owner"
live_key "$LIVE_TUI_SESSION" Escape
live_require_absence "$LIVE_TUI_SESSION" "\$Helper / │ skills" 10 "validation palette closed"
sleep 0.3
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Skill /ensemble-live-skill is assigned to \$FakeAgent, not \$Helper." 10 "skill validation names the owner and the wrong agent"
live_assert_text "$LIVE_TUI_SESSION" "!Helper /ensemble-live-skill wrong-owner" "validation failure keeps the draft"
invalid_skill_tasks=$(live_snapshot_value 'Object.values(output.state.subtasks).filter(function (t) { return t.instruction.indexOf("wrong-owner") >= 0 }).length')
[[ "$invalid_skill_tasks" == "0" ]] || live_fail "invalid skill reference created work (got $invalid_skill_tasks rows)"
live_log "ticket #101 composer skill palette, insertion, routing, and validation verified"

# v5.8 T3 cap: min(settings.maxDelegations, 8) skill tokens per message. The
# server rejects the whole message before appending a line or creating work.
previous_max=$(live_snapshot_value 'output.state.settings.maxDelegations')
live_invoke "settings.update" '{"maxDelegations":2}' >/dev/null
cap_response=$(live_invoke "skill.send" "{\"workspaceID\":\"$ws_id\",\"text\":\"!FakeAgent /ensemble-live-skill /ensemble-live-skill-two /ensemble-live-skill cap-check\"}")
[[ "$cap_response" == *'"code":"skill_limit"'* ]] || live_fail "cap rejection did not return skill_limit (got $cap_response)"
[[ "$cap_response" == *"at most 2"* ]] || live_fail "cap rejection did not name the configured limit (got $cap_response)"
cap_tasks=$(live_snapshot_value 'Object.values(output.state.subtasks).filter(function (t) { return t.instruction.indexOf("cap-check") >= 0 }).length')
[[ "$cap_tasks" == "0" ]] || live_fail "cap rejection created work (got $cap_tasks rows)"
cap_messages=$(live_snapshot_value 'Object.keys(output.state.messages).reduce(function (count, key) { return count + output.state.messages[key].filter(function (m) { return m.text.indexOf("cap-check") >= 0 }).length }, 0)')
[[ "$cap_messages" == "0" ]] || live_fail "cap rejection appended a transcript line (got $cap_messages rows)"
live_invoke "settings.update" "{\"maxDelegations\":$previous_max}" >/dev/null
live_log "ticket #102 skill batch cap rejected the whole message atomically"

# v5.8 T4 (ticket #103): General-skill leader triage. The leader receives a
# one-run native skill grant while the turn runs and the Skillbox baseline is
# restored afterwards; a delegatee gets leader guidance with no host grant;
# the owner picker resolves a non-leader message-start skill; a General skill
# under a non-leader mention and a General skill in a Direct conversation are
# rejected with actionable messages.
live_session_permissions() {
  local session_id="$1"
  curl -fsS --max-time 10 -u "opencode:$LIVE_SERVER_PASSWORD" \
    "$LIVE_SERVER_URL/api/session/$session_id" | "$LIVE_NODE_BIN" -e '
      let value = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { value += chunk });
      process.stdin.on("end", () => {
        try {
          const parsed = JSON.parse(value);
          const info = parsed?.data ?? parsed;
          const permissions = Array.isArray(info?.permissions) ? info.permissions : [];
          process.stdout.write(permissions.map((rule) => `${rule.action}:${rule.resource}:${rule.effect}`).join(","));
        } catch {
          process.exit(1);
        }
      });
    '
}

general_text='/ensemble-live-skill-general general-triage-check fake-queue-hold'
clear_composer_text
live_key "$LIVE_TUI_SESSION" C-g
live_key "$LIVE_TUI_SESSION" "i"
live_require_text "$LIVE_TUI_SESSION" "COMPOSER" 10 "composer focus for General triage"
live_type "$LIVE_TUI_SESSION" "$general_text"
live_key "$LIVE_TUI_SESSION" Escape
sleep 0.3
live_key "$LIVE_TUI_SESSION" Enter
live_require_joined_text "$LIVE_TUI_SESSION" "→ Assigned to \$FakeAgent: /ensemble-live-skill-general" 20 "General skill triage is assigned to the leader"
general_state=""
for _ in $(seq 1 40); do
  general_state=$(live_snapshot_value '(function () { var task = Object.values(output.state.subtasks).filter(function (t) { return t.instruction.indexOf("general-triage-check") >= 0 }).pop(); return task ? task.state + ":" + ((task.skillGrants || []).length > 0) + ":" + (task.skillGrants || []).join(",") : "missing" })()')
  [[ "$general_state" == '"working:true:ensemble-live-skill-general"' ]] && break
  sleep 0.25
done
[[ "$general_state" == '"working:true:ensemble-live-skill-general"' ]] || live_fail "General triage work row missed the leader/triage/grant (got $general_state)"
leader_session=$(live_snapshot_value "(function () { var ws = Object.values(output.state.workspaces)[0]; var binding = Object.values(output.state.bindings).filter(function (b) { return b.workspaceID === ws.id && b.agentID === \"$fake_id\" }).pop(); return binding ? binding.sessionID : \"missing\" })()" | tr -d '"')
[[ -n "$leader_session" && "$leader_session" != "missing" ]] || live_fail "leader native session binding missing for the grant probe"
granted_live=0
for _ in $(seq 1 40); do
  permissions=$(live_session_permissions "$leader_session" 2>/dev/null || true)
  [[ "$permissions" == *"skill:ensemble-live-skill-general:allow"* ]] && { granted_live=1; break; }
  sleep 0.2
done
[[ "$granted_live" == "1" ]] || live_fail "leader never received the one-run General skill grant (saw ${permissions:-no permissions})"
general_task_id=$(live_snapshot_value '(function () { var task = Object.values(output.state.subtasks).filter(function (t) { return t.instruction.indexOf("general-triage-check") >= 0 }).pop(); return task ? task.id : "missing" })()' | tr -d '"')
[[ "$general_task_id" != "missing" ]] || live_fail "General triage work row lost its id"
general_replied=""
for _ in $(seq 1 80); do
  general_replied=$(live_snapshot_value "(function () { var task = output.state.subtasks[\"$general_task_id\"]; return task ? task.state : \"missing\" })()")
  [[ "$general_replied" == '"replied"' ]] && break
  sleep 0.5
done
[[ "$general_replied" == '"replied"' ]] || live_fail "General triage turn did not reply (got $general_replied)"
restored_live=0
for _ in $(seq 1 40); do
  permissions=$(live_session_permissions "$leader_session" 2>/dev/null || true)
  if [[ "$permissions" == *"skill:*:deny"* && "$permissions" != *"ensemble-live-skill-general:allow"* ]]; then restored_live=1; break; fi
  sleep 0.2
done
[[ "$restored_live" == "1" ]] || live_fail "leader grant was not restored after the turn (saw ${permissions:-no permissions})"
live_log "ticket #103 leader triage grant issued for one run and restored"

# Triage rows cannot be delegated from; the leader creates a fresh follow-up.
triage_delegate=$(live_invoke "task.delegate" "{\"workspaceID\":\"$ws_id\",\"parentID\":\"$general_task_id\",\"assigneeID\":\"$helper_id\",\"title\":\"Delegated triage\",\"instruction\":\"Take over triage.\"}")
[[ "$triage_delegate" == *'"code":"triage_no_delegate"'* ]] || live_fail "delegation from a triage row was not refused (got $triage_delegate)"
# The leader's follow-up delegation carries a self-authored instruction and no
# host skill grant; the delegatee runs it as an ordinary work row.
guided_instruction='Apply the general-skill guidance to the release notes and return a short source list.'
live_invoke "task.delegate" "{\"workspaceID\":\"$ws_id\",\"assigneeID\":\"$helper_id\",\"title\":\"Guided follow-up\",\"instruction\":\"$guided_instruction\"}" >/dev/null
live_require_text "$LIVE_TUI_SESSION" "→ Assigned to \$Helper: Guided follow-up" 20 "the leader guidance reaches the delegatee as ordinary work"
guided_state=""
for _ in $(seq 1 60); do
  guided_state=$(live_snapshot_value '(function () { var task = Object.values(output.state.subtasks).filter(function (t) { return t.instruction.indexOf("Apply the general-skill guidance") >= 0 }).pop(); return task ? task.state + ":" + ((task.skillGrants || []).length > 0) + ":" + ((task.skillGrants || []).length) : "missing" })()')
  [[ "$guided_state" == '"replied:false:0"' ]] && break
  sleep 0.5
done
[[ "$guided_state" == '"replied:false:0"' ]] || live_fail "delegatee work row carried a host grant or did not reply (got $guided_state)"
guided_exact=$(live_snapshot_value '(function () { var task = Object.values(output.state.subtasks).filter(function (t) { return t.instruction.indexOf("Apply the general-skill guidance") >= 0 }).pop(); return task ? task.instruction : "missing" })()')
[[ "$guided_exact" == "\"$guided_instruction\"" ]] || live_fail "delegatee lost the leader's self-authored instruction (got $guided_exact)"
live_log "ticket #103 leader delegation delivered guidance without a delegatee grant"

# A message-start skill owned outside the leader opens the owner picker and
# keeps the exact user text after the owner is chosen.
owner_text='/ensemble-live-skill-helper owner-picker-check'
live_key "$LIVE_TUI_SESSION" C-g
live_key "$LIVE_TUI_SESSION" "i"
live_require_text "$LIVE_TUI_SESSION" "COMPOSER" 10 "composer focus for the owner picker"
live_type "$LIVE_TUI_SESSION" "$owner_text"
live_key "$LIVE_TUI_SESSION" Escape
sleep 0.3
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "║ Owner" 30 "the owner picker opens for the message-start skill"
live_key "$LIVE_TUI_SESSION" Enter
live_require_joined_text "$LIVE_TUI_SESSION" "→ Assigned to \$Helper: /ensemble-live-skill-helper" 30 "the chosen owner receives the message-start skill"
owner_exact=""
for _ in $(seq 1 40); do
  owner_exact=$(live_snapshot_value '(function () { var task = Object.values(output.state.subtasks).filter(function (t) { return t.instruction.indexOf("owner-picker-check") >= 0 }).pop(); return task ? task.instruction + "|" + task.assigneeID : "missing" })()')
  [[ "$owner_exact" == "\"$owner_text|$helper_id\"" ]] && break
  sleep 0.25
done
[[ "$owner_exact" == "\"$owner_text|$helper_id\"" ]] || live_fail "owner picker rewrote or misrouted the text (got $owner_exact)"
live_log "ticket #103 owner picker routed the message-start skill without rewriting the text"

# A General skill under a non-leader mention is rejected before appending.
live_key "$LIVE_TUI_SESSION" C-g
live_key "$LIVE_TUI_SESSION" "i"
live_require_text "$LIVE_TUI_SESSION" "COMPOSER" 10 "composer focus for the General rejection"
live_type "$LIVE_TUI_SESSION" "!Helper /ensemble-live-skill-general nonleader-general-check"
live_key "$LIVE_TUI_SESSION" Escape
sleep 0.3
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Skill /ensemble-live-skill-general is General, so it routes to \$FakeAgent for leader triage." 10 "the General rejection names the leader and the fix"
live_require_text "$LIVE_TUI_SESSION" "!Helper /ensemble-live-skill-general nonleader-" 10 "the General rejection keeps the draft prefix"
live_require_text "$LIVE_TUI_SESSION" "general-check" 10 "the General rejection keeps the wrapped draft suffix"
clear_composer_text
nonleader_tasks=$(live_snapshot_value 'Object.values(output.state.subtasks).filter(function (t) { return t.instruction.indexOf("nonleader-general-check") >= 0 }).length')
[[ "$nonleader_tasks" == "0" ]] || live_fail "General under a non-leader mention created work (got $nonleader_tasks rows)"
live_log "ticket #103 non-leader General mention rejected atomically"

# Direct conversations reject a General skill with a workspace-chat pointer.
direct_general=$(live_invoke "chat.send" "{\"agentID\":\"$helper_id\",\"workspaceID\":\"$ws_id\",\"text\":\"/ensemble-live-skill-general direct-check\"}")
[[ "$direct_general" == *'"code":"general_skill_direct"'* ]] || live_fail "Direct General skill was not rejected (got $direct_general)"
[[ "$direct_general" == *"workspace group chat"* ]] || live_fail "Direct General rejection did not point at the workspace chat (got $direct_general)"
live_log "ticket #103 Direct General skill rejection pointed at the workspace group chat"

# Init stays solo-only even though its palette row is a General skill.
live_key "$LIVE_TUI_SESSION" C-g
live_key "$LIVE_TUI_SESSION" "i"
live_require_text "$LIVE_TUI_SESSION" "COMPOSER" 10 "composer focus for init solo-only"
live_type "$LIVE_TUI_SESSION" "/init extra"
live_key "$LIVE_TUI_SESSION" Escape
sleep 0.3
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Init is solo-only." 10 "init rejects a mixed composer line"
# Ticket #123/#127: a rejected composer line keeps its draft and uses one
# feedback channel — the statusline message plus the one-shot border. No app
# toast repeats the same error.
live_assert_count "$LIVE_TUI_SESSION" "Init is solo-only." 1 "composer rejection feedback appears once"
live_assert_text "$LIVE_TUI_SESSION" "/init extra" "composer rejection keeps the draft"
clear_composer_text
live_log "ticket #103 init General row remains solo-only with single-channel validation"

# v7 Work group lifecycle (ticket #136, final verification #143): two
# overlapping commands stay independent, each group clears as one unit, and
# cancellation emits one canonical terminal event. The size matrix covers the
# same lifecycle at constrained geometries; this block proves the default
# fake surface and the terminal event.
#
# Earlier probes leave a completion batch and queued turns active. Settle
# them first so the header assertions observe only this block's groups.
no_work_header() {
  ! live_capture "$LIVE_TUI_SESSION" | grep -Eq 'WORK ACTIVE │ [0-9]+ groups?'
}
settle_previous_work() {
  local ids id
  local -a id_list=()
  ids=$(live_snapshot_value 'Object.values(output.state.subtasks).filter(function (t) { return t.state !== "replied" }).map(function (t) { return t.id }).join(",")' | tr -d '"')
  [[ -n "$ids" && "$ids" != "null" ]] || return 0
  IFS=',' read -r -a id_list <<<"$ids"
  for id in "${id_list[@]}"; do
    live_invoke "task.cancel" "{\"id\":\"$id\"}" >/dev/null || true
  done
}
clear_composer_text
live_key "$LIVE_TUI_SESSION" C-g
live_key "$LIVE_TUI_SESSION" "w"
live_require_text "$LIVE_TUI_SESSION" "#LiveSite" 20 "group surface for the v7 lifecycle probe"
settle_previous_work
live_wait_for 20 "earlier scenario work cleared" no_work_header \
  || live_fail "earlier scenario work did not clear before the v7 lifecycle probe"
v7_one_title="v7-group-one fake-queue-hold-long"
v7_two_title="v7-group-two fake-queue-hold-long"
live_invoke "message.send" "{\"workspaceID\":\"$ws_id\",\"text\":\"$v7_one_title\",\"recipientIDs\":[\"$fake_id\"]}" >/dev/null
live_require_text "$LIVE_TUI_SESSION" "WORK ACTIVE │ 1 group · 1 active · 0 done" 20 "first v7 group is visible"
live_require_text "$LIVE_TUI_SESSION" "v7-group-one" 20 "first v7 group card is visible"
live_invoke "message.send" "{\"workspaceID\":\"$ws_id\",\"text\":\"$v7_two_title\",\"recipientIDs\":[\"$fake_id\"]}" >/dev/null
live_require_text "$LIVE_TUI_SESSION" "WORK ACTIVE │ 2 groups · 2 active · 0 done" 20 "second v7 group appends without replacing the first"
live_require_text "$LIVE_TUI_SESSION" "GROUP 1 · 1 active · 0 done" 20 "first v7 group label"
live_require_text "$LIVE_TUI_SESSION" "GROUP 2 · 1 active · 0 done" 20 "second v7 group label"
live_require_text "$LIVE_TUI_SESSION" "v7-group-two" 20 "second v7 group card is visible"
v7_first_id=$(live_snapshot_value "Object.values(output.state.subtasks).filter(function (t) { return t.title === \"$v7_one_title\" })[0]?.id" | tr -d '"')
[[ -n "$v7_first_id" && "$v7_first_id" != "null" ]] || live_fail "first v7 group task id is missing"
live_invoke "task.cancel" "{\"id\":\"$v7_first_id\"}" >/dev/null
# Ticket #172: a terminal group leaves ACTIVE immediately (no hold) and is
# retained in HISTORY. The surviving active group renumbers to GROUP 1.
live_require_text "$LIVE_TUI_SESSION" "WORK ACTIVE │ 1 group · 1 active · 0 done" 20 "cancelled v7 group leaves ACTIVE"
live_assert_absence "$LIVE_TUI_SESSION" "GROUP 2 · 1 active" "the surviving active group renumbers to GROUP 1"
live_require_text "$LIVE_TUI_SESSION" "v7-group-two" 20 "second v7 group survives the first group's removal"
live_require_text "$LIVE_TUI_SESSION" "⊘ $v7_one_title cancelled" 15 "cancelled v7 task emits one terminal event"
live_assert_count "$LIVE_TUI_SESSION" "⊘ $v7_one_title cancelled" 1 "cancelled v7 terminal event appears exactly once"
live_assert_absence "$LIVE_TUI_SESSION" "Subtask failed" "no duplicate generic failure line for cancelled work"
live_focus_work
live_key "$LIVE_TUI_SESSION" "f"
live_require_text "$LIVE_TUI_SESSION" "WORK HISTORY │" 10 "cancelled group moves to HISTORY"
live_require_text "$LIVE_TUI_SESSION" "v7-group-one" 10 "cancelled group card is retained in HISTORY"
live_require_text "$LIVE_TUI_SESSION" "CANCELLED" 10 "cancelled card keeps its explicit state"
live_key "$LIVE_TUI_SESSION" "f"
live_require_text "$LIVE_TUI_SESSION" "WORK ACTIVE │" 10 "history toggled back to ACTIVE for the next group"
live_focus_chat "$LIVE_TUI_SESSION"
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Group chat" 10 "pane selection returns to the transcript after the history check"
v7_second_id=$(live_snapshot_value "Object.values(output.state.subtasks).filter(function (t) { return t.title === \"$v7_two_title\" })[0]?.id" | tr -d '"')
[[ -n "$v7_second_id" && "$v7_second_id" != "null" ]] || live_fail "second v7 group task id is missing"
live_invoke "task.cancel" "{\"id\":\"$v7_second_id\"}" >/dev/null
live_wait_for 20 "v7 groups cleared" no_work_header \
  || live_fail "second v7 group did not leave ACTIVE"
live_require_text "$LIVE_TUI_SESSION" "⊘ $v7_two_title cancelled" 15 "second cancelled v7 task emits its terminal event"
live_assert_count "$LIVE_TUI_SESSION" "⊘ $v7_two_title cancelled" 1 "second cancelled v7 terminal event appears exactly once"
live_log "v7 two-group append, ACTIVE/HISTORY split, and canonical cancellation events verified"

# v7 needs-you (ticket #136/#143): the fake provider emits one native
# ask_person tool call, so the approval is real, durable, and linked to the
# running task. The group keeps the NEEDS YOU treatment beyond the 1.2 s hold
# window; resolving the approval releases the task and the group then clears
# normally.
live_invoke "message.send" "{\"workspaceID\":\"$ws_id\",\"text\":\"fake-ask-person\",\"recipientIDs\":[\"$fake_id\"]}" >/dev/null
live_require_joined_text "$LIVE_TUI_SESSION" "Approval needed: Which release channel should this task use?" 30 "ask_person reaches the approvals surface"
live_require_text "$LIVE_TUI_SESSION" "NEEDS YOU" 30 "needs-you card treatment"
live_require_text "$LIVE_TUI_SESSION" "WORK ACTIVE │ 1 group · 1 active · 0 done" 20 "needs-you group is visible"
live_require_text "$LIVE_TUI_SESSION" "APPROVALS 1 pending │ v open" 20 "approvals are a small summary under Work"
sleep 2.2
live_assert_text "$LIVE_TUI_SESSION" "NEEDS YOU" "needs-you persists beyond the shared hold window"
live_assert_text "$LIVE_TUI_SESSION" "WORK ACTIVE │ 1 group · 1 active · 0 done" "needs-you group stays mounted"
# Ticket #185: v opens the full-height inbox over Work; Enter opens the
# decision; the ask answer prompt then resolves. Esc returns to split.
live_focus_work
live_key "$LIVE_TUI_SESSION" "v"
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Approvals" 10 "v opens full approvals"
live_require_text "$LIVE_TUI_SESSION" "APPROVALS 1 pending │ 1/1" 10 "the full inbox names its position and grammar"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "FakeAgent needs your input" 10 "Enter opens the approval decision"
live_require_text "$LIVE_TUI_SESSION" "Answer" 10 "the ask_person decision offers Answer"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Your answer" 10 "Answer opens the answer prompt"
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Dialog" 10 "the answer prompt opens in field Normal"
live_key "$LIVE_TUI_SESSION" "i"
live_require_text "$LIVE_TUI_SESSION" "INSERT  │ Dialog" 10 "i enters the answer prompt field"
sleep 0.3
live_type "$LIVE_TUI_SESSION" "Use the stable channel."
live_require_text "$LIVE_TUI_SESSION" "Use the stable channel." 10 "the answer reached the prompt field"
live_key "$LIVE_TUI_SESSION" Enter
v7_ask_replied=""
for _ in $(seq 1 80); do
  v7_ask_replied=$(live_snapshot_value "(function () { var task = Object.values(output.state.subtasks).filter(function (t) { return t.title === \"fake-ask-person\" })[0]; return task ? task.state + \":\" + (task.approvalID || \"cleared\") : \"missing\" })()")
  [[ "$v7_ask_replied" == '"replied:cleared"' ]] && break
  sleep 0.5
done
[[ "$v7_ask_replied" == '"replied:cleared"' ]] || live_fail "needs-you task did not reply after its approval resolved (got $v7_ask_replied)"
# The answer prompt can leave the global mode in Insert and may close full
# approvals as the last pending row resolves. Settle through the shared Esc
# ladder until pane selection owns the keyboard.
live_escape_to_pane_select "$LIVE_TUI_SESSION"
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Work list" 10 "Esc returns full approvals to the split Work view"
live_require_absence "$LIVE_TUI_SESSION" "NEEDS YOU" 20 "needs-you marker clears after the decision"
live_require_absence "$LIVE_TUI_SESSION" "APPROVALS 1 pending" 10 "the small approval summary leaves after the decision"
live_wait_for 20 "needs-you group cleared" no_work_header \
  || live_fail "needs-you group did not leave ACTIVE after resolution"
live_assert_absence "$LIVE_TUI_SESSION" "APPROVALS 1 pending" "small approvals disappear with the last decision"
live_focus_work
live_key "$LIVE_TUI_SESSION" "f"
live_require_text "$LIVE_TUI_SESSION" "WORK HISTORY │" 10 "resolved needs-you work moves to HISTORY"
live_require_text "$LIVE_TUI_SESSION" "fake-ask-person" 10 "resolved work card is retained"
live_require_text "$LIVE_TUI_SESSION" "REPLIED" 10 "resolved work ends REPLIED"
live_key "$LIVE_TUI_SESSION" "f"
live_focus_chat "$LIVE_TUI_SESSION"
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Group chat" 10 "pane selection returns to chat after the inline approval"
live_log "v7 needs-you approval persisted and resolved through the sticky Work section"

# v7 failure event (ticket #136/#143): rejecting the ask fails the linked task
# with one canonical failure row. This proves the live failed transition, the
# FAILED card treatment, and the absence of the old duplicate generic line.
live_invoke "message.send" "{\"workspaceID\":\"$ws_id\",\"text\":\"fake-ask-person-reject\",\"recipientIDs\":[\"$fake_id\"]}" >/dev/null
# The FakeAgent session may still be settling the previous ask/compaction, so
# the rejection task is queued behind it. Wait for the new task to appear
# before matching the needs-you handoff; the previous approval copy can still
# be in the transcript.
live_require_text "$LIVE_TUI_SESSION" "fake-ask-person-reject" 90 "rejected ask task is visible"
live_require_joined_text "$LIVE_TUI_SESSION" "Approval needed: Which release channel should this task use?" 90 "rejected ask reaches the approvals surface"
live_require_text "$LIVE_TUI_SESSION" "NEEDS YOU" 90 "rejected ask starts as needs-you"
live_focus_work
live_key "$LIVE_TUI_SESSION" "v"
live_require_text "$LIVE_TUI_SESSION" "APPROVALS 1 pending │ 1/1" 10 "rejected ask is in the full inbox"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "FakeAgent needs your input" 10 "rejecting ask opens its decision"
live_key "$LIVE_TUI_SESSION" Down
live_key "$LIVE_TUI_SESSION" Enter
live_key "$LIVE_TUI_SESSION" Escape
# Ticket #170: rejecting an ask is an explicit controlled stop, not a native
# execution error; the card and event read CANCELLED, never FAILED.
live_require_text "$LIVE_TUI_SESSION" "⊘ fake-ask-person-reject cancelled" 20 "rejected ask emits one controlled-stop event"
live_assert_count "$LIVE_TUI_SESSION" "⊘ fake-ask-person-reject cancelled" 1 "controlled-stop event appears exactly once"
live_assert_absence "$LIVE_TUI_SESSION" "✕ FakeAgent failed: User rejected the request." "user rejection is not reported as a native failure"
live_assert_absence "$LIVE_TUI_SESSION" "Subtask failed" "no duplicate generic failure line for controlled work"
live_require_absence "$LIVE_TUI_SESSION" "NEEDS YOU" 10 "rejected ask clears its needs-you state"
live_wait_for 20 "controlled-stop group left ACTIVE" no_work_header \
  || live_fail "controlled-stop group did not leave ACTIVE"
live_focus_work
live_key "$LIVE_TUI_SESSION" "f"
live_require_text "$LIVE_TUI_SESSION" "WORK HISTORY │" 10 "controlled-stop work moves to HISTORY"
live_require_text "$LIVE_TUI_SESSION" "fake-ask-person-reject" 10 "controlled-stop card is retained in HISTORY"
live_require_text "$LIVE_TUI_SESSION" "CANCELLED" 10 "controlled-stop card treatment"
live_key "$LIVE_TUI_SESSION" "f"
live_focus_chat "$LIVE_TUI_SESSION"
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Group chat" 10 "pane selection returns to chat after the controlled-stop check"
live_log "v7 controlled-stop transition, CANCELLED history card, and single terminal event verified live"

# Genuine native failure: the fake provider returns a 500 before any text. This
# is the only path that may mark FAILED; a controlled stop above stays
# CANCELLED.
live_invoke "message.send" "{\"workspaceID\":\"$ws_id\",\"text\":\"fake-native-error\",\"recipientIDs\":[\"$fake_id\"]}" >/dev/null
# Native failures retry inside MAX_ATTEMPTS with 5/15/30/60 s backoff, so a
# genuine terminal FAILED can take about two minutes.
live_require_text "$LIVE_TUI_SESSION" "✕ FakeAgent failed:" 180 "native provider error emits a failure event"
live_assert_count "$LIVE_TUI_SESSION" "✕ FakeAgent failed:" 1 "the native failure is the only failure event"
live_require_no_active_work "$LIVE_TUI_SESSION" 30 "native failure leaves ACTIVE"
live_focus_work
live_key "$LIVE_TUI_SESSION" "f"
live_require_text "$LIVE_TUI_SESSION" "WORK HISTORY │" 10 "native failure moves to HISTORY"
live_require_text "$LIVE_TUI_SESSION" "fake-native-error" 10 "native failure card is retained"
live_require_text "$LIVE_TUI_SESSION" "FAILED" 10 "native failure card treatment"
live_key "$LIVE_TUI_SESSION" "f"
live_focus_chat "$LIVE_TUI_SESSION"
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Group chat" 10 "pane selection returns to chat after the native failure check"
live_log "genuine native failure emits FAILED while a controlled stop stays CANCELLED"

# ---------------------------------------------------------------------------
# Ticket #171/#174/#166: split rail, durable collapse, native picker, member
# alignment. Quiet is a workspace member with no native binding, so the picker
# can prove the explicit missing-session message.
# ---------------------------------------------------------------------------
live_invoke "agent.create" '{"name":"Quiet","title":"Unbound"}' >/dev/null
live_wait_for "$LIVE_STEP_TIMEOUT" "Quiet in the snapshot" live_snapshot_has_agent_named "Quiet" \
  || live_fail "Quiet fixture agent was not created"
quiet_id=$(live_snapshot_value 'Object.values(output.state.agents).find(function (agent) { return agent.name === "Quiet" }).id' | tr -d '"')
[[ -n "$quiet_id" ]] || live_fail "Quiet fixture agent id is missing"
live_invoke "workspace.update" "{\"id\":\"$ws_id\",\"memberIDs\":[\"$fake_id\",\"$helper_id\",\"$scout_id\",\"$quiet_id\"]}" >/dev/null
for _ in $(seq 1 40); do
  member_count=$(live_snapshot_value "Object.values(output.state.workspaces)[0].memberIDs.length")
  [[ "$member_count" == "4" ]] && break
  sleep 0.25
done
[[ "$member_count" == "4" ]] || live_fail "Quiet was not added to the workspace (got $member_count members)"

live_escape_to_pane_select "$LIVE_TUI_SESSION"
live_key "$LIVE_TUI_SESSION" "h"
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Agents" 10 "Agents pane selected for the split-pane check"
live_assert_text "$LIVE_TUI_SESSION" "h/l column" "h selects the pane before roster interaction"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "AGENTS (4)" 10 "Agents pane counts the roster"
live_require_text "$LIVE_TUI_SESSION" "WORKSPACES (1)" 10 "Workspaces pane is a separate section"
live_require_text "$LIVE_TUI_SESSION" "▾ #LiveSite (4)" 10 "agent group header names the workspace and count"
live_require_text "$LIVE_TUI_SESSION" "FakeAgent │ LEADER" 10 "leader label stays on the agent name row"
# The agent subline is the role title only; the workspace name lives on the
# group header, not under every member.
rail_pane=$(live_capture "$LIVE_TUI_SESSION")
awk '/FakeAgent/ && /LEADER/ { getline; if ($0 ~ /├ Engineering/ && $0 !~ /#LiveSite/) ok = 1 } END { exit !ok }' <<<"$rail_pane" \
  || live_fail "agent subline is not role-only under the group header"
if grep -qE '├ .*#LiveSite' <<<"$rail_pane"; then
  live_fail "workspace name is repeated on an agent subline"
fi
# z on the group header collapses the group; a collapsed header keeps its count.
live_key "$LIVE_TUI_SESSION" "g"
live_key "$LIVE_TUI_SESSION" "g"
sleep 0.2
live_key "$LIVE_TUI_SESSION" "z"
live_require_text "$LIVE_TUI_SESSION" "▸ #LiveSite (4)" 10 "z collapses the workspace group"
live_assert_absence "$LIVE_TUI_SESSION" "├ Engineering" "collapsed group hides agent sublines"
sleep 1.2

# Durability: collapse state survives a TUI restart.
"$LIVE_TMUX_BIN" kill-session -t "$LIVE_TUI_SESSION" 2>/dev/null || true
live_start_tui
live_wait_for_native_tui
live_open_ensemble
live_require_text "$LIVE_TUI_SESSION" "ENSEMBLE" 15 "Ensemble page after the collapse restart"
live_require_text "$LIVE_TUI_SESSION" "▸ #LiveSite (4)" 20 "collapsed rail group persisted across restart"
live_focus_chat "$LIVE_TUI_SESSION"
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Group chat" 10 "l selects the restored transcript"
live_focus_agents_interact "$LIVE_TUI_SESSION"
live_key "$LIVE_TUI_SESSION" "g"
live_key "$LIVE_TUI_SESSION" "g"
sleep 0.2
live_key "$LIVE_TUI_SESSION" "z"
live_require_text "$LIVE_TUI_SESSION" "▾ #LiveSite (4)" 10 "z expands the persisted group"
live_require_text "$LIVE_TUI_SESSION" "├ Engineering" 10 "expanded group restores the role subline"

# Native-session picker: group chat `o` asks which member. Quiet has no
# binding, so Enter shows the explicit message instead of navigating.
live_focus_chat_interact "$LIVE_TUI_SESSION"
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Group chat" 10 "chat focus before the native picker"
live_key "$LIVE_TUI_SESSION" "o"
live_require_text "$LIVE_TUI_SESSION" "Native${NBSP}session" 10 "group chat o opens the native picker"
live_require_text "$LIVE_TUI_SESSION" "Engineering" 10 "picker rows name the member role"
live_require_text "$LIVE_TUI_SESSION" "leader" 10 "picker rows name the leader"
live_require_text "$LIVE_TUI_SESSION" "idle" 10 "picker rows name the busy state"
live_key "$LIVE_TUI_SESSION" "/"
live_require_text "$LIVE_TUI_SESSION" "type to filter" 10 "picker filter grammar is available"
live_type "$LIVE_TUI_SESSION" "Quiet"
live_require_text "$LIVE_TUI_SESSION" "1${NBSP}matches" 10 "picker filter narrows to one member"
live_require_text "$LIVE_TUI_SESSION" "Unbound" 10 "picker filter shows the unbound member detail"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "j/k move" 10 "Enter commits the picker filter"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "No native session for Quiet yet" 10 "missing native binding is explicit"
# A bound member routes to its native session; F2 returns to Ensemble.
live_key "$LIVE_TUI_SESSION" "o"
live_require_text "$LIVE_TUI_SESSION" "Native${NBSP}session" 10 "picker reopens for the bound member"
live_key "$LIVE_TUI_SESSION" "/"
live_type "$LIVE_TUI_SESSION" "FakeAgent"
live_require_text "$LIVE_TUI_SESSION" "1${NBSP}matches" 10 "picker filter narrows to the bound member"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "j/k move" 10 "Enter commits the bound-member filter"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "ctrl+p commands" 15 "picker Enter routes to the member native session"
live_key "$LIVE_TUI_SESSION" F2
live_require_text "$LIVE_TUI_SESSION" "ENSEMBLE" 15 "F2 returns from the member native session"
live_focus_chat_interact "$LIVE_TUI_SESSION"
live_key "$LIVE_TUI_SESSION" "w"
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Group chat" 10 "group surface restored after the native picker"
live_focus_chat_interact "$LIVE_TUI_SESSION"

# Member-column alignment: every wizard row puts its `│` separator in the same
# column, even though the member names have different lengths.
live_key "$LIVE_TUI_SESSION" "n"
live_require_text "$LIVE_TUI_SESSION" "Workspace directory" 10 "workspace wizard for alignment"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Workspace name" 10 "workspace name step for alignment"
live_key "$LIVE_TUI_SESSION" "i"
live_type "$LIVE_TUI_SESSION" "AlignProbe"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Workspace members" 10 "members step for alignment"
live_require_text "$LIVE_TUI_SESSION" "Engineering" 10 "member rows carry the role cell"
wizard_pane=$(live_capture "$LIVE_TUI_SESSION")
awk '
  /\[[ x]\]/ {
    line = $0
    sub(/^.*\] /, "", line)
    pos = index(line, "│")
    if (pos == 0) next
    rows++
    if (first == 0) first = pos
    else if (pos != first) bad = 1
  }
  END { exit !(rows >= 2 && !bad) }
' <<<"$wizard_pane" || live_fail "member wizard separators do not align in one column"
# The list step keeps the Insert arrival mode; the first Esc returns to field
# Normal, the second asks before discarding the typed name.
live_require_text "$LIVE_TUI_SESSION" "INSERT  │ Wizard" 10 "alignment member step keeps the arrival mode"
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Wizard" 10 "first Esc returns the alignment wizard to Normal"
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "discard draft?" 10 "alignment wizard cancels through the dirty confirm"
live_key "$LIVE_TUI_SESSION" "y"
live_require_absence "$LIVE_TUI_SESSION" "Agent name" 10 "alignment wizard dismissed"
live_log "split rail, durable collapse, native picker, and member alignment verified live"

# ---------------------------------------------------------------------------
# Ticket #167/#175/#176: bounded composer file references and the cached index.
# ---------------------------------------------------------------------------
if [[ "$FD_AVAILABLE" == "1" ]]; then
  [[ "$(git -C "$LIVE_PROJECT" status --porcelain handover.md)" == "?? handover.md" ]] \
    || live_fail "handover.md is not untracked before the file-reference probe"
  live_key "$LIVE_TUI_SESSION" "i"
  live_require_text "$LIVE_TUI_SESSION" "COMPOSER" 10 "composer focus for file references"
  live_type "$LIVE_TUI_SESSION" "@handover"
  live_require_text "$LIVE_TUI_SESSION" "@ files" 10 "file palette opens on the bounded token"
  live_require_text "$LIVE_TUI_SESSION" "handover.md" 10 "untracked file appears in the palette"
  live_key "$LIVE_TUI_SESSION" Enter
  live_require_absence "$LIVE_TUI_SESSION" "@ files" 10 "selection closes the file palette"
  live_type "$LIVE_TUI_SESSION" "the git log"
  live_require_text "$LIVE_TUI_SESSION" "@handover.md the git log" 10 "sentence after @file is preserved"

  clear_composer_text
  live_type "$LIVE_TUI_SESSION" "@docs/my\\ notes"
  live_require_text "$LIVE_TUI_SESSION" "docs/my notes" 10 "escaped space is part of the path query"
  live_require_text "$LIVE_TUI_SESSION" "docs/my notes.md" 10 "spaced file appears in the palette"
  live_key "$LIVE_TUI_SESSION" Enter
  live_require_text "$LIVE_TUI_SESSION" '@docs/my\ notes.md' 10 "selection inserts the escaped spaced path"

  clear_composer_text
  live_type "$LIVE_TUI_SESSION" "before @hand after"
  for _ in $(seq 1 6); do live_key "$LIVE_TUI_SESSION" Left; done
  # Typing at the mid-token cursor proves the token is bounded by the cursor,
  # not the end of the line; Backspace restores the query without moving the
  # cursor outside the token.
  live_key "$LIVE_TUI_SESSION" "o"
  live_require_text "$LIVE_TUI_SESSION" "@ files │ hando" 10 "typing inside the token keeps the bounded query"
  live_key "$LIVE_TUI_SESSION" BSpace
  live_require_text "$LIVE_TUI_SESSION" "@ files │ hand" 10 "the mid-token query follows the edit"
  live_key "$LIVE_TUI_SESSION" Enter
  live_require_text "$LIVE_TUI_SESSION" "before @handover.md after" 10 "selection preserves the suffix"

  # Cached index: filter keystrokes read the cache; no new fd discovery per key.
  clear_composer_text
  live_type "$LIVE_TUI_SESSION" "@"
  live_require_text "$LIVE_TUI_SESSION" "@ files" 10 "palette warmed for the index probe"
  sleep 0.8
  fd_before=$(wc -l <"$LIVE_BASE/fd-invocations" 2>/dev/null || echo 0)
  live_type "$LIVE_TUI_SESSION" "hand"
  live_type "$LIVE_TUI_SESSION" "over"
  live_require_text "$LIVE_TUI_SESSION" "handover.md" 10 "cache-backed filter still finds the file"
  sleep 0.8
  fd_after=$(wc -l <"$LIVE_BASE/fd-invocations" 2>/dev/null || echo 0)
  [[ "$fd_before" == "$fd_after" ]] \
    || live_fail "filtering spawned fd per keystroke ($fd_before -> $fd_after)"
  live_key "$LIVE_TUI_SESSION" Escape

  # The same escaped path reaches the server parser and the assignment line.
  clear_composer_text
  live_type "$LIVE_TUI_SESSION" '@docs/my\ notes.md file-reference-check'
  live_key "$LIVE_TUI_SESSION" Enter
  live_require_joined_text "$LIVE_TUI_SESSION" '→ Assigned to $FakeAgent: @docs/my\ notes.md file-reference-check' 20 "escaped spaced reference survives the server parser"
  # The group session still carries the long hold fixture in history, so this
  # final turn streams the 400-line fixture before it settles.
  live_require_no_active_work "$LIVE_TUI_SESSION" 60 "file-reference turn completes without a false failure"
  live_log "composer file references, suffix preservation, spaced paths, and cached index verified live"
else
  live_log "fd is unavailable; composer file-reference live checks skipped explicitly (unit tests cover the grammar)"
fi

# ---------------------------------------------------------------------------
# Ticket #186: pane select/interact matrix, per-pane colour contract, and the
# #183 column switches. Runs after the functional probes so the workspace has
# a stable transcript and every pane is populated.
# ---------------------------------------------------------------------------
settle_previous_work
live_wait_for 20 "previous work settled before the pane matrix" no_work_header \
  || live_fail "work did not settle before the pane matrix"
live_escape_to_pane_select "$LIVE_TUI_SESSION"
live_ensure_left_pane "$LIVE_TUI_SESSION"
live_ensure_right_pane "$LIVE_TUI_SESSION"
live_focus_work_interact "$LIVE_TUI_SESSION"
if live_capture "$LIVE_TUI_SESSION" | grep -qF "WORK HISTORY │"; then
  live_key "$LIVE_TUI_SESSION" "f"
fi
live_require_text "$LIVE_TUI_SESSION" "WORK ACTIVE │" 10 "ACTIVE Work view for the pane matrix"
live_focus_chat "$LIVE_TUI_SESSION"

# The top border row carries all three pane corners left to right. Exactly one
# pane is white at a time; the rest keep the subdued border.
assert_pane_borders() {
  local expected="$1" colors rail chat work
  colors=$(live_top_border_colors "$LIVE_TUI_SESSION")
  [[ -n "$colors" ]] || live_fail "could not read the pane top-border colours"
  IFS=',' read -r rail chat work <<<"$colors"
  [[ -n "$work" ]] || live_fail "expected three pane top borders (got $colors)"
  case "$expected" in
    agents)
      live_color_is_white "$rail" || live_fail "selected Agents rail border is not white (got $rail)"
      live_color_is_grey "$chat" || live_fail "unselected chat border is not grey (got $chat)"
      live_color_is_grey "$work" || live_fail "unselected Work border is not grey (got $work)"
      ;;
    workspaces)
      live_color_is_grey "$rail" || live_fail "unselected Agents border is not grey (got $rail)"
      live_color_is_grey "$chat" || live_fail "unselected chat border is not grey (got $chat)"
      live_color_is_grey "$work" || live_fail "unselected Work border is not grey (got $work)"
      ;;
    chat)
      live_color_is_grey "$rail" || live_fail "unselected rail border is not grey (got $rail)"
      live_color_is_white "$chat" || live_fail "selected chat border is not white (got $chat)"
      live_color_is_grey "$work" || live_fail "unselected Work border is not grey (got $work)"
      ;;
    work)
      live_color_is_grey "$rail" || live_fail "unselected rail border is not grey (got $rail)"
      live_color_is_grey "$chat" || live_fail "unselected chat border is not grey (got $chat)"
      live_color_is_white "$work" || live_fail "selected Work border is not white (got $work)"
      ;;
    approvals)
      live_color_is_grey "$rail" || live_fail "unselected rail border is not grey (got $rail)"
      live_color_is_grey "$chat" || live_fail "unselected chat border is not grey (got $chat)"
      live_color_is_grey "$work" || live_fail "split approvals left the Work border white (got $work)"
      ;;
    *) live_fail "unknown pane border expectation: $expected" ;;
  esac
}

assert_rail_section_border() {
  local section="$1" want="$2"
  live_assert_border_above "$LIVE_TUI_SESSION" "$section (" "$want" "$section section border"
}

# Chat interaction is white; Work stays muted. Chat Enter is transcript
# navigation, never composer focus.
live_focus_chat_interact "$LIVE_TUI_SESSION"
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Group chat" 10 "chat interaction for the colour matrix"
live_assert_text "$LIVE_TUI_SESSION" "j/k scroll" "chat interaction owns transcript navigation"
live_assert_absence "$LIVE_TUI_SESSION" "COMPOSER" "chat selection never steals composer focus"
live_assert_white_chat_text "$LIVE_TUI_SESSION" "#LiveSite" "focused chat heading"
live_assert_grey_text "$LIVE_TUI_SESSION" "WORK ACTIVE" "unfocused Work heading"
assert_pane_borders chat
live_key "$LIVE_TUI_SESSION" Escape
live_require_pane_select "$LIVE_TUI_SESSION" 10 "chat select mode"
assert_pane_borders chat

# h selects Agents; j moves to Workspaces; l returns to chat; l again selects
# Work. No movement enters a pane.
live_key "$LIVE_TUI_SESSION" "h"
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Agents" 10 "h selects Agents"
live_assert_text "$LIVE_TUI_SESSION" "h/l column" "h lands in select mode"
live_assert_white_text "$LIVE_TUI_SESSION" "AGENTS (" "focused Agents heading"
live_assert_grey_text "$LIVE_TUI_SESSION" "WORKSPACES (" "unfocused Workspaces heading"
assert_rail_section_border AGENTS white
assert_rail_section_border WORKSPACES grey
assert_pane_borders agents
live_key "$LIVE_TUI_SESSION" "j"
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Workspaces" 10 "j selects Workspaces"
live_assert_white_text "$LIVE_TUI_SESSION" "WORKSPACES (" "focused Workspaces heading"
live_assert_grey_text "$LIVE_TUI_SESSION" "AGENTS (" "unfocused Agents heading"
assert_rail_section_border AGENTS grey
assert_rail_section_border WORKSPACES white
assert_pane_borders workspaces
live_key "$LIVE_TUI_SESSION" "l"
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Group chat" 10 "l returns to chat selection"
live_key "$LIVE_TUI_SESSION" "l"
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Work list" 10 "l selects the Work pane"
live_assert_text "$LIVE_TUI_SESSION" "h/l column" "Work selection is not card interaction"
live_assert_white_text "$LIVE_TUI_SESSION" "WORK ACTIVE" "selected Work heading"
live_assert_grey_chat_text "$LIVE_TUI_SESSION" "#LiveSite" "unfocused chat heading"
assert_pane_borders work
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Work list" 10 "Enter enters the Work pane"
live_require_text "$LIVE_TUI_SESSION" "j/k cards" 10 "Work interaction owns its content grammar"
live_assert_absence "$LIVE_TUI_SESSION" "h/l column" "Work interaction is not pane selection"
sleep 0.25
live_key "$LIVE_TUI_SESSION" Escape
live_require_pane_select "$LIVE_TUI_SESSION" 10 "Esc returns Work to select mode"
live_key "$LIVE_TUI_SESSION" "h"
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Group chat" 10 "h returns to chat selection"
live_key "$LIVE_TUI_SESSION" "h"
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Agents" 10 "h from chat selects Agents first"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "enter open" 10 "Enter enters the Agents roster"
live_key "$LIVE_TUI_SESSION" Escape
live_require_pane_select "$LIVE_TUI_SESSION" 10 "Esc returns the roster to select mode"
live_log "pane select/interact transitions and per-pane white/grey headings and borders verified"

# Space b opens the which-key submenu; Space b l/r are the only column
# switches (F3 is retired). Closing a focused column returns to chat.
live_open_pane_prefix "$LIVE_TUI_SESSION"
live_require_text "$LIVE_TUI_SESSION" "Toggle the left pane" 10 "Space b lists the left toggle"
live_require_text "$LIVE_TUI_SESSION" "Toggle the right pane" 10 "Space b lists the right toggle"
live_key "$LIVE_TUI_SESSION" Escape
live_require_absence "$LIVE_TUI_SESSION" "Toggle the left pane" 10 "Esc cancels the pane prefix"

live_focus_agents_interact "$LIVE_TUI_SESSION"
live_toggle_pane_side "$LIVE_TUI_SESSION" l
live_require_absence "$LIVE_TUI_SESSION" "AGENTS (" 10 "Space b l closes the left pane"
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Group chat" 10 "closing focused Agents returns to chat selection"
live_assert_text "$LIVE_TUI_SESSION" "Message…" "chat reclaims the left pane width"
live_toggle_pane_side "$LIVE_TUI_SESSION" l
live_require_text "$LIVE_TUI_SESSION" "AGENTS (" 10 "Space b l reopens the left pane"
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Agents" 10 "reopening left selects Agents without entering"
live_assert_text "$LIVE_TUI_SESSION" "h/l column" "reopened Agents stays in select mode"

live_focus_work_interact "$LIVE_TUI_SESSION"
live_toggle_pane_side "$LIVE_TUI_SESSION" r
live_require_absence "$LIVE_TUI_SESSION" "WORK ACTIVE" 10 "Space b r closes the Work pane"
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Group chat" 10 "closing focused Work returns to chat selection"
live_toggle_pane_side "$LIVE_TUI_SESSION" r
live_require_text "$LIVE_TUI_SESSION" "WORK ACTIVE" 10 "Space b r reopens the Work pane"
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Work list" 10 "reopening right selects Work without entering cards"
live_assert_text "$LIVE_TUI_SESSION" "h/l column" "reopened Work stays in select mode"

# F3 must do nothing; Space b r is the only right-column switch.
live_toggle_pane_side "$LIVE_TUI_SESSION" r
live_require_absence "$LIVE_TUI_SESSION" "WORK ACTIVE" 10 "right column closed for the F3 probe"
live_key "$LIVE_TUI_SESSION" F3
sleep 0.5
live_assert_absence "$LIVE_TUI_SESSION" "WORK ACTIVE" "F3 no longer opens the Work pane"
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Group chat" 10 "F3 does not steal pane focus"
live_toggle_pane_side "$LIVE_TUI_SESSION" r
live_require_text "$LIVE_TUI_SESSION" "WORK ACTIVE" 10 "Space b r remains the right-column switch"

# Durable visibility: close both columns, restart the TUI, and prove the
# layout survived; reopening selects each column in select mode.
live_focus_chat "$LIVE_TUI_SESSION"
live_toggle_pane_side "$LIVE_TUI_SESSION" l
live_toggle_pane_side "$LIVE_TUI_SESSION" r
live_require_absence "$LIVE_TUI_SESSION" "AGENTS (" 10 "left column closed before restart"
live_require_absence "$LIVE_TUI_SESSION" "WORK ACTIVE" 10 "right column closed before restart"
"$LIVE_TMUX_BIN" kill-session -t "$LIVE_TUI_SESSION" 2>/dev/null || true
live_start_tui
live_wait_for_native_tui
live_open_ensemble
live_require_text "$LIVE_TUI_SESSION" "ENSEMBLE" 15 "Ensemble page after the pane-visibility restart"
live_require_text "$LIVE_TUI_SESSION" "#LiveSite" 20 "workspace surface after the pane-visibility restart"
live_require_absence "$LIVE_TUI_SESSION" "AGENTS (" 10 "closed left column stayed closed"
live_require_absence "$LIVE_TUI_SESSION" "WORK ACTIVE" 10 "closed right column stayed closed"
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Group chat" 10 "chat owns the narrowed shell after restart"
live_toggle_pane_side "$LIVE_TUI_SESSION" l
live_require_text "$LIVE_TUI_SESSION" "AGENTS (" 10 "left column reopened after restart"
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Agents" 10 "reopened left column selects Agents"
live_assert_text "$LIVE_TUI_SESSION" "h/l column" "reopened left column stays in select mode"
live_toggle_pane_side "$LIVE_TUI_SESSION" r
live_require_text "$LIVE_TUI_SESSION" "WORK ACTIVE" 10 "right column reopened after restart"
live_require_text "$LIVE_TUI_SESSION" "NORMAL  │ Work list" 10 "reopened right column selects Work"
live_assert_text "$LIVE_TUI_SESSION" "h/l column" "reopened right column stays in select mode"
live_log "Space b l/r toggles, F3 removal, focus recovery, and durable column visibility verified"

# ---------------------------------------------------------------------------
# Ticket #181/#186: one aggregate activity line, always in chat, including
# while the Work pane shares the row. No per-agent rows return.
# ---------------------------------------------------------------------------
live_focus_chat "$LIVE_TUI_SESSION"
live_invoke "message.send" "{\"workspaceID\":\"$ws_id\",\"text\":\"activity-hold fake-queue-hold-long\",\"recipientIDs\":[\"$fake_id\"]}" >/dev/null
live_require_active_work "$LIVE_TUI_SESSION" 15 "activity probe work mounts"
live_require_joined_single_text "$LIVE_TUI_SESSION" "Working…" 15 "one Working… line in chat"
live_assert_text "$LIVE_TUI_SESSION" "WORK ACTIVE │" "the activity summary remains while Work is open"
activity_joined=$(live_capture_chat_joined "$LIVE_TUI_SESSION")
if grep -qF "│ working…" <<<"$activity_joined"; then
  live_fail "per-agent activity row returned: $(grep -oF "│ working…" <<<"$activity_joined" | head -1)"
fi
if grep -qE '⠋ FakeAgent │' <<<"$activity_joined"; then
  live_fail "activity summary rendered a per-agent row"
fi
activity_id=$(live_snapshot_value "Object.values(output.state.subtasks).filter(function (t) { return t.title === \"activity-hold fake-queue-hold-long\" })[0]?.id" | tr -d '"')
[[ -n "$activity_id" && "$activity_id" != "null" ]] || live_fail "activity probe task id is missing"
live_invoke "task.cancel" "{\"id\":\"$activity_id\"}" >/dev/null
live_require_no_active_work "$LIVE_TUI_SESSION" 15 "activity probe work cleared"
live_require_absence "$LIVE_TUI_SESSION" "Working…" 10 "aggregate activity line unmounts when idle"

# Asking is the highest-priority aggregate segment for an in-flight peer turn.
live_key "$LIVE_TUI_SESSION" "i"
live_require_text "$LIVE_TUI_SESSION" "COMPOSER" 10 "composer focus for the asking summary"
live_type "$LIVE_TUI_SESSION" "\$FakeAgent activity-asking fake-queue-hold-long"
live_key "$LIVE_TUI_SESSION" Enter
live_require_joined_single_text "$LIVE_TUI_SESSION" "Asking \$FakeAgent…" 15 "one Asking… line in chat"
live_assert_text "$LIVE_TUI_SESSION" "WORK ACTIVE │" "asking summary remains while Work is open"
asking_id=$(live_snapshot_value "Object.values(output.state.subtasks).filter(function (t) { return t.workKind === \"turn\" && t.title.indexOf(\"activity-asking\") >= 0 })[0]?.id" | tr -d '"')
[[ -n "$asking_id" && "$asking_id" != "null" ]] || live_fail "asking probe task id is missing"
live_invoke "task.cancel" "{\"id\":\"$asking_id\"}" >/dev/null
live_require_no_active_work "$LIVE_TUI_SESSION" 15 "asking probe work cleared"
live_log "one-line Working/Asking activity summary verified with the Work pane open"

# ---------------------------------------------------------------------------
# Ticket #185/#186: approvals are the right column's second surface. The
# small summary opens the full-height inbox; the left footer and the chat
# modal/`V` are retired.
# ---------------------------------------------------------------------------
live_focus_chat "$LIVE_TUI_SESSION"
live_invoke "message.send" "{\"workspaceID\":\"$ws_id\",\"text\":\"fake-ask-person pane-approval-probe ask-key-pane-approval\",\"recipientIDs\":[\"$helper_id\"]}" >/dev/null
live_require_joined_text "$LIVE_TUI_SESSION" "Approval needed: Which release channel should this task use?" 60 "ask_person reaches the approvals pane"
live_require_text "$LIVE_TUI_SESSION" "APPROVALS 1 pending │ v open" 20 "small approvals summary under Work"
live_assert_absence_rail "$LIVE_TUI_SESSION" "APPROVALS" "left rail no longer carries the approvals footer"
live_focus_work_interact "$LIVE_TUI_SESSION"
live_assert_grey_text "$LIVE_TUI_SESSION" "APPROVALS 1 pending" "unfocused small approvals heading"
live_assert_border_above "$LIVE_TUI_SESSION" "APPROVALS 1 pending" grey "unfocused small approvals border"
live_select_pane "$LIVE_TUI_SESSION" approvals
live_assert_text "$LIVE_TUI_SESSION" "APPROVALS 1 pending │ enter open" "selecting approvals teaches Enter"
live_assert_white_text "$LIVE_TUI_SESSION" "APPROVALS 1 pending" "selected small approvals heading"
live_assert_border_above "$LIVE_TUI_SESSION" "APPROVALS 1 pending" white "selected small approvals border"
live_assert_grey_text "$LIVE_TUI_SESSION" "WORK ACTIVE" "selected small approvals leaves the Work heading muted"
assert_pane_borders approvals
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "APPROVALS 1 pending │ 1/1" 10 "Enter from the small pane opens full approvals"
live_assert_absence "$LIVE_TUI_SESSION" "WORK ACTIVE" "full approvals cover Work"
live_assert_text "$LIVE_TUI_SESSION" "Message…" "full approvals leave the chat composer visible"
live_assert_white_text "$LIVE_TUI_SESSION" "APPROVALS 1 pending" "focused full approvals heading"
assert_pane_borders work
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "APPROVALS 1 pending │ enter open" 10 "Esc returns full approvals to the split summary"
live_require_text "$LIVE_TUI_SESSION" "WORK ACTIVE │" 10 "split mode restores Work"
live_focus_chat "$LIVE_TUI_SESSION"
live_key "$LIVE_TUI_SESSION" "v"
live_require_text "$LIVE_TUI_SESSION" "APPROVALS 1 pending │ 1/1" 10 "v opens full approvals from chat"
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "APPROVALS 1 pending │ enter open" 10 "Esc returns v-opened approvals to split"
live_focus_chat "$LIVE_TUI_SESSION"
live_key "$LIVE_TUI_SESSION" "V"
sleep 0.4
live_assert_absence "$LIVE_TUI_SESSION" "APPROVALS 1 pending │ 1/1" "V no longer opens a chat approvals modal"
live_assert_text "$LIVE_TUI_SESSION" "APPROVALS 1 pending │ v open" "the small approvals summary stays the only inbox entry"
# Reject through the one full-height surface to clean up the pending row.
live_focus_work_interact "$LIVE_TUI_SESSION"
live_key "$LIVE_TUI_SESSION" "v"
live_require_text "$LIVE_TUI_SESSION" "APPROVALS 1 pending │ 1/1" 10 "full approvals reopened for cleanup"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Helper needs your input" 10 "approval decision opens"
live_key "$LIVE_TUI_SESSION" Down
live_key "$LIVE_TUI_SESSION" Enter
# Full approvals stays mounted while the rejection settles; close it before
# asserting the Work header, which is hidden in full mode.
live_key "$LIVE_TUI_SESSION" Escape
live_require_absence "$LIVE_TUI_SESSION" "APPROVALS 1 pending" 15 "small approvals leave after the last decision"
live_require_text "$LIVE_TUI_SESSION" "WORK ACTIVE │" 10 "split Work view returns after the decision"
live_require_no_active_work "$LIVE_TUI_SESSION" 20 "rejected approval clears its work"
live_log "small/full approvals modes, Enter/Esc, left-footer removal, and V retirement verified"

# ---------------------------------------------------------------------------
# Ticket #184/#186: HISTORY partitions tasks, not groups; a group can appear in
# both views. Newest history group expands, older groups roll up; Enter expands,
# x dismisses, and D clears the view without deleting terminal rows.
# ---------------------------------------------------------------------------
live_focus_work_interact "$LIVE_TUI_SESSION"
live_key "$LIVE_TUI_SESSION" "f"
live_require_text "$LIVE_TUI_SESSION" "WORK HISTORY │" 10 "HISTORY view for cleanup"
live_key "$LIVE_TUI_SESSION" "D"
if live_try_text "$LIVE_TUI_SESSION" "Clear the history view?" 3; then
  live_key "$LIVE_TUI_SESSION" Enter
fi
live_require_text "$LIVE_TUI_SESSION" "WORK HISTORY │ none yet" 10 "history view cleared before the probes"
live_key "$LIVE_TUI_SESSION" "f"
live_require_text "$LIVE_TUI_SESSION" "WORK ACTIVE │" 10 "ACTIVE view restored after cleanup"

# One two-task dispatch group; cancelling one task leaves the group in ACTIVE
# and puts its finished card in HISTORY at the same time.
live_focus_chat "$LIVE_TUI_SESSION"
live_invoke "message.send" "{\"workspaceID\":\"$ws_id\",\"text\":\"history-split fake-queue-hold-long\",\"recipientIDs\":[\"$fake_id\",\"$helper_id\"]}" >/dev/null
live_require_text "$LIVE_TUI_SESSION" "WORK ACTIVE │ 1 group · 2 active · 0 done" 20 "two-task group is active"
history_split_id=$(live_snapshot_value "Object.values(output.state.subtasks).filter(function (t) { return t.title.indexOf(\"history-split\") >= 0 && t.assigneeID === \"$fake_id\" })[0]?.id" | tr -d '"')
[[ -n "$history_split_id" && "$history_split_id" != "null" ]] || live_fail "history split task id is missing"
live_invoke "task.cancel" "{\"id\":\"$history_split_id\"}" >/dev/null
live_require_text "$LIVE_TUI_SESSION" "WORK ACTIVE │ 1 group · 1 active · 1 done" 20 "ACTIVE keeps the group with its live card"
live_assert_work_text "$LIVE_TUI_SESSION" "history-split" "ACTIVE shows the surviving card"
live_focus_work_interact "$LIVE_TUI_SESSION"
live_key "$LIVE_TUI_SESSION" "f"
live_require_text "$LIVE_TUI_SESSION" "WORK HISTORY │ 1 group · 1 active · 1 done" 20 "HISTORY shows the same group with its finished card"
live_assert_work_text "$LIVE_TUI_SESSION" "history-split" "HISTORY shows the finished card from the active group"
live_assert_work_text "$LIVE_TUI_SESSION" "CANCELLED" "the finished card keeps its explicit state"
live_key "$LIVE_TUI_SESSION" "f"
live_require_text "$LIVE_TUI_SESSION" "WORK ACTIVE │" 10 "back to ACTIVE for the split-group cleanup"
history_split_remaining=$(live_snapshot_value "Object.values(output.state.subtasks).filter(function (t) { return t.title.indexOf(\"history-split\") >= 0 && t.state !== \"replied\" })[0]?.id" | tr -d '"')
[[ -n "$history_split_remaining" && "$history_split_remaining" != "null" ]] || live_fail "surviving history-split task id is missing"
live_invoke "task.cancel" "{\"id\":\"$history_split_remaining\"}" >/dev/null
live_require_no_active_work "$LIVE_TUI_SESSION" 15 "history split group settled"

# Clear the view again, then create two known finished groups. The newer group
# is expanded; the older is a rolled-up row.
live_key "$LIVE_TUI_SESSION" "f"
live_require_text "$LIVE_TUI_SESSION" "WORK HISTORY │" 10 "HISTORY view before the rollup probes"
live_key "$LIVE_TUI_SESSION" "D"
if live_try_text "$LIVE_TUI_SESSION" "Clear the history view?" 3; then
  live_key "$LIVE_TUI_SESSION" Enter
fi
live_require_text "$LIVE_TUI_SESSION" "WORK HISTORY │ none yet" 10 "history cleared before the rollup groups"
live_key "$LIVE_TUI_SESSION" "f"
# Two terminal groups with no provider round-trip or completion handoff:
# delegate, then cancel each task before it can start a native run. A cancelled
# task is still a durable terminal history card.
delegate_terminal_group() {
  local title="$1" id="" attempt
  live_invoke task.delegate "{\"workspaceID\":\"$ws_id\",\"assigneeID\":\"$helper_id\",\"title\":\"$title\",\"instruction\":\"History fixture.\",\"mode\":\"research\"}" >/dev/null
  for attempt in $(seq 1 40); do
    id=$(live_snapshot_value "Object.values(output.state.subtasks).filter(function (t) { return t.title === \"$title\" })[0]?.id" | tr -d '"')
    [[ -n "$id" && "$id" != "null" ]] && break
    sleep 0.2
  done
  [[ -n "$id" && "$id" != "null" ]] || live_fail "history fixture task $title was not created"
  live_invoke task.cancel "{\"id\":\"$id\"}" >/dev/null
  live_wait_for_subtask_status "$title" replied 30 || live_fail "history fixture $title did not terminalize"
}
delegate_terminal_group "history-older fake-queue"
delegate_terminal_group "history-newer fake-queue"
live_require_no_active_work "$LIVE_TUI_SESSION" 15 "history fixture groups settled"
live_focus_work_interact "$LIVE_TUI_SESSION"
live_key "$LIVE_TUI_SESSION" "f"
live_require_text "$LIVE_TUI_SESSION" "WORK HISTORY │ 2 groups · 0 active · 2 done" 20 "two finished history groups"
live_require_work_text "$LIVE_TUI_SESSION" "history-newer" 10 "newest history group starts expanded"
live_assert_absence_work "$LIVE_TUI_SESSION" "history-older" "older history group starts rolled up"
live_require_text "$LIVE_TUI_SESSION" "▾ GROUP 1 · 1 done" 10 "newest group renders the expanded caret"
live_require_text "$LIVE_TUI_SESSION" "▸ GROUP 2 · 1 done" 10 "older group renders the rolled-up caret"
live_assert_absence_work "$LIVE_TUI_SESSION" "history-older" "rolled-up group hides its cards"
live_key "$LIVE_TUI_SESSION" "G"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "▾ GROUP 2 · 1 done" 10 "Enter expands the focused older group"
live_require_work_text "$LIVE_TUI_SESSION" "history-older" 10 "expanded older group shows its card"
live_key "$LIVE_TUI_SESSION" "x"
live_require_absence "$LIVE_TUI_SESSION" "▸ GROUP 2" 10 "x dismisses the focused history group"
live_assert_work_text "$LIVE_TUI_SESSION" "history-newer" "dismissal keeps the other history group"
dismissed_live=""
for _ in $(seq 1 40); do
  dismissed_live=$(live_snapshot_value 'output.state.ui.dismissedHistoryGroups.length')
  [[ "$dismissed_live" =~ ^[1-9][0-9]*$ ]] && break
  sleep 0.25
done
[[ "$dismissed_live" =~ ^[1-9][0-9]*$ ]] || live_fail "history dismissal was not persisted in UI state (got $dismissed_live)"
live_key "$LIVE_TUI_SESSION" "D"
live_require_text "$LIVE_TUI_SESSION" "Clear the history view?" 10 "D asks before clearing history"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "WORK HISTORY │ none yet" 10 "D clears the history view"
retained_rows=$(live_snapshot_value '(function () { var tasks = Object.values(output.state.subtasks); return ["history-older fake-queue", "history-newer fake-queue"].every(function (title) { return tasks.some(function (t) { return t.title === title && t.state === "replied" }) }) })()')
[[ "$retained_rows" == "true" ]] || live_fail "clearing history deleted terminal rows (got $retained_rows)"
live_key "$LIVE_TUI_SESSION" "f"
live_require_text "$LIVE_TUI_SESSION" "WORK ACTIVE │" 10 "ACTIVE view restored after the history probes"
live_log "task-level HISTORY split, expansion, rollup, dismiss, clear, and retention verified"

# Operator evidence: the doctor and the structured log summary are artifacts
# for the verification record. A genuine native rejection is the only failure.
OPENCODE_PASSWORD="$LIVE_SERVER_PASSWORD" "$LIVE_NODE_BIN" --experimental-strip-types \
  "$LIVE_ROOT/src/v2/doctor-cli.ts" --server "$LIVE_SERVER_URL" "$LIVE_PROJECT" \
  >"$LIVE_LOGS/doctor.txt" 2>&1 || true
grep -q "Mismatches: none" "$LIVE_LOGS/doctor.txt" \
  || live_fail "doctor reported a work mismatch: $(grep -A3 'Mismatches:' "$LIVE_LOGS/doctor.txt" | tail -n +2 | head -n 2)"
"$LIVE_NODE_BIN" "$LIVE_ROOT/scripts/log-summary.mjs" --dir "$LIVE_STATE/ensemble/logs" --json \
  >"$LIVE_LOGS/log-summary.json"
failed_tasks=$("$LIVE_NODE_BIN" -e '
  const summary = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(String((summary.failedTasks ?? []).length));
' "$LIVE_LOGS/log-summary.json")
[[ "$failed_tasks" == "1" ]] \
  || live_fail "expected exactly one native failed task in the log summary, found $failed_tasks"
sqlite_free_failures=$("$LIVE_NODE_BIN" -e '
  const summary = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const events = summary.events ?? {};
  process.stdout.write(String(events["task.stalled"] ?? 0));
' "$LIVE_LOGS/log-summary.json")
[[ "$sqlite_free_failures" == "0" ]] || live_fail "unexpected task.stalled events in the live run"
if [[ -n "${ENSEMBLE_LIVE_ARTIFACTS:-}" ]]; then
  mkdir -p "$ENSEMBLE_LIVE_ARTIFACTS"
  cp -R "$LIVE_LOGS/." "$ENSEMBLE_LIVE_ARTIFACTS/"
  mkdir -p "$ENSEMBLE_LIVE_ARTIFACTS/service-logs"
  cp -R "$LIVE_STATE/ensemble/logs/." "$ENSEMBLE_LIVE_ARTIFACTS/service-logs/"
  live_log "artifacts copied to $ENSEMBLE_LIVE_ARTIFACTS"
fi
live_log "doctor and log summary captured under $LIVE_LOGS"

live_log "fake live-check passed ($LIVE_SERVER_URL)"
