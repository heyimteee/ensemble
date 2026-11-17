#!/usr/bin/env node
/**
 * Documentation media and accessible-text check (ticket #309).
 *
 * The screenshots and cast are generated manually from an isolated synthetic
 * fixture; this check never starts a host. It verifies that the committed
 * manifest matches the files, every screenshot is used with useful alt text and
 * a caption, every Mermaid diagram declares an accessible title and
 * description, and user-facing pages keep a valid heading order.
 *
 * Usage:
 *   node scripts/docs-media-check.mjs [--root DIR]
 */
import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { privateIdentity } from "./lib/privacy.mjs"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const MANIFEST = "docs/public/media/MANIFEST.json"
const MEDIA_PREFIX = "/media/"
const IDENTITY = privateIdentity()
const FIXTURE_FORBIDDEN = ["fake-rich-fixture", "RICH_CODE_MARKER", "fake-ask-person"]
const ASSET_FORBIDDEN = ["/home/", "/Users/", "C:\\\\", ...IDENTITY.markers, ...FIXTURE_FORBIDDEN]
const PAGE_FORBIDDEN = [...IDENTITY.markers, ...FIXTURE_FORBIDDEN]
const USER_SECTIONS = [
  "getting-started",
  "concepts",
  "guides",
  "reference",
  "operations",
  "security",
  "privacy",
  "support",
]
const HEADING_EXCLUDES = ["docs/verification/", "docs/adr/", "docs/agents/", "docs/assessments/", "docs/compatibility/"]
const DOC_MEDIA_PAGES = ["docs/README.md", "docs/style-guide.md", "docs/redirects.md", "docs/contributing/README.md"]

function parseArgs(argv) {
  const args = { root: REPO_ROOT, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--root") {
      const value = argv[++index]
      if (!value || value.startsWith("--")) throw new Error("--root needs a value")
      args.root = resolve(value)
    } else if (arg === "--help" || arg === "-h") {
      args.help = true
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return args
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex")
}

function pngSize(buffer) {
  if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG") return undefined
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

function markdownPages(root) {
  const pages = []
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue
      const full = join(directory, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith(".md")) pages.push(full)
    }
  }
  walk(join(root, "docs"))
  return pages.sort()
}

function isUserPage(relativePath) {
  return (
    relativePath === "docs/README.md" ||
    DOC_MEDIA_PAGES.includes(relativePath) ||
    USER_SECTIONS.some((section) => relativePath === `docs/${section}/README.md` || relativePath.startsWith(`docs/${section}/`))
  )
}

function stripFences(markdown) {
  return markdown.replace(/```[\s\S]*?```/g, "").replace(/~~~[\s\S]*?~~~/g, "")
}

