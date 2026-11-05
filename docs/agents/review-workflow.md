# Review workflow

Review a change on two independent axes:

- **Standards:** does the change follow the repository's documented standards, including [reviewer standards](review-standards.md)?
- **Spec:** does the change implement the originating ticket or specification without scope creep?

## Steps

1. Pin the fixed point and read the diff from it, for example `git diff <fixed-point>...HEAD`.
2. Read the originating issue and its acceptance criteria.
3. Read the [contribution guide](../../CONTRIBUTING.md) and the [reviewer standards](review-standards.md). Run `npm run verify` and the relevant live checks rather than trusting their description.
4. Report Standards and Spec findings separately. Cite the standard section or the ticket line for each finding.
5. Record verification evidence and any remaining manual or unexecuted checks.

Mechanical rules are enforced by `npm run verify`, the live checks, and CI. Do not re-report them as judgement findings. The [reviewer standards](review-standards.md) cover the judgement calls that automation cannot make.
