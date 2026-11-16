import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Ticket #270: the clean-install check trusts this registry to expose the
 * packed candidate exactly as npm expects. The tarball route is the seam the
 * installer's integrity check depends on, so it must return the packed bytes,
 * not the packument.
 */
const registryScript = fileURLToPath(new URL("../../scripts/lib/local-npm-registry.mjs", import.meta.url))

async function waitForUrl(path: string, child: ReturnType<typeof spawn>): Promise<string> {
  const end = Date.now() + 5000
  while (Date.now() < end) {
    try {
      const value = (await readFile(path, "utf8")).trim()
      if (value) return value
    } catch {}
    if (child.exitCode !== null) throw new Error(`registry exited with code ${child.exitCode}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("registry did not write its URL")
}

test("ticket270: the local npm registry serves the packed candidate and its tarball", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ensemble-registry-"))
  const manifestPath = join(directory, "package.json")
  const tarballPath = join(directory, "candidate.tgz")
  const urlPath = join(directory, "registry-url")
  const tarball = Buffer.from("packed release candidate bytes")
  await writeFile(manifestPath, JSON.stringify({
    name: "@heyimteee/ensemble",
    version: "9.9.9-rc.1",
    license: "MIT",
  }))
  await writeFile(tarballPath, tarball)
  const child = spawn(process.execPath, [
    registryScript,
    "--manifest", manifestPath,
    "--tarball", tarballPath,
    "--url-file", urlPath,
  ], { stdio: ["ignore", "ignore", "pipe"] })
  t.after(async () => {
    child.kill()
    await rm(directory, { recursive: true, force: true })
  })

  const registry = (await waitForUrl(urlPath, child)).trim()
  const packumentResponse = await fetch(new URL("@heyimteee%2fensemble", registry))
  assert.equal(packumentResponse.status, 200)
  const packument = await packumentResponse.json() as any
  assert.equal(packument.name, "@heyimteee/ensemble")
  assert.equal(packument["dist-tags"].latest, "9.9.9-rc.1")
  const version = packument.versions["9.9.9-rc.1"]
  assert.equal(version.name, "@heyimteee/ensemble")
  assert.equal(version.version, "9.9.9-rc.1")
  assert.match(version.dist.integrity, /^sha512-/)
  assert.match(version.dist.shasum, /^[0-9a-f]{40}$/)

  const tarballResponse = await fetch(version.dist.tarball)
  assert.equal(tarballResponse.status, 200)
  assert.deepEqual(Buffer.from(await tarballResponse.arrayBuffer()), tarball)

  const missing = await fetch(new URL("missing", registry))
  assert.equal(missing.status, 404)
})
