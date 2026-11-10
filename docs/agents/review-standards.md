# Reviewer standards

Judgement calls only. Mechanical rules belong in automated checks: `npm run verify`, the live checks, and CI. If a command can decide a rule, put it there instead of restating it here.

Read this with the [contribution guide](../../CONTRIBUTING.md) and the [review workflow](review-workflow.md). A documented repository standard overrides a generic code smell; report a breach as a finding and a smell as a labelled judgement call.

## Behavior before text

Test what a caller or user observes at a public seam: an RPC result, a rendered chat row, a persisted snapshot shape, or a native permission state. Do not assert a constant against itself, a helper against a recomputation, or that an internal field merely exists.

When a refactor that preserves behavior breaks a test, the test was coupled to the implementation. Negative behavior counts too: assert that no task, assignment, or permission was created, not only that an error string appeared.

## Narrow source-text wiring guards

Source-text assertions are an exception for wiring that public behavior cannot reach cheaply, such as a component passing a prop into the host or a command registered in an import-time map. A wiring guard must:

- name the single wiring fact it protects;
- stay small, using one or two checks against the narrowest owning file;
- fail only when the wiring changes, not when wording, formatting, or unrelated lines move;
- point to the behavior test or live check that covers the outcome when one exists.

Do not use source-text tests to pin domain constants, copy, or whole implementations. If a public behavior test is practical, use it instead.

For example, this guard is acceptable because it slices one named method and asserts the single call inside it; the behavioral test named below carries the outcome:

```ts
// turn-finalization.test.ts: the policy matrix and service behavior tests prove
// every decision; this pins only that runTask is the single owner of the call.
const start = source.indexOf("private async runTask(")
const end = source.indexOf("\n  private ", start + 1)
const runTask = source.slice(start, end)
assert.match(runTask, /decideTurnFinalization\(/)
```

The outcome stays with `ticket194: the turn-finalization decision matrix covers every managed turn shape` and the service behavior tests. The existing `src/v2/turn-finalization.test.ts` guard also checks the complement: no other method contains the call.

This guard is rejected:

```ts
// Rejected: fixed offsets over the whole file drift on unrelated edits, and an
// identifier match passes on an import or comment even when no method calls it.
const at = source.indexOf("private async runTask(")
assert.ok(source.slice(at, at + 4000).includes("decideTurnFinalization("))
assert.ok(source.includes("decideTurnFinalization"))
```

The first check guesses a byte window instead of slicing the method, so unrelated lines shift it and a call elsewhere in the window satisfies it. The second passes with no call at all. Neither proves that `runTask` owns the call.

These examples illustrate the rule above; they do not replace the judgement call about whether a public behavior test can cover the wiring.

## One source of truth for derived state

Before accepting a new flag or field, search for an existing source that already answers the question. Derive the value from the canonical record at the point of use, or store one value and compute the rest. Keep the derivation in one helper.

A mirrored flag that can disagree with its source is a finding even when both values currently agree. Do not re-derive the same state with slightly different rules in the service, the TUI, and the tests.

## Canonical constants and aliases

Reuse the existing constant, type union, or alias table. Do not add a second literal for the same token, command, status, or limit. Extend the canonical collection in place instead of shadowing it with a local copy.

Alias sets must be one collection consumed by parsing, help, and tests. An alias added to only one of those is a finding. If a value is both a domain term and a display label, keep the domain value and name the display helper separately.

## Domain-only glossary entries

[`GLOSSARY.md`](../../GLOSSARY.md) defines domain concepts and their boundaries, not implementation policy, acceptance criteria, file paths, schema fields, or UI copy. An entry earns its place when a contributor could otherwise use the term wrongly.

Keep definitions concise and preserve `_Avoid_` lists for competing synonyms. Put behavior detail in [implementation notes](../implementation.md) or the ticket, and link rather than defining the same concept twice.

## Regression matrix for adjacent payload shapes

When a change touches a payload that neighboring features also construct or consume, review every adjacent shape, not only the changed one:

- enumerate the producers and consumers that can emit that shape, such as solo, DM, group, multi-agent, mixed anchors, skill text, and ordinary text;
- table-drive cases at the existing handler or service seam, one row per combination, with the invariant in the assertion (ownership, exact text, file reference, atomicity);
- include the previously regressed combination and prove the test fails if it is reintroduced;
- use the existing public seam; do not add a runtime seam for the matrix.

## Reporting

Cite the standard by section for each judgement finding. Quote the failing command for mechanical failures. State which checks are manual or unexecuted; the [live harness contract](../../scripts/README.md#skip-versus-fail) defines skip reporting, and a skipped check is not a pass.
