/**
 * Shared site metadata for the VitePress build and the docs-site checks.
 *
 * Keep navigation, redirects, and deployment constants here so the site build,
 * the broken-link check, and the generated artifacts cannot drift apart.
 */

import { readdirSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const CONFIG_DIR = fileURLToPath(new URL(".", import.meta.url))
export const DOCS_ROOT = resolve(CONFIG_DIR, "..")
export const OUT_DIR = resolve(CONFIG_DIR, "dist")
export const BASE = "/ensemble/"
export const SITE_ORIGIN = "https://heyimteee.github.io/ensemble/"
export const SITE_TITLE = "Ensemble"
export const SITE_DESCRIPTION =
  "Persistent agent teams inside OpenCode: named agents, one group chat, visible work, and native sessions underneath."

export const REPOSITORY_URL = "https://github.com/heyimteee/ensemble"
export const VERSION = "0.1.x"
export const VERSION_LABEL = `${VERSION} stable`

/** Every Markdown file under docs/, relative to DOCS_ROOT and slash-normalised. */
export function markdownPages() {
  const pages = []
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue
      const full = join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        pages.push(relative(DOCS_ROOT, full).split(sep).join("/"))
      }
    }
  }
  walk(DOCS_ROOT)
  return pages.sort()
}

/** `/section/README.md` becomes `/section/`; `/README.md` becomes `/`. */
export function sourceToRoute(source) {
  const normalised = source.replace(/\\/g, "/")
  if (normalised === "README.md") return "/"
  if (normalised.endsWith("/README.md")) {
    return `/${normalised.slice(0, -"README.md".length)}`
  }
  return `/${normalised.replace(/\.md$/, "")}`
}

/** Clean routes are the inverse of sourceToRoute for sidebar checks. */
export function routeToSource(route) {
  const clean = route.split("#")[0].split("?")[0].replace(/^\/+/, "")
  if (clean === "") return "README.md"
  if (clean.endsWith("/")) return `${clean}README.md`
  return `${clean}.md`
}

/**
 * VitePress rewrites section READMEs to directory indexes so the published
 * URLs match the navigation (`/getting-started/`, not `/getting-started/README`).
 */
export function rewrites() {
  const map = {}
  for (const page of markdownPages()) {
    if (page === "README.md") {
      map[page] = "index.md"
    } else if (page.endsWith("/README.md")) {
      map[page] = `${page.slice(0, -"README.md".length)}index.md`
    }
  }
  return map
}

export const SECTION_INDEXES = [
  "getting-started/README.md",
  "concepts/README.md",
  "guides/README.md",
  "reference/README.md",
  "operations/README.md",
  "security/README.md",
  "privacy/README.md",
  "support/README.md",
  "contributing/README.md",
]

/**
 * Evidence and contributor-only documentation. These pages stay in the built
 * site and are reachable from the contributing hub, but they are deliberately
 * absent from the primary user sidebar.
 */
export const EVIDENCE_PREFIXES = [
  "adr/",
  "agents/",
  "assessments/",
  "compatibility/",
  "verification/",
  "contributing/evidence.md",
  "implementation.md",
  "style-guide.md",
  "redirects.md",
]

/** Evidence that must never appear in the user sidebar. */
export const USER_SIDEBAR_EXCLUDES = [
  "adr/",
  "agents/",
  "assessments/",
  "compatibility/",
  "verification/",
  "implementation.md",
]

export const nav = [
  { text: "Getting started", link: "/getting-started/" },
  { text: "Concepts", link: "/concepts/" },
  { text: "Guides", link: "/guides/" },
  { text: "Reference", link: "/reference/" },
  { text: "Operations", link: "/operations/" },
  {
    text: "More",
    items: [
      { text: "Security", link: "/security/" },
      { text: "Privacy", link: "/privacy/" },
      { text: "Support", link: "/support/" },
      { text: "Contributing", link: "/contributing/" },
    ],
  },
]

