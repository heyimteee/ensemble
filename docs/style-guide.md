---
title: Documentation style guide
description: Voice, terminology, page template, code sample rules, and visual rules for Ensemble docs.
version: 0.1.x
---

# Documentation style guide

This guide applies to every page under `docs/`, the root `README.md`, and
contributor documentation that ships with Ensemble. It keeps user docs readable
and keeps engineering evidence out of the user path. The
[domain glossary](../GLOSSARY.md) is authoritative for definitions; this page
decides how those terms appear in prose.

**Version scope:** stable `0.1.x`.

## Voice

Write for a capable reader who is new to Ensemble, not new to software.

- Use the second person: "you create a workspace", not "the user creates a
  workspace".
- Use the present tense and active voice: "The leader answers" not "an answer
  will be produced".
- Lead with what the reader can do. Put the mental model after the action.
- Prefer short sentences and concrete nouns. Explain a consequence instead of
  calling something "simple" or "obvious".
- State the expected result after a step. If a step can fail, name the symptom
  and the next action.
- Use "must" for a requirement and "can" for an option. Avoid "should" when the
  behavior is actually enforced.
- Do not promise a hosted service, a model, a support SLA, or host support that
  the support matrix does not verify.
- Do not use marketing superlatives, jokes, or "simply", "just", "obviously",
  or "of course".

Error text follows the same rule: state what happened, why, and what to do next.
Quote the exact message in code formatting when the reader will see it.

## Canonical terms

Use these user-facing terms consistently. The glossary holds the full
definitions; the "avoid" column lists the terms that should not appear as
synonyms in user documentation.

| Canonical term | Use it for | Avoid |
|---|---|---|
| **Ensemble** | The product and this repository's plugin | Ensemble AI, the app, the tool |
| **OpenCode** | The host application | Open Code, opencode (in prose) |
| **agent** | A named teammate with lasting identity, instructions, models, memory, and skills | bot, worker, assistant |
| **roster** | The user's reusable collection of agents | team list, agent list |
| **workspace** | A directory-bound project room with a group chat, members, and one leader | room, channel, project group |
| **leader** | The workspace member who receives unaddressed messages and coordinates work | manager, owner, admin |
| **group chat** | The shared workspace transcript you and the agents use | channel, room, group conversation |
| **direct chat** | A private conversation between you and one agent | DM, private group, thread |
| **turn** | One prompt-and-execution cycle in a conversation's native session | message, run, request |
| **work item** | A visible card in the Work pane, including a queued/running unit or a native turn | task, subtask, card, job (in user docs) |
| **Work pane** | The right-hand surface showing work items in ACTIVE and HISTORY | task board, subtask list |
| **dispatch budget** | The layered ceiling on delegation: command budget, group budget, per-call task budget, and depth | hop limit, token budget, rate limit |
| **native session** | The OpenCode session where an agent executes and tool activity can be inspected | agent session, shared session, private session |
| **skill** | Reusable guidance an agent loads through OpenCode | tool, permission, plugin |
| **Skillbox** | The set of optional skills assigned to one agent | toolbox, skill list |
| **memory** | Saved knowledge with provenance, scoped to an agent or workspace | context, history, transcript |
| **approval** | An explicit user decision before dependent work continues | permission, consent, confirmation |
| **workspace contract** | The generated `AGENTS.md` block and its version | prompt, instructions file |

Rules:

- "Work" is the product surface name; "work item" is the user-facing unit.
  "Subtask" is an internal and evidence term. In a user page, introduce
  "work item" once and do not alternate with "task", "card", or "subtask".
- Use "direct chat" in user docs. "Direct conversation" is the domain term used
  by the glossary and evidence records.
- Write `$Name` and `@path` in code formatting. They are syntax, not prose.
- "Leader" is a role, not a permission level.
- Use "stable" and the exact package version, for example `0.1.1`, in install
  instructions. Label prerelease history explicitly.

## Page template

Every new user-facing page follows this shape. Delete sections that do not
apply; do not leave empty headings.

```markdown
---
title: Short page title
description: One sentence that says what the reader can do here.
version: 0.1.x
---

# Short page title

One-sentence purpose in plain language.

## Who this is for

The reader and the prerequisite, if either is not obvious.

## Before you start

- Required version, host, or access.
- A link to the concept the reader needs.

## Steps

1. One action per step.
2. The expected result, in prose or a separate output block.

## Expected result

What the reader should see when the task worked.

## Troubleshooting

The most likely failure, its symptom, and the next action. Link to the support
section instead of guessing at length.

## Next

- The next task or concept page.

## Go deeper

Optional. Link architecture decisions or verification records here, never in the
middle of a task.
```

