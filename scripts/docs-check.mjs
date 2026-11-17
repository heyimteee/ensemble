#!/usr/bin/env node
/**
 * Documentation freshness check (ticket #262).
 *
 * Reads the canonical version constants and fails when the current docs claim a
 * different workspace-contract version, an untested OpenCode host, a Node floor
 * below the verified minimum, or an unlinked current verification record.
 *
 * The check is intentionally version-scoped, not a prose style linter: a stale
 * current claim is an error; historical records and version-scoped evidence are
 * left alone. User navigation is checked separately from the evidence index:
 * current records live in docs/contributing/evidence.md, not the docs home.
 *
 * Usage:
 *   node --experimental-strip-types scripts/docs-check.mjs [--root DIR] [--skip-site-build]
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { ENSEMBLE_BLOCK_VERSION } from "../src/v2/init-block.ts"
import { workflowValue } from "../src/v2/ci-workflows.ts"
import {
  OPENCODE_PLUGIN_PEER_RANGE,
  SUPPORTED_OPENCODE_VERSIONS,
} from "../src/v2/host-compatibility.ts"
import { MINIMUM_NODE_VERSION } from "../src/v2/node-version.ts"
import { checkReferenceDocs } from "./reference-check.mjs"
import { checkDocsMedia } from "./docs-media-check.mjs"
import {
  extractLinks,
  fencedBlocks,
  pageAnchors,
  parseFrontmatter,
  shellSyntaxFailures,
} from "./lib/docs-quality.ts"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/** Verification records from this date onward must appear in docs/README.md. */
const CURRENT_RECORD_FLOOR = "2026-11-11"

function parseArgs(argv) {
  const args = { root: REPO_ROOT, help: false, skipSiteBuild: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--root") {
      const value = argv[++index]
      if (!value || value.startsWith("--")) throw new Error("--root needs a value")
      args.root = resolve(value)
    } else if (arg === "--skip-site-build" || arg === "--fast") {
      args.skipSiteBuild = true
    } else if (arg === "--help" || arg === "-h") {
      args.help = true
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return args
}

function read(root, path, failures) {
  const full = join(root, path)
  if (!existsSync(full)) {
    failures.push(`${path}: file is missing`)
    return ""
  }
  return readFileSync(full, "utf8")
}

function requireClaims(file, text, claims, failures) {
  for (const claim of claims) {
    if (!text.includes(claim)) {
      failures.push(`${file}: missing current claim ${JSON.stringify(claim)}`)
    }
  }
}

function rejectClaims(file, text, claims, failures) {
  for (const claim of claims) {
    if (text.includes(claim)) {
      failures.push(`${file}: stale claim ${JSON.stringify(claim)} must not appear`)
    }
  }
}

/** Every `contract vN` in these files states the current contract. */
function requireCurrentContractClaims(file, text, failures) {
  const expected = `v${ENSEMBLE_BLOCK_VERSION}`
  for (const match of text.matchAll(/\bcontract v(\d+)\b/gi)) {
    if (match[1] !== String(ENSEMBLE_BLOCK_VERSION)) {
      failures.push(
        `${file}: contract version claim ${JSON.stringify(match[0])} does not match contract ${expected}`,
      )
    }
  }
}

/** Every `Node X+` / `Node X or newer` floor must be the verified minimum. */
function requireCurrentNodeFloors(file, text, failures) {
  for (const match of text.matchAll(/\bNode\s+(\d+\.\d+(?:\.\d+)?)\s*(?:\+|or newer)/g)) {
    if (match[1] !== MINIMUM_NODE_VERSION) {
      failures.push(
        `${file}: Node floor claim ${JSON.stringify(match[0])} does not match Node ${MINIMUM_NODE_VERSION}`,
      )
    }
  }
}

/** The tested Node versions come from the CI matrix, not a hand-written mirror. */
function testedNodeVersions(text) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => /^\s*node:\s*$/.test(line))
  if (start < 0) return []
  const versions = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    const match = /^\s*-\s*"([^"]+)"\s*$/.exec(line)
    if (match) {
      versions.push(match[1])
      continue
    }
    if (line.trim() === "") continue
    break
  }
  return versions
}

