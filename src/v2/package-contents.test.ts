import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Ticket #269: the published tarball is a runtime artifact. This suite packs the
 * package the way `npm publish` does and asserts the contents are exactly the
 * import closure of the public exports, so a stray test, fixture, doc, script,
 * or development-only module cannot leak into a release.
 */
const repoRoot = fileURLToPath(new URL("../..", import.meta.url))
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"))

const ROOT_FILES = new Set(["package.json", "README.md", "LICENSE"])

const FORBIDDEN: ReadonlyArray<readonly [RegExp, string]> = [
  [/\.test\.tsx?$/, "test file"],
  [/(^|\/)fixtures\//, "fixture"],
  [/^(docs|scripts)\//, "docs or scripts"],
  [/(^|\/)(AGENTS|CONTRIBUTING|GLOSSARY|SECURITY)\.md$/, "repository document"],
  [/^(tsconfig\.json|package-lock\.json)$/, "development artifact"],
  [/(^|\/)node_modules\//, "dependency tree"],
  [/\.(tgz|tsbuildinfo|log|sqlite|sqlite-\w+|map)$/, "development artifact"],
]

interface PackFile {
  path: string
  size: number
  mode: number
}

interface PackReport {
  name: string
  version: string
  filename: string
  files: PackFile[]
}

let cachedPack: PackReport | undefined

/** The real package seam: ask npm which files it would publish. */
function packReport(): PackReport {
  if (cachedPack) return cachedPack
  const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  })
  const reports = Object.values(JSON.parse(output) as Record<string, PackReport>)
  const report = reports[0]
  assert.ok(report, "npm pack --dry-run --json returned a report")
  cachedPack = report
  return report
}

function sourceModules(): string[] {
  const root = join(repoRoot, "src", "v2")
  const modules: string[] = []
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const full = join(directory, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.tsx?$/.test(name)) modules.push(full)
    }
  }
  walk(root)
  return modules
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  const pattern = /\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\bimport\s*["']([^"']+)["']/g
  for (const match of source.matchAll(pattern)) {
    specifiers.push(match[1] ?? match[2] ?? match[3]!)
  }
  return specifiers
}

/** Resolve a relative TypeScript import the way Node's strip-types loader does. */
function resolveModule(from: string, specifier: string, modules: ReadonlySet<string>): string | null {
  if (!specifier.startsWith(".")) return null
  const base = resolve(dirname(from), specifier)
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (modules.has(candidate)) return candidate
  }
  return null
}

/** Every module loadable from the package's exports, including `./rpc`. */
function runtimeModules(): Set<string> {
  const modules = new Set(sourceModules())
  const entries = Object.values(packageJson.exports as Record<string, string>).map((entry) =>
    resolve(repoRoot, entry),
  )
  const reached = new Set<string>()
  const pending = [...entries]
  while (pending.length > 0) {
    const file = pending.pop()!
    if (reached.has(file)) continue
    assert.ok(modules.has(file), `${relative(repoRoot, file)} is not a source module`)
    reached.add(file)
    const source = readFileSync(file, "utf8")
    for (const specifier of importSpecifiers(source)) {
      const dependency = resolveModule(file, specifier, modules)
      if (dependency && !reached.has(dependency)) pending.push(dependency)
    }
  }
  return new Set([...reached].map((file) => relative(repoRoot, file).split(sep).join("/")))
}

/**
 * The allowlist contract, independent of npm's glob engine: only the root
 * package documents and the runtime module closure may ship.
 */
function packedContentFailures(paths: readonly string[], runtime: ReadonlySet<string>): string[] {
  const failures: string[] = []
  const packedModules = new Set<string>()
  for (const path of paths) {
    const forbidden = FORBIDDEN.find(([pattern]) => pattern.test(path))
    if (forbidden) {
      failures.push(`${path}: ${forbidden[1]} must not be packed`)
      continue
    }
    if (ROOT_FILES.has(path)) continue
    if (/^src\/v2\/.*\.tsx?$/.test(path)) {
      packedModules.add(path)
      continue
    }
    failures.push(`${path}: not an allowed package file`)
  }
  for (const path of [...runtime].sort()) {
    if (!packedModules.has(path)) failures.push(`${path}: runtime module is missing from the package`)
  }
  for (const path of [...packedModules].sort()) {
    if (!runtime.has(path)) failures.push(`${path}: is not reachable from the package exports`)
  }
  return failures
}

test("the tarball ships exactly the runtime module closure", () => {
  const report = packReport()
  const paths = report.files.map((file) => file.path).sort()
  assert.deepEqual(packedContentFailures(paths, runtimeModules()), [])
  for (const required of ["package.json", "README.md", "LICENSE"]) {
    assert.ok(paths.includes(required), `${required} ships`)
  }
})

test("the content check rejects a leaked test, fixture, doc, script, or dev module", () => {
  const runtime = new Set(["src/v2/server.ts"])
  const failures = packedContentFailures(
    [
      "package.json",
      "README.md",
      "LICENSE",
      "src/v2/server.ts",
      "src/v2/service.test.ts",
      "src/v2/fixtures/native-host-contract.jsonl",
      "docs/implementation.md",
      "scripts/docs-check.mjs",
      "src/v2/doctor.ts",
      "tsconfig.json",
    ],
    runtime,
  )
  assert.ok(failures.some((failure) => /service\.test\.ts: test file/.test(failure)), failures.join("\n"))
  assert.ok(failures.some((failure) => /fixtures\/.*fixture/.test(failure)), failures.join("\n"))
  assert.ok(failures.some((failure) => /^docs\/implementation\.md: docs or scripts/.test(failure)), failures.join("\n"))
  assert.ok(failures.some((failure) => /^scripts\/docs-check\.mjs: docs or scripts/.test(failure)), failures.join("\n"))
  assert.ok(failures.some((failure) => /doctor\.ts: is not reachable/.test(failure)), failures.join("\n"))
  assert.ok(failures.some((failure) => /tsconfig\.json: development artifact/.test(failure)), failures.join("\n"))
})

test("the package identity is the scoped MIT OpenCode plugin", () => {
  assert.equal(packageJson.name, "@heyimteee/ensemble")
  assert.equal(packageJson.private, undefined, "a published package must not be private")
  assert.equal(packageJson.license, "MIT")
  assert.equal(packageJson.author, "heyimteee")
  assert.equal(packageJson.repository?.type, "git")
  assert.equal(packageJson.repository?.url, "git+https://github.com/heyimteee/ensemble.git")
  assert.equal(packageJson.homepage, "https://github.com/heyimteee/ensemble#readme")
  assert.equal(packageJson.bugs?.url, "https://github.com/heyimteee/ensemble/issues")
  assert.ok(Array.isArray(packageJson.keywords) && packageJson.keywords.length > 0)
  assert.equal(packageJson.publishConfig?.access, "public")
  assert.deepEqual(packageJson.exports, {
    ".": "./src/v2/server.ts",
    "./tui": "./src/v2/tui/index.tsx",
    "./rpc": "./src/v2/rpc.ts",
  })
  assert.equal(packageJson.engines?.node, ">=22.23.4")
  assert.equal(packageJson.peerDependencies?.["@opencode/plugin"], "2.2.6 || 2.2.7")
})

test("the shipped license is the MIT text", () => {
  const license = readFileSync(join(repoRoot, "LICENSE"), "utf8")
  assert.match(license, /^MIT License\n/)
  assert.match(license, /Permission is hereby granted, free of charge, to any person obtaining a copy/)
  assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/)
  assert.ok(packReport().files.some((file) => file.path === "LICENSE"))
})
