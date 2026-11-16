#!/usr/bin/env node
// Read-only local npm registry for the release-candidate install check.
//
// `opencode plugin add` accepts npm names, versions, and Git specs, but not a
// tarball path. This server exposes one already-packed tarball as a real npm
// package so the installer exercises its normal registry path without a public
// publish or credentials. It binds loopback only and serves one package.
//
// Usage:
//   node scripts/lib/local-npm-registry.mjs \
//     --manifest package.json --tarball /tmp/pkg.tgz --url-file /tmp/registry-url
//
// The URL file is written after the server starts listening. The parent shell
// owns the process lifecycle.

import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"

function argValue(name, required = true) {
  const index = process.argv.indexOf(`--${name}`)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (!value && required) {
    console.error(`local-registry: missing --${name}`)
    process.exit(2)
  }
  return value
}

const manifestPath = argValue("manifest")
const tarballPath = argValue("tarball")
const urlFile = argValue("url-file")
const port = Number(argValue("port", false) ?? "0")

let manifest
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
} catch (error) {
  console.error(`local-registry: cannot read manifest: ${error.message}`)
  process.exit(2)
}

const name = manifest.name
const version = manifest.version
if (typeof name !== "string" || !name || typeof version !== "string" || !version) {
  console.error("local-registry: manifest must declare name and version")
  process.exit(2)
}

let tarball
try {
  tarball = readFileSync(tarballPath)
} catch (error) {
  console.error(`local-registry: cannot read tarball: ${error.message}`)
  process.exit(2)
}

const shasum = createHash("sha1").update(tarball).digest("hex")
const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`
const basename = `${name.split("/").pop()}-${version}.tgz`
const tarballRoute = `/${name}/-/${basename}`
const routes = new Set([`/${name}`])
const encodedRoutes = new Set([`/${encodeURIComponent(name)}`])

function requestPath(request) {
  return decodeURIComponent((request.url ?? "/").split("?")[0])
}

function packument(origin) {
  return JSON.stringify({
    name,
    "dist-tags": { latest: version, next: version },
    versions: {
      [version]: {
        name,
        version,
        license: manifest.license,
        ...(manifest.dependencies ? { dependencies: manifest.dependencies } : {}),
        ...(manifest.peerDependencies ? { peerDependencies: manifest.peerDependencies } : {}),
        ...(manifest.peerDependenciesMeta ? { peerDependenciesMeta: manifest.peerDependenciesMeta } : {}),
        ...(manifest.optionalDependencies ? { optionalDependencies: manifest.optionalDependencies } : {}),
        ...(manifest.engines ? { engines: manifest.engines } : {}),
        dist: {
          tarball: `${origin}${tarballRoute}`,
          shasum,
          integrity,
        },
      },
    },
  })
}

const server = createServer((request, response) => {
  const path = requestPath(request)
  const origin = `http://127.0.0.1:${server.address().port}`
  if (path === "/-/ping") {
    response.setHeader("content-type", "application/json")
    response.end("{}")
    return
  }
  if (routes.has(path) || encodedRoutes.has(path)) {
    const body = packument(origin)
    response.setHeader("content-type", "application/json")
    response.setHeader("content-length", Buffer.byteLength(body))
    if (request.method === "HEAD") response.end()
    else response.end(body)
    return
  }
  if (path === tarballRoute || encodedRoutes.has(path)) {
    response.setHeader("content-type", "application/octet-stream")
    response.setHeader("content-length", tarball.length)
    if (request.method === "HEAD") response.end()
    else response.end(tarball)
    return
  }
  response.statusCode = 404
  response.end("not found")
})

server.listen(port, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${server.address().port}/`
  writeFileSync(urlFile, `${url}\n`)
  console.log(`local-registry: ${name}@${version} at ${url}`)
})
