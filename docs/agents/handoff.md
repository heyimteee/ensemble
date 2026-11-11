# Handoff contract

This is the detailed contract behind the end-of-turn rule in
[AGENTS.md](../../AGENTS.md). It applies to every Ensemble workspace turn. The
short rule remains in the repository agent instructions so solo sessions still
see it; this document holds the mechanics that only matter once a turn is
running inside a workspace.

Related: [handoff terminology](../../GLOSSARY.md), tickets
[#71](https://github.com/heyimteee/ensemble/issues/71) and
[#238](https://github.com/heyimteee/ensemble/issues/238), and the
[issue tracker workflow](issue-tracker.md).

## Completion is server-owned

- A non-leader turn ends by posting its answer as the group message. The server
  decides whether the finished work returns to the leader; an agent does not add
  a handoff just to close a turn.
- Do not claim a teammate replied, agreed, or finished until that member's turn
  is visible in the conversation. A delivered message is not an acknowledgement.
- When you asked a teammate, their reply is the answer you deliver. Do not open a
  second completion loop for a teammate you asked.
- Explicit `ensemble_handoff` and `ensemble_delegate` are migration and rollback
  tools, not the normal chat path. Normal work is a `$Name` in your final text.
  While the explicit surface is enabled, a handoff is still delegation: write
  the recipient a clear, self-authored instruction in your own words — never a
  copy of the user's message. `task` stays the short display title; the
  recipient's work item uses your instruction.
- Answer first: write your own answer in the group chat before handing off. A
  handoff forwards a completed result or clearly scoped work; it is never a
  substitute for answering your assignment.
- Multiple pending completion handoffs for one recipient coalesce into one
  consolidated batch review turn after a short quiet window (~1s) or when the
  recipient is free. Decide each item with `ensemble_review` (`delegate` |
  `start` | `end` | `dismiss`); the batch closes only when every item is acted
  on or dismissed. Non-leader recipients hand the batch onward (default
  leader); the leader may end it.
- Loop guards apply: maximum handoff chain depth, no immediate back-and-forth
  to the previous sender, repeated-recipient detection, forced leader or
  termination fallback at the cap. Never call `ensemble_delegate` after a
  handoff (leader-only; would double-queue) and never queue duplicate work.

## Mention syntax

- Use `$Name` (or the `!Name` alias) for agents throughout.
- `@` is file-only and never addresses an agent.

## Terminal turns

A synthesis, completion-review, or batch-review turn is terminal. Its
routing-operator mentions are references, not work; the final text still posts
as the group message. To start the next ticket explicitly, the leader calls
`ensemble_dispatch` with a title, an instruction, and an assignment batch. It
creates a new parentless command root with a fresh command group and budget and
creates the assignments under it. It is leader-only and idempotent: a retry
returns the existing root and assignments. A terminal turn with suppressed
mentions and no dispatch posts a visible no-work notice.

## Review obligations

A recipient of a batch review owns the disposition, not just acknowledgement:

- Decide every item; an undecided item keeps the batch open.
- `delegate` requires a self-authored instruction and a real recipient.
- `start` and `end` record work state; `dismiss` records that no work is
  needed, with the reason in the note.
- Do not re-hand the same completed content back to the previous sender.
