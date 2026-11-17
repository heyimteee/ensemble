#!/usr/bin/env python3
"""Render deterministic documentation media from real tmux ANSI captures.

This is generation tooling, not a docs-build dependency. The capture harness
(`scripts/docs-media.sh`) owns the isolated synthetic workspace and writes one
ANSI snapshot per UI state. This script only turns those snapshots into the
committed PNGs and the asciinema cast; it never contacts a host or reads real
user data.

Requires Pillow (the renderer) and Python 3.11+. The media check in CI only
inspects the committed manifest and Markdown, so a docs build does not need
Python or Pillow.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from dataclasses import dataclass
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError as error:  # pragma: no cover - exercised only without Pillow
    print(
        "docs-media-render: Pillow is required for manual media regeneration: "
        f"{error}",
        file=sys.stderr,
    )
    raise SystemExit(2)

DEFAULT_FG = (238, 238, 238)
DEFAULT_BG = (10, 10, 10)
SGR_RE = re.compile(r"\x1b\[([0-9;:]*)m")
ESCAPE_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")
FONT_CANDIDATES = (
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    "/usr/share/fonts/truetype/noto/NotoSansMono-Regular.ttf",
    "/System/Library/Fonts/Menlo.ttc",
)
BOLD_CANDIDATES = (
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
    "/usr/share/fonts/truetype/noto/NotoSansMono-Bold.ttf",
)
ITALIC_CANDIDATES = (
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Oblique.ttf",
    "/usr/share/fonts/truetype/noto/NotoSansMono-Italic.ttf",
)


@dataclass
class Cell:
    char: str
    fg: tuple[int, int, int]
    bg: tuple[int, int, int]
    bold: bool = False
    faint: bool = False
    italic: bool = False
    underline: bool = False


def first_existing(candidates: tuple[str, ...]) -> str:
    for candidate in candidates:
        if Path(candidate).exists():
            return candidate
    raise SystemExit(
        "docs-media-render: no monospace font found; install DejaVu Sans Mono "
        "or pass --font"
    )


def parse_sgr(params: str, state: dict) -> None:
    values = [int(part) if part else 0 for part in params.split(";")]
    index = 0
    while index < len(values):
        value = values[index]
        if value == 0:
            state.update(fg=None, bg=None, bold=False, faint=False, italic=False, underline=False, reverse=False)
        elif value == 1:
            state["bold"] = True
        elif value == 2:
            state["faint"] = True
        elif value == 3:
            state["italic"] = True
        elif value == 4:
            state["underline"] = True
        elif value == 7:
            state["reverse"] = True
        elif value == 22:
            state["bold"] = False
            state["faint"] = False
        elif value == 23:
            state["italic"] = False
        elif value == 24:
            state["underline"] = False
        elif value == 27:
            state["reverse"] = False
        elif value == 39:
            state["fg"] = None
        elif value == 49:
            state["bg"] = None
        elif 30 <= value <= 37:
            state["fg"] = ("ansi", value - 30)
        elif 90 <= value <= 97:
            state["fg"] = ("ansi", value - 90 + 8)
        elif 40 <= value <= 47:
            state["bg"] = ("ansi", value - 40)
        elif 100 <= value <= 107:
            state["bg"] = ("ansi", value - 100 + 8)
        elif value in (38, 48):
            target = "fg" if value == 38 else "bg"
            if index + 1 < len(values) and values[index + 1] == 5 and index + 2 < len(values):
                state[target] = ("256", values[index + 2])
                index += 2
            elif index + 1 < len(values) and values[index + 1] == 2 and index + 4 < len(values):
                state[target] = ("rgb", (values[index + 2], values[index + 3], values[index + 4]))
                index += 4
        index += 1


ANSI16 = (
    (0, 0, 0),
    (205, 49, 49),
    (13, 188, 121),
    (229, 229, 16),
    (36, 114, 200),
    (188, 63, 188),
    (17, 168, 205),
    (229, 229, 229),
    (102, 102, 102),
    (241, 76, 76),
    (35, 209, 139),
    (245, 245, 67),
    (59, 142, 234),
    (214, 112, 214),
    (41, 184, 219),
    (255, 255, 255),
)


def color_of(spec, fallback, default_map) -> tuple[int, int, int]:
    if spec is None:
        return fallback
    kind, value = spec
    if kind == "ansi":
        return ANSI16[value]
    if kind == "rgb":
        return value
    if kind == "256":
        if value < 16:
            return ANSI16[value]
        if value < 232:
            index = value - 16
            levels = [0, 95, 135, 175, 215, 255]
            return (levels[index // 36], levels[(index // 6) % 6], levels[index % 6])
        level = 8 + (value - 232) * 10
        return (level, level, level)
    return default_map


def char_width(char: str) -> int:
    if unicodedata.combining(char):
        return 0
    return 2 if unicodedata.east_asian_width(char) in ("W", "F") else 1


def parse_cells(raw: str, cols: int, rows: int, replacements: list[tuple[str, str]]) -> list[list[Cell]]:
    for old, new in replacements:
        raw = raw.replace(old, new)
    # Keep SGR sequences; tmux may also include cursor/visibility controls that
    # must never become literal text in the image.
    raw = re.sub(r"\x1b\[(?![0-9;:]*m)[0-9;?]*[ -/]*[@-~]", "", raw)
    grid = [[Cell(" ", DEFAULT_FG, DEFAULT_BG) for _ in range(cols)] for _ in range(rows)]
    state = {"fg": None, "bg": None, "bold": False, "faint": False, "italic": False, "underline": False, "reverse": False}
    row = 0
    col = 0
    index = 0
    while index < len(raw):
        char = raw[index]
        if char == "\x1b":
            match = SGR_RE.match(raw, index)
            if match:
                parse_sgr(match.group(1), state)
                index = match.end()
                continue
            index += 1
            continue
        if char == "\n":
            row += 1
            col = 0
            index += 1
            continue
        if char == "\r":
            col = 0
            index += 1
            continue
        if char == "\t":
            col += 8 - (col % 8)
            index += 1
            continue
        width = char_width(char)
        if width == 0:
            index += 1
            continue
        if row >= rows:
            index += 1
            continue
        if col + width > cols:
            row += 1
            col = 0
            if row >= rows:
                break
        fg = color_of(state["fg"], DEFAULT_FG, ANSI16)
        bg = color_of(state["bg"], DEFAULT_BG, ANSI16)
        if state["faint"]:
            fg = tuple(round((a + b) / 2) for a, b in zip(fg, bg))
        if state["reverse"]:
            fg, bg = bg, fg
        grid[row][col] = Cell(
            char,
            fg,
            bg,
            bold=state["bold"],
            faint=state["faint"],
            italic=state["italic"],
            underline=state["underline"],
        )
        if width == 2 and col + 1 < cols:
            grid[row][col + 1] = Cell("", fg, bg)
        col += width
        index += 1
    return grid


def load_font(size: int, path: str | None, bold: bool = False, italic: bool = False):
    if path:
        return ImageFont.truetype(path, size)
    candidates = BOLD_CANDIDATES if bold else ITALIC_CANDIDATES if italic else FONT_CANDIDATES
    try:
        return ImageFont.truetype(first_existing(candidates), size)
    except SystemExit:
        return ImageFont.truetype(first_existing(FONT_CANDIDATES), size)


def render_png(args: argparse.Namespace) -> None:
    source = Path(args.input).read_text(encoding="utf-8", errors="replace")
    replacements = []
    for pair in args.replace or []:
        if "=" not in pair:
            raise SystemExit(f"docs-media-render: --replace needs OLD=NEW, got {pair!r}")
        old, new = pair.split("=", 1)
        replacements.append((old, new))
    grid = parse_cells(source, args.cols, args.rows, replacements)
    if args.forbid:
        visible = "".join(cell.char for row in grid for cell in row)
        for marker in args.forbid:
            if marker in visible:
                raise SystemExit(f"docs-media-render: {args.input}: captured text contains forbidden {marker!r}")
    if args.crop:
        try:
            x1, y1, x2, y2 = (int(part) for part in args.crop.split(","))
        except ValueError as error:
            raise SystemExit(f"docs-media-render: bad --crop: {error}") from error
        if not (0 <= x1 < x2 <= args.cols and 0 <= y1 < y2 <= args.rows):
            raise SystemExit("docs-media-render: --crop is outside the capture")
        grid = [row[x1:x2] for row in grid[y1:y2]]
    cols = len(grid[0]) if grid else 0
    rows = len(grid)
    font = load_font(args.font_size, args.font)
    bold_font = load_font(args.font_size, args.font, bold=True)
    italic_font = load_font(args.font_size, args.font, italic=True)
    advance = max(1, round(font.getlength("M")))
    line_height = max(1, round(args.font_size * args.line_height))
    padding = args.padding
    width = cols * advance + padding * 2
    height = rows * line_height + padding * 2
    image = Image.new("RGB", (width, height), args.background or DEFAULT_BG)
    draw = ImageDraw.Draw(image)
    for row_index, row in enumerate(grid):
        y = padding + row_index * line_height
        run_start = 0
        while run_start < cols:
            bg = row[run_start].bg
            run_end = run_start + 1
            while run_end < cols and row[run_end].bg == bg:
                run_end += 1
            if bg != (args.background or DEFAULT_BG):
                draw.rectangle(
                    [padding + run_start * advance, y, padding + run_end * advance - 1, y + line_height - 1],
                    fill=bg,
                )
            run_start = run_end
        for col_index, cell in enumerate(row):
            if not cell.char or cell.char == " ":
                continue
            text_font = bold_font if cell.bold else italic_font if cell.italic else font
            x = padding + col_index * advance
            draw.text((x, y), cell.char, font=text_font, fill=cell.fg)
            if cell.underline:
                draw.line(
                    [x, y + line_height - 2, x + advance - 1, y + line_height - 2],
                    fill=cell.fg,
                    width=max(1, args.font_size // 16),
                )
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    image.save(output, "PNG", optimize=True)
    print(f"rendered {output} ({width}x{height}) from {args.input}")


def emit_row_ansi(row: list[Cell]) -> str:
    parts = []
    current = None
    for cell in row:
        spec = (cell.fg, cell.bg, cell.bold, cell.faint, cell.italic, cell.underline)
        if spec != current:
            current = spec
            fg, bg, bold, faint, italic, underline = spec
            codes = ["0"]
            if bold:
                codes.append("1")
            if faint:
                codes.append("2")
            if italic:
                codes.append("3")
            if underline:
                codes.append("4")
            codes.append(f"38;2;{fg[0]};{fg[1]};{fg[2]}")
            codes.append(f"48;2;{bg[0]};{bg[1]};{bg[2]}")
            parts.append(f"\x1b[{';'.join(codes)}m")
        parts.append(cell.char if cell.char else " ")
    parts.append("\x1b[0m")
    return "".join(parts)


def build_cast(args: argparse.Namespace) -> None:
    frames = json.loads(Path(args.frames).read_text(encoding="utf-8"))
    if not isinstance(frames, list) or not frames:
        raise SystemExit("docs-media-render: --frames must be a non-empty JSON array")
    events = []
    for frame in frames:
        if not isinstance(frame, dict):
            raise SystemExit("docs-media-render: every frame must be an object")
        source = Path(frame["ansi"]).read_text(encoding="utf-8", errors="replace")
        replacements = []
        for pair in args.replace or []:
            old, new = pair.split("=", 1)
            replacements.append((old, new))
        grid = parse_cells(source, args.cols, args.rows, replacements)
        if args.forbid:
            visible = "".join(cell.char for row in grid for cell in row)
            for marker in args.forbid:
                if marker in visible:
                    raise SystemExit(f"docs-media-render: {args.input}: captured text contains forbidden {marker!r}")
        body = ["\x1b[2J\x1b[H\x1b[?25l"]
        for row_index, row in enumerate(grid):
            body.append(f"\x1b[{row_index + 1};1H{emit_row_ansi(row)}")
        events.append([float(frame.get("time", 0)), "o", "".join(body)])
    header = {
        "version": 2,
        "width": args.cols,
        "height": args.rows,
        "timestamp": 0,
        "env": {"SHELL": "/bin/bash", "TERM": "xterm-256color"},
        "title": args.title,
    }
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(header, ensure_ascii=False, separators=(",", ":")) + "\n")
        for event in events:
            handle.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"wrote {output} ({len(events)} frames)")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    image = sub.add_parser("image", help="render one ANSI snapshot to PNG")
    image.add_argument("--input", required=True)
    image.add_argument("--output", required=True)
    image.add_argument("--cols", type=int, required=True)
    image.add_argument("--rows", type=int, required=True)
    image.add_argument("--crop", help="cell crop x1,y1,x2,y2 (x2/y2 exclusive)")
    image.add_argument("--replace", action="append", metavar="OLD=NEW")
    image.add_argument("--font-size", type=int, default=16)
    image.add_argument("--line-height", type=float, default=1.25)
    image.add_argument("--padding", type=int, default=0)
    image.add_argument("--font")
    image.add_argument("--background")
    image.add_argument("--forbid", action="append", metavar="TEXT")
    image.set_defaults(func=render_png)

    cast = sub.add_parser("cast", help="write an asciinema v2 cast from ANSI snapshots")
    cast.add_argument("--frames", required=True, help="JSON array of {time, ansi} frames")
    cast.add_argument("--output", required=True)
    cast.add_argument("--cols", type=int, required=True)
    cast.add_argument("--rows", type=int, required=True)
    cast.add_argument("--title", default="Ensemble synthetic fixture")
    cast.add_argument("--replace", action="append", metavar="OLD=NEW")
    cast.add_argument("--forbid", action="append", metavar="TEXT")
    cast.set_defaults(func=build_cast)

    args = parser.parse_args()
    if getattr(args, "background", None):
        args.background = tuple(int(args.background[index : index + 2], 16) for index in (1, 3, 5))
    args.func(args)


if __name__ == "__main__":
    main()
