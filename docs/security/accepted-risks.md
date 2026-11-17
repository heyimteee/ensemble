---
title: Accepted security risks
description: Accepted dependency advisories and residual risks with review dates and controls.
version: 0.1.x
---

# Accepted security risks

- **Status:** Active for the 0.1 release candidate
- **Date:** 2026-11-16
- **Ticket:** #271 (parent spec #268)
- **Owner:** maintainer
- **Review cadence:** every dependency or host-compatibility change, and at least
  quarterly while any record below is active

Each record states what is accepted, why it cannot be fixed in this ticket, and
what compensates for it. A record that no longer has a compensating control must
be reopened, not silently renewed.

## Audit baseline

Run on 2026-11-16 with Node 26.12.1 against `package-lock.json`:

```text
npm audit --omit=dev  ->  0 vulnerabilities
npm audit             ->  28 vulnerabilities (25 moderate, 3 critical)
                          all in devDependencies or the peer-dependency tree;
                          no bundled production dependency
```

The published package ships source only and declares runtime peers
(`@opencode/plugin`, `@opentui/core`, `@opentui/solid`, `solid-js`) that the
OpenCode host provides. The audit result therefore describes the local
development/test tree and the host integration, not code bundled into the npm
artifact. `npm audit --omit=dev` is the release gate; `npm audit` is reviewed on
every dependency change.

## AR-271-01: Seroval/solid-js advisories in the TUI peer tree

- **Severity:** Critical (upstream advisory severity)
- **Status:** Accepted
- **Affected:** `seroval@1.5.6`, `solid-js@1.9.12`, `@opentui/solid@0.7.0`
- **Advisories:** GHSA-p6vx-979v-rg4c, GHSA-jp82-f5mq-hwhp,
  GHSA-9wx9-5pv9-3349, GHSA-97r2-qh9m-474h, GHSA-wp97-x4hv-qvhp,
  GHSA-7rv5-mrxv-xcr9 (Seroval deserialization and RegExp issues)
- **Why it is accepted:** `@opentui/solid@0.7.0` pins its peer to exactly
  `solid-js@1.9.12`; the advisory is fixed in `solid-js` 1.9.16 or newer, which
  that peer range rejects. Upgrading the TUI runtime is a product change with
  its own layout and motion verification, not a narrow security fix, and the
  installed plugin receives the host's TUI runtime. Ensemble never deserializes
  untrusted Seroval payloads itself: its use of `solid-js` is ordinary reactive
  UI rendering in the local TUI process.
- **Compensating controls:** no network-supplied serialized data reaches the
  TUI; the plugin ships no bundled dependency; the host and OpenTUI versions are
  recorded in the compatibility matrix; Dependabot keeps the update visible.
- **Fix path:** upgrade `@opentui/solid` and `solid-js` together when the
  OpenCode/OpenTUI host moves to a compatible pair, then re-run the TUI,
  accessibility, and size E2E suites.
- **Review by:** 2027-01-15, or when the host compatibility matrix changes.

## AR-271-02: Approval resolution trusts the local TUI client

- **Severity:** Low
- **Status:** Accepted
- **Affected:** `approval.resolve` RPC (`src/v2/service.ts` `resolveApproval`)
- **Description:** The server resolves any pending approval id supplied by the
  local plugin RPC client. The TUI filters the inbox to the active workspace
  (`approvalsForWorkspace`), but the server does not verify a caller workspace.
- **Why it is accepted:** Ensemble opens no socket or HTTP listener; the RPC is
  the host's plugin channel for the same OS user who can already read the state
  snapshot, the logs, and every workspace file. A same-user local client is not
  a separate security principal under this threat model.
- **Compensating controls:** agents have no resolve tool; the inbox is
  workspace-scoped; every resolution is recorded with `resolvedAt` and
  `resolution`; native replies are `once`/`reject`, never `always`.
- **Revisit if:** the RPC becomes remote, multi-user, or exposed to another
  principal, or a tool ever gains an approval action.
- **Review by:** 2027-01-15.

## AR-271-03: Repository-controlled symlinks can redirect project-file writes

- **Severity:** Moderate
- **Status:** Accepted; follow-up hardening recommended
- **Affected:** `AGENTS.md`, `.gitignore`, and `.ensemble/` writes
  (`src/v2/workspace-config.ts` `ensureEnsembleDirectory`, `writeAgentsBlock`,
  `writeWorkspaceConfig`, `writeInitMetadata`; `src/v2/service.ts` init job and
  reconciliation)
- **Description:** The writers open the project path directly. If a repository
  ships `AGENTS.md`, `.gitignore`, or `.ensemble/` as a symlink to a path outside
  the workspace, an automatic instruction reconciliation or an init can write
  the Ensemble block or config through the link.
- **Why it is accepted for the release candidate:** the attack requires the user
  to clone and add a hostile repository as a workspace; that repository can
  already execute arbitrary code through its own build/test scripts under the
  host's permission prompts. Ensemble's automatic write is limited to the
  Ensemble block, the config/init metadata, and the `.gitignore` entry; it does
  not read or copy other file content and does not touch credentials. The
  correct fix is a shared canonical containment helper for every project-file
  writer and recursive delete, which would change the behavior of deliberately
  symlinked project files and is too broad for a late release-candidate patch.
- **Compensating controls:** only create workspaces for repositories you trust;
  review `AGENTS.md` after init; the workspace directory itself is
  canonicalized; `@file` references and handoff reads are already contained.
