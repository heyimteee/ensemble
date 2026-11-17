/**
 * Rendered-page anchors for the documentation quality gate.
 *
 * VitePress does not use GitHub's heading slug. The site renderer normalises
 * Unicode, keeps the em dash in an id, turns punctuation into hyphens, prefixes
 * a leading digit with an underscore, and suffixes duplicate headings. This
 * module asks VitePress itself for those ids instead of maintaining a second
 * slug algorithm that can drift from the build.
 */
import { createMarkdownRenderer } from "vitepress"

function decodeAttribute(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}

/** Ids from headings and explicit HTML anchors in rendered Markdown. */
export function anchorsFromRenderedHtml(html) {
  const anchors = new Set()
  for (const match of html.matchAll(/\bid="([^"]*)"/g)) anchors.add(decodeAttribute(match[1]))
  for (const match of html.matchAll(/<a\b[^>]*\bname="([^"]*)"/gi)) {
    anchors.add(decodeAttribute(match[1]))
  }
  return anchors
}

/**
 * Create one renderer for a docs tree and return a function that resolves the
 * same anchors the built site will carry for a Markdown source file.
 */
export async function createRenderedAnchorResolver(srcDir) {
  const md = await createMarkdownRenderer(
    srcDir,
    {},
    "/",
    { warn() {} },
  )
  return (markdown) => anchorsFromRenderedHtml(md.render(markdown))
}