function joinClaim(values) {
  if (values.length <= 2) return values.join(" and ")
  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`
}

/** Every bold `OpenCode **X**` claim must be a supported host. */
function requireSupportedHostClaims(file, text, failures) {
  for (const match of text.matchAll(/\bOpenCode\s+\*\*(\d+\.\d+\.\d+)\*\*/g)) {
    if (!SUPPORTED_OPENCODE_VERSIONS.includes(match[1])) {
      failures.push(
        `${file}: OpenCode host claim ${JSON.stringify(match[0])} is not in the supported set `
          + `(${SUPPORTED_OPENCODE_VERSIONS.join(", ")})`,
      )
    }
  }
}

function checkWorkflow(root, path, failures) {
  const text = read(root, path, failures)
  if (!text) return ""
  return text
}

const EVIDENCE_INDEX = "docs/contributing/evidence.md"

function checkVerificationIndex(root, failures) {
  const index = read(root, EVIDENCE_INDEX, failures)
  if (!index) return
  const directory = join(root, "docs", "verification")
  if (!existsSync(directory)) {
    failures.push("docs/verification: directory is missing")
    return
  }
  for (const name of readdirSync(directory).sort()) {
    if (!name.endsWith(".md")) continue
    const date = name.slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < CURRENT_RECORD_FLOOR) continue
    if (!index.includes(name)) {
      failures.push(`${EVIDENCE_INDEX}: current verification record ${name} is not linked`)
    }
  }
}

const SECTION_INDEXES = [
  "docs/getting-started/README.md",
  "docs/concepts/README.md",
  "docs/guides/README.md",
  "docs/reference/README.md",
  "docs/operations/README.md",
  "docs/security/README.md",
  "docs/privacy/README.md",
  "docs/support/README.md",
  "docs/contributing/README.md",
]

/**
 * Ticket #302: the docs home is user navigation. Every section is reachable,
 * the style guide and redirect map are part of the docs contract, and evidence
 * (ADRs and verification records) is reached through the contributing hub.
 */
function checkDocsNavigation(root, failures) {
  for (const path of [
    ...SECTION_INDEXES,
    EVIDENCE_INDEX,
    "docs/style-guide.md",
    "docs/redirects.md",
  ]) {
    if (!existsSync(join(root, path))) {
      failures.push(`${path}: file is missing`)
    }
  }

  const home = read(root, "docs/README.md", failures)
  requireClaims(
    "docs/README.md",
    home,
    [
      ...SECTION_INDEXES.map((path) => path.replace(/^docs\//, "")),
      "style-guide.md",
      "redirects.md",
    ],
    failures,
  )

  const contributing = read(root, "docs/contributing/README.md", failures)
  requireClaims("docs/contributing/README.md", contributing, ["evidence.md"], failures)

  const evidence = read(root, EVIDENCE_INDEX, failures)
  requireClaims(EVIDENCE_INDEX, evidence, ["adr/README.md", "verification/"], failures)
}

const SUPPORT_DOCS = [
  "docs/support/README.md",
  "docs/support/incident-runbook.md",
  "docs/support/support-matrix.md",
]

const SUPPORT_TEMPLATES = [
  ".github/ISSUE_TEMPLATE/bug.yml",
  ".github/ISSUE_TEMPLATE/question.yml",
  ".github/PULL_REQUEST_TEMPLATE.md",
]

/**
 * Ticket #274: the public support path is part of the release contract. The
 * hub, runbook, matrix, and intake templates must exist, be reachable from the
 * index, and warn against posting credentials or conversation content.
 */
function checkSupport(root, failures) {
  for (const path of [...SUPPORT_DOCS, ...SUPPORT_TEMPLATES, ".github/ISSUE_TEMPLATE/config.yml"]) {
    if (!existsSync(join(root, path))) {
      failures.push(`${path}: file is missing`)
    }
  }

  const readme = read(root, "README.md", failures)
  requireClaims("README.md", readme, ["docs/support/README.md"], failures)

  const support = read(root, "docs/support/README.md", failures)
  requireClaims(
    "docs/support/README.md",
    support,
    ["incident-runbook.md", "support-matrix.md"],
    failures,
  )

  const index = read(root, "docs/README.md", failures)
  requireClaims(
    "docs/README.md",
    index,
    ["support/README.md", "support/incident-runbook.md", "support/support-matrix.md"],
    failures,
  )

  for (const path of SUPPORT_TEMPLATES) {
    const template = read(root, path, failures)
    requireClaims(path, template, ["credentials", "conversation content"], failures)
  }
}

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

const USER_ROOT_PAGES = [
  "docs/README.md",
  "docs/style-guide.md",
  "docs/redirects.md",
  "docs/contributing/README.md",
  "docs/contributing/evidence.md",
]

const REQUIRED_PAGES = [
  ...new Set([
    ...SECTION_INDEXES,
    ...USER_ROOT_PAGES,
    "docs/getting-started/quickstart.md",
    "docs/getting-started/install.md",
    "docs/reference/tools.md",
    "docs/reference/commands.md",
    "docs/support/troubleshooting.md",
  ]),
]

/** Historical release pages carry their own applicable version. */
const HISTORICAL_VERSIONS = new Map([
  ["docs/operations/release-notes-0.1.0.md", "0.1.0"],
  ["docs/operations/release-notes-0.1.0-rc.2.md", "0.1.0-rc.2"],
  ["docs/operations/launch-plan-0.1.0-rc.2.md", "0.1.0-rc.2"],
  ["docs/operations/release-signoff.md", "0.1.0-rc.2"],
])

const CURRENT_VERSION_DOCS = [
  "README.md",
  "docs/README.md",
  "docs/style-guide.md",
  "docs/getting-started/README.md",
  "docs/getting-started/install.md",
  "docs/getting-started/quickstart.md",
  "docs/getting-started/first-team.md",
  "docs/getting-started/upgrade.md",
  "docs/getting-started/what-is-ensemble.md",
]

function slash(path) {
  return path.replace(/\\/g, "/")
}

function walkMarkdown(root, directory = join(root, "docs")) {
  const pages = []
  if (!existsSync(directory)) return pages
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue
    const full = join(directory, entry.name)
    if (entry.isDirectory()) pages.push(...walkMarkdown(root, full))
    else if (entry.isFile() && entry.name.endsWith(".md")) pages.push(slash(relative(root, full)))
  }
  return pages.sort()
}

function isUserPage(path) {
  const docPath = path.replace(/^docs\//, "")
  return (
    USER_ROOT_PAGES.includes(path) ||
    USER_SECTIONS.some(
      (section) => docPath === `${section}/README.md` || docPath.startsWith(`${section}/`),
    )
  )
}

function isExternalLink(href) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)
}

function decodePath(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function insideRoot(root, target) {
  const rel = relative(root, target)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`))
}

