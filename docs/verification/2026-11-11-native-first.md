# Native-first cutover verification (#227)

Status: **Pass — the native-first cutover matrix is green; #227 is ready to
close.**
Date: 2026-11-11
Issue: [#227](https://github.com/heyimteee/ensemble/issues/227)
Spec: [#209](https://github.com/heyimteee/ensemble/issues/209)
Branch: `ticket/227-verification`
Base: `integration/native-first` at `588351c` (`Merge ticket #230`)
Child evidence index: [2026-11-11-native-first-children.md](2026-11-11-native-first-children.md)

This record is the closing evidence for the native-first program. The live
matrix is deterministic, isolated, and fake-provider only; no real model, user
credential, conversation content, file bytes, or private path is part of the
record.

## Environment

| Item | Value |
|---|---|
| OS | Linux (Debian GNU/Linux 13), tested locally |
| Terminal host | tmux 3.5a |
| Node | 26.12.1 |
| npm | 12.2.1 |
| OpenCode (host) | 2.2.6, installed in an isolated prefix and selected with `OPENCODE_BIN` |
| Declared plugin/client types | `@opencode/plugin` 2.2.1, `@opencode/client` 2.2.1 |
| Provider | local OpenAI-compatible fake provider (`ensemble-fake`); no model API, credentials, or external network |
| Isolation | `scripts/lib/live-harness.sh`; fresh `HOME`/XDG roots, project, workspace, fake provider, and host per run |
| Scenario | `scripts/live-native-first.sh` (`npm run test:live:native-first`) |
| Driver | `scripts/lib/native-first-driver.mjs`, using the #210 `@opencode/client` surface and public Ensemble RPC |

The host was restarted once inside the scenario with the same XDG state root.
The user's live host was never restarted or reconfigured.

## Commands and results

| Command | Result |
|---|---|
| `npm run verify` | **Pass** — strict typecheck; **1810 tests passed, 0 failed, 0 skipped**. |
| `npm run test:live:probe` | **Pass** — isolated OpenCode 2.2.6 host; 11 recorded scenarios, 304 fixture rows, **14/14 contract tests pass**. |
| `npm run test:live:fake:all` | **Pass** — fake 472 s, fake-empty 9 s; **2 passed, 0 failed, 0 skipped** in 481 s |
| `npm run test:live:native-first` | **Pass** — main **65/65** checks, restart **16/16** checks, **0 gaps**; exit 0. |
| `git diff --check` | **Pass** — no whitespace errors. |

The new scenario is wired as `npm run test:live:native-first`. It reuses the
#210 live harness, isolation rules, fake provider, and `@opencode/client`
surface; it does not start a second host client or a second fake host.

## Live matrix

| Scenario | Result | Evidence |
|---|---|---|
| Native direct turn | **Pass** | User row exact on `dm:<agent>:<workspace>`; one exact agent row; durable native turn; `replied`; 169 ms prompt-to-settled |
| Native workspace turn | **Pass** | User and agent rows on the workspace channel; native turn; `replied`; 91 ms |
| User `$Name` mention | **Pass** | Exactly one peer turn under the native turn; same dispatch group; server-owned group budget `maxHops=8`; no agent-authored `taskMaxHops`; 153 ms |
| Agent final-text `$Name` mention | **Pass** | Final native text is the exact group message; exactly one routed peer turn; same dispatch group; `askerKind=agent`; 215 ms |
| Attachment prompt | **Pass** | Prompt reaches the agent; one chip with name, `text/plain` MIME, `kind:"file"`, and **31-byte** size; no bytes, source path, or store path in the row or snapshot |
| Session adoption | **Pass** | Preview adoptable; binding moves to the new session; previous session kept in history; heads-up emitted; a prompt sent immediately after adoption settles as its own turn while the heads-up settles separately |
| Retry | **Pass** | `retrying` observed; one turn, one assistant row, one assistant message id; `session.retry.scheduled` in the durable event timeline; no interrupted row |
| User interruption | **Pass** | `session.interrupt` acknowledged; phase `cancelled`; partial text preserved; not an interrupted row |
| Restart / reconnect | **Pass** | Service restarted with the same state root; bindings, 9 native turns, and terminal phases survived; 0 stuck turns; `native:live`; Work history identical; a post-restart native prompt ingested and settled; service logs recorded both `native.reconcile.done reason=start` and location `reason=reconnect` passes |
| Work history reload | **Pass** | Workspace 11 terminal tasks over 5 pages; direct 4 tasks over 2 pages; no duplicate rows; fresh bootstrap returns the same ids |
| Rollback to explicit tools | **Pass** | `nativeFirst:off` + `toolSurface:legacy`; legacy `message.send` task replied; 11 Ensemble tools in the provider request; durable native turns preserved; `on` + `native` restored |
| Shadow mode | **Pass** | Shadow ingested a `$Name` mention prompt and recorded a comparison row (`phase:"replied"`, planned user routes > 0, routing delta equal to the planned routes) while creating no durable turn, message, patch, or Work card; one `native.shadow.compare` row was logged |
| Latency / tokens | **Pass (measurement only)** | See the table below; no spec numeric budget exists, so the raw values and the before/after schema comparison are the evidence |

### Matrix notes

- **Direct and workspace isolation.** The group and direct session ids were
  distinct. A direct turn wrote only the `dm:` channel; a workspace turn wrote
  only the workspace channel.
- **Mention grammar and budgets.** Both the user mention and the agent final
  text created one child peer turn with `workKind:"turn"` under the native
  turn's dispatch group. The server ledger owned `maxHops=8`; the child carried
  no `taskMaxHops`, matching ADR 0011 (the agent authors no budget).
- **Retry identity.** The retry reused one assistant message id and one durable
  agent row. A separate delayed retry remains visible as `retrying` rather than
  being mislabeled interrupted.
- **Interruption identity.** The partial row stayed visible after the user
  interrupt and the turn settled `cancelled`. `session.idle` was not used as a
  settlement signal.
- **Adoption ordering.** The driver prompts immediately after adoption, while
  the synthetic heads-up may still be active. The prompt turn and the heads-up
  turn each settle with their own exact row; neither is left `pending`.
- **Restart honesty.** The restart pass did not synthesize an interruption for
  any completed turn and did not leave a queued/working/retrying turn behind.
  The post-restart prompt proved the reattached location still ingests.
- **Shadow safety.** The comparison row carries ids, lengths, digests, phases,
  and route counts only. Shadow mode never writes a durable row, opens a
  ledger, routes a peer, or publishes a patch.

## Latency and token metrics

Latency is prompt call to the durable terminal row, polled at 50 ms, on the
isolated fake provider with zero initial/turn-start delay and 20 ms chunks. It
is a comparative measurement, not a real-model SLA.

| Path | Samples | Wall clock |
|---|---:|---:|
| Native direct turn | 1 | 169 ms |
| Native workspace turn | 1 | 91 ms |
| User mention route to peer reply | 1 | 153 ms |
| Agent final-text route to peer reply | 1 | 215 ms |
| Retry (includes 2 s fixture backoff) | 1 | 2237 ms |
| Rollback legacy task | 1 | 85 ms |

Token and tool-schema evidence (provider request, chars/4 estimate; schema
characters are exact JSON):

| Surface | Ensemble tools | Ensemble schema | Estimated prompt tokens | Model round-trips |
|---|---:|---:|---:|---:|
| Native (`on`) | 5 | 2,143 chars / 536 tok | 7,718 | 1 |
| Legacy rollback (`toolSurface:legacy`) | 11 | — | — | 1 |

The native workspace request carried both the `ensemble_turn` and
`ensemble_dispatch_budget` blocks (`turnContextInjected` and
`budgetContextInjected` were true). The direct request did not need the group
turn block, as expected.

The spec sets no numeric latency or token threshold beyond "measure, do not
claim". #225's measured schema reduction is the quantitative target (5 native
tools vs 11 legacy; 536 vs 1,371 schema tokens) and this run reproduces the
native half exactly. The fake-provider wall clock is not offered as a
real-model SLA; no exception is being claimed for an unmet numeric budget.

## Rollback

Rollback was exercised live, not just read from settings:

1. `settings.update { nativeFirst: "off", toolSurface: "legacy" }`.
2. `agent.sessionBinding` reported mode `off`.
3. `message.send` created a normal delegated task; it replied on the old path.
4. The provider request carried 11 Ensemble tools, the legacy surface.
5. Every durable native turn remained present after rollback.
6. `settings.update { nativeFirst: "on", toolSurface: "native" }` restored the
   native surface without deleting history.

The previous-release rollback contract (channel reads plus the migrated legacy
store) remains the storage rollback path in
[2026-11-11-ticket-226.md](2026-11-11-ticket-226.md).

## Shadow mode

`nativeFirst: "shadow"` now runs the #215/#216 turn semantics into an invisible,
in-memory sink:

- inbox/text/execution events create shadow turns using the same deterministic
  identities as the visible path;
- the pure #219 planner counts the routes that would be admitted, but no ledger
  is opened and no peer turn or refusal is created;
- no durable message, turn, patch, stream frame, or Work card is written;
- at settlement the sink reads the native transcript once and records a bounded,
  content-free comparison row (ids, channel kind, text length and digest,
  shadow/expected phase, route counts, match booleans).

The live probe observed `ingested: true`, `visiblePathUnchanged: true`, and
`comparisonRows: true`; the row settled `phase:"replied"` with text length 33
and 0 planned routes. The service logged one `native.shadow.compare` row, and
the scenario fails if prompt content appears in the service logs. #230 is
closed with [2026-11-11-ticket-230.md](2026-11-11-ticket-230.md).

## Follow-ups resolved

| Issue | Resolution |
|---|---|
| [#228](https://github.com/heyimteee/ensemble/issues/228) | Native prompt chips derive a bounded size from explicit fields or the host `data` payload; live chip size is 31 bytes. Closed with [2026-11-11-ticket-228.md](2026-11-11-ticket-228.md). |
| [#229](https://github.com/heyimteee/ensemble/issues/229) | A prompt steered into an in-flight adoption heads-up execution is claimed by its own turn and both participants settle separately. Closed with [2026-11-11-ticket-229.md](2026-11-11-ticket-229.md). |
| [#230](https://github.com/heyimteee/ensemble/issues/230) | Shadow mode ingests into an invisible sink, records a content-free comparison row, and leaves the visible path untouched. Closed with [2026-11-11-ticket-230.md](2026-11-11-ticket-230.md). |

The final `npm run verify` on the merged branch is **1810/1810**; the
native-first live matrix is **65/65 + 16/16 with 0 gaps**.

## Child tickets

All native-first child tickets are closed. The evidence map is in
[2026-11-11-native-first-children.md](2026-11-11-native-first-children.md).
#210, #215, #216, #217, #218, #223, #225, #226, #228, #229, and #230 have
dedicated committed records. #211, #212, #213, #214, #219, #220, #221, #222,
and #224 closed with a merge/verification comment naming the commit and
full-suite count; the index links those comments and does not upgrade them into
live evidence.

## Suites not rerun

- `npm run test:live:all` / the real-host TUI run: optional, non-deterministic,
  and the #225 record already reports the unchanged-baseline workspace-wizard
  stop. Not rerun here; recorded as **not run**, not a pass.
- `test:live:sizes`, `test:live:lifecycle`, `test:live:subagent`,
  `test:live:multilocation`, and `test:live:latency`: unchanged by #227 and the
  native-first fixes, and cited from their committed records (#177,
  #165/#177, #188, #146/#157/#164, #143/#177). No new claim is made for them.
- `npm run verify`, `npm run test:live:probe`, `npm run test:live:fake:all`,
  and `npm run test:live:native-first` were all rerun on the merged branch and
  passed. The real-host/optional suites above remain not rerun.

## Privacy

The committed record, driver output, fixtures, and fake provider logs contain
names, ids (randomly generated), booleans, counts, character lengths, MIME
names, and estimated token counts only. The attachment check asserts the
durable chip carries no bytes, source path, or store path. The scenario's
privacy gate rejects the isolated harness roots, the server password, `/home/`,
inline `data:` payloads, the attachment content marker, and shadow prompt
content in the recorded output or service logs. Service logs still carry the
host project directory by design; they are local run artifacts and are not
committed.

## Reproduce

```sh
source ~/.nvm/nvm.sh && nvm use 26.12.1
# Optional: pin the target host release
OPENCODE_BIN=/path/to/opencode-2.2.6 npm run test:live:native-first
```

A clean run passes all 65 main checks and all 16 restart checks with 0 gaps,
including attachment size, immediate post-adoption prompt, and shadow
ingestion/comparison.
