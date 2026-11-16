# Support

Ensemble is in developer preview. Support is **best effort through GitHub
Issues**. There is no paid support, private inbox, or contractual SLA.

Use this page to choose the right channel, collect evidence, and keep private
data out of public reports.

## Where to get help

| Need | Channel |
|---|---|
| Reproducible bug, crash, or regression | [Open a bug report](https://github.com/heyimteee/ensemble/issues/new/choose) and choose **Bug report** |
| Usage question, setup help, or unclear behavior | [Open a support request](https://github.com/heyimteee/ensemble/issues/new/choose) and choose **Support request** |
| Security vulnerability | Private vulnerability reporting through [SECURITY.md](../../SECURITY.md). Never open a public issue for a vulnerability. |
| Broken workspace, stuck work, failed upgrade, or data loss | Follow the [incident runbook](incident-runbook.md), then file an issue if the runbook does not resolve it |

Maintainers reply in the GitHub issue. Do not send credentials, conversation
content, or private project files over email, chat, or social media.

## Before filing

1. Read the [support matrix and known limitations](support-matrix.md). Check
   whether the platform, OpenCode release, Node version, and terminal are in
   scope.
2. Search existing issues, including closed issues, for the same symptom.
3. Reproduce on a supported configuration where possible. Note the exact
   Ensemble version that failed and the last version that worked.
4. Collect the diagnostics described in the [incident runbook](incident-runbook.md#diagnostics).
5. Redact the evidence before posting.

## Response expectations

These are best-effort targets, not guarantees. Maintainer availability varies.

| Event | Target |
|---|---|
| New issue acknowledged or triaged | Within 5 business days |
| Security report acknowledged | Within 3 business days, unless [SECURITY.md](../../SECURITY.md) states a different target |
| Missing information requested | Issue moves to `needs-info`; it is closed after 30 days without a response |
| Supported-configuration defect confirmed | Converted to a tracked fix or documented limitation |
| Unsupported platform or version | Closed as out of scope with a pointer to the [support matrix](support-matrix.md) |

A security report follows the private process in `SECURITY.md`; that process is
authoritative if it differs from this table.

## What to include

- **Versions:** Ensemble, OpenCode, Node, npm, operating system, terminal host,
  and terminal size.
- **Install method:** npm package version, Git spec, or local checkout.
- **Commands:** the exact commands or key sequences that reproduce the problem,
  plus their output.
- **Evidence:** a minimal reproduction, screenshots, or text captures that show
  the failure without conversation content.
- **Redacted diagnostics:** doctor exit code and mismatch codes, `:logs
  failures` field excerpts, log-summary counts, and relevant timestamps.
- **History:** whether it worked before, the last known-good version, and any
  configuration change.

## Keep private data out

Never post any of the following in an issue, pull request, discussion,
screenshot, or attached log:

- passwords, API keys, tokens, cookies, session secrets, or authentication
  headers;
- conversation, message, prompt, task, memory, or approval text;
- proprietary source code, file contents, database dumps, or attachments;
- absolute private paths, usernames, hostnames, IP addresses, or customer names;
- `.env` files, host configuration, or OpenCode service descriptors;
- raw log files or failure records that have not been reviewed and redacted.

Logs are designed to omit conversation content by default, but failure and
diagnostic records still carry task titles, identifiers, model names, and error
text. Redact titles and identifiers before sharing, or paste only the fields
needed to explain the failure.

Maintainers will not ask for credentials or conversation content. If a problem
cannot be demonstrated without sensitive data, reduce it to a synthetic
reproduction with placeholder names and a fresh scratch project.

## What happens next

An issue is labeled with a type and a triage state. `needs-info` means the
report is waiting on the requested evidence. Confirmed defects are linked to a
fix; accepted limitations are added to the [support matrix](support-matrix.md)
rather than kept as an open troubleshooting thread. Fixes ship in a tagged
release; see the changelog and release notes for the version that contains them.

## Related documents

- [Incident runbook](incident-runbook.md): symptoms, diagnostics, rollback,
  escalation, and data recovery.
- [Support matrix and known limitations](support-matrix.md): platforms,
  versions, live-suite prerequisites, and unverified surfaces.
- [Security policy](../../SECURITY.md): private vulnerability reporting.
- [Contributing](../../CONTRIBUTING.md): development and verification
  expectations.
