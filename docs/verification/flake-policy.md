# Live harness flake policy

Ticket #256. This policy applies to every scenario run by
`scripts/live-matrix.sh` (`test:live:fake:all`, `test:live:all`).

## Principles

1. **Fix the source first.** A retry is evidence of a defect, not a fix. The
   observed workspace-wizard race was fixed by waiting for the field value and
   step readiness instead of sending the next key on a fixed schedule.
2. **Never hide a product failure.** A retry is allowed only for a classified
   TUI timing failure. Product assertions, unknown failures, and infrastructure
   failures never retry.
3. **Every retry is reported.** The flake report names the suite, the attempt,
   the classification, and the artifact directory. A retry that cannot be
   classified is a policy breach.
4. **A quarantine is not a pass.** It is a temporary, owned, and linked record
   of a known flake. The suite still runs and its result still appears in the
   report.

## Classification

The harness writes `failure.json` on every failed attempt. The matrix reads it
and classifies the failure:

| Classification | Source | Retry |
| --- | --- | --- |
| `timing` | A readiness or input wait: `live_require_ready_text`, `live_require_ready_absence`, `live_type`, pane selection, step arrival | Once per suite per run |
| `product` | An assertion mismatch or a value that does not match the contract | Never |
| `infrastructure` | Missing server URL/password, plugin not active, fake provider, port/disk/permission failure | Never |
| `unknown` | Anything the harness did not mark and the conservative message fallback does not recognize | Never |

The timing signal is structural, not prose. The readiness helpers call
`live_fail_timing`; ordinary assertions call `live_fail`. A generic
`live_require_text` timeout stays a product/unknown failure because a missing
reply can be a real defect.

## Retry policy

- At most **one** retry per suite per matrix run.
- The retry must follow a `timing` classification and the first attempt must
  have failed. A retry is never applied to a pass, skip, or quarantine.
- A retry that passes is reported as `PASS (flaky, retried once)` and counted
  in the flake report.
- A retry that fails stops the matrix like any other failure.
- The skip-versus-fail contract is unchanged: local prerequisites skip, and
  `ENSEMBLE_LIVE_REQUIRE=1` turns a skip into a failure. Skips never retry.

## Flake budget

- **0 unclassified retries** per run. A retry without a `timing` classification
  is outside the budget.
- **1 retry per suite per run** (the hard ceiling above).
- **10% flake rate over a 20-run window** (`scripts/flake-policy.ts`,
  `FLAKE_BUDGET`). A suite above the window budget must be fixed at the source
  or quarantined with an issue and owner.
- Any product, unknown, or infrastructure failure blocks the run regardless of
  the budget.

The report prints `budget=ok` or `budget=over` with the counts. The budget is a
review trigger, not a way to make a red suite green.

## Artifacts

On failure the harness preserves, outside the disposable live root:

```
$ENSEMBLE_LIVE_ARTIFACTS/
  failure.json           # suite, attempt, kind, message, artifact path, exit
  failure.txt            # human-readable summary
  panes/<session>.txt    # redacted pane capture per tmux session
  logs/server.log
  logs/tui.log
  logs/fake.log
```

Paths under the live base, live home, live project, and the caller's home are
replaced with `<live-base>`, `<live-home>`, `<live-project>`, and `<home>`.
The server password is redacted, and lines that look like credentials are
dropped. Artifacts are ephemeral diagnostic captures, not committed fixtures;
committed live fixtures use IDs, counts, lengths, and digests only.

The matrix writes `flake-report.json` beside the attempt artifacts and prints
the same rows. CI uploads `$RUNNER_TEMP/ensemble-live-artifacts` on failure.
Set `ENSEMBLE_LIVE_KEEP=1` locally to also keep the disposable live root and
tmux sessions.

## Quarantine

`scripts/flake-quarantine.json` is a JSON array. Every entry requires:

```json
{
  "suite": "fake",
  "issue": "https://github.com/heyimteee/ensemble/issues/256",
  "owner": "Tristan",
  "reason": "known TUI readiness flake while the fix lands",
  "since": "2026-11-12"
}
```

The matrix validates the file before running. A missing issue, a missing owner,
a duplicate suite, or a non-array file fails the run before any scenario starts.
A failing quarantined suite is reported as `QUARANTINE` with its issue and
owner, is never retried, and remains visible in the report. Quarantine entries
are reviewed at least monthly and removed when the source fix lands.

## Report

```sh
npm run test:live:fake:all
# or, from an existing records file:
node --experimental-strip-types scripts/flake-report.mjs report \
  --records /tmp/opencode/.../flake-records.jsonl \
  --out /tmp/opencode/.../flake-report.json
```

The report lists one row per attempt:

```
flake-report: suite=fake attempt=1 classification=timing artifact=<artifacts>/fake/attempt-1
flake-report: suite=fake attempt=2 classification=none artifact=<artifacts>/fake/attempt-2
flake-report: suite=fake attempts=2 failures=1 retries=1 flakeRate=50%
flake-report: flake budget: maxRetriesPerSuite=1 maxUnclassifiedRetries=0 unclassifiedRetries=0 unclassifiedFailures=0 retriesFailed=0 windowRuns=20 windowFlakeRate=10% budget=ok
```

The pure classifier, retry decision, quarantine validation, and report builder
live in `src/v2/flake-policy.ts` and are covered by
`src/v2/flake-policy.test.ts`. The matrix integration is covered by
`src/v2/live-matrix.test.ts` with stub scenarios.
