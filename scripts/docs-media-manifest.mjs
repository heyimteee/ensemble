#!/usr/bin/env node
/**
 * Write the committed documentation-media manifest (ticket #309).
 *
 * The manifest records the generated file hashes and dimensions so the docs
 * check can detect a stale or hand-edited screenshot without rerunning the
 * isolated TUI capture. It also fails the generation run if the cast contains a
 * path or fixture marker that must never reach a public asset.
 *
 * Usage:
 *   node scripts/docs-media-manifest.mjs --media docs/public/media
 */
import { createHash } from "node:crypto"
import { readFileSync, statSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { privateIdentity } from "./lib/privacy.mjs"

const ASSETS = [
  { file: "workspace-shell.png", kind: "screenshot" },
  { file: "work-active.png", kind: "screenshot" },
  { file: "work-history.png", kind: "screenshot" },
  { file: "approvals.png", kind: "screenshot" },
  { file: "settings.png", kind: "screenshot" },
  { file: "native-session.png", kind: "screenshot" },
]

const FORBIDDEN = [
  "/home/",
  "/Users/",
  "/tmp/opencode/",
  ...privateIdentity().markers,
  "fake-rich-fixture",
  "RICH_CODE_MARKER",
  "QUEUE_HOLD_MARKER",
  "fake-ask-person",
  "LIVE_PROJECT",
]

function arg(name, fallback = "") {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : fallback
}

const mediaDir = resolve(arg("--media", "docs/public/media"))

function pngSize(buffer) {
  if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG") {
    throw new Error("not a PNG file")
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

function castInfo(file) {
  const text = readFileSync(file, "utf8")
  for (const marker of FORBIDDEN) {
    if (text.includes(marker)) {
      throw new Error(`${file}: forbidden string ${JSON.stringify(marker)}`)
    }
  }
  const [headerLine] = text.split("\n")
  const header = JSON.parse(headerLine)
  if (header.version !== 2) throw new Error(`${file}: not an asciinema v2 cast`)
  return { width: header.width, height: header.height, events: text.trim().split("\n").length - 1 }
}

const manifest = {
  schema: "ensemble.docs-media",
  version: 1,
  synthetic: true,
  generator: "scripts/docs-media.sh",
  capture: {
    host: "OpenCode 2.3.0 with the local fake provider",
    terminal: "tmux 140x40, ENSEMBLE_REDUCED_MOTION=1",
    workspace: "synthetic Acme Notes fixture",
    source: "isolated HOME, XDG config/data/state, and project under a temporary directory",
    redaction: "the temporary project path is rendered as ~/dev/acme-notes",
    replay: "scripted asciinema v2 replay of captured frames; the install command is illustrative",
  },
  assets: {},
}

for (const asset of ASSETS) {
  const file = join(mediaDir, asset.file)
  const buffer = readFileSync(file)
  const { width, height } = pngSize(buffer)
  manifest.assets[asset.file] = {
    kind: asset.kind,
    bytes: statSync(file).size,
    width,
    height,
    sha256: createHash("sha256").update(buffer).digest("hex"),
  }
}

const castFile = join(mediaDir, "hero-terminal.cast")
const castBuffer = readFileSync(castFile)
const cast = castInfo(castFile)
manifest.assets["hero-terminal.cast"] = {
  kind: "cast",
  bytes: statSync(castFile).size,
  width: cast.width,
  height: cast.height,
  events: cast.events,
  sha256: createHash("sha256").update(castBuffer).digest("hex"),
}

writeFileSync(join(mediaDir, "MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`docs-media-manifest: ${Object.keys(manifest.assets).length} assets`)
