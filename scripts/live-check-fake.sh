#!/usr/bin/env bash
set -euo pipefail

# Deterministic live TUI check. Starts a dependency-free OpenAI-compatible fake
# provider, points an isolated OpenCode configuration at it, then verifies rich
# Markdown streaming/finalization, the absence of stale transcript lines, and
# searchable shortcut help. It never calls a real model and needs no API key.

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
source "$SCRIPT_DIR/lib/live-harness.sh"

live_require_runtime
live_require_node
live_setup "fake"

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
live_start_tui
live_wait_for_native_tui
live_open_ensemble

live_require_text "$LIVE_TUI_SESSION" "ENSEMBLE" 15 "Ensemble page"
live_require_text "$LIVE_TUI_SESSION" "No currently opened session" 10 "empty chat state"
live_assert_text "$LIVE_TUI_SESSION" "○───○───○" "one-shot empty-state mark"
# Ticket #56: the right-hand task board is retired; nothing renders it.
live_assert_absence "$LIVE_TUI_SESSION" "SUBTASKS" "right-hand task board retired"
live_require_text "$LIVE_TUI_SESSION" "I init" 10 "I init shortcut"
live_require_text "$LIVE_TUI_SESSION" "git:(" 10 "git metadata"
live_check_help

# The fake catalog contains one model with variants, so the agent wizard always
# offers a Reasoning effort step. Select the first model and first variant.
live_key "$LIVE_TUI_SESSION" "a"
live_require_text "$LIVE_TUI_SESSION" "Agent name" 10 "agent wizard"
live_assert_text "$LIVE_TUI_SESSION" "Ctrl+P back" "wizard nav hint back"
live_assert_text "$LIVE_TUI_SESSION" "Ctrl+N next" "wizard nav hint next"
live_key "$LIVE_TUI_SESSION" "C-n"
live_require_text "$LIVE_TUI_SESSION" "Agent title" 10 "wizard next via Ctrl+N"
live_key "$LIVE_TUI_SESSION" "C-p"
live_require_text "$LIVE_TUI_SESSION" "Agent name" 10 "wizard back via Ctrl+P"
live_type "$LIVE_TUI_SESSION" "FakeAgent"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Agent title" 10 "agent title step"
live_type "$LIVE_TUI_SESSION" "Engineering"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Agent role" 10 "agent role step"
live_type "$LIVE_TUI_SESSION" "Renders deterministic Markdown."
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Agent memories (optional)" 10 "agent memories step"
live_type "$LIVE_TUI_SESSION" "Likes deterministic fixtures"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Main model" 10 "agent model step"
live_key "$LIVE_TUI_SESSION" Enter
live_require_any_text "$LIVE_TUI_SESSION" 15 "reasoning step or direct chat" "Reasoning effort" "FakeAgent · direct"
if live_capture_contains "$LIVE_TUI_SESSION" "Reasoning effort"; then
  live_key "$LIVE_TUI_SESSION" Enter
fi
live_require_text "$LIVE_TUI_SESSION" "FakeAgent · direct" 20 "direct chat opened"
agent_memories=$(live_snapshot_value 'Object.values(output.state.memories).filter(function (m) { return !m.deletedAt }).map(function (m) { return m.text })')
[[ "$agent_memories" == '["Likes deterministic fixtures"]' ]] || live_fail "wizard memories did not persist (got $agent_memories)"
# Clear it so later memory-count probes stay meaningful.
wizard_memory_id=$(live_snapshot_value 'Object.values(output.state.memories).filter(function (m) { return !m.deletedAt })[0].id')
live_invoke memory.delete "{\"id\":$wizard_memory_id}" >/dev/null
live_require_text "$LIVE_TUI_SESSION" "FakeAgent" 10 "agent roster entry"
live_require_text "$LIVE_TUI_SESSION" "Onboarding complete. I am ready." 20 "fake onboarding reply"
live_require_absence "$LIVE_TUI_SESSION" "streaming…" 15 "onboarding finalization"

# Send the marker that makes the fake provider stream the rich Markdown
# fixture, then observe the live block before it is finalized in place.
live_key "$LIVE_TUI_SESSION" "i"
live_require_text "$LIVE_TUI_SESSION" "COMPOSER" 10 "composer focus"
# v5.6 T1: Insert mode, context, and the new Esc ladder are visible in the bar.
live_assert_text "$LIVE_TUI_SESSION" "INSERT · COMPOSER · Direct conversation" "statusline names Insert and context"
live_assert_text "$LIVE_TUI_SESSION" "enter send · esc normal · ctrl+g leave" "statusline names the composer ladder"
# Slice B: the COMPOSER hint is focus-border-only — no blink glyph anywhere.
live_assert_absence "$LIVE_TUI_SESSION" "▌" "no composer blink glyph"
live_type "$LIVE_TUI_SESSION" "fake-rich-fixture"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "· working…" 15 "per-agent activity line while live"
live_assert_absence "$LIVE_TUI_SESSION" "streaming…" "raw streaming dump removed"
live_require_text "$LIVE_TUI_SESSION" "Rich Markdown Fixture" 20 "finalized rich reply"
live_require_text "$LIVE_TUI_SESSION" "table cell marker" 20 "final table row"
live_require_absence "$LIVE_TUI_SESSION" "streaming…" 20 "in-place finalization"
live_require_absence "$LIVE_TUI_SESSION" "· working…" 20 "activity line unmounts after finalize"
# v5.6 T1: Enter keeps Insert focus; Esc goes composer Insert -> composer
# Normal -> chat Normal, and never leaves Ensemble.
live_require_text "$LIVE_TUI_SESSION" "Message…" 10 "composer cleared after send but still focused"
live_assert_text "$LIVE_TUI_SESSION" "INSERT · COMPOSER" "composer keeps Insert focus after Enter send"
sleep 0.25
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "NORMAL · COMPOSER" 10 "first Esc goes to composer Normal"
live_assert_text "$LIVE_TUI_SESSION" "i insert · h/j/k/l · x/d" "composer Normal hints name the Vim keys"
live_assert_text "$LIVE_TUI_SESSION" "enter send · esc chat" "composer Normal hints name the ladder"
live_key "$LIVE_TUI_SESSION" Escape
live_require_absence "$LIVE_TUI_SESSION" "COMPOSER" 10 "second Esc returns to chat Normal"
live_assert_text "$LIVE_TUI_SESSION" "NORMAL · Direct conversation" "chat stays in Normal mode"

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
live_key "$LIVE_TUI_SESSION" "h"
live_require_text "$LIVE_TUI_SESSION" "NORMAL · Roster" 10 "roster focus before search"
live_require_text "$LIVE_TUI_SESSION" "AGENTS (1)" 10 "unfiltered roster count"
live_key "$LIVE_TUI_SESSION" "/"
live_require_text "$LIVE_TUI_SESSION" "COMMAND · Roster" 10 "search opens the command line on the roster"
live_require_text "$LIVE_TUI_SESSION" "enter search · esc cancel" 10 "search hint names Enter and Esc"
live_type "$LIVE_TUI_SESSION" "zzz-no-roster-match"
live_require_text "$LIVE_TUI_SESSION" "/zzz-no-roster-match" 10 "roster query renders in the bottom bar"
live_require_absence "$LIVE_TUI_SESSION" "AGENTS (1)" 10 "roster filter hid the agent row"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "0 roster matches" 10 "committed roster search names its match count"
live_require_text "$LIVE_TUI_SESSION" "filter “zzz-no-roster-match”" 10 "roster filter hint survives the committed search"
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "AGENTS (1)" 10 "Esc restored the unfiltered roster"
live_require_absence "$LIVE_TUI_SESSION" "filter “zzz-no-roster-match”" 10 "roster filter hint cleared"

