#!/usr/bin/env node
/**
 * Post-build artifacts and assertions for the VitePress docs site (ticket #308).
 *
 * Generates `llms.txt`, `llms-full.txt`, and static meta-refresh redirect pages,
 * then verifies that every Markdown page produced HTML with the expected SEO
 * metadata, the sitemap and local-search index exist, and no external analytics
 * slipped into the output. GitHub Pages does not support `_redirects`; these
 * redirects are ordinary HTML pages generated after VitePress writes `dist/`.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import {
  BASE,
  DOCS_ROOT,
  OUT_DIR,
  REPOSITORY_URL,
  SITE_DESCRIPTION,
  SITE_ORIGIN,
  SITE_TITLE,
  VERSION_LABEL,
  markdownPages,
  redirects,
  sourceToRoute,
} from "../docs/.vitepress/site-data.mjs"
import { pageDescription, pageTitle } from "../docs/.vitepress/seo.mjs"

const USER_SECTIONS = [
  ["Getting started", "getting-started"],
  ["Concepts", "concepts"],
  ["Guides", "guides"],
  ["Reference", "reference"],
  ["Operations", "operations"],
  ["Security", "security"],
  ["Privacy", "privacy"],
  ["Support", "support"],
]

const EVIDENCE_SECTIONS = [
  ["Contributing", "contributing"],
  ["Architecture decisions", "adr"],
  ["Agent and contributor notes", "agents"],
  ["Compatibility evidence", "compatibility"],
  ["Implementation notes", "implementation.md"],
  ["Assessment evidence", "assessments"],
]

const ANALYTICS_PATTERNS = [
  /googletagmanager\.com/i,
  /google-analytics\.com/i,
  /plausible\.io/i,
  /posthog\.com/i,
  /segment\.(?:io|com)/i,
  /umami\.is/i,
]

function slash(value) {
  return value.replace(/\\/g, "/")
}

function routeToOutFile(route) {
  if (route === "/") return "index.html"
  if (route.endsWith("/")) return `${route.slice(1)}index.html`
  return `${route.slice(1)}.html`
}

function absoluteUrl(route) {
  return `${SITE_ORIGIN}${route === "/" ? "" : route.replace(/^\/+/, "")}`
}

function pageRecord(source) {
  const markdown = readFileSync(join(DOCS_ROOT, source), "utf8")
  return {
    source,
    route: sourceToRoute(source),
    title: pageTitle(markdown, SITE_TITLE),
    description: pageDescription(markdown),
  }
}

function sectionPages(section) {
  return markdownPages()
    .filter((page) => page === section || page.startsWith(`${section}/`))
    .map(pageRecord)
}

function orderedPages() {
  const seen = new Set()
  const pages = []
  const add = (page) => {
    if (seen.has(page.source)) return
    seen.add(page.source)
    pages.push(page)
  }
  add(pageRecord("README.md"))
  for (const [, section] of USER_SECTIONS) {
    for (const page of sectionPages(section)) add(page)
  }
  add(pageRecord("contributing/README.md"))
  add(pageRecord("contributing/evidence.md"))
  for (const [, section] of EVIDENCE_SECTIONS.slice(1)) {
    for (const page of sectionPages(section)) add(page)
  }
  add(pageRecord("style-guide.md"))
  add(pageRecord("redirects.md"))
  for (const page of sectionPages("verification")) add(page)
  return pages
}

function writeLlms(pages) {
  const lines = [
    `# ${SITE_TITLE} documentation`,
    "",
    `> ${SITE_DESCRIPTION}`,
    "",
    `- Documentation: ${absoluteUrl("/")}`,
    `- Repository: ${REPOSITORY_URL}`,
    `- Version: ${VERSION_LABEL}`,
    "",
  ]
  for (const [heading, section] of USER_SECTIONS) {
    lines.push(`## ${heading}`, "")
    for (const page of pages.filter((item) => item.source.startsWith(`${section}/`))) {
      lines.push(`- [${page.title}](${absoluteUrl(page.route)}): ${page.description}`)
    }
    lines.push("")
  }
  lines.push("## Contributing and evidence", "")
  for (const page of pages.filter(
    (item) =>
      item.source === "contributing/README.md" ||
      item.source === "contributing/evidence.md" ||
      item.source === "style-guide.md" ||
      item.source === "redirects.md",
  )) {
    lines.push(`- [${page.title}](${absoluteUrl(page.route)}): ${page.description}`)
  }
  lines.push("")
  lines.push(
    "Engineering evidence and historical verification records are linked from the evidence index above. They remain public but are not part of the user documentation path.",
    "",
  )
  writeFileSync(join(OUT_DIR, "llms.txt"), `${lines.join("\n")}\n`)
}

function writeLlmsFull(pages) {
  const parts = [
    `# ${SITE_TITLE} documentation (full)`,
    "",
    `> ${SITE_DESCRIPTION}`,
    "",
    `Documentation: ${absoluteUrl("/")}`,
    `Repository: ${REPOSITORY_URL}`,
    `Version: ${VERSION_LABEL}`,
    "",
  ]
  for (const page of pages) {
    parts.push(
      "---",
      "",
      `## ${page.title}`,
      "",
      `Source: ${absoluteUrl(page.route)}`,
      "",
      readFileSync(join(DOCS_ROOT, page.source), "utf8").trim(),
      "",
    )
  }
  writeFileSync(join(OUT_DIR, "llms-full.txt"), `${parts.join("\n")}\n`)
}

function writeRedirects() {
  const pages = new Set(markdownPages().map(sourceToRoute))
  const files = new Set(markdownPages().map((page) => routeToOutFile(sourceToRoute(page))))
  for (const [source, target] of Object.entries(redirects)) {
    if (!pages.has(target)) {
      throw new Error(`redirect ${source} points at missing route ${target}`)
    }
    const output = source.replace(/\.md$/, ".html")
    if (files.has(output)) {
      throw new Error(`redirect ${output} collides with a built page`)
    }
    const url = `${BASE}${target.replace(/^\/+/, "")}`
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Redirecting…</title>
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="0; url=${url}">
<link rel="canonical" href="${absoluteUrl(target)}">
<script>location.replace(${JSON.stringify(url)} + location.hash)</script>
</head>
<body>
<p>This page moved to <a href="${url}">${absoluteUrl(target)}</a>.</p>
</body>
</html>
`
    const path = join(OUT_DIR, output)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, html)
  }
}

function allFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...allFiles(full))
    else files.push(full)
  }
  return files
}

function requirePattern(html, pattern, label, failures) {
  if (!pattern.test(html)) failures.push(`${label}: missing ${pattern}`)
}

function verifyBuild() {
  const failures = []
  if (!existsSync(OUT_DIR)) {
    failures.push(`${slash(relative(process.cwd(), OUT_DIR))}: build output is missing`)
    return failures
  }

  for (const page of markdownPages()) {
    const route = sourceToRoute(page)
    const file = join(OUT_DIR, routeToOutFile(route))
    if (!existsSync(file)) {
      failures.push(`${page}: expected build output ${slash(relative(OUT_DIR, file))} is missing`)
      continue
    }
    const html = readFileSync(file, "utf8")
    const label = `${page} (${slash(relative(OUT_DIR, file))})`
    if (!/<title>[^<]+<\/title>/.test(html)) failures.push(`${label}: missing page title`)
    requirePattern(html, /<meta name="description" content="[^"]+"/, label, failures)
    requirePattern(html, /<link rel="canonical" href="https:\/\/heyimteee\.github\.io\/ensemble\//, label, failures)
    requirePattern(html, /<meta property="og:title" content="[^"]+"/, label, failures)
    requirePattern(html, /<meta property="og:image" content="https:\/\/heyimteee\.github\.io\/ensemble\/og-image\.png"/, label, failures)
    if (ANALYTICS_PATTERNS.some((pattern) => pattern.test(html))) {
      failures.push(`${label}: contains an external analytics reference`)
    }
  }

  const sitemap = join(OUT_DIR, "sitemap.xml")
  if (!existsSync(sitemap)) {
    failures.push("sitemap.xml: file is missing")
  } else {
    const xml = readFileSync(sitemap, "utf8")
    for (const expected of [`${SITE_ORIGIN}`, `${SITE_ORIGIN}getting-started/`, `${SITE_ORIGIN}reference/tools`]) {
      if (!xml.includes(expected)) failures.push(`sitemap.xml: missing ${expected}`)
    }
  }

  const files = allFiles(OUT_DIR)
  const search = files.find((file) => /localSearchIndex/.test(file))
  if (!search || statSync(search).size === 0) {
    failures.push("local search index: file is missing or empty")
  }

  for (const artifact of ["llms.txt", "llms-full.txt"]) {
    const file = join(OUT_DIR, artifact)
    if (!existsSync(file) || statSync(file).size === 0) {
      failures.push(`${artifact}: file is missing or empty`)
    }
  }

  for (const source of Object.keys(redirects)) {
    const file = join(OUT_DIR, source.replace(/\.md$/, ".html"))
    if (!existsSync(file)) failures.push(`redirect ${source}: output is missing`)
  }

  return failures
}

const pages = orderedPages()
writeLlms(pages)
writeLlmsFull(pages)
writeRedirects()
const failures = verifyBuild()
if (failures.length > 0) {
  for (const failure of failures) console.error(`docs:site:artifacts: ${failure}`)
  console.error(`docs:site:artifacts: ${failures.length} build assertion(s) failed`)
  process.exitCode = 1
} else {
  console.log(
    `docs:site:artifacts: ok (${pages.length} pages, llms.txt, llms-full.txt, ${Object.keys(redirects).length} redirects)`,
  )
}