function resolveMarkdownTarget(root, fromPath, rawHref) {
  const hashAt = rawHref.indexOf("#")
  const hash = hashAt >= 0 ? rawHref.slice(hashAt + 1) : ""
  const pathAndQuery = hashAt >= 0 ? rawHref.slice(0, hashAt) : rawHref
  const queryAt = pathAndQuery.indexOf("?")
  const rawPath = queryAt >= 0 ? pathAndQuery.slice(0, queryAt) : pathAndQuery
  if (!rawPath) {
    return { file: join(root, fromPath), hash }
  }
  const path = decodePath(rawPath)
  let target
  if (path.startsWith("/")) {
    const clean = path.replace(/^\/+/, "")
    if (clean.startsWith("media/")) {
      target = join(root, "docs", "public", clean)
    } else if (["favicon.svg", "og-image.png", "robots.txt", ".nojekyll"].includes(clean)) {
      target = join(root, "docs", "public", clean)
    } else {
      target = join(root, "docs", clean)
    }
  } else {
    target = resolve(dirname(join(root, fromPath)), path)
  }
  if (!insideRoot(root, target)) {
    return { error: "link leaves the repository" }
  }
  let file = target
  if (existsSync(target) && statSync(target).isDirectory()) {
    file = join(target, "README.md")
  } else if (!existsSync(target) && existsSync(`${target}.md`)) {
    file = `${target}.md`
  }
  if (!existsSync(file) || statSync(file).isDirectory()) {
    return { error: `target ${slash(relative(root, target))} is missing` }
  }
  return { file, hash }
}

