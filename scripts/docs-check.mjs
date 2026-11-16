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
 * left alone.
 *
 * Usage:
 *   node --experimental-strip-types scripts/docs-check.mjs [--root DIR]
 */
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { ENSEMBLE_BLOCK_VERSION } from "../src/v2/init-block.ts"
import { workflowValue } from "../src/v2/ci-workflows.ts"
import {
  OPENCODE_PLUGIN_PEER_RANGE,
  SUPPORTED_OPENCODE_VERSIONS,
} from "../src/v2/host-compatibility.ts"
import { MINIMUM_NODE_VERSION } from "../src/v2/node-version.ts"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/** Verification records from this date onward must appear in docs/README.md. */
const CURRENT_RECORD_FLOOR = "2026-11-11"

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

function checkVerificationIndex(root, failures) {
  const indexPath = "docs/README.md"
  const index = read(root, indexPath, failures)
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
      failures.push(`${indexPath}: current verification record ${name} is not linked`)
    }
  }
}

function checkDocs(root = REPO_ROOT) {
  const failures = []
  const version = ENSEMBLE_BLOCK_VERSION
  const hosts = [...SUPPORTED_OPENCODE_VERSIONS]
  const hostList = hosts.join(" and ")
  const boldHostList = hosts.map((host) => `**${host}**`).join(" and ")

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

  checkVerificationIndex(root, failures)

  return { failures, version, hosts, liveNode }
}

const help = process.argv.includes("--help") || process.argv.includes("-h")
if (help) {
  console.log(`Usage: node --experimental-strip-types scripts/docs-check.mjs [--root DIR]

Asserts that the current docs match the canonical contract, host, and Node
versions, and that every verification record from ${CURRENT_RECORD_FLOOR} onward is
linked from docs/README.md. Exits 1 on any stale or missing claim.`)
} else {
  try {
    const args = parseArgs(process.argv.slice(2))
    const { failures, version, hosts, liveNode } = checkDocs(args.root)
    if (failures.length > 0) {
      for (const failure of failures) console.error(`docs:check: ${failure}`)
      console.error(`docs:check: ${failures.length} stale or missing claim(s)`)
      process.exitCode = 1
    } else {
      console.log(
        `docs:check: ok (contract v${version}; OpenCode ${hosts.join(", ")}; `
          + `Node >=${MINIMUM_NODE_VERSION}; live Node ${liveNode || "unset"})`,
      )
    }
  } catch (error) {
    console.error(`docs:check: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
  }
}