- **Fix path:** add `realpath` containment (allowing in-workspace symlinks,
  refusing escapes) to the project-file writers and the `.ensemble/` recursive
  delete, with tests, before 1.0 or in a dedicated hardening ticket.
- **Review by:** 2026-12-15, or before the first 1.0 release.

## AR-271-04: Development-only advisories in the npm/OpenCode toolchain

- **Severity:** Moderate (upstream advisory severity)
- **Status:** Accepted
- **Affected:** 25 moderate advisories in the dev tree, including
  `@npmcli/*`, `cacache`, `glob`, `minimatch`, `pacote`, `sigstore`,
  `@opencode/plugin`, and `@opencode/util`
- **Advisories:** GHSA-g3hv-75wg-m249 (minimatch globparts amplification),
  GHSA-3g3m-2fjr-6pw4 (glob AbortSignal cancellation bypass), and the npm
  arborist/pacote/sigstore dependency chain
- **Why it is accepted:** every affected package is a devDependency or a
  transitive of `@opencode/plugin`'s packaging/CLI tooling; none is bundled into
  the published plugin, and `npm audit --omit=dev` reports zero vulnerabilities.
  The fix for most of the chain is an upstream `@opencode/plugin`/npm release,
  which is outside this repository's control. `gaxios` and `rimraf` have
  audit-fixable paths but are still dev-only; Dependabot will propose them.
- **Compensating controls:** the release gate uses `npm audit --omit=dev`; the
  package has no runtime dependencies; CI installs with `npm ci` from the
  lockfile; Dependabot opens grouped weekly updates.
- **Review by:** 2027-01-15 (or sooner when Dependabot reports a new advisory).

## AR-271-05: Pattern-based log redaction is not exhaustive

- **Severity:** Low
- **Status:** Accepted
- **Affected:** `src/v2/logging.ts` `redactText`/`redactValue`;
  `src/v2/failure-record.ts`
- **Description:** Redaction covers common credential shapes (bearer/basic
  headers, URL userinfo, `sk-` keys, GitHub tokens, key/value secret names). An
  unusual secret form could survive in an error message or user-entered
  resolution. Message text and task instructions are excluded by default and
  included only with `ENSEMBLE_LOG_CONTENT=1`.
- **Why it is accepted:** the logs are local, `0600`, under a `0700` directory,
  and retained for 7 days / 5 files. The same OS user can already read the
  underlying state. Content logging is an explicit opt-in for debugging.
- **Compensating controls:** metadata-only logging by default; bounded strings;
  rotation and retention; `ENSEMBLE_LOG=0` disables the file sinks.
- **Revisit if:** logs become exportable or remotely collected (they are not).
- **Review by:** 2027-01-15.

## AR-271-06: `private_transcript` share becomes durable global memory

- **Severity:** Low
- **Status:** Accepted; owned by #272
- **Affected:** `src/v2/service.ts` `toolShare`, `resolveApproval`
  (`cross_project` branch)
- **Description:** Approving a `share` request creates a `global` memory from
  the submitted text, including when the scope is `private_transcript`. The
  approval title distinguishes the scope, but the effect is durable shared
  knowledge rather than a one-time disclosure.
- **Why it is accepted for this ticket:** the data-retention and consent
  semantics are #272's deliverable. Changing the effect now would fork the
  privacy contract #272 is about to implement.
- **Compensating controls:** nothing is shared without an explicit user
  approval; the request text is shown in the approval detail; the resulting
  memory is visible in the memory UI and can be deleted.
- **Fix path for #272:** either state "this becomes shared knowledge" in the
  consent copy, or make `private_transcript` a one-time hand-off that does not
  persist as a global memory.
- **Review by:** when #272 lands.

## AR-271-07: AGENTS.md roster disclosure

- **Severity:** Low
- **Status:** Accepted; owned by #272
- **Affected:** `src/v2/init-block.ts` `teamRosterTable`; workspace `AGENTS.md`
- **Description:** The v7 contract writes active member names, titles, and roles
  into the workspace `AGENTS.md`, which is a committed project file. Users may
  not expect those values to be visible to everyone with repository access.
- **Why it is accepted for this ticket:** the guidance/opt-out is explicitly
  #272's acceptance criterion; the security requirement is documented in the
  threat model.
- **Compensating controls:** only active members are listed; the table is
  Markdown-escaped; `.ensemble/` is gitignored, so the roster table is the only
  roster disclosure in the repository; agent names/titles/roles are
  user-controlled and should not contain secrets.
- **Fix path for #272:** document the disclosure and provide an opt-out or a
  reduced table.
- **Review by:** when #272 lands.

## AR-271-08: Agent home directories are outside the workspace

- **Severity:** Informational
- **Status:** Accepted
- **Affected:** `src/v2/service.ts` `createHomeBinding`, `createAgent`
- **Description:** An agent's direct/home session runs in
  `~/.ensemble/agents/<id>` or a configured `homeDirectory`, not in the
  workspace. This is intentional: direct conversations should not require a
  project, and the native session needs a directory.
- **Why it is accepted:** the directory is chosen by the user at agent creation;
  the host's own permissions still gate file and shell actions; Ensemble does
  not copy workspace files there.
- **Compensating controls:** the location is explicit in agent state and shown
  by the workspace/agent surfaces; `@file` references are still resolved against
  the workspace, not the home.
- **Review by:** 2027-01-15.
