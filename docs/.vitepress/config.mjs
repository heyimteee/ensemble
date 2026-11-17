import { existsSync, statSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { defineConfig } from "vitepress"
import { withMermaid } from "vitepress-plugin-mermaid"
import { canonicalFor, descriptionText, pageDescriptionFromFile } from "./seo.mjs"
import {
  BASE,
  DOCS_ROOT,
  REPOSITORY_URL,
  SITE_DESCRIPTION,
  SITE_ORIGIN,
  SITE_TITLE,
  VERSION_LABEL,
  nav,
  rewrites,
  sidebar,
  sourceToRoute,
} from "./site-data.mjs"

const REPO_ROOT = resolve(DOCS_ROOT, "..")
// Ticket #309 owns the screenshots and terminal recording. Drop those assets
// under docs/public/media/; the site serves them from /ensemble/media/.
const OG_IMAGE = `${SITE_ORIGIN}og-image.png`
const FAVICON = `${BASE}favicon.svg`
const REWRITES = rewrites()

function slash(value) {
  return value.split(sep).join("/")
}

function isInsideDocs(target) {
  const rel = relative(DOCS_ROOT, target)
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
}

function isInsideRepo(target) {
  const rel = relative(REPO_ROOT, target)
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
}

/**
 * Root-level files (README, GLOSSARY, CHANGELOG, SECURITY, CONTRIBUTING,
 * AGENTS, LICENSE) and source/script paths live outside the docs source root.
 * VitePress cannot serve them, so point those links at the public repository
 * instead of shipping dead relative links.
 */
function repositoryUrl(target, hash) {
  const rel = slash(relative(REPO_ROOT, target))
  const exists = existsSync(target)
  const tree = exists && statSync(target).isDirectory()
  const suffix = hash ? `#${hash}` : ""
  return `${REPOSITORY_URL}/${tree ? "tree" : "blob"}/main/${rel}${suffix}`
}

/**
 * Docs prose uses angle-bracket placeholders such as `<name>` and
 * `<previous-version>` inside ordinary sentences. With Markdown HTML enabled,
 * Vue treats them as unclosed elements. Escape everything except the void tags
 * the docs actually use so placeholders render as literal text.
 */
function escapePlaceholderHtml(md) {
  const previous = md.renderer.rules.html_inline
  // Cross-reference aliases are the one raw HTML construct docs need: a
  // heading's GitHub slug and VitePress slug can differ (numeric versions,
  // em dashes, punctuation). <a name="..."></a> gives both tools one explicit
  // target without changing the visible heading. Everything else is escaped
  // so placeholders such as `<name>` render as text.
  const namedAnchor = /^<a\s+(?:name|id)="[A-Za-z0-9_:.-]+"\s*>$/i
  md.renderer.rules.html_inline = (tokens, index, options, env, self) => {
    const content = tokens[index].content
    if (
      /^<(?:br|wbr)\s*\/?>$/i.test(content) ||
      namedAnchor.test(content) ||
      content === "</a>"
    ) {
      return previous
        ? previous(tokens, index, options, env, self)
        : content
    }
    return md.utils.escapeHtml(content)
  }
}

/**
 * Rewrite links before VitePress's own link plugin sees them:
 * - links to a docs README become the clean directory route;
 * - links outside docs point at the public repository.
 */
function rewriteLinks(md) {
  const previous = md.renderer.rules.link_open
  md.renderer.rules.link_open = (tokens, index, options, env, self) => {
    const token = tokens[index]
    const href = token.attrGet("href")
    if (
      href &&
      !href.startsWith("#") &&
      !href.startsWith("/") &&
      !/^[a-z][a-z0-9+.-]*:/i.test(href)
    ) {
      const [rawPath, rawHash] = href.split("#", 2)
      const [pathPart] = rawPath.split("?", 1)
      const target = resolve(dirname(env.path), decodeURIComponent(pathPart))
      if (isInsideDocs(target)) {
        if (target.endsWith(`${sep}README.md`) || target === resolve(DOCS_ROOT, "README.md")) {
          const route = sourceToRoute(slash(relative(DOCS_ROOT, target)))
          token.attrSet("href", rawHash ? `${route}#${rawHash}` : route)
        }
      } else if (isInsideRepo(target)) {
        token.attrSet("href", repositoryUrl(target, rawHash))
      }
    }
    return previous(tokens, index, options, env, self)
  }
}

function descriptionFor(pageData) {
  if (typeof pageData.frontmatter.description === "string" && pageData.frontmatter.description) {
    return descriptionText(pageData.frontmatter.description)
  }
  const source = resolve(DOCS_ROOT, pageData.filePath || pageData.relativePath)
  return pageDescriptionFromFile(source)
}

function seoHead({ page, title, description, pageData }) {
  const canonical = canonicalFor(page)
  const isNotFound = page === "404.md"
  const head = [
    ["link", { rel: "canonical", href: canonical }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:site_name", content: SITE_TITLE }],
    ["meta", { property: "og:title", content: title }],
    ["meta", { property: "og:description", content: description }],
    ["meta", { property: "og:url", content: canonical }],
    ["meta", { property: "og:image", content: OG_IMAGE }],
    ["meta", { property: "og:image:width", content: "1200" }],
    ["meta", { property: "og:image:height", content: "630" }],
    ["meta", { property: "og:image:alt", content: "Ensemble documentation" }],
    ["meta", { property: "og:locale", content: "en_US" }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["meta", { name: "twitter:title", content: title }],
    ["meta", { name: "twitter:description", content: description }],
    ["meta", { name: "twitter:image", content: OG_IMAGE }],
  ]
  if (isNotFound) head.push(["meta", { name: "robots", content: "noindex" }])
  if (pageData.frontmatter.version) {
    head.push(["meta", { name: "ensemble:docs-version", content: String(pageData.frontmatter.version) }])
  }
  return head
}

export default withMermaid(defineConfig({
  lang: "en-US",
  title: SITE_TITLE,
  titleTemplate: `:title · ${SITE_TITLE} docs`,
  description: SITE_DESCRIPTION,
  base: BASE,
  srcDir: ".",
  outDir: ".vitepress/dist",
  cacheDir: ".vitepress/cache",
  cleanUrls: true,
  rewrites: REWRITES,
  appearance: true,
  lastUpdated: false,
  head: [
    ["link", { rel: "icon", href: FAVICON, type: "image/svg+xml" }],
    ["meta", { name: "theme-color", content: "#16181d" }],
    ["meta", { name: "generator", content: "VitePress" }],
    ["meta", { name: "ensemble:docs-version", content: VERSION_LABEL }],
    ["meta", { property: "og:image", content: OG_IMAGE }],
  ],
  sitemap: {
    hostname: SITE_ORIGIN,
  },
  mermaid: {
    // Mermaid's dark theme draws edge labels on a mid-grey chip. Keep the chip
    // dark enough for the docs text colour to meet WCAG AA in both themes.
    themeVariables: {
      edgeLabelBackground: "#24242b",
      primaryTextColor: "#e6e6e6",
      lineColor: "#9aa0a6",
    },
  },
  markdown: {
    config(md) {
      escapePlaceholderHtml(md)
      rewriteLinks(md)
    },
  },
  themeConfig: {
    logo: "/favicon.svg",
    siteTitle: SITE_TITLE,
    nav,
    sidebar,
    search: {
      provider: "local",
      options: {
        detailedView: true,
        translations: {
          button: {
            buttonText: "Search the docs",
            buttonAriaLabel: "Search the docs",
          },
          modal: {
            noResultsText: "No results for",
            resetButtonTitle: "Clear search",
          },
        },
      },
    },
    outline: { level: [2, 3], label: "On this page" },
    docFooter: { prev: "Previous page", next: "Next page" },
    returnToTopLabel: "Return to top",
    sidebarMenuLabel: "Docs menu",
    darkModeSwitchLabel: "Appearance",
    lightModeSwitchTitle: "Switch to light mode",
    darkModeSwitchTitle: "Switch to dark mode",
    socialLinks: [{ icon: "github", link: REPOSITORY_URL }],
    footer: {
      message: "Released under the MIT License.",
      copyright: "Ensemble documentation · stable 0.1.x",
    },
    editLink: {
      pattern: `${REPOSITORY_URL}/edit/main/docs/:path`,
      text: "Edit this page",
    },
  },
  transformPageData(pageData) {
    const description = descriptionFor(pageData)
    if (pageData.relativePath === "README.md" || pageData.relativePath === "index.md") {
      return { title: "Ensemble documentation", titleTemplate: false, description }
    }
    return { description }
  },
  transformHead(context) {
    return seoHead(context)
  },
}))
