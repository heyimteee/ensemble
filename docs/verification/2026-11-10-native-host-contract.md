# Native host event contract (#210)

Status: **verified on an isolated real OpenCode 2.2.6 host with the deterministic fake provider; replayable fixture and contract test committed; 2.2.7 re-verified on 2026-11-11 with no contract change; no product behavior changed.**
Date: 2026-11-10
Issue: [#210](https://github.com/heyimteee/ensemble/issues/210)
Spec: [#209](https://github.com/heyimteee/ensemble/issues/209)
Branch: `ticket/210-host-probe`
Base: `integration/native-first` at `e45d900`

This record establishes the host behavior native-first ingestion depends on. It
is evidence, not a design: ticket #211 owns the ADRs and #212+ owns ingestion.

## Environment

| Item | Value |
|---|---|
| OS | Linux (Debian GNU/Linux 13), tested locally |
| Terminal host | tmux 3.5a |
| Node | 26.12.1 |
| npm | 12.2.1 |
| OpenCode (probe) | `opencode v2.2.6` (committed fixture); `opencode v2.2.7` re-verified 2026-11-11 |
| Declared plugin/client types | `@opencode/plugin` 2.2.1, `@opencode/client` 2.2.1 |
| Provider | local OpenAI-compatible fake provider (`ensemble-fake`); no model API, credentials, or external network |
| Fixture | `src/v2/fixtures/native-host-contract.jsonl` |
| Contract test | `src/v2/native-host-fixture.test.ts` |
| Probe | `scripts/live-host-probe.sh` (wired as `npm run test:live:probe`) |

The probe ran against a fresh isolated host and did not restart, reconfigure, or
read the user's live host.

## Commands and results

| Command | Result |
|---|---|
| `npm run test:live:probe` | **Pass** — isolated OpenCode 2.2.6 + fake provider; 11 recorded scenarios (304 fixture rows); 14/14 contract tests pass against the fresh record. |
| `npm run test:live:probe` (2026-11-11) | **Pass** — isolated OpenCode 2.2.7 + fake provider; 14/14 contract tests pass against the fresh record; only the host version string differed. |
| `npm run verify` | **Pass** — strict type check; **1553 tests passed, 0 failed, 0 skipped, 0 todo** (46.6 s). |
| `npm run test:live:probe` with `ENSEMBLE_PROBE_WRITE=1` | Regenerates the committed fixture; the committed file in this branch came from that command. |
| `git diff --check` | **Pass** — no whitespace errors. |

## 2.2.7 re-verification

Ticket [#233](https://github.com/heyimteee/ensemble/issues/233) re-ran the probe
on an isolated OpenCode **2.2.7** host with the same Node 26.12.1, tmux 3.5a,
fake provider, and recorded scenarios. The fresh record passed all 14 contract
tests without a behavioral mismatch: identity and event-order checks held, and
the busy move was still accepted and queued rather than refused. The only
difference was the recorded host version string.

`src/v2/native-host-fixture.test.ts` therefore accepts the supported **2.2.6 and
2.2.7** patch releases. The committed fixture remains the 2.2.6 record above,
and the 2.2.6 evidence is unchanged. A future host upgrade needs a fresh probe
and an explicit supported-set change, not a floating version range.

## Probe method

`scripts/host-probe-plugin/` is a small server plugin loaded only by the
isolated host. Its `setup` subscribes through `ctx.event.subscribe` — the same
plugin-context surface the Ensemble service uses — and appends selected host
events to a JSONL file. `scripts/host-probe.mjs` drives the turns through the
public `@opencode/client` API, subscribes independently to `/api/event`, and
deduplicates the two sources by host event id. The fixture records shapes and
identities; it records no message text, file bytes, credentials, or absolute
paths.

The plugin is loaded for the project and workspace locations. Both locations
reported `ready`. The fixture tags each plugin-recorded event with the observing
location; workspace-session events were observed by **both** the project and
workspace plugin instances. The event bus is therefore realm-wide for this
scenario even though each subscription is attached per location. Per-location
subscribers must deduplicate by host event id, which the service already does.

Warm-up sessions activate each location before the recorded cases, so the first
recorded `session.created` is not lost to a late subscription. Warm-up sessions
are not part of the fixture.

## Recorded order

### Direct, workspace, attachment, and synthetic turns

```
session.created
session.inbox.enqueued          item.type=user|synthetic, delivery=steer
session.execution.started
session.inbox.delivered
session.text.started            assistantMessageID, ordinal=0
session.text.delta              one or more
session.text.ended              exact part text, ordinal=0
session.execution.succeeded
```

`session.execution.started` precedes `session.inbox.delivered` in every measured
turn. Delivery is not the gate for execution start.

A synthetic message is a real turn: it is enqueued as `item.type="synthetic"`,
starts an execution, produces assistant text, and appears in the context as a
`type="synthetic"` message. The declared `session.synthetic` event was not
delivered by this host.

### Host retry

```
session.inbox.enqueued
session.execution.started
session.inbox.delivered
session.retry.scheduled         attempt=2, error.type=provider.rate-limit, status=429,
                                error.retryAfterMs=0, observed delay ≈ 2360 ms
session.text.started            same assistantMessageID as the failed attempt
session.text.delta
session.text.ended
session.execution.succeeded
```

The retry reuses one assistant message id. The fixture records `delayMs` from
the event's own `at` and `created` fields. No `session.status` retry event and no
`session.execution.interrupted` event was observed.

### User interruption

```
session.inbox.enqueued
session.execution.started
session.inbox.delivered
session.text.started
session.text.delta
session.text.ended              partial text, 96 characters in this run
session.execution.interrupted   reason=user
```

`session.interrupt` while streaming returns `{ interrupted: true }`.
`session.interrupt` while idle returns `{ interrupted: false }` and emits no
event. The partial text part is ended before the interruption settles.

### Background subagent

```
parent session.created
parent session.inbox.enqueued
parent session.execution.started
parent session.inbox.delivered
child session.created            parentID = parent session
child session.inbox.enqueued
child session.execution.started
child session.inbox.delivered
child session.text.started/delta...
parent session.text.started/ended
parent session.execution.succeeded   parent settles before the child
child session.text.ended
child session.execution.succeeded
parent session.inbox.enqueued        item.type=synthetic, metadata:
                                     {source:"subagent", childID, agent:"Explore", state:"completed"}
parent session.execution.started
parent session.inbox.delivered
parent session.text.started/delta/ended
parent session.execution.succeeded   a second parent turn
```

A finished background child injects a synthetic message into the parent and the
parent runs one more model turn for it. The synthetic message is not a tool
result and is not tagged by turn identity; its `metadata.childID` is the link to
the child session.

### Session move

```
session.inbox.enqueued          item.type=move, payload={}, delivery=steer
session.execution.started
session.inbox.delivered
session.moved                   location={directory:"<new>"}, subpath=""
session.execution.succeeded
```

A move is a native inbox item and a real execution turn, not a metadata-only
update. `session.get` shows the new location only after the move executes.

## Identity findings

- The prompt return id, `session.inbox.enqueued.data.inboxID`,
  `session.inbox.delivered.data.inboxID`, and the context user message `id` are
  the same message id. The field name `inboxID` does not identify a separate
  inbox row.
- `session.text.started` and `session.text.ended` carry the same
  `assistantMessageID`, and that id matches the context assistant message id in
  every measured turn. A retry reuses that id across attempts.
- Concatenated `session.text.ended` parts match the context assistant text part
  lengths. The ended text is authoritative for its part.
- Context messages are ordered chronologically by `time.created`, but message
  ids are allocation-order and are not monotonic. In the subagent parent, the
  synthetic message id appears after the preceding idle id in the transcript
  even though it is numerically lower. Do not derive turn order from id order.
- The context includes a `type="idle"` message after each settled turn. This is
  a reliable transcript marker even when no idle event arrives.

## Payload shapes

- `session.inbox.enqueued`: `{ sessionID, inboxID, item: { type, delivery,
  payload } }`.
  - user payload: `{ text, files?, agents?, skills?, metadata? }`
  - synthetic payload: `{ text, description?, metadata? }`
  - move payload: `{}`
- Prompt `metadata` is preserved in the enqueued payload and in the context user
  message.
- Prompt `files` accept `{ uri, name?, description? }`. The enqueued payload and
  the context user message replace the uri with inline file data:
  `{ data, mime, name?, description?, source: { type: "uri" | "inline" } }`.
  The original uri is not echoed. In this run the fixture recorded
  `mime="text/plain"`, a non-empty `dataLength`, `source.type="uri"`, and no
  `uri`.
- `session.retry.scheduled`: `{ sessionID, assistantMessageID, attempt, at,
  error: { type, message, status?, retryAfterMs? } }`.
- `session.execution.interrupted`: `{ sessionID, reason: "user" }`.
- `session.inbox.delivery.changed`: `{ sessionID, inboxID, delivery }`.
- `session.inbox.cancelled`: `{ sessionID, inboxID }`.
- `session.moved`: `{ sessionID, location: { directory }, projectID, subpath }`.
- `session.created`: `{ sessionID, parentID?, projectID, location, subpath,
  slug, title, version }`.

## Session list scopes

- `session.list({ directory })` returns sessions in that location. Workspace
  sessions do not appear in the project scope; a moved session leaves the old
  scope and appears in the new one.
- `parentID: null` returns roots only. `parentID: <parent>` returns that parent's
  child sessions. Child sessions are excluded from the root list.
- `archived: false` excludes archived sessions. `archived: true` returns only
  archived sessions. `session.update({ archived })` emits
  `session.archived`/`session.unarchived`.
- `search` matches titles in the selected scope.
- `{}` returned every observed location, including workspace and child sessions.
- Every non-empty list reported `hasNext: true` even with no limit supplied. Do
  not treat `hasNext` alone as proof of more rows; use the cursor.

## Busy-session behavior

- A queued prompt (`delivery: "queue"`) is accepted while the session is busy.
  `session.inbox.list` returns both queued items. `session.inbox.update` changes
  one to `steer`; `session.inbox.cancel` removes one.
- A move while busy is **accepted and queued**, not refused: the host enqueues a
  `move` inbox item and leaves the session in its current location until the
  move executes. After interruption the pending inbox still contained the
  earlier steer prompt and the move item. The spec's "move only when idle" is a
  service policy, not a host guarantee.
- A move to a missing directory fails with `InvalidRequestError` and enqueues no
  move item.
- A busy move does not itself interrupt or settle the current turn.

## Supported and unsupported against the declared 2.2.1 types

Supported and observed:

- `session.created`, `session.moved`, `session.archived`, `session.unarchived`
- `session.inbox.enqueued`, `delivered`, `cancelled`, `delivery.changed`
- `session.execution.started`, `succeeded`, `interrupted`
- `session.text.started`, `delta`, `ended`
- `session.retry.scheduled`
- `session.prompt` with `metadata`, `files`, and `delivery`
- `session.synthetic` method, `session.interrupt`, `session.move`,
  `session.update`, `session.list`, `session.context`, `session.inbox.list`,
  `session.inbox.update`, `session.inbox.cancel`

Not observed or mismatched in this headless 2.2.6 run:

- **`session.idle` was not delivered** on the plugin-context subscription or the
  HTTP `/api/event` stream within ten seconds after settlement, including after
  `session.view`. The declared type exists; the event did not arrive. Settlement
  evidence is `session.execution.succeeded|failed|interrupted`; the context
  `idle` message is the transcript marker. Do not use `session.idle` as the only
  settlement signal.
- **`session.status` was not delivered** at all, including during the retry and
  busy cases. Do not depend on it for retry or busy UI; use
  `session.retry.scheduled` and the execution families.
- **`session.synthetic` was not delivered** as an event. The synthetic message is
  visible in `session.inbox.enqueued` (`item.type="synthetic"`), in the context,
  and in the execution it starts.
- `session.execution.failed` and `session.deleted` were not exercised in this
  probe. Their payloads remain unverified; a terminal-failure probe is still
  needed before #217/#218 rely on the failure shape.
- `session.inbox.delivered` arrives after `session.execution.started`; delivery
  ordering must not be used to decide that a turn started.
- A background subagent's parent can run a second turn after the child
  completes. A turn is not finished just because the parent's first execution
  succeeded; the synthetic completion is a new inbox item and a new execution.
- Context message ids are not chronological. Use `time.created` for order and
  inbox/assistant ids for identity.
- `hasNext` is not a reliable "more rows" flag without a cursor.

Scope note: the idle/status/synthetic event absences were measured with a
headless server plus HTTP client and a server plugin. They may differ for a TUI
client. They should be rechecked before any ingestion path depends on those
events; the fixture makes that recheck a single live probe run.

## Blockers and handoff notes

- #211 can write the ADRs from this record. It must treat `session.execution.*`
  as authoritative for settlement and `session.idle` as unavailable in the
  measured headless shape.
- #212/#213 should use the prompt/inbox user message id as the turn identity and
  must not assume a separate inbox id.
- #214/#224 must not assume `session.move` only works when idle; the host queues
  a busy move.
- #217 must handle a retry as the same assistant message id and the same turn,
  not a second assistant message.
- #218 should reconcile from the context `idle` marker and execution terminal
  events; the `session.idle` event is not a usable single signal here.
- #215/#216 must treat a background subagent synthetic completion as a new
  parent inbox item and a second parent turn.

## Privacy

The fixture contains only lengths, short SHA-256 prefixes of fixed synthetic
prompt text, ids normalized to `sN`/`mN`/`eN`, placeholders `<project>`,
`<workspace>`, `<path>`, and structural values. It contains no message text,
no file bytes, no credentials, and no absolute paths. The live harness
re-checks the generated record before the contract test runs.