live_key "$LIVE_TUI_SESSION" "l"
live_require_text "$LIVE_TUI_SESSION" "NORMAL · Direct conversation" 10 "chat focus before transcript search"
live_key "$LIVE_TUI_SESSION" "/"
live_require_text "$LIVE_TUI_SESSION" "COMMAND · Direct conversation" 10 "search opens on the transcript"
live_type "$LIVE_TUI_SESSION" "text"
live_require_text "$LIVE_TUI_SESSION" "/text" 10 "transcript query renders in the bottom bar"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Match 1/2" 10 "first transcript match"
live_require_text "$LIVE_TUI_SESSION" "▶ FakeAgent · /text" 10 "matching row is highlighted"
live_require_text "$LIVE_TUI_SESSION" "match 1/2 · n next · N previous · esc clear" 10 "search statusline names n/N"
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
live_require_text "$LIVE_TUI_SESSION" "COMMAND · Direct conversation" 10 "colon opens Command mode"
live_require_text "$LIVE_TUI_SESSION" "enter run · esc cancel" 10 "command hint names Enter and Esc"
live_type "$LIVE_TUI_SESSION" "set"
live_key "$LIVE_TUI_SESSION" Tab
live_require_text "$LIVE_TUI_SESSION" ":settings" 10 "Tab completed the command"
live_key "$LIVE_TUI_SESSION" Escape
live_require_absence "$LIVE_TUI_SESSION" ":settings" 10 "Esc cancelled the command line"
live_assert_text "$LIVE_TUI_SESSION" "NORMAL · Direct conversation" "cancel restored Normal mode"
live_assert_absence "$LIVE_TUI_SESSION" "FakeAgent · settings" "cancel never ran the completed command"

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
live_require_text "$LIVE_TUI_SESSION" "Approvals inbox" 15 "command opened approvals"
live_key "$LIVE_TUI_SESSION" Escape
live_require_absence "$LIVE_TUI_SESSION" "Approvals inbox" 10 "approvals closed"
live_log "ticket #80 command line, completion, history, and transcript search verified"

# Workspace wizard: Enter owns every non-text step, including the
# leader-synthesis yes/no choice, and never opens a completion surface.
live_key "$LIVE_TUI_SESSION" "n"
live_require_text "$LIVE_TUI_SESSION" "New workspace" 10 "workspace wizard"
live_require_text "$LIVE_TUI_SESSION" "Workspace directory" 10 "directory step"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Workspace name" 10 "workspace name step"
live_type "$LIVE_TUI_SESSION" "LiveSite"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Workspace members" 10 "members step"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Workspace leader" 10 "leader step"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Leader synthesis" 10 "synthesis choice step"
live_assert_text "$LIVE_TUI_SESSION" "Yes — let the leader synthesize" "synthesis yes option"
live_key "$LIVE_TUI_SESSION" Enter
live_assert_absence "$LIVE_TUI_SESSION" "\$ agents" "no completion popup from wizard Enter"
live_require_text "$LIVE_TUI_SESSION" "Move FakeAgent into" 15 "move-home confirm"
sleep 0.25
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "#LiveSite" 20 "workspace created"
live_require_text "$LIVE_TUI_SESSION" "leader FakeAgent" 15 "leader visible on group surface"
synthesis=$(live_snapshot_value 'Object.values(output.state.workspaces)[0].synthesis')
[[ "$synthesis" == "true" ]] || live_fail "synthesis choice did not persist as Yes (got $synthesis)"
leader_name=$(live_snapshot_value 'Object.values(output.state.agents).filter(function (agent) { return !agent.archived })[0].name')
[[ "$leader_name" == '"FakeAgent"' ]] || live_fail "unexpected roster leader (got $leader_name)"

