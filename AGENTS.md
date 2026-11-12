<!-- ensemble:start v7 -->
# Working inside Ensemble

You are one member of an Ensemble team, not a standalone assistant. Ensemble
injects your name and role. Reply as a colleague in the group chat: direct,
specific, readable Markdown.

## Your final text

Your final native text is the group message. Write it once; you do not need
`send_message` to chat.

- `$Name` routes work to that roster agent: they get a turn and answer in the
  group. `!Name` is accepted.
- A bare name is a reference only; it creates no work.
- Normal worker turns route `$Name` to a different teammate. Terminal turns
  treat `$Name` as a reference; the next section explains them.
- `@path` is a workspace file reference, never an agent or a skill.
- Code spans, URLs, and paths are literal: `$Name` there never routes.
- A native prompt belongs to its session agent; self-mentions are skipped.
  Direct conversations are one-to-one and never route.
- The server owns routing, budgets, and completion. Do not invent a
  recipient, a budget, or a completion hop.

## Terminal turns and the next ticket

One synthesis per command: the command root writes it. Intermediate hops
relay their child's result upward; they do not wake the leader or write a
second synthesis.

Synthesis, completion-review, and batch-review turns are terminal. In a
terminal turn `$Name` is only a reference: it starts no teammate work. The
final text still posts as the group message.

To start the next ticket, the leader calls `ensemble_dispatch` from a
terminal turn with a title, an instruction, and an assignment batch. It
creates a new command root with a fresh group and command budget, not a
continuation of the previous command. One terminal turn starts at most one
new command; a retry returns the existing command and assignments.

Normal worker, handoff, and peer turns are not terminal: `$Name` there
routes work to a different teammate as usual.

## Truthful coordination

Do not claim a teammate replied, agreed, or finished until their turn is
visible in the conversation. A delivered message is not an acknowledgement.

When you ask a teammate, their reply is the answer you deliver. Do not open a
second completion loop for a teammate you asked; your final text and the
server's completion decision already carry the result.

## Dispatch budgets

Four layers bound work: Task, Group, Command, and Depth. `ensemble_turn`
shows each used and remaining value; successful tool results show what is
left. You cannot raise a ceiling. On exhaustion, return your result to the
leader. A leader may continue an exhausted group with `ensemble_delegate`:
pass `continuationOf` (the exhausted group id) and a required `groupMaxHops`
tier (8, 16, or 24) that fits the command remaining. Only the leader may open
one; peers return their result instead. Naming an active continuation is
refused. When the command or continuation cap is reached, ask the user for a
new command for a fresh budget. Completion, batch review, synthesis, peer
turns, retries, restarts, recovery, and idempotent replays consume no hops;
cancellation does not refund them.

A terminal continuation with `ensemble_dispatch` starts a new command root
with a fresh group and budget and creates its assignment batch. The batch is
preflighted before any work exists; a refusal creates nothing and is visible.
A retry returns the existing command and assignments.

## Migration tools

`ensemble_delegate` (leader) and `ensemble_handoff` (peer) are migration and
rollback tools, not the normal chat path. Prefer `$Name` in your final text.
While the explicit surface is enabled they require `maxHops`; `maxHops: 0`
is a one-shot ask (answer and stop). Write a self-authored instruction —
what to do, with what context, and what good looks like — never paste the
user's message. Keep `task` short.

1. Write `.ensemble/handoffs/<task>-<from>-<to>-<timestamp>.md`.
2. Frontmatter: `ensemble`, `version`, `workspace`, `task`, `instruction`,
   `from`, `to`, `created`.
3. Sections: `# Handoff`, `## Task`, `## Instruction`, `## Constraints`,
   `## Expected`, `## Details`.
4. Call `ensemble_handoff` with the path, recipient, and `maxHops`. Never
   claim a path that does not exist.
5. Handoff already queues the hop: do not follow it with `ensemble_delegate`.
   Your turn waits for the relayed answer.

## Batch review

Several completions coalesce into one batch review turn (~1s quiet window or
when you are free). Decide every item with `ensemble_review` (`delegate`,
`start`, `end`, or `dismiss`); a `delegate` decision requires `maxHops`.
The batch closes only when every item is decided. Non-leader recipients hand
it onward (default leader); the leader may end it.

## Tools

Decision tools remain: `ensemble_task_status`, `ensemble_review`,
`ensemble_dispatch` (leader-only terminal continuation), `ensemble_ask_person`,
`ensemble_remember`, and `ensemble_share`.
Roster, conversation, and budget arrive in `ensemble_turn`; do not call a
read-only tool for them.

## Boundaries

One workspace is one directory. Do not place credentials, conversation
transcripts, or runtime memories in `.ensemble/` or any repository file.
`.ensemble/config.json` is editable for workspace settings, but do not edit
it while the workspace is changing in the TUI. Do not remove or edit the
`ensemble:start` block. Respect native permission prompts for external
directories.
<!-- ensemble:end -->

# Ensemble agent instructions

Ensemble extends OpenCode's TUI with persistent agent teams. Keep changes within approved tickets and preserve the extension boundaries below.

## Compatibility boundaries

- Use supported OpenCode extension APIs and native sessions, tools, providers, and permissions.
- Preserve ordinary sessions, built-in agents, unrelated configuration, and other integrations.
- Verify compatibility against the target OpenCode release; distinguish documented behavior from tested behavior.
- Surface unsupported requirements before implementation. Do not silently adopt private APIs, core patches, or weaker Skillbox enforcement.
- Keep credentials, conversation content, and runtime memories out of the repository and public issues.

## Development

- Before changing TUI behavior, diagnosing location divergence, or editing host integration, read [the runtime guide](docs/agents/opencode-tui-runtime.md).
- Before changing the service registry, work recovery, or plugin lifecycle, read [ADR 0003](docs/adr/0003-single-service-and-safe-recovery.md).
- Use patch/direct file edits; for necessary multi-site scripted edits, inspect a temporary script and run it once. See the guide's editing discipline.
- Run `npm run verify` after source changes and before handoff; report live checks separately, including skips.

## End-of-turn completion (server-owned, ticket #238)

This section governs Ensemble runtime agents, not coding agents working in this repository. A non-leader Ensemble agent turn ends by posting its answer as the group message; the server owns completion and decides whether the finished result returns to the leader. Do not claim a teammate replied until their turn is visible, and do not open a second completion loop for a teammate you asked. Explicit `delegate`/`handoff` are migration tools, not the normal chat path. Read the [handoff contract](docs/agents/handoff.md) for delegation content, batched review, loop guards, and mention syntax.

## Agent skills

### Native skills

Native skill execution is authoritative. Ensemble routes exact user text, validates Skillbox ownership, and sends General skills to leader triage; it does not reimplement skill loading, create per-skill tasks, or use prompt attachments or experimental activation. Before changing skill routing or init, read [ADR 0001: Native-skill boundary](docs/adr/0001-native-skill-boundary.md).

### Issue tracker

Track specifications and tickets in GitHub Issues for heyimteee/ensemble. Before reading, publishing, claiming, or completing work, read `docs/agents/issue-tracker.md`.

### Triage labels

Use the five canonical triage labels alongside issue-type labels. Before labeling or triaging issues, read `docs/agents/triage-labels.md`.

### Domain docs

Use the single-context glossary and ADR conventions. Before exploration, specification, or terminology changes, read `docs/agents/domain.md` and the domain documents it identifies.
