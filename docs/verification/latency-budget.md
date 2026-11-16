# Latency budget and SLO

Ticket #260, parent spec #255. The probe measures three separate paths so a
slow model is never mistaken for a slow UI.

## Metrics and budgets

| Metric | Boundary | Reference budget |
| --- | --- | --- |
| `rail` | `tmux send-keys` -> first capture showing the moved rail cursor | p95 <= 50 ms (gated) |
| `patchCard` | `task.delegate` RPC -> durable patch -> real Work-card render | p95 <= 250 ms (gated) |
| `firstToken` | `task.delegate` RPC -> first visible model reply | report only (never gated) |

`patchCard` is the deterministic fixture from ticket #260. It invokes the
public `task.delegate` RPC, reads the durable `changes.since` patch after that
version, applies the subtask changes to a client-side state map, and renders
the same pure `workCardForTask` mapping the TUI uses. It never waits for a
model token, so the fake provider's hold cannot dominate the card number.

`firstToken` uses the fake provider's short reply and stays report-only: the
model delay is not a UI cost. It is logged with the RPC and first-visible
split for context.

## Profiles

| Profile | Rail p95 | Patch-card p95 | Use |
| --- | --- | --- | --- |
| `reference` | 50 ms | 250 ms | Quiet reference host and nightly job |
| `smoke` | 500 ms | 5000 ms | PR runner; generous because a shared runner is not a reference host |
| `report` | none | none | Local measurement only |

The default is `smoke`. A budget failure exits nonzero; a missing prerequisite
still follows the live harness skip contract, and `ENSEMBLE_LIVE_REQUIRE=1`
turns that skip into a failure in CI.

## Commands

```sh
# Local smoke measurement and gate (default profile)
npm run test:live:latency

# Reference-host gate: strict budgets
ENSEMBLE_LIVE_REQUIRE=1 npm run test:live:latency:reference

# More stable reference samples
ENSEMBLE_LATENCY_PROFILE=reference \
ENSEMBLE_LATENCY_SAMPLES=20 \
ENSEMBLE_LATENCY_CARD_SAMPLES=10 \
npm run test:live:latency

# Deliberate regression: must fail the reference gate
ENSEMBLE_LATENCY_PROFILE=reference ENSEMBLE_LATENCY_REGRESSION_MS=1000 \
npm run test:live:latency

# Evaluate a saved result with the pure evaluator
npm run latency:budget -- path/to/latency-result.json
```

Run `npm run test:live:preflight` first on a new reference host. The reference
gate expects the pinned live versions (Node 26.12.1, OpenCode 2.2.7 at the time
of this record), Linux, tmux, and a quiet machine. `verify.yml` runs the smoke
profile in the `latency-smoke` PR job, and `nightly.yml` runs the reference
profile in `latency-reference`. The pure evaluator is covered by
`npm run verify` on every PR. The separate `latency.yml` workflow was removed
by ticket #261 so each gate has one owner.

## Baseline

Measured on the reference host (Linux, Node 26.12.1, OpenCode 2.2.7, tmux,
140x50 TUI). The patch-card values are the headless RPC -> durable patch ->
card render path; the old tmux card-appearance number is not a budget metric.

| Metric | Samples (ms) | p50 | p95 | Budget |
| --- | --- | --- | --- | --- |
| `rail` | 9, 9, 9, 9, 9, 9, 9, 10, 9, 9 | 9 | 10 | 50 |
| `patchCard` | 36, 32, 33, 31, 33 | 33 | 36 | 250 |
| `firstToken` | 672 | 672 | 672 | report only |

The deliberate regression run added 1000 ms per patch-card sample and failed
with `patchCard p95=1051ms exceeds 250ms`.

## Failure policy

- A budget failure is a product failure; the live matrix never retries it.
- A rail repaint or first-token wait timeout is a harness timing failure and
  follows the [flake policy](flake-policy.md) (one classified retry).
- A missing prerequisite is a skip locally and a failure under
  `ENSEMBLE_LIVE_REQUIRE=1`.
- The probe writes the result JSON to `ENSEMBLE_LATENCY_OUT` when set, so CI
  uploads it with the redacted failure artifacts.

## Privacy

The result contains fixture sample timings, counts, and generated fixture
titles only. It never contains conversation content, credentials, file bytes,
or private paths.