function sectionOf(path) {
  const match = /^docs\/([^/]+)\//.exec(path)
  return match?.[1]
}

function checkPageInventory(root, failures) {
  for (const path of REQUIRED_PAGES) {
    if (!existsSync(join(root, path))) {
      failures.push(`${path}: required page is missing`)
    }
  }

  const allPages = walkMarkdown(root)
  for (const section of USER_SECTIONS) {
    const index = `docs/${section}/README.md`
    if (!existsSync(join(root, index))) continue
    const pages = allPages.filter((path) => sectionOf(path) === section)
    const reachable = new Set([index])
    const queue = [index]
    while (queue.length > 0) {
      const page = queue.shift()
      const text = read(root, page, failures)
      if (!text) continue
      for (const link of extractLinks(text)) {
        if (isExternalLink(link.href) || link.href.startsWith("#")) continue
        const target = resolveMarkdownTarget(root, page, link.href)
        if (!target.file || !target.file.endsWith(".md")) continue
        const targetPath = slash(relative(root, target.file))
        if (sectionOf(targetPath) !== section || reachable.has(targetPath)) continue
        reachable.add(targetPath)
        queue.push(targetPath)
      }
    }
    for (const page of pages) {
      if (!reachable.has(page)) {
        failures.push(`${page}: user page is not reachable from ${index} (page inventory)`)
      }
    }
  }
}

function checkFrontmatter(root, failures) {
  for (const path of walkMarkdown(root)) {
    if (!isUserPage(path)) continue
    const text = read(root, path, failures)
    if (!text) continue
    const parsed = parseFrontmatter(text)
    if (!parsed.hasFrontmatter) {
      failures.push(`${path}: user page needs frontmatter with title, description, and version`)
      continue
    }
    if (!parsed.values.title) failures.push(`${path}: frontmatter is missing title`)
    if (!parsed.values.description || parsed.values.description.length < 10) {
      failures.push(`${path}: frontmatter needs a useful description`)
    }
    const version = parsed.values.version ?? ""
    const expected = HISTORICAL_VERSIONS.get(path) ?? "0.1.x"
    if (version !== expected) {
      failures.push(
        `${path}: frontmatter version ${JSON.stringify(version)} must be ${JSON.stringify(expected)}`,
      )
    }
    if (parsed.values.title) {
      const h1 = /^#\s+(.+?)\s*$/m.exec(parsed.body)
      if (!h1) {
        failures.push(`${path}: frontmatter page needs exactly one H1 matching the title`)
      } else if (h1[1] !== parsed.values.title) {
        failures.push(
          `${path}: H1 ${JSON.stringify(h1[1])} must match frontmatter title ${JSON.stringify(parsed.values.title)}`,
        )
      }
    }
  }
}

