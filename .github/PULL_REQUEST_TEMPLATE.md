## Summary

Describe the change and the observable behavior it fixes.

## Ticket

Link the implementation ticket. Completing it must not close its parent
specification.

## Change type

- [ ] Fix
- [ ] Feature or capability
- [ ] Docs or templates
- [ ] Verification or CI
- [ ] Maintenance

## Verification

| Check | Result |
|---|---|
| `npm run verify` | |
| `npm run docs:check` | |
| Live suite(s), if affected | |
| Manual check, if affected | |

Record the versions used for any live or manual check:

- Ensemble version or commit:
- OpenCode version (`opencode --version`):
- Node version (`node --version`):
- Operating system and terminal:
- Install method: npm package / Git spec / local checkout

## Commands and evidence

Paste the exact commands that produced the result, plus redacted output,
redacted logs, screenshots, or a minimal reproduction. State what is not
covered and whether a skipped or blocked check is being reported as a pass (it
must not be).

## Privacy and safety

- [ ] I did not include credentials, tokens, cookies, API keys, conversation content, memories, proprietary file bytes, or private absolute paths in
      this description, the code, tests, fixtures, logs, screenshots, or
      artifacts.
- [ ] Any log excerpt is reviewed and redacted; raw logs and the OpenCode
      service descriptor are not attached.
- [ ] The change preserves OpenCode's permission model and does not bypass
      approvals.
- [ ] Externally visible behavior is documented, and the support matrix or
      runbook is updated if the supported boundary changed.

## Rollback

State how to reverse the change if it regresses a released version.

## Checklist

- [ ] The change stays within the linked ticket's acceptance criteria.
- [ ] Tests assert observable behavior at a public seam, not internals.
- [ ] `npm run verify` and `npm run docs:check` pass locally.
- [ ] No secrets, private paths, conversation content, or user data are
      committed.
