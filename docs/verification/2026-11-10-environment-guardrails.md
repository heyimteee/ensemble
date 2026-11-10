# Environment guardrails verification (#202 / #208)

Status: **verified locally on Linux/tmux and on hosted GitHub Actions; the
controlled live-failure artifact upload, the helper exercises, and the docs
links are recorded below. A post-review repair fixed the inert diff check and
the artifact log-source privacy bug; the final code run and controlled run are
recorded below. Real-model checks, macOS/Herdr, and the user's live host were
not run.**
Date: 2026-11-10
Issue: [#208](https://github.com/heyimteee/ensemble/issues/208)
Parent spec: [#202](https://github.com/heyimteee/ensemble/issues/202)
Child tickets: [#203](https://github.com/heyimteee/ensemble/issues/203),
[#204](https://github.com/heyimteee/ensemble/issues/204),
[#205](https://github.com/heyimteee/ensemble/issues/205),
[#206](https://github.com/heyimteee/ensemble/issues/206),
[#207](https://github.com/heyimteee/ensemble/issues/207)
Branch: `ticket/208-verify-env`
Worktree: `/home/tristan/dev/ensemble-208`
Integration branch: `integration/env-guardrails` (pre-review run at `609e274`;
final code tip `6c849f4`; this record commit is the final documentation tip)
Base: `integration/core-turn-reliability` at `3bfa21f` (this branch is stacked;
merge the environment branch after #192 lands on `main`)

This record proves the environment guardrails added by the child tickets:

1. The hosted `verify` job runs `git diff --check` and the full
   `npm run verify` gate.
2. The hosted `live` job runs the isolated native-subagent probe with
   `ENSEMBLE_LIVE_REQUIRE=1` and the pinned Node/OpenCode/tmux/fd toolset.
3. A failed live job retains and uploads the redacted diagnostic set; a
   controlled failure proves the artifact is actually uploaded and
   downloadable.
4. The worktree and integration-merge helpers pass shell syntax checking and
   were exercised against temporary branches/worktrees, including their
   refusal, conflict, and dirty-worktree paths.
5. The service map and the service-log pointer resolve.

## Environment

| Item | Value |
|---|---|
| OS | Debian GNU/Linux 13 (trixie), Linux 6.12.116+deb13-amd64 x86_64 |
| Terminal host | tmux 3.5a |
| Node | v26.12.1 |
| npm | 12.2.1 |
| OpenCode (isolated probe host) | `opencode v2.2.6` |
| Git | 2.47.3 |
| Hosted CI runner | `ubuntu-latest` for `verify`; `ubuntu-24.04` for `live` |
| Fake provider | dependency-free local OpenAI-compatible server |
| User's live host | **not restarted, reloaded, or reconfigured** |
| macOS/Herdr | Not available; not run |
| Real model/provider | Not run |

The live harness creates its own temporary project, HOME, XDG
config/data/state/cache, OpenCode server, TUI, fake provider, and tmux
sessions. It loads only the worktree plugin and never uses the user's
credentials or live workspace. CI uses the same isolated harness and the
deterministic fake provider.

## Commands and results

| Command | Result |
|---|---|
| `npm run verify` | **Pass** — strict type check; **1618 tests passed, 0 failed, 0 skipped, 0 todo**; 49.2 s test duration, 50.4 s wall clock. |
| `npm run verify` at the post-review code tip (`6c849f4`) | **Pass** — **1625 tests passed, 0 failed, 0 skipped, 0 todo**, including the committed-whitespace/conflict diff checks and the ambient-log retention regression. |
| `ENSEMBLE_LIVE_REQUIRE=1 ENSEMBLE_LIVE_ARTIFACTS=/tmp/opencode/verification-208/subagent npm run test:live:subagent` | **Pass** — isolated real OpenCode 2.2.6 host + deterministic fake provider; **40 s wall clock**. Delayed wake-up `native.subagent.wakeup.received` measured **3427 ms**; doctor reported **0 mismatches across 1 location**; logs contained none of the fixture answer markers. |
| Same probe at the post-review code tip (`6c849f4`) | **Pass** — **35 s wall clock**; delayed wake-up **3427 ms**; doctor **0 mismatches across 1 location**; no answer markers in the service/TUI logs. |
| `bash scripts/ci-diff-check.sh 3bfa21f HEAD` and `... 609e274 HEAD` | **Pass** — the post-review commit-range check found no whitespace or conflict residue. |
| `git diff --check` | **Pass** — no whitespace errors or conflict residue. |
| `bash -n scripts/worktree-create.sh && bash -n scripts/integration-merge.sh` | **Pass**. |
| Link check over the changed docs | **Pass** — 131 relative links and anchors across 8 files, 0 failures. |

## Hosted CI

### Pre-review integration run

The `integration/env-guardrails` branch was pushed at `609e274` (branch only;
`main` was not pushed). This is the pre-review history; the post-review code
run below is the final gate. The first attempt's `Install tmux and fd` setup step
stayed in progress for about 20 minutes and was cancelled; attempt 2 used the
same commit and completed green:

| Item | Value |
|---|---|
| Run id | **42761614338** (attempt 2) |
| Commit | `609e274fc4901fdcae98329b83e0474d091ccb55` |
| Workflow | `Verify` |
| `verify` job | **Pass** in 1m19s — `Check whitespace and conflict residue` and `Run npm run verify` succeeded. |
| `live` job | **Pass** in 9m57s — preflight, fake/empty suite, multi-location probe, and native-subagent probe succeeded. |
| Native-subagent step | **`Native-subagent live probe`** succeeded with `ENSEMBLE_LIVE_REQUIRE=1`. |
| Diff-check step | **`Check whitespace and conflict residue`** succeeded. This pre-review run used the bare `git diff --check`; the post-review run uses the range script below. |
| Artifact upload | **Skipped** on success, as designed. |

The `verify` job completed in **1m19s**. The `live` job stayed inside its
30-minute timeout; the native-subagent step ran the same pinned host and fake
provider measured locally. Attempt 1 was cancelled after its pre-existing
`Install tmux and fd` setup step hung; no assertion or check was modified for
attempt 2.

### Post-review guardrail repair

Code review of the first integration run found two real defects in the new
guardrails, both fixed before the final gate:

- The verify job's `git diff --check` was bare, so on a clean checkout it
  compared the worktree to the index and could not see committed whitespace or
  conflict residue. The final job runs `scripts/ci-diff-check.sh` against the
  push `before` or pull-request base, with `fetch-depth: 0` and an initial-push
  fallback. The check was proven against committed trailing whitespace and
  committed conflict markers.
- Failure-artifact retention preferred an ambient `ENSEMBLE_LOG_DIR` over the
  isolated `LIVE_STATE` logs. The final retention reads only the isolated
  `LIVE_STATE` service logs; a regression test plants an ambient log and
  proves it is never copied.

The shared worktree helpers were also consolidated, the service map lost its
duplicated constants, the runtime guide now links to the authoritative harness
docs, and the integration merge helper checks the merge range. The helper
exercise evidence below was rerun after those changes.

Final code commit: `6c849f4` (merge of review-fix commit `e9ca31d`). Final
hosted code run: **42764450341**, commit `6c849f4`.

| Job | Result |
|---|---|
| `verify` | **Pass** in 1m21s — `Check whitespace and conflict residue` and `npm run verify` succeeded. |
| `live` | **Pass** in 10m26s — preflight, fake/empty suite, multi-location probe, and native-subagent probe succeeded. |
| `Native-subagent live probe` | **Pass** with `ENSEMBLE_LIVE_REQUIRE=1`. |
| `Upload live failure artifacts` | **Skipped** on success, as designed. |

The record commit is documentation-only and triggers its own final run; that
run is recorded in the #208 closing comment rather than recursively embedded
here.

### Pre-review controlled live failure and artifact upload

To prove the failure path without waiting for a real product regression, a
disposable branch was created from `609e274` with one deliberate failure after
the native-subagent probe's last assertion:

```sh
# scripts/live-subagent-probe.sh, after the successful probe log
live_fail "ticket #208 controlled CI failure artifact probe"
```

The branch was pushed as `test/208-controlled-failure` and deleted after the
evidence was downloaded. The run was:

| Item | Value |
|---|---|
| Run id | **42762162487** (attempt 1) |
| Commit | `bdc154aecf0d85bee02ae13cec0b4f4085d23a1c` |
| `verify` job | **Pass** in 1m15s, including `git diff --check` and `npm run verify`. |
| `live` job | **Failed as intended** in 10m32s at `Native-subagent live probe` with `ticket #208 controlled CI failure artifact probe`; the probe's own assertions had already logged `native subagent probe passed (barrier)`. |
| Upload step | **Pass** — `Upload live failure artifacts` ran because the job failed. |
| Artifact | **`live-failure-artifacts-1`** (artifact id `13739070371`), 19,545 bytes, 15 files, seven-day retention. |

The downloaded artifact was inspected for the expected files and for private
material:

| Path | Evidence |
|---|---|
| `subagent/meta.txt` | `scenario: subagent`, `exit_status: 1`. |
| `subagent/logs/` | `doctor.txt`, `doctor.json`, `doctor-failure.txt`, `server.log`, `tui.log`, `fake.log`. Both doctor reports: `Mismatches: none` and `Summary: 0 mismatches across 1 location`. |
| `subagent/service-logs/` | Three service JSONL and three TUI JSONL files. Event counts include `service.start` (3), `native.subagent.created` (1), `native.subagent.finished` (1), `native.subagent.barrier.released` (1), `native.subagent.wakeup.wait` (1), `task.completed` (3), and `dispatch.group.created` (1). |
| `subagent/captures/` | Pane captures for the fake, serve, and TUI sessions. |

Privacy scan of the downloaded set:

- **No credentials or host descriptors**: no unredacted `Authorization`
  header, bearer token, API key, `service.json`, `config.json`, or
  fake-provider URL file was present; no `/home/tristan` path appeared.
- **No user conversation content**: CI uses a disposable project and the
  deterministic fake provider. The only conversational text is the synthetic
  fixture text in `logs/fake.log` (`promptTail` fields, including the
  `fake-subagent-wakeup-marker` and `fake-native-late-report-marker` strings).
  That is test data, not a user's conversation, and is the documented
  fixture-text boundary in `scripts/README.md`. The service logs, TUI log,
  doctor output, and captures contained none of the answer markers.
- The artifact never contains the isolated HOME, config, project, dependency
  directory, fake-provider URL file, or host descriptors.

### Post-review controlled live failure and artifact upload

After the review repair, a second disposable branch was created from the final
code tip `6c849f4` with the same deliberate failure after the native-subagent
probe's last assertion. The branch was pushed as
`test/202-controlled-failure` and deleted after the evidence was downloaded.

| Item | Value |
|---|---|
| Run id | **42764462126** |
| Commit | `d98a342` |
| `verify` job | **Pass** in 1m22s, including `git diff --check` and `npm run verify`. |
| `live` job | **Failed as intended** in 10m26s at `Native-subagent live probe` with `ticket #202 controlled CI failure artifact probe`. |
| Upload step | **Pass** — `Upload live failure artifacts` ran because the job failed. |
| Artifact | **`live-failure-artifacts-1`**, 16 files, downloaded to `/tmp/opencode/spec-202/controlled-artifact-final/`. |

The downloaded artifact contains `subagent/meta.txt` (`exit_status: 1`),
doctor/doctor-failure output with `Mismatches: none`, server/TUI/fake logs,
three service and three TUI JSONL files, and pane captures. A privacy scan
found no credentials, host descriptors, `/home/tristan` paths, ambient log
directory, or user conversation content. The pre-review artifact above remains
as history; the post-review run is the final evidence for the repaired
retention path.

## Helper exercise

Both helpers were run from the ticket worktree against temporary branches and
worktrees, then removed. They never touched unrelated worktrees and were never
imported by the plugin or TUI.

### Worktree helper

| Exercise | Result |
|---|---|
| Create `test/208-source` from `test/208-base` (`609e274`) at `/tmp/opencode/verification-208/source` | **Pass** — printed `BASE test/208-base 609e274`, `WORKTREE`, `BRANCH test/208-source`, and `DEPS /home/tristan/dev/ensemble/node_modules`; the dependency link was created. |
| Create `test/208-integration` from the same base | **Pass** — same output shape; used as the disposable integration worktree for the merge exercise. |
| Existing path | **Refused, exit 1** — `worktree-create: worktree path already exists: /tmp/opencode/verification-208/source`. |
| Existing branch | **Refused, exit 1** — `worktree-create: branch 'test/208-source' already exists`. |
| Dirty base | **Refused, exit 1** — `worktree-create: base branch 'test/208-base' is checked out in a dirty worktree: /tmp/opencode/verification-208/base`. |

### Integration merge helper

| Exercise | Result |
|---|---|
| Clean no-fast-forward merge of `test/208-source` into `test/208-integration` | **Pass** — merge commit `db4b17f7e4b07dfcb377753a95fed3b2cb8c93fe`, parents `609e274` and `50cb25e`; `VERIFY PASS`; 1618/1618 tests. |
| Conflicting source branch | **Stopped, exit 1** — `CONFLICT (add/add): Merge conflict in tmp-helper-exercise.txt`; printed the conflicted path and `RESULT conflict`; left the merge in progress. It did not resolve the conflict. |
| Dirty integration worktree | **Refused, exit 1** — `integration-merge: integration worktree is not clean` with the untracked file listed. |
| Cleanup | The temporary worktrees and branches were removed; `git worktree list` no longer contains them. The user's existing worktrees were not modified. |

The post-review helper versions were re-exercised against a disposable minimal
repository: worktree create, existing path/branch refusal, dirty-base refusal,
unrelated-worktree safety, clean no-ff merge plus verify, dirty/committed-
whitespace refusal, and a conflict stop with merge-in-progress handling. The
helpers remained developer tooling only; no plugin or TUI import was added.

## Docs links

The service map, the runtime-guide log pointer, the integration workflow, the
reviewer example, and `scripts/README.md` were checked for relative links and
anchors:

```sh
node /tmp/opencode/verification-208/check-links.mjs \
  docs/verification/2026-11-10-environment-guardrails.md \
  AGENTS.md docs/README.md docs/agents/service-map.md \
  docs/agents/integration-workflow.md docs/agents/opencode-tui-runtime.md \
  docs/agents/review-standards.md scripts/README.md
# checked 131 links across 8 files; failures=0
```

The reviewed files were `AGENTS.md`, `docs/README.md`,
`docs/agents/service-map.md`, `docs/agents/integration-workflow.md`,
`docs/agents/opencode-tui-runtime.md`,
`docs/agents/review-standards.md`, `scripts/README.md`, and this record. The
runtime guide names `${XDG_STATE_HOME:-$HOME/.local/state}/ensemble/logs` and
`npm run logs:summary -- --dir <dir>` with the no-content-in-issues rule. The
service map covers lifecycle, retry/delivery holds, dispatch ledger, handoffs
and completion, batch review, native subagents, stream settlement, turn
finalization, store/feed, doctor, and the TUI boundary, and links the owning
ADRs/contracts.

## Artifacts

Local artifacts (not committed; review before sharing):

- `/tmp/opencode/verification-208/verify-console.txt` — full `npm run verify`.
- `/tmp/opencode/verification-208/subagent-console.txt` — full native-subagent
  probe output.
- `/tmp/opencode/verification-208/subagent/` — `doctor.txt`, `doctor.json`,
  `fake.log`, `server.log`, `tui.log`, and `service-logs/*.jsonl`.
- `/tmp/opencode/verification-208/worktree-*.txt`,
  `merge-clean.txt`, `merge-conflict.txt`, `merge-dirty.txt`, and
  `link-check-final.txt` — helper and docs evidence.
- `/tmp/opencode/207-fail-artifacts3/artifact-probe/` — the #207 local
  controlled-failure set used as prior evidence: `meta.txt`, `logs/` (doctor,
  doctor-failure, fake, log-summary, server, tui), `service-logs/`, and
  `captures/`.
- `/tmp/opencode/verification-208/ci-artifact/subagent/` — the downloaded
  pre-review `live-failure-artifacts-1` CI artifact from run `42762162487`:
  `meta.txt`, `logs/`, `service-logs/`, and `captures/`.
- `/tmp/opencode/spec-202/controlled-artifact-final/live-failure-artifacts-1/subagent/`
  — the downloaded post-review artifact from run `42764462126`; 16 files,
  isolated-only service logs, and a clean privacy scan.
- `/tmp/opencode/verification-208/ci-controlled-live.log` — the controlled
  failure run's live-job log, including the deliberate failure and the
  `retained failure artifacts at .../live-artifacts/subagent` line.

The CI artifact was downloaded with:

```sh
gh run download 42762162487 -n live-failure-artifacts-1 \
  -D /tmp/opencode/verification-208/ci-artifact
```

The general form is `gh run download <run-id> -n
live-failure-artifacts-<attempt> -D <dir>`.

It is private diagnostic evidence. Cite event names, IDs, states, counts, and
reason codes rather than attaching content, per the
[service-log rule](../agents/opencode-tui-runtime.md#service-logs).

## Skips and residual limits

- **Real model/provider: NOT RUN.** The native-subagent probe uses the
  deterministic fake provider. It proves the plugin, service, host event,
  queue, card, and transcript seams, not a real model's decision to call a
  subagent or use a tool.
- **macOS/Herdr: NOT RUN.** The existing manual checklist remains the
  authority.
- **User's live host: NOT TOUCHED.** It was not restarted, reloaded, or
  reconfigured.
- **`main`: NOT CHANGED.** Only `integration/env-guardrails` and the
  disposable `test/208-controlled-failure` branch were pushed; the latter was
  deleted after the evidence was captured.
- The environment branch is stacked on `integration/core-turn-reliability`
  (`3bfa21f`). It should merge after #192 lands on `main`.
- The controlled failure is an injected `live_fail` after every probe
  assertion passed. It proves retention and upload, not the diagnosis quality
  of a natural product failure. The upload step is intentionally skipped on a
  successful live job.
- The post-review verify job runs `scripts/ci-diff-check.sh` against the push
  `before` or pull-request base, with `fetch-depth: 0` and an initial-push
  fallback. The check was controlled against committed trailing whitespace and
  committed conflict markers; the pre-review bare `git diff --check` history
  above is retained to explain the repair.
- The hosted `verify` job runs on `ubuntu-latest`; GitHub's migration notice
  for that label was the only annotation. The live job is pinned to
  `ubuntu-24.04`.
- The local probe runtime (40 s) includes host/TUI startup and the two
  restarts. GitHub Actions adds `npm ci`, tool installation, and the earlier
  live suites; the 30-minute live-job timeout is unchanged.

## References

- Parent spec: [#202](https://github.com/heyimteee/ensemble/issues/202)
- Verification ticket: [#208](https://github.com/heyimteee/ensemble/issues/208)
- Child tickets: [#203](https://github.com/heyimteee/ensemble/issues/203),
  [#204](https://github.com/heyimteee/ensemble/issues/204),
  [#205](https://github.com/heyimteee/ensemble/issues/205),
  [#206](https://github.com/heyimteee/ensemble/issues/206),
  [#207](https://github.com/heyimteee/ensemble/issues/207)
- Prior reliability evidence:
  [core turn reliability](2026-11-10-core-turn-reliability.md)
- Live harness and CI contract: [scripts/README.md](../../scripts/README.md)
- Integration workflow:
  [docs/agents/integration-workflow.md](../agents/integration-workflow.md)