function checkMarkdownStructure(root, failures) {
  const pages = [
    "README.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "AGENTS.md",
    "GLOSSARY.md",
    "CHANGELOG.md",
    ...walkMarkdown(root),
  ]
  for (const path of pages) {
    if (!existsSync(join(root, path))) continue
    const text = read(root, path, failures)
    if (!text) continue
    for (const block of fencedBlocks(text)) {
      if (!block.closed) {
        failures.push(`${path}: unclosed code fence starting at line ${block.startLine}`)
      } else if (isUserPage(path) && !block.language) {
        failures.push(`${path}: code fence at line ${block.startLine} needs a language`)
      }
    }
    for (const failure of shellSyntaxFailures(text)) {
      failures.push(`${path}: ${failure}`)
    }
  }
}

function checkInternalLinks(root, failures) {
  const pages = [
    "README.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "AGENTS.md",
    "GLOSSARY.md",
    "CHANGELOG.md",
    ...walkMarkdown(root),
  ]
  const anchorCache = new Map()
  for (const path of pages) {
    if (!existsSync(join(root, path))) continue
    const text = read(root, path, failures)
    if (!text) continue
    for (const link of extractLinks(text)) {
      if (isExternalLink(link.href)) continue
      const target = resolveMarkdownTarget(root, path, link.href)
      if (target.error) {
        failures.push(`${path}:${link.line}: broken link ${JSON.stringify(link.href)} (${target.error})`)
        continue
      }
      if (!target.hash || !target.file?.endsWith(".md")) continue
      let anchors = anchorCache.get(target.file)
      if (!anchors) {
        anchors = pageAnchors(readFileSync(target.file, "utf8"))
        anchorCache.set(target.file, anchors)
      }
      const anchor = decodePath(target.hash)
      if (!anchors.has(anchor)) {
        failures.push(
          `${path}:${link.line}: broken anchor #${anchor} in ${JSON.stringify(link.href)}`,
        )
      }
    }
  }
}

function checkCurrentPackageVersionClaims(root, packageName, packageVersion, failures) {
  for (const path of CURRENT_VERSION_DOCS) {
    const text = read(root, path, failures)
    if (!text) continue
    for (const match of text.matchAll(
      new RegExp(`${packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}@(\\d[^\\s\`]*)`, "g"),
    )) {
      if (match[1] !== packageVersion) {
        failures.push(`${path}: install version ${JSON.stringify(match[0])} must use ${packageVersion}`)
      }
    }
  }
  const siteData = read(root, "docs/.vitepress/site-data.mjs", failures)
  if (siteData) {
    const match = /export const VERSION = "([^"]+)"/.exec(siteData)
    const expected = `${packageVersion.split(".").slice(0, 2).join(".")}.x`
    if (!match || match[1] !== expected) {
      failures.push(
        `docs/.vitepress/site-data.mjs: VERSION ${JSON.stringify(match?.[1] ?? "")} must be ${expected}`,
      )
    }
  }
}

function runSiteBuild(root, failures) {
  const result = spawnSync("npm", ["run", "docs:site:build"], {
    cwd: root,
    encoding: "utf8",
    timeout: 10 * 60 * 1000,
    maxBuffer: 10 * 1024 * 1024,
  })
  if (result.error) {
    failures.push(`docs:site:build could not run: ${result.error.message}`)
    return
  }
  if (result.status !== 0) {
    const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-12)
      .join(" | ")
    failures.push(`docs:site:build failed: ${output || `exit ${result.status}`}`)
  }
}