function checkHeadings(file, markdown, failures) {
  const relativePath = file.replace(/\\/g, "/")
  if (!isUserPage(relativePath) || HEADING_EXCLUDES.some((prefix) => relativePath.startsWith(prefix))) return
  const text = stripFences(markdown).replace(/<!--[\s\S]*?-->/g, "")
  const headings = [...text.matchAll(/^(#{1,6})\s+(.+)$/gm)].map((match) => ({ level: match[1].length, title: match[2].trim() }))
  const h1 = headings.filter((heading) => heading.level === 1)
  if (h1.length !== 1) {
    failures.push(`${relativePath}: expected exactly one H1, found ${h1.length}`)
    return
  }
  let previous = 1
  for (const heading of headings) {
    if (heading.level > previous + 1) {
      failures.push(`${relativePath}: heading level skips from H${previous} to H${heading.level} at ${JSON.stringify(heading.title)}`)
    }
    previous = heading.level
  }
}

function checkMermaid(file, relativePath, markdown, failures) {
  const diagrams = [...markdown.matchAll(/```mermaid\n([\s\S]*?)```/g)]
  for (const [index, match] of diagrams.entries()) {
    const body = match[1]
    if (!/^\s*accTitle\s*:/m.test(body)) {
      failures.push(`${relativePath}: Mermaid diagram ${index + 1} is missing accTitle`)
    }
    if (!/^\s*accDescr\s*:/m.test(body)) {
      failures.push(`${relativePath}: Mermaid diagram ${index + 1} is missing accDescr`)
    }
  }
  return diagrams.length
}

function attr(source, name) {
  const match = new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(source)
  return match?.[1]
}

/**
 * The docs check contract reports a missing required page as a validation
 * failure (exit 1), not an uncaught I/O error (exit 2). Keep the missing-file
 * diagnostic so a real repository cannot silently pass with no README.
 */
function readRequiredPage(root, relativePath, failures) {
  const full = join(root, relativePath)
  if (!existsSync(full)) {
    failures.push(`${relativePath}: file is missing`)
    return undefined
  }
  return readFileSync(full, "utf8")
}

function checkMarkdownMedia(root, manifest, failures) {
  const pages = markdownPages(root)
  const used = new Set()
  let diagramCount = 0
  for (const file of pages) {
    const relativePath = relative(root, file).replace(/\\/g, "/")
    const markdown = readFileSync(file, "utf8")
    diagramCount += checkMermaid(file, relativePath, markdown, failures)
    checkHeadings(file, relativePath, markdown, failures)

    for (const match of markdown.matchAll(/<DocsFigure\b([\s\S]*?)\/>/g)) {
      const block = match[1]
      const src = attr(block, "src")
      const alt = attr(block, "alt")
      const caption = attr(block, "caption")
      const width = attr(block, "width")
      const height = attr(block, "height")
      if (!src || !src.startsWith(MEDIA_PREFIX)) {
        failures.push(`${relativePath}: DocsFigure src must start with ${MEDIA_PREFIX}`)
        continue
      }
      const name = src.slice(MEDIA_PREFIX.length)
      const asset = manifest.assets[name]
      if (!asset || asset.kind !== "screenshot") {
        failures.push(`${relativePath}: DocsFigure ${src} is not a manifest screenshot`)
        continue
      }
      used.add(name)
      if (!alt || alt.trim().length < 30) failures.push(`${relativePath}: DocsFigure ${src} needs useful alt text`)
      if (!caption || caption.trim().length < 20) failures.push(`${relativePath}: DocsFigure ${src} needs a caption`)
      if (width !== String(asset.width) || height !== String(asset.height)) {
        failures.push(`${relativePath}: DocsFigure ${src} width/height must match the manifest (${asset.width}x${asset.height})`)
      }
    }

    for (const match of markdown.matchAll(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      if (!match[1].trim()) failures.push(`${relativePath}: Markdown image ${match[2]} needs alt text`)
      if (match[2].startsWith("/")) failures.push(`${relativePath}: Markdown image ${match[2]} should use DocsFigure`)
    }
    for (const match of markdown.matchAll(/<img\b[^>]*>/g)) {
      if (!/\balt\s*=\s*"[^"]+"/.test(match[0])) failures.push(`${relativePath}: raw img needs alt text`)
    }

    if (markdown.includes("<TerminalHero")) {
      if (!/\bposter-alt\s*=\s*"[^"]{30,}"/.test(markdown)) {
        failures.push(`${relativePath}: TerminalHero needs a useful poster-alt`)
      }
      if (!/\bcaption\s*=\s*"[^"]{20,}"/.test(markdown)) {
        failures.push(`${relativePath}: TerminalHero needs a caption`)
      }
      if (!/<summary>Text summary of the replay<\/summary>/.test(readFileSync(join(root, "docs/.vitepress/theme/TerminalHero.vue"), "utf8"))) {
        failures.push("docs/.vitepress/theme/TerminalHero.vue: text summary is missing")
      }
      const component = readFileSync(join(root, "docs/.vitepress/theme/TerminalHero.vue"), "utf8")
      if ((component.match(/<li>/g) ?? []).length < 4) {
        failures.push("docs/.vitepress/theme/TerminalHero.vue: needs at least four text-summary beats")
      }
    }

    if (!HEADING_EXCLUDES.some((prefix) => relativePath.startsWith(prefix))) {
      for (const marker of PAGE_FORBIDDEN) {
        if (markdown.includes(marker)) failures.push(`${relativePath}: contains forbidden private-data marker ${JSON.stringify(marker)}`)
      }
    }
  }

  for (const name of Object.keys(manifest.assets)) {
    const asset = manifest.assets[name]
    if (asset.kind === "screenshot" && !used.has(name)) failures.push(`media: ${name} is not referenced by a DocsFigure`)
  }
  const rootReadme = readRequiredPage(root, "README.md", failures)
  if (rootReadme) {
    for (const match of rootReadme.matchAll(/<img\b[^>]*>/g)) {
      const tag = match[0]
      if (!/\balt\s*=\s*"[^"]+"/.test(tag)) {
        failures.push("README.md: raw img needs alt text")
      } else if (tag.includes("docs/public/media/") && !/\balt\s*=\s*"[^"]{30,}"/.test(tag)) {
        failures.push("README.md: product screenshot needs useful alt text")
      }
    }
    if (!rootReadme.includes("docs/public/media/workspace-shell.png")) {
      failures.push("README.md: the product landing page must show the workspace screenshot")
    }
  }
  const home = readRequiredPage(root, "docs/README.md", failures)
  if (home) {
    if (!home.includes("hero-terminal.cast")) failures.push("docs/README.md: TerminalHero must use hero-terminal.cast")
    if (!home.includes("<TerminalHero")) failures.push("docs/README.md: the terminal hero is missing")
  }
  return diagramCount
}