# Inline work progress at this layer (ticket #56, slice A ticket #64): group
# messages create leader work that starts with no further TUI action — no
# navigation, no native session — and runs to replied. While active, the
# ephemeral WORK block lists exactly the active rows with the assigned agent,
# and a per-agent activity line shows what each agent is doing; no raw
# streamed body text appears anywhere. Each terminal outcome is announced
# once as a transcript system line, finished rows never remain in the block,
# and the block unmounts when all work is terminal. A second message proves
# multiple live items each finalize without duplicates or stale lines.
live_key "$LIVE_TUI_SESSION" "i"
live_require_text "$LIVE_TUI_SESSION" "COMPOSER" 10 "composer focus on group surface"
live_type "$LIVE_TUI_SESSION" "fake-queue-alpha"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "fake-queue-alpha" 15 "group message posted"
sleep 0.25
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "WORK ·" 15 "ephemeral work block mounts while active"
live_require_text "$LIVE_TUI_SESSION" "· FakeAgent · working" 15 "work row loading state with assignee"
live_assert_absence "$LIVE_TUI_SESSION" "streaming…" "raw streaming dump removed"
# Slice B: live activity lines animate across the named working frames
# (◐◑◒◓). Bursts finalize in about half a second on this fixture, so a slow
# capture cadence after further requires observes a single tick. Collect at
# 0.15 s from the moment live work is known (the WORK row) across both
# delegation bursts instead: the loop subsumes the "activity line while live"
# wait, and zero frames means the line never rendered.
live_log "observing working-frame animation across ticks"
seen_frames=0
seen_which=""
collect_work_frames() {
  local rounds="${1:-16}" _ pane frame
  for _ in $(seq 1 "$rounds"); do
    pane=$(live_capture "$LIVE_TUI_SESSION")
    for frame in "◐" "◑" "◒" "◓"; do
      if grep -qF -- "${frame} FakeAgent · working" <<<"$pane" && [[ "$seen_which" != *"$frame"* ]]; then
        seen_which="${seen_which}${frame}"
        seen_frames=$((seen_frames + 1))
      fi
    done
    [[ "$seen_frames" -ge 2 ]] && return 0
    sleep 0.15
  done
  return 1
}
collect_work_frames 16 || true
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
collect_work_frames 16 || true
[[ "$seen_frames" -ge 2 ]] || live_fail "activity line did not animate across working frames (saw: $seen_which)"
live_log "activity line animated across working frames ($seen_which)"
queue_replied=0
for _ in $(seq 1 120); do
  queue_replied=$(live_snapshot_value 'Object.values(output.state.subtasks).filter(function (t) { return t.state === "replied" }).length')
  [[ "$queue_replied" == "2" ]] && break
  sleep 0.5
done
[[ "$queue_replied" == "2" ]] || live_fail "group work did not run to replied with no further action (got $queue_replied replied)"
live_require_text "$LIVE_TUI_SESSION" "● FakeAgent finished: fake-queue-alpha" 15 "terminal announcement for first work"
live_require_text "$LIVE_TUI_SESSION" "● FakeAgent finished: fake-queue-beta" 15 "terminal announcement for second work"
live_assert_count "$LIVE_TUI_SESSION" "● FakeAgent finished:" 2 "each terminal outcome announced exactly once"
live_require_absence "$LIVE_TUI_SESSION" "WORK ·" 15 "work block unmounts when all work is terminal"
live_assert_absence "$LIVE_TUI_SESSION" "· FakeAgent · working" "no active rows remain in the block"
live_assert_absence "$LIVE_TUI_SESSION" "· FakeAgent · replied" "no finished rows remain in the block"
live_assert_absence "$LIVE_TUI_SESSION" "· working…" "no activity lines when idle"
# Review fixes (findings 2–3): no interim label can stick after completion,
# and no needs-you marker appears without user-blocked work in this flow.
live_assert_absence "$LIVE_TUI_SESSION" "Stopping…" "no stuck stop label after terminal"
live_assert_absence "$LIVE_TUI_SESSION" "Cancelling…" "no stuck cancel label after terminal"
live_assert_absence "$LIVE_TUI_SESSION" "Retrying…" "no stuck retry label after terminal"
live_assert_absence "$LIVE_TUI_SESSION" "Restarting…" "no stuck restart label after terminal"
live_assert_absence "$LIVE_TUI_SESSION" "needs you" "no needs-you marker without blocked work"
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
# its own row; the terminal outcome is announced once and the block
# unmounts. The recipient's reply is the relay: exactly one answer row, no
# second leg.
live_key "$LIVE_TUI_SESSION" C-g
live_key "$LIVE_TUI_SESSION" "i"
live_require_text "$LIVE_TUI_SESSION" "COMPOSER" 10 "composer focus for peer turn"
live_type "$LIVE_TUI_SESSION" "$"
live_require_text "$LIVE_TUI_SESSION" "\$ agents" 10 "agent completion for mention"
live_key "$LIVE_TUI_SESSION" Enter
live_require_absence "$LIVE_TUI_SESSION" "\$ agents" 10 "completion accepted"
live_type "$LIVE_TUI_SESSION" "peer-check"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "peer-check" 15 "peer mention posted"
# Slice C: the assignment event names the owner; while the peer turn is in
# flight the live row reads `Asking $Name…` instead of the generic verb.
live_require_text "$LIVE_TUI_SESSION" "→ Assigned to \$FakeAgent: \$FakeAgent peer-check" 15 "assignment line for the peer turn"
live_assert_count "$LIVE_TUI_SESSION" "→ Assigned to \$FakeAgent: \$FakeAgent peer-check" 1 "peer assignment emitted exactly once"
live_require_text "$LIVE_TUI_SESSION" "WORK ·" 15 "work block mounts fresh for the new burst"
live_require_text "$LIVE_TUI_SESSION" "Asking \$FakeAgent…" 15 "asking live row while the peer turn is in flight"
live_assert_count "$LIVE_TUI_SESSION" "Asking \$FakeAgent…" 1 "asking row exactly once, no duplicate turn row"
live_assert_count "$LIVE_TUI_SESSION" "· FakeAgent · working" 1 "fresh burst lists only its own active row"
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
live_require_absence "$LIVE_TUI_SESSION" "WORK ·" 15 "work block unmounts after the peer burst"
live_assert_absence "$LIVE_TUI_SESSION" "· FakeAgent · working" "no active rows remain after the peer burst"
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
live_require_text "$LIVE_TUI_SESSION" "→ Assigned to \$FakeAgent: \$FakeAgent peer-asking-probe fake-rich-fixture" 15 "assignment line for the attribution probe"
live_assert_count "$LIVE_TUI_SESSION" "→ Assigned to \$FakeAgent: \$FakeAgent peer-asking-probe fake-rich-fixture" 1 "probe assignment emitted exactly once"
live_require_text "$LIVE_TUI_SESSION" "Asking \$FakeAgent…" 15 "asking live row while the probe turn is in flight"
live_assert_count "$LIVE_TUI_SESSION" "Asking \$FakeAgent…" 1 "probe asking row exactly once"
# v5.6 T3: the long fixture keeps the work zone live while Tab focuses it.
live_key "$LIVE_TUI_SESSION" C-g
live_key "$LIVE_TUI_SESSION" Tab
live_require_text "$LIVE_TUI_SESSION" "NORMAL · Work list" 10 "Tab focuses the work list"
live_require_text "$LIVE_TUI_SESSION" "enter result" 10 "work list names its open action"
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "NORMAL · Group chat" 10 "Esc returns to the transcript"
# Slice C third probe (direct surface): the `!Name` alias needs no completion
# popup, so it posts in one shot while the probe turn is still streaming its
# long reply — per-agent serialization parks it as pending, giving a wide,
# race-free window for the direct-surface check.
live_key "$LIVE_TUI_SESSION" C-g
live_key "$LIVE_TUI_SESSION" "i"
live_require_text "$LIVE_TUI_SESSION" "COMPOSER" 10 "composer focus for direct-surface probe"
live_type "$LIVE_TUI_SESSION" "!FakeAgent peer-direct-probe fake-rich-fixture"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "→ Assigned to \$FakeAgent: !FakeAgent peer-direct-probe fake-rich-fixture" 20 "assignment line for the direct-surface probe"
live_assert_count "$LIVE_TUI_SESSION" "→ Assigned to \$FakeAgent: !FakeAgent peer-direct-probe fake-rich-fixture" 1 "direct probe assignment emitted exactly once"
# Esc can be swallowed by the host while a native run is active; Ctrl+G is
# the reliable leave-composer chord and is asserted here.
live_key "$LIVE_TUI_SESSION" C-g
live_require_absence "$LIVE_TUI_SESSION" "COMPOSER" 10 "Ctrl+G leaves the composer"
live_key "$LIVE_TUI_SESSION" "z"
live_require_text "$LIVE_TUI_SESSION" "FakeAgent · direct" 10 "direct surface for the assignment check"
live_key "$LIVE_TUI_SESSION" C-g
live_key "$LIVE_TUI_SESSION" "w"
live_require_text "$LIVE_TUI_SESSION" "#LiveSite" 20 "back on the group surface"
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
live_require_text "$LIVE_TUI_SESSION" "● FakeAgent finished: !FakeAgent peer-direct-probe fake-rich-fixture" 15 "latest outcome announced inline at the tail"
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
[[ "$terminal_total" == "5" ]] || live_fail "expected five terminal subtasks (got $terminal_total)"
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
live_require_all_text "$LIVE_TUI_SESSION" 20 "settled bubble reply" \
  "Bubble Long Heading Marker" "bubble list alpha" "BUBBLE_CODE_MARKER" "bubble table marker"
