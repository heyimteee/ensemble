---
title: Security
description: Threat model, permission review, accepted risks, and private vulnerability reporting.
version: 0.1.x
---

# Security

How Ensemble separates user authority, agent work, and OpenCode's native
permissions. These pages are written for security reviewers and operators who
need to assess the product before adopting it.

## Security documents

| Document | What it covers |
|---|---|
| [Threat model](threat-model.md) | Storage, filesystem and shell, tools, cross-workspace access, skills, approvals, model fallback, and logs, with code evidence |
| [Permission-model review](permission-model-review.md) | Approvals, outside-roster contact, external directories, self-approval, and native permission preservation |
| [Accepted risks](accepted-risks.md) | Dependency advisories and residual risks with review dates and compensating controls |
| [Security policy](../../SECURITY.md) | Private vulnerability reporting and the maintainer response process |

## Reporting a vulnerability

Report vulnerabilities privately through the process in
[SECURITY.md](../../SECURITY.md). Never open a public issue, and never post
credentials, tokens, conversation content, private paths, or unredacted logs.
The [support policy](../support/README.md) explains how to redact public
evidence for ordinary support requests.

## Boundaries

- Ensemble does not replace OpenCode's tool permissions. An Ensemble approval is
  a product workflow decision, not a grant of host permission.
- The leader coordinates work but receives no additional permissions.
- Agent skills are guidance, not tool grants.
- Diagnostics are local by default. Ensemble has no telemetry.

## Related

- [Privacy](../privacy/README.md): data classes, retention, export, and delete.
- [Operations](../operations/README.md): backup, restore, and incident
  procedures.
- [Evidence index](../contributing/evidence.md): security review records and
  verification evidence.
