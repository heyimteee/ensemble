#!/usr/bin/env node
/**
 * Documentation-site integrity check (ticket #308).
 *
 * Runs before the VitePress build and fails when the sidebar or top navigation
 * points at a page that does not exist, when a user-facing docs page is missing
 * from the sidebar, when evidence pages become unreachable from the contributing
 * hub, or when a generated redirect points at a route the site does not build.
 *
 * Usage:
 *   node scripts/docs-site-check.mjs
 */
import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  DOCS_ROOT,
  EVIDENCE_PREFIXES,
  SECTION_INDEXES,
  USER_SIDEBAR_EXCLUDES,
  markdownPages,
  nav,
  redirects,
  routeToSource,
  sidebar,
  sourceToRoute,
} from "../docs/.vitepress/site-data.mjs"
import { checkDocsMedia } from "./docs-media-check.mjs"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

const REQUIRED_FILES = [
  "docs/.vitepress/config.mjs",
  "docs/.vitepress/site-data.mjs",
  "docs/.vitepress/seo.mjs",
  "docs/.vitepress/theme/index.js",
  "docs/.vitepress/theme/Layout.vue",
  "docs/.vitepress/theme/DocsFigure.vue",
  "docs/.vitepress/theme/TerminalHero.vue",
  "docs/.vitepress/theme/custom.css",
  "docs/public/favicon.svg",
  "docs/public/logo.svg",
  "docs/public/og-image.png",
  "docs/public/.nojekyll",
]

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

const USER_ROOT_PAGES = ["README.md", "style-guide.md", "redirects.md", "contributing/README.md"]

function slash(value) {
  return value.replace(/\\/g, "/")
}

function isExternal(link) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(link)
}

function isEvidencePage(page) {
  return EVIDENCE_PREFIXES.some((prefix) =>
    prefix.endsWith(".md") ? page === prefix : page.startsWith(prefix),
  )
}

function isUserSidebarExcluded(page) {
  return USER_SIDEBAR_EXCLUDES.some((prefix) =>
    prefix.endsWith(".md") ? page === prefix : page.startsWith(prefix),
  )
}