live_assert_text "$LIVE_TUI_SESSION" "Bubble Long Heading Marker" "long wrapping heading"
live_assert_text "$LIVE_TUI_SESSION" "bubble list alpha" "bubble list"
live_assert_text "$LIVE_TUI_SESSION" "BUBBLE_CODE_MARKER" "bubble fenced code"
live_assert_text "$LIVE_TUI_SESSION" "bubble table marker" "bubble table cell"
live_assert_count "$LIVE_TUI_SESSION" "Bubble Long Heading Marker" 1 "long heading exactly once, no overlap duplication"
live_assert_count "$LIVE_TUI_SESSION" "BUBBLE_CODE_MARKER" 1 "fenced code marker exactly once"
live_assert_count "$LIVE_TUI_SESSION" "bubble table marker" 1 "table cell exactly once"
live_require_absence "$LIVE_TUI_SESSION" "streaming…" 20 "bubble reply finalized in place"
live_require_text "$LIVE_TUI_SESSION" "Message…" 10 "composer cleared after the bubble fixture"
live_log "long multi-element bubble reply verified with no clipped markers"

# Slice C direct surface (verbatim + queued): user text renders literally
# while agent text stays Markdown, and parked user-owned input shows
# `· queued · [x remove]` with removal by key.
live_key "$LIVE_TUI_SESSION" C-g
live_key "$LIVE_TUI_SESSION" "z"
live_require_text "$LIVE_TUI_SESSION" "FakeAgent · direct" 10 "direct surface for verbatim probe"
live_key "$LIVE_TUI_SESSION" C-g
live_key "$LIVE_TUI_SESSION" "i"
live_require_text "$LIVE_TUI_SESSION" "COMPOSER" 10 "composer focus on DM surface"
live_type "$LIVE_TUI_SESSION" "verbatim *stars* [brackets](http://x)"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "verbatim *stars* [brackets](http://x)" 15 "DM user text rendered verbatim"
live_assert_count "$LIVE_TUI_SESSION" "verbatim *stars* [brackets](http://x)" 1 "verbatim line exactly once, no Markdown rewrite"
live_require_absence "$LIVE_TUI_SESSION" "· working…" 20 "verbatim reply finalized in place"
live_require_text "$LIVE_TUI_SESSION" "Message…" 10 "composer cleared after the verbatim send"

live_key "$LIVE_TUI_SESSION" C-g
live_key "$LIVE_TUI_SESSION" "i"
live_require_text "$LIVE_TUI_SESSION" "INSERT · COMPOSER" 10 "composer focus for queue dance"
# Deterministic queue window: the hold fixture streams for several seconds
# (fake-queue-hold), so the second message stays parked while the harness
# observes the queued row and removes it. It is one-shot and never leaks into
# later replies through session history.
live_type "$LIVE_TUI_SESSION" "fake-queue-hold"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "· working…" 10 "DM live line while streaming"
live_require_text "$LIVE_TUI_SESSION" "Message…" 10 "composer cleared after the live DM send"
live_key "$LIVE_TUI_SESSION" C-g
live_key "$LIVE_TUI_SESSION" "i"
live_require_text "$LIVE_TUI_SESSION" "INSERT · COMPOSER" 10 "composer focus for queued probe"
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
live_require_absence "$LIVE_TUI_SESSION" "· working…" 30 "queue hold reply finalized"
live_log "verbatim user text and queued-line removal verified on the direct surface"
live_key "$LIVE_TUI_SESSION" C-g
live_key "$LIVE_TUI_SESSION" "w"
live_require_text "$LIVE_TUI_SESSION" "#LiveSite" 20 "group surface restored after DM probes"

# Slice E (ticket #65) chrome walkthrough: one focus owner at a time, proven
# through the context footer. Border colors do not survive `capture-pane`
# text capture, so the footer — driven by the same single-owner resolver —
# is the text-observable proxy; the exactly-one invariant itself is
# unit-pinned in chrome.test.ts across all 8 focus/composer/overlay states.
live_key "$LIVE_TUI_SESSION" "h"
live_require_text "$LIVE_TUI_SESSION" "enter open" 10 "rail focus footer names the open action"
live_assert_absence "$LIVE_TUI_SESSION" "enter result" "idle rail footer hides work results"

