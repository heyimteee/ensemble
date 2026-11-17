/**
 * Independent anchor validation for the built VitePress site.
 *
 * Source-side checks use the VitePress markdown renderer, but the published
 * artifact is the final authority. This crawler reads every generated HTML
 * page, collects its real ids and explicit named anchors, and follows every
 * internal link with a fragment. It is deliberately independent of the source
 * link checker: a build plugin, rewrite, or component id that changes rendered
 * navigation must fail here too.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"

function slash(value) {
  return value.split(sep).join("/")
}

function walkHtml(directory, pages = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) walkHtml(full, pages)
    else if (entry.isFile() && entry.name.endsWith(".html")) pages.push(full)
  }
  return pages.sort()
}

function decode(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function pageAnchors(html) {
  const anchors = new Set()
  for (const match of html.matchAll(/\bid="([^"]*)"/g)) anchors.add(match[1])
  for (const match of html.matchAll(/<a\b[^>]*\bname="([^"]*)"/gi)) anchors.add(match[1])
  return anchors
}

function internalHrefs(html) {
  const hrefs = []
  for (const match of html.matchAll(/<a\b[^>]*\bhref="([^"]*)"/gi)) hrefs.push(match[1])
  return hrefs
}

function targetFor(pageFile, rawPath, distDir, base) {
  const path = decode(rawPath)
  if (!path) return pageFile
  if (path === base.slice(0, -1)) return join(distDir, "index.html")
  if (path.startsWith(base)) {
    const relativePath = path.slice(base.length)
    const target = relativePath.endsWith("/")
      ? join(distDir, relativePath, "index.html")
      : join(distDir, relativePath)
    return target
  }
  if (path.startsWith("/")) return undefined
  return resolve(dirname(pageFile), path)
}

function existingPage(target) {
  if (!target) return undefined
  if (existsSync(target) && statSync(target).isDirectory()) {
    const index = join(target, "index.html")
    return existsSync(index) ? index : undefined
  }
  if (existsSync(target)) return target
  if (existsSync(`${target}.html`)) return `${target}.html`
  return undefined
}

/**
 * Read the built site and validate every internal anchor and asset target.
 * Returns counts for the release report; failures are fully qualified with the
 * page that carries the link.
 */
export function checkBuiltSiteAnchors(distDir, { base = "/ensemble/" } = {}) {
  if (!existsSync(distDir) || !statSync(distDir).isDirectory()) {
    return {
      failures: [`${slash(distDir)}: built site directory is missing`],
      pages: 0,
      links: 0,
      anchors: 0,
    }
  }
  const pages = walkHtml(distDir)
  const pageFiles = new Set(pages)
  const anchorsByPage = new Map(pages.map((page) => [page, pageAnchors(readFileSync(page, "utf8"))]))
  const failures = []
  let links = 0
  let anchors = 0

  for (const page of pages) {
    const html = readFileSync(page, "utf8")
    for (const href of internalHrefs(html)) {
      if (!href || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) continue
      links += 1
      const hashAt = href.indexOf("#")
      const hash = hashAt >= 0 ? href.slice(hashAt + 1) : ""
      const path = hashAt >= 0 ? href.slice(0, hashAt) : href
      const withoutQuery = path.split("?")[0]
      const target = existingPage(targetFor(page, withoutQuery, distDir, base))
      const label = `${slash(relative(distDir, page))}: ${href}`
      if (!target) {
        failures.push(`${label} (target is missing)`)
        continue
      }
      if (!hash) continue
      anchors += 1
      if (!target.endsWith(".html") || !pageFiles.has(target)) continue
      const decoded = decode(hash)
      if (!anchorsByPage.get(target)?.has(decoded)) {
        failures.push(`${label} (anchor #${decoded} is missing)`)
      }
    }
  }

  return { failures: [...new Set(failures)], pages: pages.length, links, anchors }
}
