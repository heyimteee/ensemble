import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Ticket #269/#279: the published tarball is a runtime artifact. This suite
 * packs the package the way `npm publish` does (which runs the `prepack`
 * build) and asserts the contents are exactly the built import closure of the
 * public exports, so a stray test, fixture, doc, script, TypeScript source, or
 * development-only module cannot leak into a release.
 */
const repoRoot = fileURLToPath(new URL("../..", import.meta.url))
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"))

const ROOT_FILES = new Set(["package.json", "README.md", "LICENSE"])

/** The source entries behind the `.`, `./tui`, and `./rpc` exports. */
const SOURCE_ENTRIES = ["./src/v2/server.ts", "./src/v2/tui/index.tsx", "./src/v2/rpc.ts"]

const FORBIDDEN: ReadonlyArray<readonly [RegExp, string]> = [
  [/\.test\.jsx?$/, "test file"],
  [/\.(ts|tsx|mts|cts)$/, "TypeScript source"],
  [/(^|\/)fixtures\//, "fixture"],
  [/^(docs|scripts)\//, "docs or scripts"],
  [/(^|\/)(AGENTS|CONTRIBUTING|GLOSSARY|SECURITY)\.md$/, "repository document"],
  [/^(tsconfig\.json|tsconfig\.build\.json|package-lock\.json)$/, "development artifact"],
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

/** Resolve a relative TypeScript import the way the source graph uses it. */
function resolveModule(from: string, specifier: string, modules: ReadonlySet<string>): string | null {
  if (!specifier.startsWith(".")) return null
  const base = resolve(dirname(from), specifier)
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (modules.has(candidate)) return candidate
  }
  return null
}

/** Every source module loadable from the package's three public entries. */
function runtimeSourceModules(): Set<string> {
  const modules = new Set(sourceModules())
  const entries = SOURCE_ENTRIES.map((entry) => resolve(repoRoot, entry))
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
  return reached
}

/** The built paths the three exports must ship, derived from the source closure. */
function expectedBuiltPaths(): Set<string> {
  return new Set(
    [...runtimeSourceModules()].map((file) => {
      const sourcePath = relative(join(repoRoot, "src", "v2"), file).split(sep).join("/")
      return `dist/${sourcePath.replace(/\.tsx?$/, ".js")}`
    }),
  )
}

/**
 * The allowlist contract, independent of npm's glob engine: only the root
 * package documents and the built runtime closure may ship.
 */
function packedContentFailures(paths: readonly string[], expected: ReadonlySet<string>): string[] {
  const failures: string[] = []
  const packedBuilt = new Set<string>()
  for (const path of paths) {
    const forbidden = FORBIDDEN.find(([pattern]) => pattern.test(path))
    if (forbidden) {
      failures.push(`${path}: ${forbidden[1]} must not be packed`)
      continue
    }
    if (ROOT_FILES.has(path)) continue
    if (path.startsWith("dist/") && path.endsWith(".js")) {
      packedBuilt.add(path)
      continue
    }
    failures.push(`${path}: not an allowed package file`)
  }
  for (const path of [...expected].sort()) {
    if (!packedBuilt.has(path)) failures.push(`${path}: built runtime module is missing from the package`)
  }
  for (const path of [...packedBuilt].sort()) {
    if (!expected.has(path)) failures.push(`${path}: is not reachable from the package exports`)
  }
  return failures
}

function builtSources(): Map<string, string> {
  const dist = join(repoRoot, "dist")
  const sources = new Map<string, string>()
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const full = join(directory, name)
      if (statSync(full).isDirectory()) walk(full)
      else sources.set(relative(repoRoot, full).split(sep).join("/"), readFileSync(full, "utf8"))
    }
  }
  walk(dist)
  return sources
}

test("the tarball ships exactly the built runtime closure", () => {
  const report = packReport()
  const paths = report.files.map((file) => file.path).sort()
  assert.deepEqual(packedContentFailures(paths, expectedBuiltPaths()), [])
  for (const required of ["package.json", "README.md", "LICENSE"]) {
    assert.ok(paths.includes(required), `${required} ships`)
  }
  for (const entry of ["./dist/server.js", "./dist/tui/index.js", "./dist/rpc.js"]) {
    assert.ok(paths.includes(entry.slice(2)), `${entry} ships`)
  }
})