# v5.6 T3: roster Enter opens the surface and focuses the composer in Insert.
# Rail order is agents then workspaces, so j selects #LiveSite.
live_require_text "$LIVE_TUI_SESSION" "NORMAL · Roster" 10 "roster uses Normal grammar"
live_key "$LIVE_TUI_SESSION" "j"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "INSERT · COMPOSER · Group chat" 15 "roster Enter focuses the composer in Insert"
sleep 0.25
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "NORMAL · COMPOSER" 10 "composer Normal after one Esc"
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "NORMAL · Group chat" 10 "second Esc returns to the transcript"
# The retired ~ leader leaves no popup; Space opens which-key.
live_key "$LIVE_TUI_SESSION" '~'
sleep 0.3
live_assert_absence "$LIVE_TUI_SESSION" "which-key" "tilde no longer opens the leader"
live_key "$LIVE_TUI_SESSION" Space
live_require_text "$LIVE_TUI_SESSION" "LEADER · which-key" 10 "Space opens the which-key leader"
live_require_text "$LIVE_TUI_SESSION" "Leave Ensemble" 10 "which-key lists leader actions"
live_key "$LIVE_TUI_SESSION" Escape
live_require_absence "$LIVE_TUI_SESSION" "which-key" 10 "Esc closes the leader"
live_key "$LIVE_TUI_SESSION" "i"
live_require_text "$LIVE_TUI_SESSION" "enter send · esc normal · ctrl+g leave" 10 "composer Insert hints name the ladder"
live_assert_absence "$LIVE_TUI_SESSION" "enter result" "composer footer hides dead work keys"
sleep 0.25
live_key "$LIVE_TUI_SESSION" Escape
live_require_absence "$LIVE_TUI_SESSION" "enter send · esc normal · ctrl+g leave" 10 "Insert hints replaced by Normal hints"
live_key "$LIVE_TUI_SESSION" Escape
live_require_absence "$LIVE_TUI_SESSION" "COMPOSER" 10 "second Esc returns to chat Normal"
live_log "slice E focus walkthrough shows context footers with no hidden-work hints"

# Slice E help: tone-down keeps every shortcut searchable; the zero state
# names the fix.
live_key "$LIVE_TUI_SESSION" Space
live_require_text "$LIVE_TUI_SESSION" "LEADER" 10 "leader mode before help"
live_key "$LIVE_TUI_SESSION" '?'
live_require_text "$LIVE_TUI_SESSION" "Keyboard shortcuts" 15 "searchable shortcut help"
live_type "$LIVE_TUI_SESSION" "zzz-no-shortcut"
live_require_text "$LIVE_TUI_SESSION" "No matching shortcuts" 10 "help zero state names the miss"
live_assert_absence "$LIVE_TUI_SESSION" "Delete workspace" "help filter hid unrelated shortcuts"
live_key_repeat "$LIVE_TUI_SESSION" "BSpace" 20
live_require_text "$LIVE_TUI_SESSION" "Leader key" 10 "help filter cleared"
sleep 0.25
live_key "$LIVE_TUI_SESSION" Escape
live_require_absence "$LIVE_TUI_SESSION" "Keyboard shortcuts" 10 "help closed"

# Slice E settings frame: tab line keeps the live unfiltered memory total
# with the active cursor (zero here — the memories flow below proves the
# count at one plus edit and filter). v5.6 T5 (#83) also proves the shared
# modal grammar: tabs, rows, action hints, and the statusline mode/context.
live_key "$LIVE_TUI_SESSION" "s"
live_require_text "$LIVE_TUI_SESSION" "FakeAgent · settings" 10 "agent settings for tab check"
live_assert_text "$LIVE_TUI_SESSION" "NORMAL · Settings" "statusline names Normal and the settings context"
live_assert_text "$LIVE_TUI_SESSION" "h/l tabs" "settings teaches h/l tabs"
live_assert_text "$LIVE_TUI_SESSION" "j/k rows" "settings teaches j/k rows"
live_assert_text "$LIVE_TUI_SESSION" "enter edit" "settings teaches Enter"
live_assert_text "$LIVE_TUI_SESSION" "s save" "settings teaches save"
live_assert_text "$LIVE_TUI_SESSION" "esc close" "settings teaches the close step"
live_assert_absence "$LIVE_TUI_SESSION" "a add ·" "the general tab does not promise an add row"
live_assert_text "$LIVE_TUI_SESSION" "› Name" "the general tab starts on the first row"
live_assert_text "$LIVE_TUI_SESSION" "› General" "settings tab cursor"
live_assert_text "$LIVE_TUI_SESSION" "Memories (0)" "settings tab keeps the live memory total"
live_key "$LIVE_TUI_SESSION" "j"
live_require_text "$LIVE_TUI_SESSION" "› Title" 10 "j moves to the next row"
live_key "$LIVE_TUI_SESSION" "G"
live_require_text "$LIVE_TUI_SESSION" "› Model" 10 "G jumps to the last row"
live_key "$LIVE_TUI_SESSION" "g"
live_key "$LIVE_TUI_SESSION" "g"
live_require_text "$LIVE_TUI_SESSION" "› Name" 10 "gg jumps back to the first row"
live_key "$LIVE_TUI_SESSION" "l"
live_require_text "$LIVE_TUI_SESSION" "› Models" 10 "l switches to the next tab"
live_require_text "$LIVE_TUI_SESSION" "a add · s save" 10 "models teaches add; no backup exists to delete"
live_key "$LIVE_TUI_SESSION" "h"
live_require_text "$LIVE_TUI_SESSION" "› General" 10 "h switches back to the previous tab"
live_key "$LIVE_TUI_SESSION" "Tab"
live_require_text "$LIVE_TUI_SESSION" "› Models" 10 "Tab also switches tabs"
sleep 0.25
live_key "$LIVE_TUI_SESSION" Escape
live_require_absence "$LIVE_TUI_SESSION" "FakeAgent · settings" 10 "settings closed"