function checkDocs(root = REPO_ROOT, { skipSiteBuild = false } = {}) {
  const failures = []
  const version = ENSEMBLE_BLOCK_VERSION
  const hosts = [...SUPPORTED_OPENCODE_VERSIONS]
  const hostList = joinClaim(hosts)
  const boldHostList = joinClaim(hosts.map((host) => `**${host}**`))

  const verifyWorkflow = checkWorkflow(root, ".github/workflows/verify.yml", failures)
  const liveNode = workflowValue(verifyWorkflow, "NODE_VERSION") ?? ""
  const nodeMatrix = checkWorkflow(root, ".github/workflows/node-matrix.yml", failures)
  const testedNodes = testedNodeVersions(nodeMatrix)
  const testedNodeClaim = testedNodes.length > 0 ? `Node ${joinClaim(testedNodes)}` : undefined

  const readme = read(root, "README.md", failures)
  requireClaims(
    "README.md",
    readme,
    [
      `OpenCode ${boldHostList}`,
      `Node ${MINIMUM_NODE_VERSION} or newer`,
      ...(testedNodeClaim ? [testedNodeClaim] : []),
      OPENCODE_PLUGIN_PEER_RANGE,
      `contract v${version}`,
      "Ensemble is released under the [MIT License](LICENSE).",
    ],
    failures,
  )
  rejectClaims(
    "README.md",
    readme,
    [
      "not published, versioned, or licensed",
      "no license has been selected",
      "A license has not been selected",
      "package is private",
      "No npm package or license",
    ],
    failures,
  )
  requireCurrentContractClaims("README.md", readme, failures)
  requireCurrentNodeFloors("README.md", readme, failures)
  requireSupportedHostClaims("README.md", readme, failures)

  // Ticket #269 owns the license and package identity contract: the README
  // install command, LICENSE text, and package metadata must agree.
  const license = read(root, "LICENSE", failures)
  requireClaims("LICENSE", license, ["MIT License", "Permission is hereby granted"], failures)

  const docsIndex = read(root, "docs/README.md", failures)
  requireClaims("docs/README.md", docsIndex, [`v${version} roster contract`], failures)

  const implementation = read(root, "docs/implementation.md", failures)
  requireClaims(
    "docs/implementation.md",
    implementation,
    [
      `ENSEMBLE_BLOCK_VERSION = ${version}`,
      `OpenCode ${hostList}`,
      `Node ${MINIMUM_NODE_VERSION} or newer`,
      `contract v${version}`,
    ],
    failures,
  )
  requireCurrentNodeFloors("docs/implementation.md", implementation, failures)

  const adr = read(root, "docs/adr/0011-mention-routing-and-budgets.md", failures)
  requireClaims(
    "docs/adr/0011-mention-routing-and-budgets.md",
    adr,
    [`contract v${version}`, `Contract v${version} says`],
    failures,
  )
  rejectClaims(
    "docs/adr/0011-mention-routing-and-budgets.md",
    adr,
    [`Contract v${version - 1} says`],
    failures,
  )

  const hostRange = read(root, "docs/compatibility/opencode-host-range.md", failures)
  requireClaims(
    "docs/compatibility/opencode-host-range.md",
    hostRange,
    [
      `supported on OpenCode ${hostList}`,
      OPENCODE_PLUGIN_PEER_RANGE,
      ...hosts.map((host) => `**${host}**`),
      ...(liveNode ? [`Node ${liveNode}`] : []),
    ],
    failures,
  )

  const scriptsReadme = read(root, "scripts/README.md", failures)
  requireClaims("scripts/README.md", scriptsReadme, [`Node ${MINIMUM_NODE_VERSION}+`, `v${version} roster table`], failures)
  requireCurrentNodeFloors("scripts/README.md", scriptsReadme, failures)

  // Ticket #262 owns the docs/package contract: the README claims, engines
  // floor, Node matrix, and docs:check must agree with the canonical
  // constants. Keeping these checks here is deliberate, not a scope leak.
  const packageJson = read(root, "package.json", failures)
  if (packageJson) {
    let pkg
    try {
      pkg = JSON.parse(packageJson)
    } catch {
      failures.push("package.json: not valid JSON")
    }
    if (pkg) {
      const engines = pkg.engines?.node ?? ""
      if (engines !== `>=${MINIMUM_NODE_VERSION}`) {
        failures.push(
          `package.json: engines.node ${JSON.stringify(engines)} does not match >=${MINIMUM_NODE_VERSION}`,
        )
      }
      if (pkg.license !== "MIT") {
        failures.push(`package.json: license ${JSON.stringify(pkg.license)} does not match MIT`)
      }
      if (pkg.private === true) {
        failures.push("package.json: a publishable package must not set private")
      }
      if (typeof pkg.name !== "string" || pkg.name.length === 0) {
        failures.push("package.json: name is missing")
      } else {
        requireClaims("README.md", readme, [`opencode plugin add ${pkg.name}`], failures)
        if (typeof pkg.version === "string" && pkg.version.length > 0) {
          requireClaims("README.md", readme, [`opencode plugin add ${pkg.name}@${pkg.version}`], failures)
          checkCurrentPackageVersionClaims(root, pkg.name, pkg.version, failures)
        }
      }
    }
  }

  const compatibility = checkWorkflow(root, ".github/workflows/compatibility.yml", failures)
  for (const host of hosts) {
    if (compatibility && !compatibility.includes(`"${host}"`)) {
      failures.push(`.github/workflows/compatibility.yml: supported host ${host} is not in the matrix`)
    }
  }

  if (nodeMatrix) {
    for (const node of [MINIMUM_NODE_VERSION, liveNode].filter(Boolean)) {
      if (!nodeMatrix.includes(`"${node}"`)) {
        failures.push(`.github/workflows/node-matrix.yml: tested Node ${node} is not in the matrix`)
      }
    }
  }
  if (liveNode) {
    requireClaims("README.md", readme, [`Node ${liveNode}`], failures)
  }

  checkDocsNavigation(root, failures)
  checkPageInventory(root, failures)
  checkFrontmatter(root, failures)
  checkMarkdownStructure(root, failures)
  checkInternalLinks(root, failures)
  checkVerificationIndex(root, failures)
  checkSupport(root, failures)
  for (const failure of checkReferenceDocs(root)) {
    failures.push(`reference:check: ${failure}`)
  }
  for (const failure of checkDocsMedia(root)) {
    failures.push(`media: ${failure}`)
  }

  let siteBuild = "skipped"
  if (skipSiteBuild) {
    siteBuild = "skipped (--skip-site-build)"
  } else if (root !== REPO_ROOT) {
    siteBuild = "skipped (fixture root)"
  } else {
    runSiteBuild(root, failures)
    siteBuild = failures.some((failure) => failure.startsWith("docs:site:build")) ? "failed" : "ok"
  }

  return { failures, version, hosts, liveNode, siteBuild }
}

