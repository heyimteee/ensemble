# Native-first child-ticket evidence index

- **Date:** 2026-11-11
- **Parent:** [#209](https://github.com/heyimteee/ensemble/issues/209)
- **Cutover:** [#227](https://github.com/heyimteee/ensemble/issues/227)
- **Integration tip:** `d2659ab` (`Merge ticket #225`)

This index records where each native-first child ticket's verification lives.
Tickets with a committed record under `docs/verification/` are linked directly.
Tickets that closed with a merge/verification comment on the issue are marked
**issue comment**; the comment names the merge commit and the exact
`npm run verify` result. No claim is upgraded by this index.

| Ticket | Scope | State | Verification evidence |
|---|---|---|---|
| [#210](https://github.com/heyimteee/ensemble/issues/210) | Host native-event contract probe | Closed | [2026-11-10-native-host-contract.md](2026-11-10-native-host-contract.md); 304-row fixture, 14 contract tests |
| [#211](https://github.com/heyimteee/ensemble/issues/211) | ADRs and glossary | Closed | Issue comment; docs-only, `1553/1553` at `2d50b0a` |
| [#212](https://github.com/heyimteee/ensemble/issues/212) | Conversation-scoped message channels | Closed | Issue comment; `1568/1568` at `49b1201` |
| [#213](https://github.com/heyimteee/ensemble/issues/213) | Conversation binding foundation | Closed | Issue comment; merge `33588f7` |
| [#214](https://github.com/heyimteee/ensemble/issues/214) | Direct chat on its own native session | Closed | Issue comment; merge `7eba79c` |
| [#215](https://github.com/heyimteee/ensemble/issues/215) | Direct native turn ingestion | Closed | [2026-11-10-ticket-215.md](2026-11-10-ticket-215.md); `1660/1660` |
| [#216](https://github.com/heyimteee/ensemble/issues/216) | Workspace native turn ingestion | Closed | [2026-11-11-ticket-216.md](2026-11-11-ticket-216.md); `1717/1717` |
| [#217](https://github.com/heyimteee/ensemble/issues/217) | Retry and interruption semantics | Closed | [2026-11-11-ticket-217.md](2026-11-11-ticket-217.md); `1731/1731` |
| [#218](https://github.com/heyimteee/ensemble/issues/218) | Reconciliation and support surface | Closed | [2026-11-11-ticket-218.md](2026-11-11-ticket-218.md); `1784/1784` |
| [#219](https://github.com/heyimteee/ensemble/issues/219) | Mention-safe parser and routing policy | Closed | Issue comment; pure parser, `1580/1580` at `808138c` |
| [#220](https://github.com/heyimteee/ensemble/issues/220) | Native user-message mentions | Closed | Issue comment; `1728/1728` at `9e7254c` |
| [#221](https://github.com/heyimteee/ensemble/issues/221) | Native agent final-text mentions | Closed | Issue comment; `1764/1764` at `8923d99` |
| [#222](https://github.com/heyimteee/ensemble/issues/222) | Work history and persistent cards | Closed | Issue comment; `1756/1756` at `324e180` |
| [#223](https://github.com/heyimteee/ensemble/issues/223) | Composer attachments | Closed | [2026-11-10-ticket-223.md](2026-11-10-ticket-223.md); #227 found the native-prompt size path is incomplete (**#228**) |
| [#224](https://github.com/heyimteee/ensemble/issues/224) | Session picker and adoption | Closed | Issue comment; merge `ddbf0d5`, `1702/1702` |
| [#225](https://github.com/heyimteee/ensemble/issues/225) | Tool retirement and contract shrink | Closed | [2026-11-11-ticket-225.md](2026-11-11-ticket-225.md); `1798/1798` |
| [#226](https://github.com/heyimteee/ensemble/issues/226) | Legacy DM transcript contract | Closed | [2026-11-11-ticket-226.md](2026-11-11-ticket-226.md); `1770/1770` |
| [#228](https://github.com/heyimteee/ensemble/issues/228) | Native prompt attachment size (follow-up) | Fixed | [2026-11-11-ticket-228.md](2026-11-11-ticket-228.md); `1801/1801`; live main 65/65 |

**Gap:** #211, #212, #213, #214, #219, #220, #221, #222, and #224 do not have a
dedicated committed file. Their evidence is the closing issue comment plus the
merge commit and full-suite count recorded there. This index is not a
replacement for those records; it is the link map used by #227.

The #227 cutover matrix is in
[2026-11-11-native-first.md](2026-11-11-native-first.md).
