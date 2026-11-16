# Release operations

Ticket #275. A version tag is the only path that publishes Ensemble. This page
records the release workflow, the main-branch protection, the credential
boundary, and the dry-run rehearsal. Use
[the release sign-off checklist](release-signoff.md) before creating the tag.

## Current candidate

The release candidate is `@heyimteee/ensemble@0.1.0-rc.2`. No version bump or
rebuild is planned for the remaining manual check. The public release is
**not approved**; the final public version and tag are cut on the approved
commit after the human-gated publish decision. If the artifact stays at
`0.1.0-rc.2`, the matching release tag is `v0.1.0-rc.2` and the dist-tag is
`next`; a final `0.1.0` is a separate version and tag.

The release-candidate verification tag is `rc-0.1.0-rc.2` at `d74fc3d`. It
predates the #281–#284 fixes, so it is an evidence base, not a publish source,
and it must not be moved. The fixed runtime was installed and checked on macOS
from the build at `70f3da7`; the package runtime is unchanged through
`b194b95` and `4ccc410`. The later diffs are the repository-only doctor CLI,
the live harness, the CI workflows/contract checker, and documentation.
Final-tip clean install, fake E2E, and 4-hour soak evidence at `b194b95` is in
the [parent #268 record](../verification/2026-11-17-ticket-268.md#final-tip-evidence-b194b95)
and the [soak record](../verification/2026-11-17-soak.md). Required CI at
`4ccc410` is green with one rerun of failed jobs and no code change; see the
[CI section](../verification/2026-11-17-ticket-268.md#required-ci-at-4ccc410).
If any runtime source changes, rerun the clean-install proof before tagging.

See the [release notes](release-notes-0.1.0-rc.2.md), [launch
plan](launch-plan-0.1.0-rc.2.md), [candidate
sign-off](release-signoff.md#candidate-sign-off--010-rc2-2026-11-17), and
[parent #268 verification](../verification/2026-11-17-ticket-268.md).

## Required checks and main protection

`main` is protected by the repository ruleset **main protection** (ruleset id
`27380159`), applied on 2026-11-16 with `gh api`. The ruleset targets the
default branch and is active:

| Rule | Setting |
|---|---|
| Deletion | Blocked |
| Non-fast-forward | Blocked |
| Pull request | 1 required approval, stale reviews dismissed on push, last-push approval required, unresolved review threads block merge |
| Required status checks | Strict: the branch must be up to date and every check below must pass |
| Bypass | Repository admin role only |

The required contexts are the real GitHub Actions check names, not the
workflow file or job id. They come from `REQUIRED_STATUS_CHECKS` in
`src/v2/ci-workflows.ts`; the contract test proves each one is produced by a
checked-in workflow.

```text
verify
live-fake
live-native
live-multilocation
latency-smoke
docs:check
verify (Node 22.23.4)
verify (Node 24.22.1)
verify (Node 26.12.1)
OpenCode 2.2.6
OpenCode 2.2.7
```

Inspect the applied state without changing it:

```sh
gh api repos/heyimteee/ensemble/rulesets
gh api repos/heyimteee/ensemble/rulesets/27380159
```

The authenticated maintainer holds the repository admin role and is therefore
the only bypass actor. Bypassing the review requirement is an emergency action:
it is logged by GitHub, and the reason belongs in the release sign-off. Do not
rename a workflow job or change the Node/OpenCode matrix without updating
`REQUIRED_STATUS_CHECKS` and this list; a required context that no workflow
produces blocks every pull request indefinitely.

## Release workflow

`.github/workflows/release.yml` has two triggers:

- `push` of a tag matching `v*` — a real release;
- `workflow_dispatch` — always a dry run. The publish jobs are gated to a tag
  push, so a manual dispatch cannot publish.

A plain branch push or a pull request cannot reach the publish jobs.

| Job | What it does | Runs when |
|---|---|---|
| `release-preflight` | Validates the tag against `package.json`, extracts the changelog section into `RELEASE_NOTES.md`, exports `version`, `tag`, `dry-run`, and `dist-tag` | Always |
| `package` | `npm ci`, `npm run verify`, `npm run docs:check`, `npm run build`, `npm pack`, CycloneDX SBOM, artifact upload | Always |
| `publish-dry-run` | `npm publish --dry-run --access public --tag "$DIST_TAG"` with no registry secret | Dry run only |
| `publish` | `npm publish --provenance --access public --tag "$DIST_TAG"` with `id-token: write` and the `NPM_TOKEN` secret | Tag push only |
| `github-release` | Creates the GitHub release from the changelog notes and attaches the SBOM, tarball, notes, and changelog | Tag push only |

The default workflow permission is `contents: read`. Only the publish job adds
`id-token: write`; only the GitHub release job adds `contents: write`. The
workflow does not print a secret, enable shell tracing, or contain a private
absolute path.

### Credential setup

- `NPM_TOKEN` is a repository secret: an npm granular automation token with
  publish rights for the `@heyimteee` scope. It is exposed only to the publish
  step, never to the dry-run job.
- Provenance needs `id-token: write` and a public package. The workflow runs
  `npm publish --provenance --access public`; npm signs the artifact through
  GitHub's OIDC provider.
- npm refuses a prerelease without an explicit dist-tag. The preflight exports
  `next` for a version with a prerelease suffix and `latest` for a final
  release, and both publish jobs pass `--tag "$DIST_TAG"`. A release candidate
  therefore never becomes the default install.
- Rotate or revoke the token after a release if the credential may have been
  exposed. Never put a token in a workflow file, tag message, or issue.

### Dry run

Start it from Actions → **Release** → **Run workflow**. The run needs no npm
credential and publishes nothing:

```sh
gh workflow run release.yml
```

A local rehearsal runs the same gates without a registry token:

```sh
npm run verify
npm run docs:check
node --experimental-strip-types scripts/release-guard.mjs \
  --event workflow_dispatch --ref refs/heads/main \
  --manifest package.json --changelog CHANGELOG.md --out RELEASE_NOTES.md
npm run build
npm pack --json
npm sbom --sbom-format=cyclonedx --package-lock-only > "ensemble-$(node -p "require('./package.json').version").cdx.json"
npm publish --dry-run --access public --tag next   # latest for a final version
```

`npm publish --dry-run` runs the same `prepack` build and content guard as a
real publish, so a tarball with raw TypeScript, tests, fixtures, docs, or a
missing export fails before any upload.

### Tagged release

1. Approve the candidate and its notes, launch plan, and sign-off (#278). The
   current candidate is `0.1.0-rc.2`; bump the version only if the approved
   artifact or version decision changes.
2. Confirm `version` in `package.json` and `package-lock.json` agree; open the
   release pull request and let every required check pass.
3. Merge to `main`, then tag the merge commit:
   ```sh
   version=$(node -p "require('./package.json').version")
   git tag -a "v$version" -m "Ensemble release"
   git push origin "v$version"
   ```
4. Watch the `Release` workflow. The preflight refuses a tag that disagrees
   with `package.json` or a version with no changelog section.
5. Confirm the npm provenance attestation, the GitHub release, and the attached
   CycloneDX SBOM before announcing.

The GitHub release body is the changelog section, and the notes file, tarball,
SBOM, and `CHANGELOG.md` are attached as release assets. The notes are never
generated from commit messages, so an unnoticed change cannot silently become
the announcement.

## Failure and rollback

- A failed preflight, verify, docs, pack, or dry run publishes nothing.
- A failed real publish leaves the tag in place; fix forward with a new patch
  version. Do not move a published tag.
- A bad published release follows [package rollback](rollback.md): reinstall
  the previous exact version, restore state only when the older release cannot
  read newer rows, and prefer `npm deprecate` plus a patch release over
  `npm unpublish`. npm only permits unpublishing within 72 hours and only when
  no other package depends on the version.
- A bad GitHub release can be edited or deleted; the npm artifact and the tag
  are the durable record.

## Sign-off

Complete [the release sign-off checklist](release-signoff.md). The checklist
covers security, the MIT license and legal review, package contents, rollback,
support readiness, and the clean-install proof. A blocked check is not a pass;
record it as blocked and decide explicitly whether to release.