Rules:

- Exactly one H1, matching the title.
- Use sentence case for headings. Do not skip heading levels.
- Keep the first screen useful: no "Introduction" heading before the point.
- Put prerequisites before steps and expected results after them.
- Use tables for reference choices, not for sequential instructions.
- Keep evidence links under "Go deeper" or in the
  [evidence index](contributing/evidence.md). The user path does not list
  verification records.
- Declare the applicable stable version in front matter or in a short version
  note. Prerelease pages are historical and must say so.

## Code samples

- Use a `sh` fence for commands and a separate `text` fence for output.
- Make every block copy-paste-ready. Do not include a shell prompt (`$` or `>`).
- Use the stable package version. Do not use a floating `latest` in a deliberate
  install instruction.
- Put placeholders in angle brackets, define each one, and prefer `~/…` or
  `/home/you/…` over a real private path.
- One command per line where possible. If a command must span lines, use a
  documented continuation and keep the block runnable.
- Do not chain unrelated commands with `&&` just to shorten the page.
- Show only the output that proves the step worked. Redact identifiers, paths,
  conversation text, credentials, and model names that are not part of the
  point.
- Never put a credential, token, cookie, service descriptor, or real transcript
  in an example.
- For JSON or JSONC, use the correct fence and keep comments out of strict JSON.
- Windows commands are out of scope for `0.1.x`; say so rather than inventing
  one.

## Visual rules

- Use Mermaid for architecture, routing, lifecycle, and budget diagrams. Label
  every edge with the action or condition it represents.
- Use a terminal recording for a short end-to-end interaction and a still
  screenshot for a stable state. Do not duplicate in an image what the reader
  can copy from text.
- Use synthetic data only: a fake "Acme Notes" workspace, placeholder names, and
  no real paths, conversations, credentials, or user data.
- Give every image useful alt text that states its purpose. Add a caption when
  the image needs context that alt text cannot carry.
- Do not use color alone to carry meaning. Pair status colors with the status
  word and a glyph or text fallback.
- Prefer the stable `0.1.x` interface for captures. A historical capture must be
  labelled with its version.
- Keep screenshots and diagrams readable at narrow widths; do not rely on a
  wide terminal to show the point.
- Optimize images before committing and keep the source asset next to the
  generated file when the build supports it.
- Use `<DocsFigure>` for screenshots. It requires `src`, a useful `alt`, a
  `caption`, and the natural `width`/`height`; the media check verifies all
  four.
- Every Mermaid fence declares `accTitle` and `accDescr`. The rendered SVG
  carries them as its accessible title and description.
- Regenerate captures with `npm run docs:media`, not during a docs build. Use
  `npm run docs:media:check` for the cheap manifest, alt-text, caption, and
  diagram check.

## Links, navigation, and redirects

- Use relative links between docs pages. Do not link to a local absolute path or
  a private repository.
- Link to the section index for a concept, not to an old aggregate index.
- Keep the docs home and section indexes current when you add a page.
- When a page or index entry moves, record the old location and the new home in
  the [redirect map](redirects.md).
- Link evidence only from the contributing hub, the evidence index, or a
  **Go deeper** section.
- Do not use a raw issue number as the only explanation of a behavior. Link the
  user page first and the evidence second.

## Review checklist

- [ ] The page answers one clear reader question.
- [ ] The title, description, and version scope are present.
- [ ] Every command runs as written and uses the stable version.
- [ ] Expected output is shown and redacted.
- [ ] Canonical terms match the table above.
- [ ] No credentials, private paths, conversations, or user data.
- [ ] Internal evidence is a **Go deeper** link, not a step.
- [ ] The page is linked from the right section index.
- [ ] Moved entries are recorded in the redirect map.
- [ ] The page has title, description, and version front matter; the H1 matches
      the title.
- [ ] `npm run docs:check` passes, including its default docs-site build and
      built-anchor crawl. CI runs `npm run docs:check:fast` in the separate Docs
      job; the Docs site job owns the one PR site build.
- [ ] `npm run verify` passes.
