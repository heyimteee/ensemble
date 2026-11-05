# Handoff contract

This is the detailed contract behind the mandatory handoff line in
[AGENTS.md](../../AGENTS.md). It applies to every Ensemble workspace turn. The
short rule remains in the repository agent instructions so solo sessions still
see it; this document holds the mechanics that only matter once a turn is
running inside a workspace.

Related: [handoff terminology](../../GLOSSARY.md), ticket
[#71](https://github.com/heyimteee/ensemble/issues/71), and the
[issue tracker workflow](issue-tracker.md).

## Mandatory completion handoff

- Every non-leader agent turn must end with a handoff to another workspace
  member: explicit via `ensemble_handoff`, or the automatic server default to
  the workspace leader carrying the finished task content. The group shows
  `Handed to $Recipient`. Leader turns may end normally or hand off
  voluntarily.
- A handoff is delegation: write the recipient a clear, self-authored
  instruction in your own words — never a copy of the user's message. `task`
  stays the short display title; the recipient's work item uses your
  instruction.
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
  termination fallback at the cap. Mandatory handoff never calls
  `ensemble_delegate` after a handoff (leader-only; would double-queue) and
  never queues duplicate work.

## Mention syntax

- Use `$Name` (or the `!Name` alias) for agents throughout.
- `@` is file-only and never addresses an agent.

## Review obligations

A recipient of a batch review owns the disposition, not just acknowledgement:

- Decide every item; an undecided item keeps the batch open.
- `delegate` requires a self-authored instruction and a real recipient.
- `start` and `end` record work state; `dismiss` records that no work is
  needed, with the reason in the note.
- Do not re-hand the same completed content back to the previous sender.