# Slice E approvals: the empty inbox names that no action is needed. The
# `Resolving…` pending row is unit-covered (no live fixture produces a
# pending approval in the fake catalog); the inbox open/close path is live.
live_key "$LIVE_TUI_SESSION" "v"
live_require_text "$LIVE_TUI_SESSION" "Approvals inbox" 10 "approvals inbox opens"
live_require_text "$LIVE_TUI_SESSION" "Nothing waits for you." 10 "approvals empty state"
sleep 0.25
live_key "$LIVE_TUI_SESSION" Escape
live_require_absence "$LIVE_TUI_SESSION" "Approvals inbox" 10 "approvals closed"
live_log "slice E help/settings/approvals chrome verified"

# In-house pickers and confirms still back model choices and destructive
# confirmations. Settings text fields now use the shared modal grammar
# (#83): Insert -> field Normal -> settings Normal -> close. This proves the
# ladder, the dirty mark, and the discard confirm; the memories flow below
# proves field commits persist end to end. (The picker overlay renders word
# gaps as non-breaking spaces, hence NBSP.)
NBSP=$'\u00a0'
live_key "$LIVE_TUI_SESSION" "s"
live_require_text "$LIVE_TUI_SESSION" "FakeAgent · settings" 10 "agent settings"
live_key "$LIVE_TUI_SESSION" "e"
live_require_text "$LIVE_TUI_SESSION" "Name · INSERT" 10 "e opens the Name field in Insert"
live_require_text "$LIVE_TUI_SESSION" "INSERT · Settings" 10 "the statusline names the field mode and context"
live_assert_text "$LIVE_TUI_SESSION" "enter done · esc field normal" "the field teaches its first Esc"
live_type "$LIVE_TUI_SESSION" "X"
live_require_text "$LIVE_TUI_SESSION" "FakeAgentX" 10 "typing edits the field buffer"
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "Name · NORMAL" 10 "the first Esc returns to field Normal"
live_assert_text "$LIVE_TUI_SESSION" "NORMAL · Settings" "field Normal still reports the settings context"
live_assert_text "$LIVE_TUI_SESSION" "esc settings" "field Normal teaches the next Esc"
live_key "$LIVE_TUI_SESSION" Escape
live_require_absence "$LIVE_TUI_SESSION" "Name · NORMAL" 10 "the second Esc returns to settings Normal"
live_require_text "$LIVE_TUI_SESSION" "UNSAVED" 10 "draft marked unsaved"
sleep 0.25
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "Discard changes?" 10 "the third Esc closes settings and confirms discard"
live_assert_text "$LIVE_TUI_SESSION" "enter yes · esc cancel" "confirm footer"
live_key "$LIVE_TUI_SESSION" Enter
live_require_absence "$LIVE_TUI_SESSION" "Discard changes?" 10 "confirm accepted"
live_require_absence "$LIVE_TUI_SESSION" "FakeAgent · settings" 10 "settings closed after discard"

live_key "$LIVE_TUI_SESSION" "s"
live_require_text "$LIVE_TUI_SESSION" "FakeAgent · settings" 10 "agent settings reopened"
live_key "$LIVE_TUI_SESSION" "Tab"
live_key "$LIVE_TUI_SESSION" "Tab"
live_require_text "$LIVE_TUI_SESSION" "No memories yet. a adds one." 10 "memories empty state names the add key"
live_assert_text "$LIVE_TUI_SESSION" "Memories (0)" "memories count renders at zero"
live_assert_text "$LIVE_TUI_SESSION" "a add · s save" "memories teaches the add row before any row exists"
live_key "$LIVE_TUI_SESSION" "a"
live_require_text "$LIVE_TUI_SESSION" "New memory · INSERT" 10 "a opens a new memory field"
live_type "$LIVE_TUI_SESSION" "fake-live-memory"
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "New memory · NORMAL" 10 "new-memory field Normal"
live_key "$LIVE_TUI_SESSION" Escape
live_require_absence "$LIVE_TUI_SESSION" "New memory · NORMAL" 10 "the second Esc commits and returns to settings Normal"
live_require_text "$LIVE_TUI_SESSION" "Memories (1)" 10 "memories count renders the live total"
memory_text=$(live_snapshot_value 'Object.values(output.state.memories).filter(function (m) { return !m.deletedAt }).map(function (m) { return m.text })')
[[ "$memory_text" == '["fake-live-memory"]' ]] || live_fail "memory field did not persist (got $memory_text)"
live_require_text "$LIVE_TUI_SESSION" "manual · project · reviewed" 10 "memory provenance line"
# Slice D edit-in-place through the shared Vim adapter: e opens the fact,
# Esc -> field Normal, $ -> end, i -> Insert, append. One row keeps its origin
# and history (no delete/re-add).
live_key "$LIVE_TUI_SESSION" "e"
live_require_text "$LIVE_TUI_SESSION" "Edit memory · INSERT" 10 "e opens the selected memory field"
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "Edit memory · NORMAL" 10 "memory field Normal"
live_key "$LIVE_TUI_SESSION" "$"
live_key "$LIVE_TUI_SESSION" "A"
live_require_text "$LIVE_TUI_SESSION" "INSERT · Settings" 10 "A returns the field to Insert at the line end"
live_type "$LIVE_TUI_SESSION" " v2"
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "Edit memory · NORMAL" 10 "edit field Normal before commit"
live_key "$LIVE_TUI_SESSION" Escape
live_require_absence "$LIVE_TUI_SESSION" "Edit memory · NORMAL" 10 "edit memory committed"
memory_edited=$(live_snapshot_value 'Object.values(output.state.memories).filter(function (m) { return !m.deletedAt }).map(function (m) { return m.text })')
[[ "$memory_edited" == '["fake-live-memory v2"]' ]] || live_fail "memory edit did not persist (got $memory_edited)"
memory_rows=$(live_snapshot_value 'Object.values(output.state.memories).filter(function (m) { return !m.deletedAt }).length')
[[ "$memory_rows" == '1' ]] || live_fail "edit re-added instead of updating in place (got $memory_rows rows)"
memory_prov=$(live_snapshot_value '(function () { var m = Object.values(output.state.memories).filter(function (x) { return !x.deletedAt })[0]; return m.origin + "|" + m.scope + "|" + m.history.map(function (h) { return h.action }).join(",") })()')
[[ "$memory_prov" == '"manual|project|created,edited"' ]] || live_fail "edit lost provenance history (got $memory_prov)"
live_require_text "$LIVE_TUI_SESSION" "fake-live-memory v2" 10 "edited fact renders"
live_assert_text "$LIVE_TUI_SESSION" "Memories (1)" "count unchanged after edit"
# x deletes the selected memory row without a dialog. Add a scratch row so the
# original fact survives for the later tabs.
live_key "$LIVE_TUI_SESSION" "a"
live_require_text "$LIVE_TUI_SESSION" "New memory · INSERT" 10 "second memory field opens"
live_type "$LIVE_TUI_SESSION" "scratch-memory"
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "New memory · NORMAL" 10 "second memory field Normal"
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "Memories (2)" 10 "second memory persisted"
live_require_text "$LIVE_TUI_SESSION" "› scratch-memory" 10 "the new memory row holds the cursor"
live_key "$LIVE_TUI_SESSION" "x"
live_require_text "$LIVE_TUI_SESSION" "Memories (1)" 10 "x deletes the selected memory"
live_require_absence "$LIVE_TUI_SESSION" "scratch-memory" 10 "deleted memory leaves the list"
memory_left=$(live_snapshot_value 'Object.values(output.state.memories).filter(function (m) { return !m.deletedAt }).map(function (m) { return m.text })')
[[ "$memory_left" == '["fake-live-memory v2"]' ]] || live_fail "delete removed the wrong memory (got $memory_left)"
# Slice D inline filter (ticket #80): / opens the shared command-line search
# and filters the focused settings tab live; Enter commits, Esc would restore
# the prior filter.
live_key "$LIVE_TUI_SESSION" "/"
live_require_text "$LIVE_TUI_SESSION" "enter search · esc cancel" 10 "settings search opens in the command line"
live_type "$LIVE_TUI_SESSION" "zzz-no-match"
live_require_text "$LIVE_TUI_SESSION" "Filter: zzz-no-match" 10 "settings filter follows the search line"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "No matching memories" 10 "memory filter zero state"
live_key "$LIVE_TUI_SESSION" "/"
live_require_text "$LIVE_TUI_SESSION" "enter search · esc cancel" 10 "settings search reopens"
live_require_text "$LIVE_TUI_SESSION" "manual · project · reviewed" 10 "opening a new search clears the filter preview"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "manual · project · reviewed" 10 "provenance line restored after clearing filter"
live_assert_text "$LIVE_TUI_SESSION" "Memories (1)" "count survives filtering"
sleep 0.25
live_key "$LIVE_TUI_SESSION" Escape
live_require_absence "$LIVE_TUI_SESSION" "FakeAgent · settings" 10 "settings closed"

