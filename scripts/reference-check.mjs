#!/usr/bin/env node
/**
 * Generated-reference contract check (ticket #305).
 *
 * Fails when a generated reference page is missing, stale, not reachable from
 * the reference index, or no longer mentions a catalogued tool or command. The
 * page comparison is byte-exact, so a hand edit or a code change without a
 * regeneration cannot pass.
 *
 * Usage:
 *   node --experimental-strip-types scripts/reference-check.mjs [--root DIR]
 */
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
  CLI_DOCS,
  LEGACY_TOOLS,
  MAINTAINER_COMMANDS,
  NATIVE_TOOLS,
  REFERENCE_PAGES,
  referenceInventory,
  renderReferenceDocs,
  sourceEnvironmentNames,
} from "./reference-docs.mjs"
import { ENSEMBLE_BLOCK_VERSION } from "../src/v2/init-block.ts"
import { MINIMUM_NODE_VERSION } from "../src/v2/node-version.ts"
import { COMMANDS } from "../src/v2/tui/commands.ts"
import { COMPOSER_COMMANDS } from "../src/v2/tui/composer.ts"
import { TOOL_SURFACE_TOOL_NAMES } from "../src/v2/tool-surface.ts"
import { KEYMAP_CATALOG } from "../src/v2/tui/keymap.ts"

const REPO_ROOT = resolve(new URL("..", import.meta.url).pathname)

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

function readIfPresent(root, path, failures) {
  const full = join(root, path)
  if (!existsSync(full)) {
    failures.push(`${path}: generated reference page is missing; run npm run docs:reference`)
    return ""
  }
  return readFileSync(full, "utf8")
}

function requireText(file, text, needle, message, failures) {
  if (!text.includes(needle)) failures.push(`${file}: ${message}`)
}

function checkNativeTools(root, failures) {
  const file = "docs/reference/tools.md"
  const text = readIfPresent(root, file, failures)
  if (!text) return
  for (const tool of NATIVE_TOOLS) {
    requireText(file, text, `## \`${tool.name}\``, `native tool ${tool.name} is undocumented`, failures)
  }
}

function checkLegacyTools(root, failures) {
  const file = "docs/reference/migration-tools.md"
  const text = readIfPresent(root, file, failures)
  if (!text) return
  for (const tool of LEGACY_TOOLS) {
    requireText(file, text, `\`${tool.name}\``, `migration/legacy tool ${tool.name} is undocumented`, failures)
  }
  for (const base of TOOL_SURFACE_TOOL_NAMES.legacy) {
    const name = `ensemble_${base}`
    if (TOOL_SURFACE_TOOL_NAMES.native.includes(base)) continue
    requireText(
      file,
      text,
      `## \`${name}\``,
      `legacy-only tool ${name} needs its own section`,
      failures,
    )
  }
  if (text.includes("## `ensemble_dispatch`")) {
    failures.push(`${file}: ensemble_dispatch belongs on the native page, not the legacy page`)
  }
}

function checkCommands(root, failures) {
  const file = "docs/reference/commands.md"
  const text = readIfPresent(root, file, failures)
  if (!text) return
  for (const command of COMMANDS) {
    requireText(file, text, `### \`:${command.name}\``, `command :${command.name} is undocumented`, failures)
  }
  for (const command of COMPOSER_COMMANDS) {
    requireText(file, text, `\`/${command.name}\``, `composer command /${command.name} is undocumented`, failures)
  }
  if (text.includes("### `:ensemble-init`")) {
    failures.push(`${file}: :ensemble-init is not a valid command; do not document it as one`)
  }
}

function checkKeyboard(root, failures) {
  const file = "docs/reference/keyboard.md"
  const text = readIfPresent(root, file, failures)
  if (!text) return
  const inventory = referenceInventory()
  for (const title of inventory.keyboard.sections) {
    requireText(file, text, `## ${title}\n`, `keyboard section ${JSON.stringify(title)} is undocumented`, failures)
  }
  for (const context of inventory.keyboard.contexts) {
    requireText(file, text, `\`${context}\``, `keyboard context ${context} is undocumented`, failures)
  }
  for (const entry of KEYMAP_CATALOG) {
    requireText(file, text, `| ${entry.title} |`, `keybinding ${entry.id} (${entry.title}) is undocumented`, failures)
  }
  for (const key of [
    "PageDown / Ctrl+d",
    "PageUp / Ctrl+u",
    "Enter / s",
    "Esc / q",
  ]) {
    requireText(file, text, key, `custom overlay key ${JSON.stringify(key)} is undocumented`, failures)
  }
}