const help = process.argv.includes("--help") || process.argv.includes("-h")
if (help) {
  console.log(`Usage: node --experimental-strip-types scripts/docs-check.mjs [--root DIR] [--skip-site-build]

Asserts that the current docs match the canonical contract, host, and Node
versions, that the page inventory and frontmatter are complete, that every
internal link and anchor resolves, that Markdown fences and shell samples are
valid, that every verification record from ${CURRENT_RECORD_FLOOR} onward is
linked from ${EVIDENCE_INDEX}, and that the generated reference is current.
The default runs the VitePress docs-site build; --skip-site-build is the
explicit fast mode used by fixture tests and is not the CI gate.
Exits 1 on any stale or missing claim.`)
} else {
  try {
    const args = parseArgs(process.argv.slice(2))
    const { failures, version, hosts, liveNode, siteBuild } = checkDocs(args.root, {
      skipSiteBuild: args.skipSiteBuild,
    })
    if (failures.length > 0) {
      for (const failure of failures) console.error(`docs:check: ${failure}`)
      console.error(`docs:check: ${failures.length} stale or missing claim(s)`)
      process.exitCode = 1
    } else {
      console.log(
        `docs:check: ok (contract v${version}; OpenCode ${hosts.join(", ")}; `
          + `Node >=${MINIMUM_NODE_VERSION}; live Node ${liveNode || "unset"}; `
          + `site build: ${siteBuild})`,
      )
    }
  } catch (error) {
    console.error(`docs:check: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
  }
}