export const sidebar = [
  {
    text: "Overview",
    items: [{ text: "Documentation home", link: "/" }],
  },
  {
    text: "Getting started",
    items: [
      { text: "Getting started", link: "/getting-started/" },
      { text: "What is Ensemble?", link: "/getting-started/what-is-ensemble" },
      { text: "Install Ensemble", link: "/getting-started/install" },
      { text: "Quickstart", link: "/getting-started/quickstart" },
      { text: "Your first team", link: "/getting-started/first-team" },
      { text: "Upgrade Ensemble", link: "/getting-started/upgrade" },
    ],
  },
  {
    text: "Concepts",
    items: [
      { text: "Concepts", link: "/concepts/" },
      { text: "The workspace shell", link: "/concepts/workspace-shell" },
      { text: "Agents, workspaces, and the leader", link: "/concepts/agents-and-workspaces" },
      { text: "Conversations and routing", link: "/concepts/conversations-and-routing" },
      { text: "Turns and synthesis", link: "/concepts/turns-and-synthesis" },
      { text: "Work lifecycle", link: "/concepts/work-lifecycle" },
      { text: "Dispatch budgets", link: "/concepts/dispatch-budgets" },
      { text: "Native sessions", link: "/concepts/native-sessions" },
      { text: "Skills", link: "/concepts/skills" },
      { text: "Memory and approvals", link: "/concepts/memory-and-approvals" },
      { text: "Architecture overview", link: "/concepts/architecture" },
    ],
  },
  {
    text: "Guides",
    items: [
      { text: "Guides", link: "/guides/" },
      { text: "Create a workspace and agents", link: "/guides/create-workspace-and-agents" },
      { text: "Edit members and the leader", link: "/guides/edit-members-and-leader" },
      { text: "Initialize a workspace", link: "/guides/initialize-a-workspace" },
      { text: "Route a group or direct message", link: "/guides/route-messages" },
      { text: "Use a skill", link: "/guides/use-skills" },
      { text: "Use the Work pane", link: "/guides/use-the-work-pane" },
      { text: "Resolve an approval", link: "/guides/resolve-approvals" },
      { text: "Configure an agent", link: "/guides/configure-an-agent" },
      { text: "Manage memory", link: "/guides/manage-memory" },
      { text: "Back up or restore", link: "/guides/back-up-or-restore" },
    ],
  },
  {
    text: "Recipes",
    items: [
      { text: "Recipes", link: "/guides/recipes/" },
      { text: "Run parallel research", link: "/guides/recipes/parallel-research" },
      { text: "Run a multi-agent code review", link: "/guides/recipes/multi-agent-code-review" },
      { text: "Turn an issue into a ticket", link: "/guides/recipes/issue-to-ticket" },
      { text: "Use an agent-scoped skill", link: "/guides/recipes/agent-scoped-skills" },
    ],
  },
  {
    text: "Reference",
    items: [
      { text: "Reference", link: "/reference/" },
      { text: "Native tools", link: "/reference/tools" },
      { text: "Migration and legacy tools", link: "/reference/migration-tools" },
      { text: "Command reference", link: "/reference/commands" },
      { text: "Keyboard reference", link: "/reference/keyboard" },
      { text: "Configuration", link: "/reference/configuration" },
      { text: "Environment", link: "/reference/environment" },
      { text: "Files and storage", link: "/reference/files" },
      { text: "Operator CLI", link: "/reference/cli" },
      { text: "Supported hosts and versions", link: "/reference/supported" },
    ],
  },
  {
    text: "Operations",
    items: [
      { text: "Operations", link: "/operations/" },
      { text: "Backup and restore", link: "/operations/backup-restore" },
      { text: "Upgrade from the pre-release", link: "/operations/upgrade" },
      { text: "Package rollback", link: "/operations/rollback" },
      { text: "Scale, soak, and diagnostics", link: "/operations/scale-and-monitoring" },
      { text: "Release operations", link: "/operations/release" },
      { text: "Release sign-off checklist", link: "/operations/release-signoff" },
      { text: "Release notes 0.1.0", link: "/operations/release-notes-0.1.0" },
      { text: "Release history", link: "/operations/launch-plan-0.1.0-rc.2" },
      { text: "Release notes 0.1.0-rc.2", link: "/operations/release-notes-0.1.0-rc.2" },
    ],
  },
  {
    text: "Security",
    items: [
      { text: "Security", link: "/security/" },
      { text: "Threat model", link: "/security/threat-model" },
      { text: "Permission-model review", link: "/security/permission-model-review" },
      { text: "Accepted security risks", link: "/security/accepted-risks" },
    ],
  },
  {
    text: "Privacy",
    items: [
      { text: "Privacy", link: "/privacy/" },
      { text: "Data classes, retention, export, and delete", link: "/privacy/data-and-retention" },
    ],
  },
  {
    text: "Support",
    items: [
      { text: "Support", link: "/support/" },
      { text: "Troubleshooting", link: "/support/troubleshooting" },
      { text: "FAQ", link: "/support/faq" },
      { text: "Operations and support", link: "/support/operations" },
      { text: "Incident runbook", link: "/support/incident-runbook" },
      { text: "Support matrix and known limitations", link: "/support/support-matrix" },
    ],
  },
  {
    text: "Contributing",
    items: [
      { text: "Contributing", link: "/contributing/" },
      { text: "Evidence index", link: "/contributing/evidence" },
      { text: "Documentation style guide", link: "/style-guide" },
      { text: "Redirect map", link: "/redirects" },
      { text: "CONTRIBUTING.md", link: `${REPOSITORY_URL}/blob/main/CONTRIBUTING.md` },
      { text: "AGENTS.md", link: `${REPOSITORY_URL}/blob/main/AGENTS.md` },
      { text: "Changelog", link: `${REPOSITORY_URL}/blob/main/CHANGELOG.md` },
      { text: "Domain glossary", link: `${REPOSITORY_URL}/blob/main/GLOSSARY.md` },
    ],
  },
]