# Slice D (ticket #61): the Skillbox tab is a searchable skill palette with
# `name — description` rows, inline filtering, fill-not-tick assignment, and
# an explicit overflow line past the viewport cap (cap overflow itself is
# unit-covered: the host catalog here is too small to page).
live_key "$LIVE_TUI_SESSION" "s"
live_require_text "$LIVE_TUI_SESSION" "FakeAgent · settings" 10 "agent settings reopened for skillbox"
live_key "$LIVE_TUI_SESSION" "Tab"
live_key "$LIVE_TUI_SESSION" "Tab"
live_key "$LIVE_TUI_SESSION" "Tab"
live_require_text "$LIVE_TUI_SESSION" "› Skillbox" 10 "skillbox tab active with cursor"
live_assert_text "$LIVE_TUI_SESSION" "space toggle" "skillbox teaches Space"
live_assert_text "$LIVE_TUI_SESSION" "/ filter" "skillbox teaches / filter"
live_key "$LIVE_TUI_SESSION" "/"
live_require_text "$LIVE_TUI_SESSION" "enter search · esc cancel" 10 "skill filter opens in the command line"
live_type "$LIVE_TUI_SESSION" "zzz-no-such-skill"
live_require_text "$LIVE_TUI_SESSION" "No matching skills" 10 "empty palette names the miss"
live_key "$LIVE_TUI_SESSION" Enter
live_key "$LIVE_TUI_SESSION" "/"
live_require_text "$LIVE_TUI_SESSION" "enter search · esc cancel" 10 "skill filter search reopens"
live_require_absence "$LIVE_TUI_SESSION" "No matching skills" 10 "opening a new search clears the prior filter"
live_key "$LIVE_TUI_SESSION" Enter
live_require_absence "$LIVE_TUI_SESSION" "enter search · esc cancel" 10 "filter search submitted"
if live_capture_contains "$LIVE_TUI_SESSION" "[ ]"; then
  live_key "$LIVE_TUI_SESSION" "Space"
  live_require_text "$LIVE_TUI_SESSION" "[x]" 10 "fill mark shows the assignment"
  live_require_text "$LIVE_TUI_SESSION" "UNSAVED" 10 "skill toggle dirties the draft"
  sleep 0.25
live_key "$LIVE_TUI_SESSION" Escape
  live_require_text "$LIVE_TUI_SESSION" "Discard changes?" 10 "skill draft discards via confirm"
  live_key "$LIVE_TUI_SESSION" Enter
  live_require_absence "$LIVE_TUI_SESSION" "FakeAgent · settings" 10 "settings closed after skill discard"
else
  live_log "host skill catalog is empty; toggle covered by unit tests"
  sleep 0.25
live_key "$LIVE_TUI_SESSION" Escape
  live_require_absence "$LIVE_TUI_SESSION" "FakeAgent · settings" 10 "settings closed"
fi

# Slice G (ticket #69) settings stylization: one designed language across all
# four tabs — section header, aligned label/value columns, descriptions and
# counts, selection marker, action footer — plus the agent list and the
# model picker. Earlier blocks prove save/dirty and approval flows; this
# block proves the styled grammar with no behavior change.
live_key "$LIVE_TUI_SESSION" "s"
live_require_text "$LIVE_TUI_SESSION" "FakeAgent · settings" 10 "settings header names the agent"
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
live_assert_text "$LIVE_TUI_SESSION" "Main       ensemble-fake/ensemble-fake-model" "main row aligns and names provider/model"
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
live_require_text "$LIVE_TUI_SESSION" "FakeAgent · settings" 10 "settings kept with no dirty draft"
live_key "$LIVE_TUI_SESSION" "Tab"
live_require_text "$LIVE_TUI_SESSION" "Saved knowledge — Memories (1)" 10 "memories section header with count"
live_assert_text "$LIVE_TUI_SESSION" "› fake-live-memory v2" "memories selection marker on the row"
live_assert_text "$LIVE_TUI_SESSION" "manual · project · reviewed" "memories provenance line kept"
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
live_require_absence "$LIVE_TUI_SESSION" "FakeAgent · settings" 10 "settings closed with bindings intact"
live_log "slice G settings stylization verified across all four tabs"

