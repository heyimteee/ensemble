# Security

Ensemble is not implemented or released yet. There is no supported-version policy at this stage.

## Reporting a vulnerability

Use the repository's **Security → Report a vulnerability** option if private vulnerability reporting is enabled. If it is unavailable, open a public issue requesting a private reporting channel, without exploit details, secrets, or sensitive data. The maintainer must establish a private channel before those details are shared.

Never post credentials, authentication headers, private conversations, memory contents, or sensitive project files in public issues.

## Product security boundaries

- Assigned skills and leader status do not grant permissions.
- Agents cannot approve actions on the user's behalf.
- Private conversations and cross-project knowledge require deliberate sharing.
- Model fallback must not blindly repeat actions with an uncertain outcome.
- Ensemble must preserve OpenCode's existing permission handling.

These are product requirements, not claims of implemented protections or a completed security audit.
