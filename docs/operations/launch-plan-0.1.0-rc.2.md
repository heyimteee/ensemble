# Launch plan — Ensemble 0.1.0-rc.2

Status: **draft, not approved.** This plan covers the first public package
candidate. The publish, GitHub release, and announcement are human-gated. No
agent may tag, publish, or announce.

## Release being launched

- Package: `@heyimteee/ensemble@0.1.0-rc.2`, MIT, one OpenCode plugin with the
  server, TUI, and RPC parts.
- Supported hosts for this launch: OpenCode `2.2.6`, `2.2.7`, and `2.3.0` on
  Linux/tmux. macOS/Herdr is verified on `2.2.7` only, except manual check 1.7;
  macOS 2.3.0 is not claimed.
- Not in scope: Windows, WSL, OpenCode releases outside the supported range,
  and the final `0.1.0` version.
- Public npm dist-tag: `next`. A prerelease must not become `latest`.

## Audience

Primary:

- OpenCode users on Linux with tmux who want persistent agent teams, routing,
  and durable Work rather than one-off chats.
- Developers already running OpenCode `2.2.7` or `2.3.0` who can install and
  test a scoped npm plugin with a pinned version.

Secondary:

- macOS users running Herdr in Ghostty, with the explicit caveat that mouse
  drag (checklist 1.7) is not verified.
- Teams evaluating a local, no-telemetry workflow who can provide structured
  bug reports through GitHub Issues.

Not addressed: Windows users, users below Node `22.23.4`, users on untested
OpenCode releases, and anyone expecting managed hosting or paid support.

## Channels

| Channel | Use | Owner |
|---|---|---|
| GitHub Release | Canonical announcement and changelog, with tarball, SBOM, and notes attached | Release manager |
| Repository README and `docs/` | Install, upgrade, rollback, support, and known limitations | Maintainer |
| GitHub Issues | Support intake, bug reports, and release feedback | Maintainer |
| One OpenCode community post (Discord/forum) | Short pointer to the GitHub release, only if the maintainer chooses | Maintainer |
| npm registry | Artifact and provenance only, not a discovery channel | Release workflow |

No paid promotion, unsolicited direct messages, or mass cross-posting. The
release note is factual: what shipped, what is proven, and what is pending.

## Support path

- Bugs and usage questions: <https://github.com/heyimteee/ensemble/issues/new/choose>
- Security: private reporting through [SECURITY.md](../../SECURITY.md); never a
  public issue.
- Broken workspace, failed upgrade, or suspected data loss: follow the
  [incident runbook](../support/incident-runbook.md) before filing.
- Response targets are the best-effort table in the
  [support policy](../support/README.md). Launch capacity is one maintainer;
  the plan does not promise an SLA.

Every report should name the exact Ensemble version, OpenCode and Node
versions, OS, terminal host, install method, commands, and redacted evidence.
Never request or post credentials, conversation content, private project
files, or unredacted logs.

## Human-gated publish sequence

1. **Approve the candidate.** The release manager reviews
   [the sign-off](release-signoff.md), records the date and name, and
   explicitly accepts or clears each pending item: macOS 1.7 and the
   package-downgrade gap. Both supported Linux hosts passed the 4-hour soak,
   and required CI is green on all three OpenCode versions.
2. **Freeze the release commit.** Merge the approved release commit; every
   required check in [the release guide](release.md) must be green. No runtime
   change after the last clean-install evidence without a re-run.
3. **Create the tag.** Only the release manager pushes the approved
   `v<version>` tag on that commit. If the artifact stays at `0.1.0-rc.2`, the
   tag is `v0.1.0-rc.2`; any other approved version uses its matching tag. The
   tag push is the only action that can publish. Do not move or reuse
   `rc-0.1.0-rc.2`, which is an older evidence base.
4. **Watch the workflow.** Confirm preflight, verify, docs, build, pack, SBOM,
   and publish succeed; confirm npm provenance and the `next` dist-tag.
5. **Check the public artifact.** Confirm the GitHub release body is the
   changelog section and the notes, changelog, tarball, and SBOM are attached.
   Confirm the npm attestation and that `npm view` reports the exact version
   and `next`.
6. **Install smoke from the public registry.** On a Linux OpenCode 2.2.7 host
   and, if available, the macOS host, install the approved exact version:
   ```sh
   opencode plugin add @heyimteee/ensemble@<approved-version>
   opencode plugin list
   ```
   Open `/ensemble`, confirm the six native tools load, and send one group
   message. Confirm the registry dist-tag is `next` for a prerelease or
   `latest` for a final version. Do not announce before this passes.
7. **Announce.** Publish the GitHub release note and the optional community
   pointer. Link the support path and known limitations.
8. **Record the outcome.** Add the publish result, attestation, install smoke,
   and `NPM_TOKEN` rotation/revocation decision to the release sign-off and the
   parent verification record.

## Rollback trigger

Stop the announcement and begin rollback when any of these is confirmed:

- the package cannot install on a supported OpenCode `2.2.6`, `2.2.7`, or
  `2.3.0` host with Node `>=22.23.4`;
- the installed TUI route or `/ensemble` command fails to load, or the six
  native server tools are absent;
- a crash loop, startup failure, or workspace corruption is reproducible on a
  supported host;
- data loss, cross-workspace leakage, a security defect, or a license problem
  is confirmed;
- two independent reports describe the same release-blocking defect.

Rollback action:

1. Stop promotion and mark the GitHub release as affected.
2. Record the incident in the [incident runbook](../support/incident-runbook.md)
   and tell users to pin the previous exact version, or remove the plugin entry
   if this is their first install.
3. `npm deprecate @heyimteee/ensemble@0.1.0-rc.2` with a short message and a
   fixed version. Prefer a patch/RC fix over `npm unpublish`.
4. `npm unpublish` only inside npm's 72-hour window and only when nothing
   depends on the version.
5. Restore state only when the older code cannot read newer rows; use the
   pre-upgrade backup or the automatic rollback slot. Keep the failing state
   for diagnosis.
6. Do not move a published tag. Fix forward with a new version.

## Success signals

There is no telemetry, so success is judged from public signals:

- the install smoke passes on Linux and macOS before announcement;
- no confirmed release-blocking defect in the first 7 days;
- issue volume and triage stay within the published best-effort targets;
- users can install, upgrade, and roll back using only the published docs.

## Out of scope

- A final `0.1.0` launch. That is a separate decision after this candidate has
  run.
- Windows support, paid support, hosted service, or a marketing campaign.
- Claiming a macOS or non-Linux 4-hour soak. Both supported Linux hosts passed
  the 4-hour gate; macOS 2.3.0 is not claimed. The macOS mouse-drag check and
  Herdr prefix ownership remain pending or inconclusive until recorded.
