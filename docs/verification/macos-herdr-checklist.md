# macOS/Herdr manual verification checklist

Status: **Manual and unexecuted.** No macOS/Herdr host has run this checklist.
It is a repeatable procedure, not evidence. Until a run is recorded below or in
a dated verification record, treat macOS/Herdr behavior as unverified and do
not cite this document as a pass.

This checklist covers the areas that Linux/tmux cannot prove:

- terminal shortcuts and key ownership on macOS/Herdr
- System Agent init streaming and report rendering
- composer palette behavior
- init lifecycle, writes, and restoration

Related records: [v5.8 verification](2026-11-05-v58.md),
[issue #105](https://github.com/heyimteee/ensemble/issues/105),
[ticket #112](https://github.com/heyimteee/ensemble/issues/112), and the
[known limitations](../../README.md#keyboard).

## Before starting

| Item | Required |
|---|---|
| Host | macOS with Herdr as the terminal host |
| OpenCode | 2.2.5 or the version under test; record the exact output of `opencode --version` |
| Node | 26.4 or newer |
| Repository | This checkout loaded as the only Ensemble plugin |
| Project | A scratch directory with no existing `.ensemble/`, `AGENTS.md`, or conversation history |
| Model | A configured host model catalog; record whether the run used a real model or a fake provider |

Record the environment before the first check:

```text
Date:
Tester:
macOS version:
Herdr version:
OpenCode version:
Node version:
Project directory:
Model/provider:
```

Do not use a real workspace or real credentials in the scratch project. If a
check writes files, record the path and inspect it before deleting the scratch
directory.

## Result legend

| Mark | Meaning |
|---|---|
| `PASS` | Expected outcome observed exactly once unless the step says otherwise |
| `FAIL` | Expected outcome missing, duplicated, stale, or visibly wrong |
| `BLOCKED` | Cannot run on this host; record why |
| `NOT RUN` | Not attempted |

A skipped or blocked check is not a pass.

## 1. Shortcuts and key ownership

The goal is to prove that Ensemble's bindings work on macOS/Herdr, that Herdr
does not intercept them, and that leaving Ensemble hands the keyboard back to
the native prompt immediately.

- [ ] **1.1 Normal mode and basic navigation.** Open Ensemble. Press `j`/`k`,
      `h`/`l`, `Tab`, and `Enter`.
  Expected: the roster, chat, and work list move or focus without a modifier;
  no Herdr pane/tab shortcut fires. The statusline shows the mode chip.
- [ ] **1.2 Leader and help.** Press `Space`, then `?`.
  Expected: `Space` opens the Leader menu; `?` opens the searchable help
  catalog. On macOS the app still labels these as `Space` and `?`, not `Cmd`.
- [ ] **1.3 Deliberate leave and native keys.** Press `Space q` (or `:q`).
  Then type letters immediately, without pressing `Esc`.
  Expected: the native prompt receives the letters. Press `C-u` to clear, type
  `/`, and confirm the native slash menu opens. `F2` returns to Ensemble.
- [ ] **1.4 Prose command text stays native after leave.** Leave with `:q`,
      type `:` followed by text, and confirm the text goes to the native prompt
      rather than opening Ensemble Command mode. Return with `F2`.
- [ ] **1.5 Esc ladder.** From Insert, Visual, and Command, press `Esc`; then
      from Normal press `Esc` repeatedly.
  Expected: each step goes up one level; `Esc` never quits Ensemble. A second
  `Esc` in a wizard text field cancels with a dirty-draft confirm.
- [ ] **1.6 Ctrl chords and Herdr collisions.** In the composer, exercise
      `Ctrl+G` (leave editor), `Ctrl+C` (stop running work), `Ctrl+D`/`Ctrl+U`
      (half page), and `Ctrl+R` (redo in composer Normal).
  Expected: only these documented editor chords act. Herdr does not swallow
  them, and no other `Ctrl+letter` triggers an Ensemble action. Record any
  chord the host intercepts.
- [ ] **1.7 macOS copy/paste.** Use the system copy/paste and mouse selection in
      the chat and composer.
  Expected: `Cmd+C`/`Cmd+V` are not shadowed by Ensemble; a pane-bounded drag
  copies on release and does not change mode or focus.
- [ ] **1.8 Native session handoff.** Open a work item's native session (`o`),
      then return with `F2`.
  Expected: the native session owns the keyboard while visible; Ensemble does
  not consume keys behind it; `F2` restores the Ensemble page.
- [ ] **1.9 Leader label and chrome.** Inspect the rail.
  Expected: `LEADER` is inline after a faint `│` on the agent's name row, with
  no badge box or opaque cutout. The statusline and chrome use `│` (ASCII `|`
  fallback), and the rail stays transparent.

## 2. System Agent streaming

The goal is to prove that init progress is visible and streams while it runs,
then settles into one final report with no stale working state.

- [ ] **2.1 `I` init.** In a fresh workspace, press `I`.
  Expected: a visible `/init` audit line appears; the System Agent row starts
  as `Initializing workspace…`; progress text updates while the job runs; the
  row finalizes into `Ensemble init complete` (or an explicit failure report).
- [ ] **2.2 `:init` init.** Re-run in a clean scratch copy with `:init`.
  Expected: the same visible audit line, streaming row, and terminal report as
  `I`; exactly one audit line for this trigger.
- [ ] **2.3 Message-start `/init`.** Re-run with `/init` at message start.
  Expected: the same behavior. The composer must not fall through to the
  native `/init` command.
- [ ] **2.4 Prose `/init`.** Send a sentence containing `/init` mid-message.
  Expected: it is ordinary group text and starts no job.
- [ ] **2.5 Navigation during streaming.** Start init, leave the workspace or
      chat, then return while it runs.
  Expected: the job survives navigation; progress continues; no duplicate
  System Agent rows and no second audit line.
- [ ] **2.6 Completion settles once.** Let the job finish.
  Expected: progress stops, the final report appears once, and no streaming
  label or animated working glyph remains after the report.
- [ ] **2.7 Failure report.** Cause a controlled native init failure (for
      example, make the scratch project's `AGENTS.md` unwritable or point the
      scratch project at an invalid state directory). Re-run.
  Expected: the previous `AGENTS.md` is restored (or removed when it did not
  exist), and the report names the failure rather than hanging or silently
  succeeding.

## 3. Palette behavior

The goal is to prove the `|` flags, scoping, exact-text routing, and validation
on a host with a real catalog.

- [ ] **3.1 Message-start `/` palette.** Type `/` at message start.
  Expected: the palette lists commands and catalog skills with `Command`,
  `Skill | General`, or `Skill | <Owner>`. Every skill flag uses `|`; the
  middle-dot form `Skill ·` never appears.
- [ ] **3.2 Agent-scoped palette.** Type `$Agent /`.
  Expected: only that agent's assigned skills appear; General skills and
  commands are hidden. The title names the agent and `skills`.
- [ ] **3.3 Assigned-skill insertion and exact text.** Select an assigned skill,
  add text, and send.
  Expected: the bare `/skill` template is inserted; one owner-assigned turn is
  created; the exact user text reaches the owner; the assignment line names the
  owner.
- [ ] **3.4 Grouped skills.** Send `$Agent /skill-one /skill-two text`.
  Expected: one turn, one assignment row, a grouped skill title, and the exact
  user text. Do not produce one task per skill.
- [ ] **3.5 Multiple and mixed anchors.** Send `$Agent /skill !Other text`, then
  `$Agent /skill !Other /other-skill text`.
  Expected: one row per unique agent; skilled anchors keep their resolved
  skill; a normal anchor keeps a normal turn; the same exact text reaches each
  recipient.
- [ ] **3.6 General-skill triage.** Send a General skill.
  Expected: the leader receives the turn for triage and reads it under a
  one-run native skill grant. The grant is visible in the native session while
  the turn runs and restored to the Skillbox baseline afterwards. A delegatee
  receives leader guidance with no host grant.
- [ ] **3.7 Owner picker.** Send a message-start skill owned by a non-leader.
  Expected: the owner picker opens; choosing the owner routes the message
  without rewriting its text.
- [ ] **3.8 Validation is atomic.** Send a wrong-owner skill, a General skill
  under a non-leader mention, a General skill in a Direct conversation, and an
  over-cap skill list.
  Expected: each is rejected before any transcript line or work row; the error
  names the exact problem (skill, owner, leader, or limit); the draft stays in
  the composer.
- [ ] **3.9 Built-in init row.** Type `/init` in the palette.
  Expected: it appears as `Skill | General` but executes the System Agent init
  job, remains solo-only, and is not assignable in a Skillbox.

## 4. Init lifecycle and writes

The goal is to prove the durable effects, not just the visible stream.

- [ ] **4.1 Success writes.** After a successful init, inspect the scratch
      project.
  Expected: `.ensemble/init.json` exists with the current block version
  (version 2 for the v5.8 contract), and `AGENTS.md` contains exactly one
  `<!-- ensemble:start ... -->` block at the top. Content outside the markers
  is preserved.
- [ ] **4.2 Re-run is idempotent.** Run init again.
  Expected: the Ensemble block is replaced, not duplicated; other content is
  preserved; `init.json` stays valid.
- [ ] **4.3 Solo-only.** Try `:init extra` and an init alias attached to an
  agent anchor.
  Expected: both are rejected as solo-only/mixed, with the draft preserved and
  no work rows created.
- [ ] **4.4 Workspace-only.** Run `/init` in a native prompt outside Ensemble.
  Expected: the native command still works normally; Ensemble intercepts only
  its own composer path. A workspace-less Ensemble attempt is rejected.
- [ ] **4.5 Duplicate active init.** Start init twice while the first is
  running.
  Expected: the duplicate is rejected; one job and one report.
- [ ] **4.6 Cancellation and restart.** Cancel via reset/archive/delete during
  init, then repeat and restart OpenCode while the job is running.
  Expected: cancellation restores the prior `AGENTS.md`; restart marks the job
  interrupted with a rerun instruction rather than leaving a stuck working row.

## Recording the run

Copy this table into a dated verification record or append it below as a run
log. Add evidence paths for pane captures, `init.json`, and `AGENTS.md` diffs.

| Section | Result | Evidence / notes |
|---|---|---|
| 1. Shortcuts and key ownership | NOT RUN | |
| 2. System Agent streaming | NOT RUN | |
| 3. Palette behavior | NOT RUN | |
| 4. Init lifecycle and writes | NOT RUN | |

Only change `NOT RUN` to `PASS` after observing the expected outcome on the
recorded host. Record a `FAIL` as a ticket or a follow-up; do not quietly relax
the expected outcome.
