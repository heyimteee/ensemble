# Changelog

All notable changes to Ensemble are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The tag-driven release workflow reads the `## [<version>]` section for the
version in `package.json` and uses it as the GitHub release body. A version
without a non-empty section is refused by the release preflight. The
`0.1.0-rc.2` entry is the current candidate note; the final public version and
announcement remain pending. These entries are release history, not a launch
announcement.

## [Unreleased]

- The public version, release tag, GitHub release, and announcement are pending
  the human-gated publish in #278. The candidate remains `0.1.0-rc.2`; no
  version bump is planned for the remaining manual check.

## [0.1.0-rc.2] - 2026-11-16

Release candidate for the first public package release: one MIT-licensed
OpenCode plugin package containing the server and TUI parts. The candidate
identity was set on 2026-11-16 and re-verified on macOS on 2026-11-17 after the
#281–#284 fixes. It is not published at the time of this entry.

### Added

- MIT license and the `@heyimteee/ensemble` npm identity: scoped name, public
  publish configuration, repository/homepage/bugs metadata, and a runtime-only
  `dist` allowlist. (#269)
- A built package: the server, TUI, and RPC entries are compiled JavaScript,
  the TUI uses the Solid OpenTUI transform, and the TUI runtime dependencies
  resolve from the installed plugin cache. (#279, #280)
- A clean-install proof through `opencode plugin add` into isolated OpenCode
  2.2.7 hosts: six native server tools, the installed TUI route, and the
  `/ensemble` command. (#279; #270 records the superseded `0.1.0-rc.1` TUI
  failure)
- A security baseline: threat model, permission-model review, accepted risks,
  `SECURITY.md` supported-version and private-reporting policy, Dependabot
  updates, and containment for a handoff symlink escape. (#271)
- Data classes and retention, a scoped JSON export, workspace delete, and the
  AGENTS v7 roster title/role disclosure guidance. (#272)
- Versioned backup/restore, additive upgrade notes, and package/state rollback
  with a rehearsed failed-restore path. (#273)
- Support intake through GitHub Issues, an incident runbook, a support matrix,
  and issue/PR templates with redaction rules. (#274)
- A tag-driven release workflow: token-free dry run, changelog-based notes,
  npm provenance, CycloneDX SBOM, and a release sign-off checklist. (#275)
- A repeatable fake soak harness, a redacted local support bundle, and an
  explicit no-telemetry/local-diagnostics policy. (#276)
- macOS/Herdr verification of the installed package through SSH: install, TUI
  route, fake E2E, and the manual checklist except mouse drag 1.7. (#277)

### Changed

- The published package ships compiled `dist/` JavaScript instead of raw
  TypeScript; `prepack` builds and typechecks the runtime closure. The tarball
  contains only `package.json`, `README.md`, `LICENSE`, and `dist/`.
- macOS/Herdr is verified for the installed path, with one manual check still
  pending (mouse drag, 1.7).

### Fixed

- An init interrupted by a service restart now restores `AGENTS.md` to its
  exact prior bytes and removes `.ensemble/init.json`; a workspace with no
  prior file is returned to no file. (#281)
- `NO_COLOR` now suppresses Work-card, border, statusline, and Braille color
  decoration while keeping state text and glyphs. (#282)
- `NO_COLOR` now also suppresses transcript agent-author and Markdown colors.
  (#284)
- The Work feed is reconstructed from durable state after a service restart,
  with one group header and one card per task and no manual reload. (#283)
- The newest settled native-session state is retained when the cap is reached;
  an active turn, inbox, row, watchdog, or deferred child is never evicted.
  (#276)
- CI live jobs and the compatibility matrix build `dist` after `npm ci`, and a
  contract test rejects a live workflow that omits the build. This fixed the
  release-blocking post-#279 CI failure. (#285)

### Verified

- `npm run verify` and `npm run docs:check` on the release candidate.
- Final-tip clean install at `b194b95` in an isolated OpenCode 2.2.7 / Node
  26.12.1 host: `test:install:rc` PASS; 124 runtime files, 507,824 bytes;
  `plugin list` reported `ensemble.v2 0.1.0-rc.2` from the package; six native
  server tools and the installed TUI route/`/ensemble` loaded.
- Final-tip deterministic fake E2E at `b194b95` on OpenCode 2.2.7:
  `test:live:fake:all` PASS; `fake` 407 s, `fake-empty` 9 s; 2 passed, 0 failed,
  0 skipped, 0 retries; local flake budget ok.
- Required CI at `4ccc410` is green: Verify (`verify`, `live-fake`,
  `live-native`, `live-multilocation`, `latency-smoke`), Compatibility
  (OpenCode 2.2.6 and 2.2.7), Docs, and Node Matrix. Verify and Compatibility
  each needed one rerun of failed jobs with no code change; the first attempts
  hit CI timing flakes (`filtering spawned fd per keystroke (13 -> 14)` and
  `typed text did not reach the TUI: s`). This is not a clean first pass.
- The package runtime is unchanged between `b194b95` and `4ccc410`; the later
  diff is CI workflows, the CI contract checker, and documentation.
- A 4-hour enforced soak at `b194b95` passed with 240 samples over 14,439 s and
  5,240 messages: 0 failures, queue/native settled, RSS growth 94.89 MiB/h
  (gate 256) and 19.14 MiB/1k messages (gate 64), no findings. The first run
  resolved OpenCode 2.3.0, which is outside the supported range; the
  supported-version 2.2.7 rerun is still in progress and is not claimed.
- The deterministic fake and native E2E matrices on OpenCode 2.2.6 and 2.2.7.
- The Node 22.23.4, 24.22.1, and 26.12.1 unit/typecheck matrix.
- The installed `0.1.0-rc.2` package on Linux (loopback registry) and macOS
  (Herdr/Ghostty), including the six server tools and the TUI route.

### Known limitations

- **Not published yet.** The public npm version/tag, GitHub release, and
  announcement are pending human approval. This section is a candidate note,
  not a launch announcement.
- **Windows is out of scope.** Native Windows and WSL are untested.
- **macOS mouse drag is not claimed.** Checklist item 1.7 was not run; no
  selection/copy behavior is verified. Cmd+C/Cmd+V passed.
- **Herdr prefix control is inconclusive.** The host test did not produce a tab
  or pane; no Ensemble key was observed to be intercepted, but the host-level
  claim is not proven.
- **Git-spec installs fail upstream in OpenCode 2.2.7.** `github:` and
  `git+https://` specs fail during git dependency preparation; use the npm
  package or the loopback registry.
- **No telemetry.** Ensemble does not upload logs or usage data; diagnostics
  are local and must be redacted before sharing.
- **The 4-hour soak passed on an unsupported host.** The enforced gate passed
  on OpenCode 2.3.0; the supported-version 2.2.7 rerun is still in progress and
  is not claimed. Do not treat the 2.3.0 result as a 2.2.7 support claim.
- **The macOS size-matrix load probe is Linux-only.** The size matrix passes
  with the load probe skipped; Braille glyphs depend on terminal font fallback
  on the tested Mac.

## [0.1.0-rc.1] - 2026-11-16

Unpublished clean-install candidate. It proved the server plugin install and
the six native tools; the TUI source entry failed to load, which led to the
built package in `0.1.0-rc.2`. Keep this entry for traceability; no public
artifact was published for it.
