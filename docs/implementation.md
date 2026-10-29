# Ensemble implementation

Status: **developer preview for OpenCode 2.2.1**. The plugin is loadable and usable locally, but not published, versioned, or license-selected.

## Install for local development

Add the repository as a plugin in a project or global `opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/home/you/dev/ensemble"]
}
```

The package exports both parts:

- `.` — server plugin (state, scheduling, native sessions, RPC, tools)
- `./tui` — terminal workspace

Open `/ensemble` from the prompt, or run the **Open Ensemble** palette command. Do not also place the same plugin under `.opencode/plugins/`; that creates a duplicate plugin ID.

## Architecture

- **Server plugin** owns durable state in OpenCode plugin storage, schedules work, creates native OpenCode sessions, and exposes a typed RPC contract.
- **TUI plugin** is a single workspace page with an internal sidebar for Agents, project-grouped Channels, Approvals, and Work. It talks to the server through RPC and refreshes on `rpc.ensemble.changed`.
- **Native sessions** execute every model turn. Ensemble injects its persona, memory, and channel context through session instruction entries; it does not replace OpenCode tools, providers, or permissions.
- **Skillboxes** are enforced with per-session `skill` permissions: deny all, then allow assigned IDs. This is native enforcement for agent-initiated skill loading.
- **No second daemon**. Work is owned by the OpenCode server, so closing the TUI does not stop running turns.

### State

`EnsembleState` contains agents, channels, conversations, work items, handoffs, approvals, memories, chains, and team settings. `EnsembleStore` serializes mutations and persists one JSON snapshot after each change.

### Key flows

- **Direct conversation:** create a native session with `agent: "build"`, apply the profile’s main model and Skillbox permissions, inject persona/memory, prompt, wait, then record the transcript in Ensemble.
- **Channel message:** parse recognized `!mentions`; unaddressed messages go only to the leader. Each recipient gets a queued work item and a per-agent channel conversation.
- **Handoff:** the `ensemble_handoff` tool records a visible handoff, enforces channel membership and the task-chain limit, and queues the target’s work. Replies are posted to the channel and recorded on the requester’s conversation.
- **Approvals:** outside-roster contact, chain-limit continuation, memory promotion, cross-project/private transcript sharing, roster proposals, and interrupted work. They block dependent work only.
- **Queues:** one active turn per conversation, a configurable team-wide limit (default 3), and one editing turn per resolved checkout. Distinct checkouts run in parallel.
- **Model fallback:** availability failures switch through the ordered backup list with visible status; native retries are disabled for Ensemble sessions so fallback can decide. Any tool call makes a retry unsafe, so work pauses for review instead of replaying.
- **Lifecycle:** archive preserves history; permanent delete is separate and asks whether native sessions should also be deleted.

## Feature map

| Ticket | Implementation |
| --- | --- |
| #3 Agents and direct conversations | Agent profiles, direct conversations, native sessions, RPC snapshot/invoke |
| #4 Settings tabs | General/Models/Memories/Skillbox views, drafts, Save/Cancel, pending marker |
| #5 Skillboxes | Assigned skill catalog, missing-skill warnings, native per-session permissions |
| #6 Memories | Manual project/global memories, provenance, history, delete/fresh conversation |
| #7 Channels | Project grouping, members, leader, `!mentions`, per-agent channel sessions |
| #8 Handoffs | `ensemble_handoff`, visible records, correlated replies, chain limit |
| #9 Queues | Per-conversation queues, cancel/steer/reorder, channel stop/resume |
| #10 Parallel work | Three-turn default, per-conversation lock, per-checkout editing lock |
| #11 Approvals | Inbox plus originating channel/direct context, idempotent resolution |
| #12 Learning | `ensemble_remember`, channel memory, approval-governed promotion |
| #13 Fallback | Ordered backups, visible switches, uncertain-tool pause, retry |
| #14 Background | Native server ownership, state recovery, no TUI daemon |
| #15 Archive/delete | Archive default, permanent delete, leader replacement, native-session choice |
| #16 Acceptance | This document, core tests, compatibility report, manual journey below |

## Tests

```bash
npm test
```

The suite covers state serialization, mention routing and name boundaries, model-variant validation, checkout normalization, concurrency and editing locks, queue ordering, memory scope isolation, lifecycle rules, and approval idempotence.

No TUI or server test harness is committed yet. The compatibility report records real OpenCode 2.2.1 probes; the acceptance journey below records the implementation checks.

A dated record of the live checks is in [verification/2026-10-29.md](verification/2026-10-29.md).

## Manual acceptance journey

Run against an isolated OpenCode 2.2.1 project (never the user’s global config):

1. Add the plugin path to `opencode.json`; open `/ensemble`.
2. Create two agents with different models and different Skillboxes.
3. Message one directly; verify the native session opens and the reply is recorded.
4. Create a channel with both agents and a leader; send an unaddressed message and a `!Agent` message.
5. Make the leader hand off to a member; verify the channel handoff record and the member’s reply.
6. Try an outside-roster handoff; verify the approval appears and the handoff waits.
7. Approve it; verify the target runs and the reopens show the result.
8. Create editing work in two channels on the same checkout; verify one runs and the other waits. Repeat with a different checkout and verify parallel execution.
9. Close the TUI while a turn is running; verify the server completes it and reconnecting shows the result.
10. Restart the server; verify running work becomes interrupted and requires explicit resume.
11. Assign a Skillbox, then have the agent attempt an unassigned skill; verify native denial.
12. Delete or archive an agent/channel; verify leader replacement, pending-work handling, and the native-session choice.

## Known limitations

- TUI workspace is a plugin page, not a native OpenCode tab or global sidebar.
- `!` autocomplete is a recipient picker plus text mentions, not inline completion.
- No server/TUI automated integration harness yet.
- The shared global `opencode service` lifecycle was validated only through the compatibility probes and an isolated standalone server.
- No npm package, versioning policy, or license has been selected.