/**
 * Static redirects for the URL forms that existed before the clean-URL site:
 * the old docs home/section README paths and the `.md` / `.html` variants.
 * GitHub Pages cannot read `_redirects`, so these are emitted as meta-refresh
 * pages by scripts/docs-site-artifacts.mjs.
 */
export const redirects = {
  "docs/README.md": "/",
  "docs/README.html": "/",
  "docs/index.html": "/",
  "docs.html": "/",
  "docs/getting-started/README.md": "/getting-started/",
  "docs/getting-started/README.html": "/getting-started/",
  "getting-started/README.md": "/getting-started/",
  "getting-started/README.html": "/getting-started/",
  "getting-started.html": "/getting-started/",
  "docs/concepts/README.md": "/concepts/",
  "docs/concepts/README.html": "/concepts/",
  "concepts/README.md": "/concepts/",
  "concepts/README.html": "/concepts/",
  "concepts.html": "/concepts/",
  "docs/guides/README.md": "/guides/",
  "docs/guides/README.html": "/guides/",
  "guides/README.md": "/guides/",
  "guides/README.html": "/guides/",
  "guides.html": "/guides/",
  "guides/recipes/README.md": "/guides/recipes/",
  "guides/recipes/README.html": "/guides/recipes/",
  "docs/reference/README.md": "/reference/",
  "docs/reference/README.html": "/reference/",
  "reference/README.md": "/reference/",
  "reference/README.html": "/reference/",
  "reference.html": "/reference/",
  "docs/operations/README.md": "/operations/",
  "docs/operations/README.html": "/operations/",
  "operations/README.md": "/operations/",
  "operations/README.html": "/operations/",
  "operations.html": "/operations/",
  "docs/security/README.md": "/security/",
  "docs/security/README.html": "/security/",
  "security/README.md": "/security/",
  "security/README.html": "/security/",
  "security.html": "/security/",
  "docs/privacy/README.md": "/privacy/",
  "docs/privacy/README.html": "/privacy/",
  "privacy/README.md": "/privacy/",
  "privacy/README.html": "/privacy/",
  "privacy.html": "/privacy/",
  "docs/support/README.md": "/support/",
  "docs/support/README.html": "/support/",
  "support/README.md": "/support/",
  "support/README.html": "/support/",
  "support.html": "/support/",
  "docs/contributing/README.md": "/contributing/",
  "docs/contributing/README.html": "/contributing/",
  "contributing/README.md": "/contributing/",
  "contributing/README.html": "/contributing/",
  "contributing.html": "/contributing/",
}
