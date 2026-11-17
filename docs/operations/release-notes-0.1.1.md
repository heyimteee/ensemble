---
title: Ensemble 0.1.1 release notes
description: Documentation and npm presentation patch; runtime identical to 0.1.0.
version: 0.1.x
---

# Ensemble 0.1.1 release notes

Status: **stable**, published from tag `v0.1.1`. This is a documentation and npm
presentation patch; the runtime is identical to `0.1.0`.

## Install

```sh
opencode plugin add @heyimteee/ensemble@0.1.1
```

npm dist-tags are `latest: 0.1.1` and `next: 0.1.0-rc.3`.

## Changed

- The README uses the official three-bar Ensemble logo and the current
  full-window screenshots.
- Current install, version, support, and operations pages point at `0.1.1`.
- The documentation site, generated reference, and evidence index are
  published from the same release commit.

## Unchanged

- No runtime, API, TUI, permission, storage, or supported-host behavior changed.
- Supported hosts remain OpenCode 2.2.6, 2.2.7, and 2.3.0 on Linux/tmux, with
  Node 22.23.4 or newer.
- The prerelease history remains `0.1.0-rc.2` and `0.1.0-rc.3` under `next`.

## Verification

- `npm run verify`: 2,188 tests pass.
- `npm run docs:check` and the full docs-site build pass.
- The documentation site was reviewed at 186 routes with zero layout, image,
  console, network, or axe WCAG A/AA violations.
- The packed-install quickstart reaches a `REPLIED` work item.