test("the content check rejects a leaked test, fixture, doc, script, source, or dev module", () => {
  const expected = new Set(["dist/server.js", "dist/tui/index.js", "dist/rpc.js"])
  const failures = packedContentFailures(
    [
      "package.json",
      "README.md",
      "LICENSE",
      "dist/server.js",
      "dist/tui/index.js",
      "dist/rpc.js",
      "dist/service.test.js",
      "dist/fixtures/native-host-contract.jsonl",
      "dist/tui/index.tsx",
      "src/v2/server.ts",
      "dist/doctor.js",
      "docs/implementation.md",
      "scripts/docs-check.mjs",
      "tsconfig.json",
      "tsconfig.build.json",
    ],
    expected,
  )
  assert.ok(failures.some((failure) => /service\.test\.js: test file/.test(failure)), failures.join("\n"))
  assert.ok(failures.some((failure) => /fixtures\/.*fixture/.test(failure)), failures.join("\n"))
  assert.ok(failures.some((failure) => /tui\/index\.tsx: TypeScript source/.test(failure)), failures.join("\n"))
  assert.ok(failures.some((failure) => /src\/v2\/server\.ts: TypeScript source/.test(failure)), failures.join("\n"))
  assert.ok(failures.some((failure) => /dist\/doctor\.js: is not reachable/.test(failure)), failures.join("\n"))
  assert.ok(failures.some((failure) => /^docs\/implementation\.md: docs or scripts/.test(failure)), failures.join("\n"))
  assert.ok(failures.some((failure) => /^scripts\/docs-check\.mjs: docs or scripts/.test(failure)), failures.join("\n"))
  assert.ok(failures.some((failure) => /tsconfig\.json: development artifact/.test(failure)), failures.join("\n"))
  assert.ok(failures.some((failure) => /tsconfig\.build\.json: development artifact/.test(failure)), failures.join("\n"))
})

test("the built entries are JavaScript for the Solid OpenTUI runtime", () => {
  packReport()
  const built = builtSources()
  assert.deepEqual(
    [...built.keys()].sort(),
    [...expectedBuiltPaths()].sort(),
    "the build emits exactly the runtime closure",
  )
  const tui = built.get("dist/tui/index.js")
  assert.ok(tui, "dist/tui/index.js exists")
  assert.match(tui, /from "@opentui\/solid"/)
  const allBuilt = [...built.values()].join("\n")
  assert.match(allBuilt, /from "solid-js"/, "the built TUI uses Solid's reactive runtime")
  assert.doesNotMatch(allBuilt, /["']react["']|react\/jsx/)
  for (const [path, source] of built) {
    if (!path.endsWith(".js")) continue
    for (const specifier of importSpecifiers(source)) {
      if (!specifier.startsWith(".")) continue
      assert.match(specifier, /\.js$/, `${path} keeps a JavaScript relative import: ${specifier}`)
    }
    assert.doesNotMatch(source, /\bfrom\s*["'][^"']+\.(ts|tsx)["']/, `${path} imports no TypeScript source`)
  }
})

test("the package identity is the scoped MIT OpenCode plugin", () => {
  assert.equal(packageJson.name, "@heyimteee/ensemble")
  assert.equal(packageJson.private, undefined, "a published package must not be private")
  assert.equal(packageJson.license, "MIT")
  assert.equal(packageJson.author, "heyimteee")
  assert.equal(packageJson.repository?.type, "git")
  assert.equal(packageJson.repository?.url, "git+https://github.com/heyimteee/ensemble.git")
  assert.equal(packageJson.homepage, "https://heyimteee.github.io/ensemble/")
  assert.equal(packageJson.bugs?.url, "https://github.com/heyimteee/ensemble/issues")
  assert.ok(Array.isArray(packageJson.keywords) && packageJson.keywords.length > 0)
  assert.equal(packageJson.publishConfig?.access, "public")
  assert.deepEqual(packageJson.exports, {
    ".": "./dist/server.js",
    "./tui": "./dist/tui/index.js",
    "./rpc": "./dist/rpc.js",
  })
  assert.deepEqual(packageJson.files, ["dist"])
  assert.ok(
    typeof packageJson.scripts?.build === "string" && packageJson.scripts.build.length > 0,
    "the package declares a build script",
  )
  assert.ok(
    /build/.test(packageJson.scripts?.prepack ?? ""),
    "prepack runs the build before a tarball is produced",
  )
  assert.equal(existsSync(join(repoRoot, "tsconfig.build.json")), true)
  assert.equal(packageJson.engines?.node, ">=22.23.4")
  assert.equal(packageJson.peerDependencies?.["@opencode/plugin"], "2.2.6 || 2.2.7 || 2.3.0")
  assert.deepEqual(Object.keys(packageJson.peerDependencies ?? {}), ["@opencode/plugin"])
  assert.deepEqual(packageJson.dependencies, {
    "@opentui/core": "0.7.0",
    "@opentui/solid": "0.7.0",
    "solid-js": "1.9.12",
  })
})

test("the shipped license is the MIT text", () => {
  const license = readFileSync(join(repoRoot, "LICENSE"), "utf8")
  assert.match(license, /^MIT License\n/)
  assert.match(license, /Permission is hereby granted, free of charge, to any person obtaining a copy/)
  assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/)
  assert.ok(packReport().files.some((file) => file.path === "LICENSE"))
})
