# ADR 0012: Terminal turns, root-only synthesis, and explicit continuation

- Status: Accepted
- Tickets: spec #245, #246–#251
- Related: [ADR 0004](0004-dispatch-budgets-and-continuation.md),
  [ADR 0011](0011-mention-routing-and-budgets.md)

## Context

Per-hop synthesis woke the leader for every handoff in a relay, and a terminal
review could fan out acknowledgements through the routing operator. The leader
wrote more than the team in both a five-writer relay and a three-way fan-out.
The command root already owns the final answer, so intermediate parents only
need to relay their child's result.

A blanket "terminal turns cannot route" rule would stop the leader from
starting the next ticket in a multi-ticket project. The continuation path must
be explicit, and it must not launder work around the command budget.

## Decision

**Only the command root synthesizes.** The root resolver walks the parent chain
to the topmost Subtask. A native turn stays host-answered and is never
converted into synthesis work. Intermediate handoff and delegation parents
settle replied with the child result and propagate upward without a leader
turn. An intermediate parent with several children settles only when its whole
non-completion subtree is terminal.

**The root digest uses terminal leaves.** The synthesis context carries the
original request and a bounded branch digest: worker path plus the final result
per terminal leaf. A relay parent keeps its own `resultMessageID`; the digest
still reports the leaf, never the intermediate reply. Failed, cancelled,
stalled, and pending branches remain visible.

**The ancestor completion guard is structural.** The completion hop is skipped
when the leader is the immediate parent, the peer turn's asker, the handoff's
sender, or an owner of the command root or another ancestor. Work rooted under
another member still reaches the leader for review. A skip creates no
completion task, Work card, leader message, or model turn.

**Terminal turns suppress mentions.** Synthesis, completion-review, and
batch-review turns are terminal: routing-operator mentions are references and
create no peer work. The final text still posts as the group message. Explicit
tools remain available. A terminal turn with suppressed mentions and no
dispatch reports that no work was created and how to continue. Normal worker,
handoff, and peer turns keep the full routing grammar, including sibling and
new-agent routes; only the existing echo, cycle, fan-out, and budget guards
apply.

**`ensemble_dispatch` starts a new command.** A terminal turn may start the
next ticket as a new parentless command root with a fresh command group and
budget. `continuationOf` is provenance only; it does not share the previous
command's budget or open a continuation segment. The batch is preflighted
before the root exists, and the ordinary store admission remains the one hop
authority. If a later assignment is refused, the rows this attempt created are
cancelled before the visible refusal; existing retry rows are untouched. A host
that already claimed an earlier assignment may still append its answer, which
is the documented residual race.

**One terminal turn starts at most one new command.** This is the
anti-laundering boundary: a terminal turn cannot spend one review to open many
fresh command budgets. Each ticket is a new command with its own group,
command, depth, continuation, and task caps. A batch above the new command's
own command ceiling is a batch-too-large refusal (reduce or split the batch),
not a request for the user to start a new command.

## Consequences

- A relay or fan-out produces exactly one leader synthesis per command.
- The leader's input no longer grows with every hop; synthesis reads a bounded
  digest instead of the recent group transcript.
- A multi-ticket workflow continues without a new user message, but the
  continuation is explicit and idempotent rather than inferred from prose.
- Terminal turns cannot accidentally create peer work, so acknowledgements
  stay references.
- Normal worker collaboration is unchanged outside terminal turns.
- The native tool surface grows by one tool (`ensemble_dispatch`); the legacy
  surface and TUI stay unchanged.