function checkConfiguration(root, failures) {
  const file = "docs/reference/configuration.md"
  const text = readIfPresent(root, file, failures)
  if (!text) return
  const inventory = referenceInventory()
  for (const field of inventory.configuration.workspace) {
    requireText(file, text, `| \`${field}\` |`, `workspace config field ${field} is undocumented`, failures)
  }
  for (const field of inventory.configuration.settings) {
    requireText(file, text, `| \`${field}\` |`, `stored setting ${field} is undocumented`, failures)
  }
  for (const phrase of ["deprecated", "unused", "v2/meta", ".ensemble/config.json"]) {
    requireText(file, text.toLowerCase(), phrase.toLowerCase(), `configuration page is missing ${JSON.stringify(phrase)}`, failures)
  }
}

function checkEnvironment(root, failures) {
  const file = "docs/reference/environment.md"
  const text = readIfPresent(root, file, failures)
  if (!text) return
  const documented = referenceInventory().environment
  const source = sourceEnvironmentNames()
  for (const name of source) {
    requireText(file, text, `| \`${name}\` |`, `environment variable ${name} is undocumented`, failures)
  }
  for (const name of documented) {
    if (!source.includes(name)) {
      failures.push(`${file}: documented environment variable ${name} is not read by the non-test product source`)
    }
  }
  for (const group of ["ENSEMBLE_LIVE_", "ENSEMBLE_LATENCY_", "ENSEMBLE_FAKE_", "ENSEMBLE_SOAK_", "OPENCODE_BIN", "TMUX_BIN"]) {
    requireText(file, text, group, `test-harness variable group ${group} is undocumented`, failures)
  }
}

function checkFiles(root, failures) {
  const file = "docs/reference/files.md"
  const text = readIfPresent(root, file, failures)
  if (!text) return
  const inventory = referenceInventory()
  for (const path of inventory.files.workspace) {
    requireText(file, text, path, `workspace path ${path} is undocumented`, failures)
  }
  for (const prefix of inventory.files.prefixes) {
    requireText(file, text, `\`${prefix}\``, `plugin storage prefix ${prefix} is undocumented`, failures)
  }
  for (const phrase of ["AGENTS.md", "init.json", "handoffs", "attachments", "v2/backup/rollback", "ensemble.state", "7 days"]) {
    requireText(file, text, phrase, `files page is missing ${JSON.stringify(phrase)}`, failures)
  }
}

function packageScripts(root, failures) {
  const file = "package.json"
  if (!existsSync(join(root, file))) {
    failures.push(`${file}: file is missing`)
    return {}
  }
  try {
    return JSON.parse(readFileSync(join(root, file), "utf8")).scripts ?? {}
  } catch {
    failures.push(`${file}: not valid JSON`)
    return {}
  }
}

function checkCLI(root, failures) {
  const file = "docs/reference/cli.md"
  const text = readIfPresent(root, file, failures)
  if (!text) return
  const scripts = packageScripts(root, failures)
  for (const entry of CLI_DOCS) {
    requireText(file, text, `## \`${entry.heading}\``, `operator command ${entry.heading} is undocumented`, failures)
    if (!(entry.script in scripts)) {
      failures.push(`${file}: documented script ${entry.script} does not exist in package.json`)
    }
    for (const option of entry.options) {
      const flag = /--[a-z-]+/.exec(option[0])?.[0]
      if (!flag) continue
      requireText(file, text, flag, `option ${flag} for ${entry.heading} is undocumented`, failures)
      const source = readFileSync(join(REPO_ROOT, entry.source), "utf8")
      if (!source.includes(flag)) {
        failures.push(`docs/reference/cli.md: option ${flag} for ${entry.heading} is not in ${entry.source}`)
      }
    }
    for (const [exitCode] of entry.exits) {
      if (!text.includes(exitCode)) failures.push(`${file}: exit code ${exitCode} for ${entry.heading} is undocumented`)
    }
  }
  for (const [name] of MAINTAINER_COMMANDS) {
    if (name.endsWith("*")) {
      const prefix = name.slice(0, -1)
      if (!Object.keys(scripts).some((script) => script.startsWith(prefix))) {
        failures.push(`${file}: maintainer command group ${name} has no package script`)
      }
      continue
    }
    if (!(name in scripts)) {
      failures.push(`${file}: maintainer command ${name} does not exist in package.json`)
    }
    requireText(file, text, `\`${name}\``, `maintainer command ${name} is undocumented`, failures)
  }
  if (!text.includes("release-guard.mjs")) failures.push(`${file}: release guard is undocumented`)
}

