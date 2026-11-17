/**
 * Pure helpers for the documentation quality gate (ticket #310).
 *
 * These functions parse Markdown without rendering it: frontmatter, heading
 * anchors, links, fenced blocks, and shell syntax. The docs check owns the
 * repository-specific policy; this module keeps the parsing testable.
 */
import { spawnSync } from "node:child_process"

export interface Frontmatter {
  hasFrontmatter: boolean
  values: Record<string, string>
  body: string
}

export interface FencedBlock {
  language: string
  content: string
  startLine: number
  closed: boolean
}

export interface ExtractedLink {
  href: string
  line: number
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/

export function parseFrontmatter(markdown: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown)
  if (!match) return { hasFrontmatter: false, values: {}, body: markdown }
  const values: Record<string, string> = {}
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!field) continue
    values[field[1]!] = field[2]!.replace(/^["']|["']$/g, "").trim()
  }
  return { hasFrontmatter: true, values, body: markdown.slice(match[0].length) }
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/[*~]/g, "")
    .trim()
}

/** GitHub's heading slug for the ordinary ASCII headings used by these docs. */
export function githubSlug(text: string): string {
  return stripInlineMarkdown(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-")
}

function fenceLine(line: string, fence: { char: string; length: number }): boolean {
  return new RegExp(`^ {0,3}${fence.char === "`" ? "`" : "~"}{${fence.length},}\\s*$`).test(line)
}

/** Every fenced block, including an unclosed final block. */
export function fencedBlocks(markdown: string): FencedBlock[] {
  const blocks: FencedBlock[] = []
  const lines = markdown.split(/\r?\n/)
  let current:
    | { char: string; length: number; language: string; content: string[]; startLine: number }
    | undefined
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    if (!current) {
      const open = FENCE_OPEN.exec(line)
      if (!open) continue
      current = {
        char: open[1]![0]!,
        length: open[1]!.length,
        language: open[2]!.trim().split(/\s+/)[0] ?? "",
        content: [],
        startLine: index + 1,
      }
      continue
    }
    if (fenceLine(line, current)) {
      blocks.push({
        language: current.language,
        content: current.content.join("\n"),
        startLine: current.startLine,
        closed: true,
      })
      current = undefined
      continue
    }
    current.content.push(line)
  }
  if (current) {
    blocks.push({
      language: current.language,
      content: current.content.join("\n"),
      startLine: current.startLine,
      closed: false,
    })
  }
  return blocks
}

function blankFences(markdown: string): string {
  const lines = markdown.split(/\r?\n/)
  let fence: { char: string; length: number } | undefined
  return lines
    .map((line) => {
      if (!fence) {
        const open = FENCE_OPEN.exec(line)
        if (open) {
          fence = { char: open[1]![0]!, length: open[1]!.length }
          return ""
        }
        return line
      }
      if (fenceLine(line, fence)) fence = undefined
      return ""
    })
    .join("\n")
}

function blankInlineCode(markdown: string): string {
  return markdown
    .replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(/`[^`\n]*`/g, (code) => " ".repeat(code.length))
}

/** Headings (GitHub slugs) and explicit `<a name>` anchors used by a page. */
export function pageAnchors(markdown: string): Set<string> {
  const text = blankFences(markdown).replace(/<!--[\s\S]*?-->/g, "")
  const anchors = new Set<string>()
  const seen = new Map<string, number>()
  for (const match of text.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const slug = githubSlug(match[1]!.replace(/\s*\{#[^}]+\}\s*$/, ""))
    const count = seen.get(slug) ?? 0
    seen.set(slug, count + 1)
    anchors.add(count === 0 ? slug : `${slug}-${count}`)
  }
  for (const match of text.matchAll(/<a\b[^>]*\b(?:name|id)\s*=\s*"([^"]+)"/gi)) {
    anchors.add(match[1]!)
  }
  return anchors
}

/** Markdown links, images, and raw HTML links, with their 1-based line. */
export function extractLinks(markdown: string): ExtractedLink[] {
  const text = blankInlineCode(blankFences(markdown))
  const links: ExtractedLink[] = []
  const add = (index: number, href: string): void => {
    if (!href) return
    links.push({
      href: href.startsWith("<") && href.endsWith(">") ? href.slice(1, -1) : href,
      line: text.slice(0, index).split("\n").length,
    })
  }
  for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)) {
    add(match.index ?? 0, match[1] ?? "")
  }
  for (const match of text.matchAll(/<(?:a|img)\b[^>]*\b(?:href|src)\s*=\s*"([^"]+)"/gi)) {
    add(match.index ?? 0, match[1] ?? "")
  }
  return links
}

/**
 * Run `bash -n` over every documented `sh`/`bash` block. Angle-bracket
 * placeholders are part of the docs style guide; replace them with one word so
 * shell redirection parsing does not produce a false syntax error.
 */
export function shellSyntaxFailures(markdown: string): string[] {
  const failures: string[] = []
  for (const block of fencedBlocks(markdown)) {
    if (!["sh", "bash", "shell"].includes(block.language)) continue
    const source = block.content.replace(/<[A-Za-z][^<>\s]*>/g, "PLACEHOLDER")
    if (!source.trim()) continue
    const result = spawnSync("bash", ["-n"], { input: source, encoding: "utf8" })
    if (result.error) {
      failures.push(`line ${block.startLine}: shell syntax check could not run (${result.error.message})`)
      continue
    }
    if (result.status !== 0) {
      const detail = (result.stderr || "").trim().split("\n").find((line) => line.trim().length > 0)
      failures.push(`line ${block.startLine}: shell syntax error${detail ? `: ${detail}` : ""}`)
    }
  }
  return failures
}