# v5.6 T7: composer Normal runs Vim motions, x/u/Ctrl+r, A, yy/p, dd, and
# Enter sends from Normal. The statusline position is the text-observable
# cursor, so motions are proven without reading private state.
live_key "$LIVE_TUI_SESSION" "i"
live_require_text "$LIVE_TUI_SESSION" "COMPOSER" 10 "composer focus for Vim probe"
live_type "$LIVE_TUI_SESSION" "vim alpha beta"
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "NORMAL · COMPOSER" 10 "Vim probe starts in composer Normal"
live_require_text "$LIVE_TUI_SESSION" "vim alpha beta" 10 "Esc keeps the typed text"
live_key "$LIVE_TUI_SESSION" "0"
live_require_text "$LIVE_TUI_SESSION" " · 1:1 · " 10 "0 goes to the line start"
live_key "$LIVE_TUI_SESSION" "w"
live_require_text "$LIVE_TUI_SESSION" " · 1:5 · " 10 "w goes to the next word start"
live_key "$LIVE_TUI_SESSION" '$'
live_require_text "$LIVE_TUI_SESSION" " · 1:14 · " 10 "$ goes to the last character"
live_key "$LIVE_TUI_SESSION" "b"
live_require_text "$LIVE_TUI_SESSION" " · 1:11 · " 10 "b goes back to the word start"
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
live_require_text "$LIVE_TUI_SESSION" "NORMAL · COMPOSER" 10 "A returns to composer Normal"
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
live_require_text "$LIVE_TUI_SESSION" "INSERT · COMPOSER" 10 "Insert focus before the Enter-send probe"
live_type "$LIVE_TUI_SESSION" "vim-enter-check"
sleep 0.25
live_key "$LIVE_TUI_SESSION" Escape
live_require_text "$LIVE_TUI_SESSION" "NORMAL · COMPOSER" 10 "Normal before Enter send"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "vim-enter-check" 15 "Enter sends from Normal"
live_assert_text "$LIVE_TUI_SESSION" "NORMAL · COMPOSER" "send from Normal keeps the composer focused"
sleep 0.25
live_key "$LIVE_TUI_SESSION" C-g
live_require_absence "$LIVE_TUI_SESSION" "COMPOSER" 10 "Ctrl+G leaves the composer from Normal"
live_assert_text "$LIVE_TUI_SESSION" "NORMAL · Group chat" "Ctrl+G returns to chat Normal"

live_check_help

# Ticket #77d / #80: Escape must never leave Ensemble; `:q` and `Space q` do.
live_key "$LIVE_TUI_SESSION" Escape
sleep 0.5
live_assert_text "$LIVE_TUI_SESSION" "ENSEMBLE" "Escape never quits Ensemble"
# Ticket #80: `:q` is the deliberate command-line quit.
live_type "$LIVE_TUI_SESSION" ":"
live_require_text "$LIVE_TUI_SESSION" "COMMAND · " 10 "colon opens Command mode"
live_type "$LIVE_TUI_SESSION" "q"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "Ask anything" 15 "native TUI after :q"
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
live_assert_absence "$LIVE_TUI_SESSION" "WORK ·" "stale work section after leaving Ensemble"

# Slice B reduced-motion run: restart the TUI with ENSEMBLE_REDUCED_MOTION=1
# and prove live work renders static frame-0 glyphs only — the working
# activity line stays on ◐, and no non-zero motion codepoint (◑◒◓◌▹▌)
# appears across sustained captures while work is in flight.
live_log "restarting TUI under ENSEMBLE_REDUCED_MOTION=1"
"$LIVE_TMUX_BIN" kill-session -t "$LIVE_TUI_SESSION" 2>/dev/null || true
live_tmux_env_add "ENSEMBLE_REDUCED_MOTION=1"
live_start_tui
live_wait_for_native_tui
live_open_ensemble
live_require_text "$LIVE_TUI_SESSION" "ENSEMBLE" 15 "Ensemble page under reduced motion"
live_require_text "$LIVE_TUI_SESSION" "#LiveSite" 20 "group surface restored under reduced motion"
live_key "$LIVE_TUI_SESSION" "i"
live_require_text "$LIVE_TUI_SESSION" "enter send · esc normal · ctrl+g leave" 10 "static composer hint under reduced motion"
live_assert_absence "$LIVE_TUI_SESSION" "▌" "no blink glyph under reduced motion"
live_type "$LIVE_TUI_SESSION" "fake-motion-static"
live_key "$LIVE_TUI_SESSION" Enter
live_require_text "$LIVE_TUI_SESSION" "◐ FakeAgent · working…" 15 "frame-0 activity line under reduced motion"
sleep 0.25
live_key "$LIVE_TUI_SESSION" Escape
for _ in $(seq 1 8); do
  pane=$(live_capture "$LIVE_TUI_SESSION")
  for glyph in "◑" "◒" "◓" "◌" "▹" "▌"; do
    grep -qF -- "$glyph" <<<"$pane" && live_fail "reduced-motion run animated (saw $glyph)"
  done
  sleep 0.3
done
live_log "reduced-motion run stayed on frame-0 glyphs while live"
live_require_text "$LIVE_TUI_SESSION" "● FakeAgent finished: fake-motion-static" 30 "reduced-motion work announced once"
live_assert_count "$LIVE_TUI_SESSION" "● FakeAgent finished: fake-motion-static" 1 "reduced-motion completion exactly once, no duplicate inline line"
live_require_absence "$LIVE_TUI_SESSION" "WORK ·" 15 "work block unmounts under reduced motion"
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
live_require_text "$LIVE_TUI_SESSION" "→ Assigned to \$Helper: !Helper !Scout joint-task" 15 "assignment line for the Helper turn"
live_require_text "$LIVE_TUI_SESSION" "→ Assigned to \$Scout: !Helper !Scout joint-task" 15 "assignment line for the Scout turn"
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
live_require_text "$LIVE_TUI_SESSION" "→ Assigned to \$FakeAgent: Review 2 completions" 30 "batch review assigned to the leader"
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

live_log "fake live-check passed ($LIVE_SERVER_URL)"