function checkSupported(root, failures) {
  const file = "docs/reference/supported.md"
  const text = readIfPresent(root, file, failures)
  if (!text) return
  const inventory = referenceInventory()
  for (const host of inventory.supported.hosts) {
    requireText(file, text, `| **${host}** | **`, `supported host ${host} is undocumented`, failures)
  }
  for (const node of [...inventory.supported.testedNodes, inventory.supported.liveNode].filter(Boolean)) {
    requireText(file, text, node, `tested Node ${node} is undocumented`, failures)
  }
  for (const claim of [
    inventory.supported.peerRange,
    inventory.supported.minimumNode,
    inventory.supported.packageVersion,
    `contract v${ENSEMBLE_BLOCK_VERSION}`,
    "unsupported_node",
  ]) {
    requireText(file, text, claim, `supported-version claim ${JSON.stringify(claim)} is missing`, failures)
  }
  if (MINIMUM_NODE_VERSION !== inventory.supported.minimumNode) {
    failures.push(`${file}: Node floor is stale`)
  }
}

function sectionText(text, heading) {
  const start = text.indexOf(heading)
  if (start < 0) return ""
  const rest = text.slice(start + heading.length)
  const end = rest.search(/\n## /)
  return end < 0 ? rest : rest.slice(0, end)
}

function checkImplementation(root, failures) {
  const file = "docs/implementation.md"
  const text = readIfPresent(root, file, failures)
  if (!text) return
  const native = sectionText(text, "## Native tools")
  if (!native) {
    failures.push(`${file}: Native tools section is missing`)
    return
  }
  for (const tool of NATIVE_TOOLS) {
    requireText(file, native, tool.name, `native tool ${tool.name} is missing from the implementation tool list`, failures)
  }
  if (text.includes("also clears a legacy tool-surface override")) {
    failures.push(`${file}: stale claim that :native-first on clears a legacy tool-surface override`)
  }
  if (!text.includes(":tools native")) {
    failures.push(`${file}: the native-first restore path (:tools native) is undocumented`)
  }
  if (text.includes("not a published release yet")) {
    failures.push(`${file}: stale claim that the package is not a published release`)
  }
}

function checkNavigation(root, failures) {
  const file = "docs/reference/README.md"
  const text = readIfPresent(root, file, failures)
  if (!text) return
  for (const page of REFERENCE_PAGES) {
    const name = page.replace("docs/reference/", "")
    requireText(file, text, name, `generated reference page ${name} is not linked from the reference index`, failures)
  }
}

function checkFreshness(root, failures) {
  const expected = renderReferenceDocs()
  for (const [path, content] of Object.entries(expected)) {
    const full = join(root, path)
    if (!existsSync(full)) continue
    const actual = readFileSync(full, "utf8")
    if (actual !== content) {
      failures.push(`${path}: generated reference is stale; run npm run docs:reference`)
    }
  }
}

export function checkReferenceDocs(root = REPO_ROOT) {
  const failures = []
  checkNativeTools(root, failures)
  checkLegacyTools(root, failures)
  checkCommands(root, failures)
  checkKeyboard(root, failures)
  checkConfiguration(root, failures)
  checkEnvironment(root, failures)
  checkFiles(root, failures)
  checkCLI(root, failures)
  checkSupported(root, failures)
  checkImplementation(root, failures)
  checkNavigation(root, failures)
  checkFreshness(root, failures)
  return failures
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
const help = invokedDirectly && (process.argv.includes("--help") || process.argv.includes("-h"))
if (!invokedDirectly) {
  // Imported by docs-check or a contract test; the exported function owns the result.
} else if (help) {
  console.log(`Usage: node --experimental-strip-types scripts/reference-check.mjs [--root DIR]

Asserts that every generated reference page exists, is linked from
docs/reference/README.md, documents every catalogued tool and command, and
matches the generator output byte-for-byte. Exits 1 on drift.`)
} else {
  try {
    const args = parseArgs(process.argv.slice(2))
    const failures = checkReferenceDocs(args.root)
    if (failures.length > 0) {
      for (const failure of failures) console.error(`reference:check: ${failure}`)
      console.error(`reference:check: ${failures.length} reference failure(s)`)
      process.exitCode = 1
    } else {
      console.log(
        `reference:check: ok (${NATIVE_TOOLS.length} native tools; `
          + `${LEGACY_TOOLS.length} legacy tools; ${COMMANDS.length} : commands; `
          + `${COMPOSER_COMMANDS.length} / commands; ${REFERENCE_PAGES.length} generated pages)`,
      )
    }
  } catch (error) {
    console.error(`reference:check: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
  }
}
