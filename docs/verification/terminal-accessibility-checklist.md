# Terminal accessibility checklist

- **Status:** manual, host-dependent; unexecuted until a run is recorded below.
- **Applies to:** the Ensemble TUI on OpenCode 2.2.6/2.2.7 and the supported
  Node lines (22, 24, 26).
- **Automated companions:** `src/v2/tui/theme.test.ts` (contrast matrix),
  `src/v2/tui/workrows.test.ts` (glyph + word + tone), `src/v2/tui/interaction.test.ts`
  (keyboard-only reachability and no focus trap), `src/v2/tui/motion.test.ts`
  (reduced motion and ASCII frames), `src/v2/tui/separators.test.ts` (ASCII
  chrome).
- **Why manual:** the terminal emulator, font, screen reader, operating system,
  and OpenCode host own rendering, key routing, and the accessibility tree.
  The TUI can guarantee its own text and palette mapping, not the host's
  presentation.

Record one row per run. Never paste conversation content, prompts, answers,
credentials, file bytes, or private paths into this file.

| Date | Terminal / version | Screen reader | Theme / contrast mode | Result | Notes |
| --- | --- | --- | --- | --- | --- |
| _(pending)_ | | | | | |

## 1. Screen reader

Use at least one of: Orca + GNOME Terminal or WezTerm (Linux), NVDA + Windows
Terminal (Windows), VoiceOver + iTerm2 (macOS).

- [ ] Start Ensemble and read the statusline. Mode and context are words:
      `NORMAL │ Agents`, `INSERT │ Composer │ Group chat`, `V:LINE │ …`.
- [ ] Read a Work card. The state word is present (`QUEUED`, `WORKING`,
      `WAITING`, `RETRYING`, `NEEDS YOU`, `REPLIED`, `FAILED`, `STALLED`,
      `CANCELLED`), not only a color or glyph.
- [ ] Read a failed card and its transcript announcement. Both carry the word
      `failed` and the bounded error text.
- [ ] Read a needs-you/approval card. It says `NEEDS YOU` and
      `waiting for you…`; an approval row names its source and title.
- [ ] Read a terminal announcement. Replied, failed, and cancelled rows carry
      `finished`, `failed`, or `cancelled` plus the task title or reason.
- [ ] Read the composer, help overlay, settings rows, wizard steps, and command
      line. Every focused surface is named in text.
- [ ] Confirm no state is conveyed only by a glyph. Braille and status marks may
      be read as “Braille pattern” or skipped; the state word is the fallback.
- [ ] Note whether the screen reader follows the TUI focus. Most terminals read
      the text buffer on demand and do not expose TUI widgets as semantic
      controls; this is a host limit, not an Ensemble promise.

## 2. High contrast and themes

Run once with the terminal's default theme, once with the OS high-contrast
theme, and once with a custom OpenCode theme.

- [ ] Dark theme: text, muted text, faint text, status tones, pale-blue agent
      names, and the focused card border are readable.
- [ ] Light theme: the same roles are readable and the focused card border is
      dark rather than white-on-white.
- [ ] Custom theme with a raised card surface: the card surface and the
      surrounding page are distinguishable; text on both is readable.
- [ ] `NO_COLOR=1`: state words, glyphs, positions, and selection remain
      visible. Color suppression is host-dependent; the TUI never relies on
      color alone for state.
- [ ] Focus is visible without color: the focused card border and the selected
      pane are identifiable in a monochrome screenshot.
- [ ] Automated floor: text roles meet WCAG AA 4.5:1 and border/focus roles
      meet 3:1 on the palette matrix. If a host theme fails, switch themes and
      record the theme name; do not treat a host palette override as an
      Ensemble regression.

## 3. Font scaling and glyph coverage

- [ ] Set the terminal font to a small size (about 9–10 pt) and a large size
      (about 20–24 pt). Repeat at 80×24 and 120×40 cells.
- [ ] The status word is never truncated; the Work-card name truncates first.
- [ ] Every animated frame occupies one terminal cell. The layout does not
      reflow as frames advance.
- [ ] Braille frames (`⠋ ⠙ ⠹ …`) render as single cells. They require a font
      with U+2800–U+28FF (for example a Nerd Font or a terminal font with
      Braille Patterns). A missing font may show tofu or a fallback box.
- [ ] Status marks (`▫ ◌ ◆ ● ✕ ◍ ⊘`) and the empty-state mark (`○───○───○`)
      render. If they do not, the state words still carry the meaning.
- [ ] Wide characters (CJK, emoji) in user content do not shift the status
      word or the card right edge.
- [ ] Terminal line height and letter spacing do not clip the top or bottom
      row of a card.

## 4. Reduced motion

- [ ] `ENSEMBLE_REDUCED_MOTION=1` (or `true`) freezes every animated glyph to
      its still frame; no frame advances.