function internalLinks(markdown) {
  const text = markdown
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "")
    .replace(/`[^`]*`/g, "")
  const links = []
  for (const match of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const href = match[1]
    if (isExternal(href) || href.startsWith("/")) continue
    links.push(href.split("#")[0].split("?")[0])
  }
  return links
}

function resolveDocLink(fromPage, href) {
  const target = resolve(dirname(join(DOCS_ROOT, fromPage)), decodeURIComponent(href))
  if (!existsSync(target)) return undefined
  const info = statSync(target)
  const file = info.isDirectory() ? join(target, "README.md") : target
  if (!existsSync(file) || !file.endsWith(".md")) return undefined
  const rel = slash(relative(DOCS_ROOT, file))
  if (rel.startsWith("..")) return undefined
  return rel
}

function flatten(items, output = []) {
  for (const item of items) {
    if (item.link) output.push(item)
    if (Array.isArray(item.items)) flatten(item.items, output)
  }
  return output
}

function checkLinkTarget(link, label, failures) {
  if (isExternal(link)) return
  if (!link.startsWith("/")) {
    failures.push(`${label}: site link ${JSON.stringify(link)} must start with "/"`)
    return
  }
  const source = routeToSource(link)
  if (!existsSync(join(DOCS_ROOT, source))) {
    failures.push(`${label}: ${JSON.stringify(link)} resolves to missing docs/${source}`)
  }
}

function checkNavigation(failures, allPages) {
  for (const item of flatten(nav)) {
    checkLinkTarget(item.link, `nav ${JSON.stringify(item.text)}`, failures)
  }
  for (const item of flatten(sidebar)) {
    checkLinkTarget(item.link, `sidebar ${JSON.stringify(item.text)}`, failures)
  }

  const sidebarSources = new Set()
  for (const item of flatten(sidebar)) {
    if (!item.link || isExternal(item.link)) continue
    sidebarSources.add(routeToSource(item.link))
  }

  for (const page of allPages) {
    const isUserPage = USER_SECTIONS.some((section) => page.startsWith(`${section}/`))
    if (isUserPage && !sidebarSources.has(page)) {
      failures.push(`sidebar: user page docs/${page} is missing from the sidebar`)
    }
  }

  const required = new Set([
    ...USER_SECTIONS.map((section) => `${section}/README.md`),
    ...USER_ROOT_PAGES,
  ])
  for (const source of required) {
    if (!sidebarSources.has(source)) {
      failures.push(`sidebar: user page docs/${source} is missing from the sidebar`)
    }
  }

  for (const item of flatten(sidebar)) {
    if (!item.link || isExternal(item.link)) continue
    const source = routeToSource(item.link)
    if (isUserSidebarExcluded(source)) {
      failures.push(`sidebar: evidence page docs/${source} must not appear in the user sidebar`)
    }
  }

  for (const source of SECTION_INDEXES) {
    const route = sourceToRoute(source)
    if (!existsSync(join(DOCS_ROOT, source))) {
      failures.push(`section index docs/${source} is missing`)
    } else if (!sidebarSources.has(source)) {
      failures.push(`sidebar: section index ${route} is missing from the sidebar`)
    }
  }
}

/**
 * Every ADR, verification record, agent note, assessment, compatibility report,
 * and implementation note must be reachable from the contributing hub. The
 * evidence index carries most of them; this follows links so an old record that
 * is only linked from another record still counts.
 */
function checkEvidenceReachability(failures, allPages) {
  const start = "contributing/README.md"
  if (!existsSync(join(DOCS_ROOT, start))) {
    failures.push(`docs/${start} is missing`)
    return
  }
  const queue = [start]
  const seen = new Set()
  while (queue.length > 0) {
    const page = queue.shift()
    if (seen.has(page)) continue
    seen.add(page)
    const markdown = readFileSync(join(DOCS_ROOT, page), "utf8")
    for (const href of internalLinks(markdown)) {
      const target = resolveDocLink(page, href)
      if (target && !seen.has(target)) queue.push(target)
    }
  }
  for (const page of allPages) {
    if (isEvidencePage(page) && !seen.has(page)) {
      failures.push(
        `documentation evidence docs/${page} is not reachable from docs/${start}`,
      )
    }
  }
}

function routeToOutFile(route) {
  if (route === "/") return "index.html"
  if (route.endsWith("/")) return `${route.slice(1)}index.html`
  return `${route.slice(1)}.html`
}

function checkRedirects(failures, allPages) {
  const routes = new Set(allPages.map(sourceToRoute))
  const files = new Set(allPages.map((page) => routeToOutFile(sourceToRoute(page))))
  for (const [source, target] of Object.entries(redirects)) {
    if (!routes.has(target)) {
      failures.push(`redirect ${source}: target ${target} is not a built page`)
    }
    const output = source.replace(/\.md$/, ".html")
    if (files.has(output)) {
      failures.push(`redirect ${source}: output ${output} collides with a built page`)
    }
  }
}

export function checkDocsSite() {
  const failures = []
  for (const path of REQUIRED_FILES) {
    if (!existsSync(join(REPO_ROOT, path))) failures.push(`${path}: file is missing`)
  }
  const allPages = markdownPages()
  checkNavigation(failures, allPages)
  checkEvidenceReachability(failures, allPages)
  checkRedirects(failures, allPages)
  for (const failure of checkDocsMedia(REPO_ROOT)) failures.push(`media: ${failure}`)
  return failures
}

const failures = checkDocsSite()
if (failures.length > 0) {
  for (const failure of failures) console.error(`docs:site:check: ${failure}`)
  console.error(`docs:site:check: ${failures.length} navigation or page failure(s)`)
  process.exitCode = 1
} else {
  console.log("docs:site:check: ok (navigation, evidence reachability, redirects)")
}
