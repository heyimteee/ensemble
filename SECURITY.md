# Security policy

Ensemble is distributed as the `@heyimteee/ensemble` OpenCode plugin. It runs
inside the host process with the host's filesystem access. It stores team state
in the host plugin storage, writes a small set of project files under
`<workspace>/.ensemble/` and an `AGENTS.md` block, and drives native OpenCode
sessions. This policy covers that plugin, its published package, and its
documentation.

- **Threat model:** [docs/security/threat-model.md](docs/security/threat-model.md)
- **Permission-model review:** [docs/security/permission-model-review.md](docs/security/permission-model-review.md)
- **Accepted risks:** [docs/security/accepted-risks.md](docs/security/accepted-risks.md)

## Supported versions

Ensemble is pre-1.0. Security fixes ship in a new release of the supported line;
older versions are not backported.

| Version | Supported |
|---|---|
| Latest published `0.1.x` release, including a published release candidate | Yes |
| Earlier `0.1.x` releases | No — upgrade to the latest |
| Unpublished pre-release, release candidate, or local build | No — reproduce on the latest published release before reporting |
| Source checkout, fork, or modified package | Best effort only |

The compatibility boundary is explicit: the supported OpenCode releases, the
`@opencode/plugin` peer range, and the Node floor are documented in
[docs/compatibility/opencode-host-range.md](docs/compatibility/opencode-host-range.md)
and in `package.json` (`engines.node`, `peerDependencies`). A report against an
unsupported host or Node version will be closed with a pointer to the supported
range, unless the issue is a plugin bug independent of the host.

## Reporting a vulnerability

Use the repository's **Security → Report a vulnerability** option and open a
private GitHub Security Advisory draft. This is the preferred and private
channel. If private vulnerability reporting is unavailable, open a public issue
that asks for a private channel and contains **no exploit details, secrets, or
sensitive data**; the maintainer will establish a private channel before those
details are shared.

Never post credentials, authentication headers, private conversations, memory
contents, file bytes, or sensitive project files in a public issue. If a report
must include a file, replace its content with a minimal synthetic reproduction
that shows the shape of the data.

A useful report includes:

- the plugin version, OpenCode version, Node version, and platform;
- the affected surface (approval, tool, workspace file, log, skill, import,
  install);
- a minimal reproduction using a synthetic workspace, not a real project;
- the impact you observed and whether state, files, or credentials are at risk;
- whether the issue requires the user to open an untrusted repository or to
  enable the legacy tool surface.

## Response expectations

These are targets, not a contract, and they assume a single maintainer:

| Stage | Target |
|---|---|
| Acknowledge the report and open a private channel | 3 business days |
| Initial assessment (severity, affected versions, next step) | 10 business days |
| Critical fix or mitigation | 14 days after triage |
| High-severity fix | 30 days after triage |
| Moderate/low fix | Next scheduled release |
| Coordinated public disclosure | 90 days after the report, or 30 days after a fix is available, whichever comes first |

If a report is not acknowledged within 10 business days, reply on the advisory
or open a public issue that asks for an update without revealing details. We
will credit reporters in the advisory unless anonymity is requested. There is no
bug bounty.

## Scope

**In scope:** the plugin code in this repository; the published plugin package
and its declared peer range; the approval and permission model; the tool
surface; workspace file handling under `.ensemble/` and `AGENTS.md`; logging and
redaction; dependency and release configuration.

**Out of scope:** OpenCode itself (report to the OpenCode project), model
providers, MCP servers, other plugins or tools the user installs, the user's
project code and build scripts, the npm registry and publishing account,
social engineering, and a compromised local machine or OS account. Release
provenance and artifact signing are tracked by the release workflow; report a
suspected artifact compromise privately rather than opening a public issue.

## Product security boundaries

These are reviewed requirements, with evidence in the threat model and
permission-model review. They are not a claim that the host, the model, or the
user's project is secure.

- **Only the user approves.** Assigned skills and leader status do not grant
  permissions. No agent tool resolves an approval, and there is no automatic
  approval branch. Native permission mirrors reply `once` on approve and
  `reject` on deny, never `always`.
- **Contact outside the workspace needs consent.** Group mentions, direct
  messages, delegates, and handoffs to a non-member create an `outside_roster`
  approval; the approved contact runs once.
- **Cross-project knowledge and private transcripts need consent.** `remember`
  at global scope and `share` create pending approvals; the user decides.
- **Native permissions are preserved.** Ensemble mirrors host permission events
  and never answers a host request on its own. It adds only `skill` rules to the
  session permission set, and a General-skill grant is restored after the turn.
- **Model fallback does not replay uncertain actions.** A backup model is tried
  only for a provider availability failure and only when no tool call has
  happened since the attempt started.
- **Paths are contained.** Workspace directories and `@file` references are
  canonicalized; handoff files are canonicalized on both sides of the
  containment check.
- **No telemetry.** Ensemble makes no outbound network request, has no
  analytics, crash reporting, or update check, and ships no telemetry
  dependency. Diagnostics are local logs and the `doctor` / `logs:summary`
  commands.

## Data handling

Ensemble keeps data local:

| Data | Where | Default retention |
|---|---|---|
| Conversations, Work, approvals, memories, session bindings | Host plugin storage | Until workspace delete or Ensemble reset; no time-based expiry |
| Attachments | `<workspace>/.ensemble/attachments/` and agent-home attachments | Until the conversation/workspace is deleted or Ensemble is reset |
| Workspace config and init metadata | `<workspace>/.ensemble/config.json`, `.ensemble/init.json` | Until workspace delete or reset |
| Handoff files | `<workspace>/.ensemble/handoffs/` | User-managed; reset can delete them |
| Roster table (name, title, role) | `AGENTS.md` in the workspace | Project-owned; review before committing |
| Logs | `$ENSEMBLE_LOG_DIR` or `$XDG_STATE_HOME/ensemble/logs` (default `~/.local/state/ensemble/logs`) | 7 days / 5 files / 10 MB per sink; `0600` files in a `0700` directory |
| Native sessions and transcripts | OpenCode host storage | Host-owned; not controlled by Ensemble |

Logs are metadata-only by default: message rows log ids, author, kind, and
character counts, not text. Setting `ENSEMBLE_LOG_CONTENT=1` opts into message
text and task instruction text in the failure sink; `ENSEMBLE_LOG=0` disables the
file sinks. Redaction covers common credential shapes but is pattern-based.

Export and delete, the roster-disclosure guidance or opt-out, and the retention
policy's user-facing details are implemented under #272. The security
requirements those implementations must meet are listed in the threat model's
"Data handling" section: no credentials, no unrelated private paths, and a
delete path that covers plugin storage, attachments, the `.ensemble/` files
Ensemble created, and logs.

## Dependencies and updates

- The release gate is `npm audit --omit=dev`; the published package has no
  bundled runtime dependency and receives its peers from the host.
- `npm audit` is reviewed on dependency and host changes. Known, unfixable
  findings are recorded with compensating controls in
  [accepted risks](docs/security/accepted-risks.md); a high or critical finding
  cannot remain open without such a record.
- Dependabot checks npm weekly and GitHub Actions monthly, with minor/patch
  development updates grouped (`.github/dependabot.yml`). Version-update
  grouping and ignore rules do not apply to Dependabot security updates; those
  must be enabled in repository settings and are an operator action.
- Do not report a dependency advisory through this repository unless Ensemble's
  use of the dependency changes its impact; report it upstream and open a
  `security` issue with the advisory id.