- [ ] `NO_COLOR` also freezes motion (presence is the signal, even an empty
      value), matching the reduced-motion convention.
- [ ] First-paint stagger is off; transcript rows appear full.
- [ ] The Work-card tide is static and the card still shows its state word,
      title, and detail.
- [ ] No decorative motion is required to understand state. `WORKING` still
      reads `WORKING` when the Braille cell is frozen at `⠋`.

## 5. ASCII fallback

- [ ] `ENSEMBLE_ASCII=1` (or `true`) or `TERM=dumb` replaces chrome separators
      with `|`.
- [ ] ASCII mode replaces decorative glyphs with one-cell ASCII: working `*`,
      waiting `-`, waiting-for-children `o`, retrying `~`, needs-you `!`,
      replied `+`, failed `x`, stalled `%`, cancelled `/`.
- [ ] Init stage marks read `#` and `-`; the empty-state mark reads
      `o---o---o`.
- [ ] State words, card titles, details, approvals, and terminal announcements
      are unchanged. Chat message content is never rewritten by the ASCII
      fallback.
- [ ] A terminal without Braille or Unicode box drawing remains usable with
      ASCII mode; a terminal with a Braille font can use the default mode.

## 6. Keyboard-only

Disconnect or ignore the mouse for the whole pass.

- [ ] `Tab` / `Shift+Tab` cycles every visible pane and returns to the start.
      Hidden panes are skipped. No pane traps focus.
- [ ] `h/l` selects columns and `j/k` selects stacked panes in select mode;
      `Enter` enters the selected pane.
- [ ] `Esc` walks up one level from every context: command → search → visual →
      insert → composer normal → chat → pane selection; overlays close; the
      wizard confirmation is the only adapter-owned stop.
- [ ] Roster: `j/k`, `gg/G`, `Enter`, `a`, `n`, `e`, `s`, `x`, `X`, `v`, `I`,
      `p`, `/`, `z`, and `Space` are reachable without a mouse.
- [ ] Chat: `j/k`, `gg/G`, `Ctrl+D/U`, `i`, `/`, `x`, `a`, `n`, `s`, `v`,
      `o`, `p`, `w/W`, `z/Z`, and `Space` are reachable.
- [ ] Work: `j/k`, `h/l`, `gg/G`, `Ctrl+D/U`, `Enter`, `w`, `d`, `t`, `r`,
      `R`, `x`, `D`, `f`, `o`, `v`, and `Space` are reachable.
- [ ] Approvals: `j/k`, `gg/G`, `Enter`, `Esc`, and `Tab` are reachable.
- [ ] Settings: tabs (`h/l`), rows (`j/k`), edit/toggle (`Enter`/`e`), add,
      delete, save, filter, reorder, and close are reachable.
- [ ] Wizard and prompt: list navigation, text entry, continue/back, multi-select,
      filter, memory actions, cancel, and Ctrl+G leave are reachable.
- [ ] Composer: Insert, Normal, and Visual modes, send, newline, mention,
      file, slash, stop, and leave are reachable.
- [ ] Help and command/search open, filter, page, and close from the keyboard.
- [ ] Every action named in Help has a key sequence in the catalog; no action
      requires a pointer.

## 7. Host-dependent limits

- [ ] The TUI is a terminal surface, not a native accessibility tree. Screen
      readers read cells/lines; they do not receive widget roles, names, or
      live-region announcements from Ensemble.
- [ ] Streaming transcript updates are not announced automatically. Navigate
      to the row or use the terminal's review buffer.
- [ ] Unicode, Braille, color depth, and font fallback are terminal/font
      properties. Ensemble documents the required ranges and provides the
      ASCII fallback, but cannot install a font or override every terminal.
- [ ] Terminal high-contrast modes and `NO_COLOR` may override the host theme
      or the TUI palette. State words remain the source of truth.
- [ ] OpenCode owns focus, key routing, and the host theme. A host keybinding
      can shadow a TUI key; verify the binding in Help on that host.
- [ ] tmux/screen, SSH, and multiplexers can change color, Unicode width, and
      key sequences. Re-run the contrast and keyboard checks inside the
      multiplexer actually used.
- [ ] OS font scaling and terminal zoom change the cell grid; the TUI does not
      implement its own font scaling. Re-check the 80×24 and 120×40 layouts at
      the scaled size.
- [ ] macOS/Herdr and Windows are not executed by the automated gate. Record a
      manual run before claiming them.
- [ ] Mouse actions are optional. Every product action has a keyboard path;
      a pointer is never required.

## Sign-off

| Check | Result | Evidence |
| --- | --- | --- |
| Screen reader | | |
| High contrast / themes | | |
| Font scaling / Braille | | |
| Reduced motion | | |
| ASCII fallback | | |
| Keyboard-only | | |
| Host limits reviewed | | |