function checkManifest(root, failures) {
  const path = join(root, MANIFEST)
  if (!existsSync(path)) {
    failures.push(`${MANIFEST}: file is missing; run npm run docs:media`)
    return undefined
  }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    failures.push(`${MANIFEST}: invalid JSON (${error.message})`)
    return undefined
  }
  if (manifest.schema !== "ensemble.docs-media" || manifest.version !== 1) {
    failures.push(`${MANIFEST}: unexpected schema/version`)
  }
  if (manifest.synthetic !== true) failures.push(`${MANIFEST}: must declare synthetic: true`)
  if (manifest.generator !== "scripts/docs-media.sh") failures.push(`${MANIFEST}: unexpected generator`)
  if (!manifest.capture || !String(manifest.capture.workspace ?? "").includes("synthetic")) {
    failures.push(`${MANIFEST}: capture provenance must name the synthetic workspace`)
  }
  const mediaDir = join(root, "docs/public/media")
  for (const [name, asset] of Object.entries(manifest.assets ?? {})) {
    const file = join(mediaDir, name)
    if (!existsSync(file)) {
      failures.push(`${MANIFEST}: ${name} is missing`)
      continue
    }
    const buffer = readFileSync(file)
    if (statSync(file).size < 1000) failures.push(`${MANIFEST}: ${name} looks empty`)
    if (sha256(buffer) !== asset.sha256) failures.push(`${MANIFEST}: ${name} hash does not match the committed file`)
    if (asset.kind === "screenshot") {
      const size = pngSize(buffer)
      if (!size) failures.push(`${MANIFEST}: ${name} is not a PNG`)
      else if (size.width !== asset.width || size.height !== asset.height) {
        failures.push(`${MANIFEST}: ${name} dimensions do not match the PNG`)
      }
    }
    if (asset.kind === "cast") {
      const text = buffer.toString("utf8")
      const [header] = text.split("\n")
      let parsed
      try {
        parsed = JSON.parse(header)
      } catch {
        failures.push(`${MANIFEST}: ${name} has an invalid asciinema header`)
      }
      if (parsed && (parsed.version !== 2 || parsed.width !== 140 || parsed.height !== 40)) {
        failures.push(`${MANIFEST}: ${name} must be an asciinema v2 140x40 cast`)
      }
      for (const marker of ASSET_FORBIDDEN) {
        if (text.includes(marker)) failures.push(`${MANIFEST}: ${name} contains forbidden marker ${JSON.stringify(marker)}`)
      }
    }
  }
  const expected = new Set(["MANIFEST.json", ".gitkeep", ...Object.keys(manifest.assets ?? {})])
  for (const name of readdirSync(mediaDir)) {
    if (!expected.has(name)) failures.push(`docs/public/media: unexpected file ${name}`)
  }
  return manifest
}

export function checkDocsMedia(root = REPO_ROOT) {
  const failures = []
  const manifest = checkManifest(root, failures)
  if (manifest) {
    const diagramCount = checkMarkdownMedia(root, manifest, failures)
    if (diagramCount < 4) failures.push(`Mermaid: expected at least four rendered diagrams, found ${diagramCount}`)
  }
  return failures
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
const help = invokedDirectly && (process.argv.includes("--help") || process.argv.includes("-h"))
if (!invokedDirectly) {
  // Imported by docs-check or a contract test; the exported function owns the result.
} else if (help) {
  console.log(`Usage: node scripts/docs-media-check.mjs [--root DIR]

Validates the committed documentation media manifest and hashes, screenshot
alt text and captions, the terminal hero summary, Mermaid accTitle/accDescr
coverage, and user-page heading order. It never runs the capture harness.`)
} else {
  try {
    const args = parseArgs(process.argv.slice(2))
    const failures = checkDocsMedia(args.root)
    if (failures.length > 0) {
      for (const failure of failures) console.error(`docs:media: ${failure}`)
      console.error(`docs:media: ${failures.length} problem(s)`)
      process.exitCode = 1
    } else {
      console.log("docs:media: ok (manifest, screenshots, cast, alt text, captions, Mermaid, headings)")
    }
  } catch (error) {
    console.error(`docs:media: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
  }
}
