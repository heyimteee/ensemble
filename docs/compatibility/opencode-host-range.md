# OpenCode host support range

Status: **supported on OpenCode 2.2.6 and 2.2.7**
Tested: 2026-11-12
Host: Linux/tmux, Node 26.12.1
Tickets: [#255](https://github.com/heyimteee/ensemble/issues/255), [#257](https://github.com/heyimteee/ensemble/issues/257)

Ensemble separates the OpenCode **CLI** release from the
`@opencode/plugin` **host API** package it ships. The peer range declares the
API packages this build accepts; the runtime preflight checks the CLI release
reported by `ctx.app.version`. The two currently match by patch number, but
they are tracked as separate contracts.

## Supported matrix

| OpenCode CLI | `@opencode/plugin` API | Evidence |
| --- | --- | --- |
| **2.2.6** | 2.2.6 | Committed [native host contract](../verification/2026-11-10-native-host-contract.md); `compatibility.yml` runs the host probe and deterministic fake smoke |
| **2.2.7** | 2.2.7 | [2.2.7 re-verification](../verification/2026-11-10-native-host-contract.md#227-re-verification); `compatibility.yml` runs the host probe and deterministic fake smoke |

The canonical constants live in
[`src/v2/host-compatibility.ts`](../../src/v2/host-compatibility.ts):

- `SUPPORTED_OPENCODE_VERSIONS` — tested CLI releases (`2.2.6`, `2.2.7`).
- `OPENCODE_PLUGIN_PEER_RANGE` — peer range (`2.2.6 || 2.2.7`).
- `OPENCODE_PLUGIN_VERSION_BY_HOST` — CLI-to-API mapping.

`@opencode/plugin` stays an **optional** peer, as do `@opentui/core`,
`@opentui/solid`, and `solid-js`; OpenCode supplies them at runtime. The
repository still installs `@opencode/plugin` 2.2.1 for type checking. That is
the declaration baseline Ensemble compiles against, not a runtime support
claim.

## Runtime preflight

`EnsembleV2Service.start()` reads `ctx.app.version` once per service realm:

- A supported version produces no warning.
- An unsupported version writes one `warn`-level `host.unsupported` record and
  prints:

  ```text
  [ensemble] OpenCode 2.2.5 is not supported by this Ensemble build; supported hosts are 2.2.6 and 2.2.7 (@opencode/plugin 2.2.6 || 2.2.7). Ensemble will continue, but behavior on this version is untested.
  ```

- A missing or unreadable version stays quiet. The warning never replaces the
  normal setup failures: if a required host API (for example `ctx.rpc.register`)
  is absent, the location attachment still rejects and the service reference is
  released.

The warning is deliberately non-fatal: an unsupported host can still load the
workspace, but its behavior is untested. There is no automatic retry or
fallback.

## CI matrix

[`.github/workflows/compatibility.yml`](../../.github/workflows/compatibility.yml)
runs for each supported CLI release on Node 26.12.1:

1. `npm run test:live:preflight` with the expected CLI version pinned.
2. `npm run test:live:probe` — the isolated real-host contract probe against
   the deterministic fake provider.
3. `npm run test:live:fake:all` — the deterministic fake and empty-catalog
   smoke suites.

The workflow is separate from the Node-version matrix so the two support
policies can change independently. A sanitized host-contract record is uploaded
only when the probe fails; it never contains message text, file bytes,
credentials, or absolute paths.

## Upgrade policy

A new OpenCode host is unsupported until all of the following happen together:

1. Add the CLI release to `SUPPORTED_OPENCODE_VERSIONS` and the mapping.
2. Widen `OPENCODE_PLUGIN_PEER_RANGE` to the API package it ships.
3. Add the release to `compatibility.yml`.
4. Run the host probe and deterministic fake smoke on that release.
5. Record the result here and in the host-contract verification.

Do not widen the peer range to a floating `2.2.x` line without that evidence.
The [2.2.1 compatibility report](opencode-2.2.1.md) remains historical,
version-scoped evidence; it is not the current support range.
