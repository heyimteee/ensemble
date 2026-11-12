# Ticket #258: Node support policy and CI matrix

- **Date:** 2026-11-12
- **Branch:** `ticket/258-node-matrix`
- **Base:** `integration/prod-partials` at `a1fe441` (main baseline)
- **Spec:** parent #255, P4; ticket #258
- **Engine:** `>=22.23.4` (oldest passing line)
- **Runtime gate:** `assertSupportedNode()` at the server plugin, TUI plugin, and doctor CLI entry points

## Matrix

`npm run verify` (strict no-emit typecheck plus the unit suite) ran on each
candidate line. All three passed with the same 1,953 tests and no skips.

| Node | npm | `npm run check` | `npm test` | Result |
| --- | --- | --- | --- | --- |
| 22.23.4 | 10.9.9 | Pass | 1,953 pass, 0 fail | **Pass** |
| 24.22.1 | 11.19.1 | Pass | 1,953 pass, 0 fail | **Pass** |
| 26.12.1 | 12.2.1 | Pass | 1,953 pass, 0 fail | **Pass** |

No candidate failed on a Node API, so the floor stays at the oldest tested
release instead of being raised. Node 22.23.4 is also the first 22-line
release used for this gate; earlier 22 releases were not tested and are not
claimed.

`@opentui/core` 0.7.0 (a development dependency for typechecking and a peer
supplied by the host at runtime) declares `engines.node >=26.4.0`. npm's
default engine behavior only warns, so the deterministic gate runs on 22 and
24; the real TUI and live suites remain on Node 26.12.1. Peer ranges are owned
by ticket #257 and were not changed here.

## Runtime check

`src/v2/node-version.ts` exports the pure parser, comparator, floor, and
`assertSupportedNode()`. The server plugin, TUI plugin, and doctor CLI call it
at load/start. A too-old runtime throws `NodeVersionError` with code
`unsupported_node` and this copy:

```
Ensemble requires Node >=22.23.4 (tested lines: 22.23.4, 24.x, and 26.x);
this process is running Node <version>. Upgrade Node and restart OpenCode.
```

The pure tests cover the tested lines, newer releases, the 22.23.3 boundary,
older lines, and unparseable values.

## CI

`.github/workflows/node-matrix.yml` runs `npm ci` and `npm run verify` on
22.23.4, 24.22.1, and 26.12.1 with `fail-fast: false`. `verify.yml` keeps the
live fake/empty and multi-location suites on the current tested Node
26.12.1; no live suite runs on the older lines.

## Commands

```sh
source ~/.nvm/nvm.sh
nvm use 22.23.4 && npm run verify
nvm use 24.22.1 && npm run verify
nvm use 26.12.1 && npm run verify
```

The worktree shares the repository `node_modules`; the matrix runs use the
same locked dependency tree.

## Live check

On Node 26.12.1, OpenCode 2.2.7, tmux 3.5a, and fd 10.2.0:

- `ENSEMBLE_LIVE_REQUIRE=1 npm run test:live:preflight` passed.
- `ENSEMBLE_LIVE_REQUIRE=1 npm run test:live:fake:all` passed before merging
  `integration/prod-partials` (`fake` 458s, `fake-empty` 9s, 2 passed).
- After merging #263, the same suite fails reproducibly at
  `leader visible on group surface`. The wider post-#263 chat wraps `leader`
  and `FakeAgent` onto separate rows, so the contiguous `leader FakeAgent`
  assertion no longer matches. A detached run of integration `26b32c3` alone
  fails at the same step; the failure is inherited from #263, not from this
  ticket or the version gate. It is recorded, not retried or papered over.
  Live suites were not run on Node 22 or 24.
