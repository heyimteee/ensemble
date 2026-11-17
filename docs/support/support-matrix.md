---
title: Support matrix and known limitations
description: Supported hosts, Node versions, platforms, live-suite prerequisites, and limitations.
version: 0.1.x
---

# Support matrix and known limitations

This page is the support boundary for the public preview. A supported
combination has test evidence in this repository. An unverified combination may
work, but it is not a support claim. A skipped or blocked check is not a pass.
The macOS/Herdr run is recorded in #277; the full manual checklist, including
1.7 mouse selection, passes on 2.2.7. Automatic copy-on-release is a host
preference and is not claimed.

If a platform or version is outside this matrix, the issue may be closed as out
of scope with a pointer here. See the [support policy](README.md) for the
channel and response expectations.

## Platforms

| Platform | Status | Evidence | Notes |
|---|---|---|---|
| Linux with tmux | **Supported** | [Production-readiness partials E2E](../verification/2026-11-16-prod-partials-e2e.md), the deterministic fake suites, and the real TUI acceptance | The tested terminal host is tmux 3.5a on Linux. Other terminals on Linux are untested. |
| macOS with Herdr | **Supported for the installed path on OpenCode 2.2.7** | [macOS/Herdr record](../verification/2026-11-16-ticket-277.md) | Installed `0.1.0-rc.2` on OpenCode 2.2.7, six server tools, TUI route in Herdr/Ghostty, full checklist, and the fake E2E pass. 1.7 passed with a pane-bounded Shift+drag and explicit copy; automatic copy-on-release is not claimed. Herdr prefix ownership is inconclusive host evidence. OpenCode 2.3.0 on macOS is not claimed. |
| Windows | **Out of scope** | None | Native Windows is not tested and is not a supported platform. Do not assume PowerShell, WSL, or a Windows terminal behaves like the Linux path. |
| Other Unix-like hosts | **Untested** | None | No support claim. |

Linux/tmux evidence is not macOS/Herdr evidence. See the
[macOS/Herdr checklist](../verification/macos-herdr-checklist.md) for the manual
procedure and its result legend.

## OpenCode and Node

| Component | Supported | Status | Notes |
|---|---|---|---|
| OpenCode `2.2.6` | Yes | Compatibility matrix and fake smoke pass | The host range is `2.2.6 || 2.2.7 || 2.3.0` |
| OpenCode `2.2.7` | Yes | Compatibility matrix and fake smoke pass | The previous primary live host |
| OpenCode `2.3.0` | Yes | Primary live host for the deterministic matrix | The PR matrix pins 2.3.0; the focused-text harness accepts the host's `#eeeeee` high-contrast tone |
| Other OpenCode 2.x releases | No | Untested | The plugin loads with a runtime warning; behavior is not supported |
| Node `22.23.4` | Yes | Unit and typecheck matrix | Minimum engine floor |
| Node `24.22.1` | Yes | Unit and typecheck matrix | Supported for the package |
| Node `26.12.1` | Yes | Unit matrix and all live suites | Required for live-suite reproduction |
| Node below `22.23.4` | No | Fails at plugin load | The load-time gate names the supported range and refuses to start |
| Other Node lines not listed above | No | Untested | Not in the matrix; no support claim |

The package engine is `>=22.23.4` and the peer range is `2.2.6 || 2.2.7 || 2.3.0`.
An unsupported OpenCode host still loads Ensemble, but Ensemble writes a
runtime warning. That warning is a boundary notice, not a compatibility pass.

## Terminal and layout

| Surface | Supported | Notes |
|---|---|---|
| 80x24 (minimum tested) | Yes | The smallest tested layout; Work becomes a right drawer below 96 columns |
| 100x30, 120x40, 160x50 | Yes | Covered by the size matrix and the work-item fit checks |
| Fewer than 80 columns or fewer than 24 rows | Untested | No support claim |
| Truecolor terminal | Yes | The default experience |
| `NO_COLOR=1` | Yes | Color decoration is suppressed; state text and glyphs remain |
| `ENSEMBLE_REDUCED_MOTION=1` | Yes | Decorative motion freezes at its final state |
| Screen readers, high contrast, font scaling | Host-dependent | See the [terminal accessibility checklist](../verification/terminal-accessibility-checklist.md); this is a manual host surface |

## Live-suite prerequisites

The live suites are the strongest evidence and the hardest to reproduce. They
require all of the following:

- Linux with tmux on `PATH` (the harness uses tmux panes and captures).
- Node `26.12.1`; the package engine floor is lower, but the live matrix uses
  the pinned live version.
- The pinned OpenCode host (`2.3.0` for the PR matrix; `2.2.6` and `2.2.7` for
  the compatibility runs) and `fd` (`10.2.0` in CI).
- Locked dependencies installed with `npm ci`.
- An isolated fake provider for the deterministic suites, or a configured host
  model catalog for the real-model acceptance.
- `ENSEMBLE_LIVE_REQUIRE=1` when a skip must fail the run; without it, a
  missing model or tool can skip a check.
- Sufficient disk and time for the lifecycle and fake suites; CI allows up to
  45 minutes for the fake/lifecycle job.

See [the live harness guide](../../scripts/README.md) for the exact commands,
artifacts, skip-versus-fail contract, and failure-artifact locations. A local
pass without the pinned host and tools is not equivalent to CI evidence.

## Known limitations

These are accepted boundaries, not open troubleshooting threads. Report a new
symptom through the [support policy](README.md) if it is not listed.

- **Stable `0.1.1` owns npm `latest`.** `@heyimteee/ensemble` publishes stable
  `0.1.1` on `latest` and `0.1.0-rc.3` on `next`. Pin the exact version in an
  install instruction. See the
  [0.1.1 release notes](../operations/release-notes-0.1.1.md).
- **Automatic copy-on-release is not claimed on macOS.** Checklist item 1.7
  passed with a pane-bounded Shift+drag and explicit copy. Ghostty
  `copy-on-select` is off, so a drag alone does not copy; this is a host
  preference. Cmd+C/Cmd+V also passed. Herdr prefix control is inconclusive
  host evidence, not a checklist failure.
- **Windows is out of scope.** WSL is untested and is not a substitute for
  Linux/tmux evidence.
- **Git-spec installs fail upstream in OpenCode 2.2.7.** `github:` and
  `git+https://` specs fail during Git dependency preparation. Use the npm
  package or a loopback registry.
- **Host support is narrow.** Only OpenCode 2.2.6, 2.2.7, and 2.3.0 are tested.
  Other releases load with a warning and may break in untested ways.
- **macOS/Herdr is verified on OpenCode 2.2.7 only.** The 2.3.0 support claim is
  Linux-verified; macOS 2.3.0 is not claimed.
- **Live evidence is platform-bound.** The real-model acceptance is opt-in and
  not part of the PR gate. A local run without the pinned tools is not CI
  evidence.
- **Diagnostics are local and the doctor is checkout-based.** Ensemble does not
  upload logs or a support bundle and has no telemetry. The doctor ships in the
  repository; a package-only install uses the in-app `:logs` viewer and host
  logs.
- **The 4-hour soak is a nightly/opt-in gate.** The recorded evidence is a
  four-hour enforced PASS on OpenCode 2.2.7 and 2.3.0, not part of the PR gate.
  See the [soak record](../verification/2026-11-17-soak.md).
- **Conversation history is host-owned.** Ensemble does not hand-edit or
  reconstruct OpenCode storage. Back up and restore it through the host; see
  the [incident runbook](incident-runbook.md#data-recovery).
- **Some surfaces stay native.** Arbitrary OpenCode slash commands are not
  proxied into the group chat, rich Markdown links are not clickable, and
  direct conversations have no separate Ensemble search or export.
- **The host owns page lifetime.** OpenCode keeps old plugin pages mounted;
  Ensemble's route gate prevents stale key ownership but cannot force the host
  to dispose them.
- **Terminal accessibility is host-dependent.** Screen-reader output, high
  contrast, font scaling, and automatic mouse copy-on-release are host
  features. Ensemble
  supplies glyph-and-word status, reduced motion, `NO_COLOR`, and ASCII
  fallbacks; see the [accessibility checklist](../verification/terminal-accessibility-checklist.md).

## Related documents

- [Support policy](README.md)
- [Incident runbook](incident-runbook.md)
- [OpenCode host support range](../compatibility/opencode-host-range.md)
- [Node support policy and CI matrix](../verification/2026-11-12-node-matrix.md)
- [macOS/Herdr manual checklist](../verification/macos-herdr-checklist.md)
- [Terminal accessibility checklist](../verification/terminal-accessibility-checklist.md)
