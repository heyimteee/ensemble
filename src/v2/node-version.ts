/**
 * Ticket #258: the Node support floor is evidence-based.
 *
 * `MINIMUM_NODE_VERSION` is the oldest release that passed `npm run verify`
 * on the 22 line; `TESTED_NODE_LINES` is the tested set recorded in the
 * README and the Node matrix workflow. Keep all three in sync with
 * `package.json` `engines.node`.
 */
export const MINIMUM_NODE_VERSION = "22.23.4"
export const TESTED_NODE_LINES = "22.23.4, 24.x, and 26.x"

export type ParsedNodeVersion = { major: number; minor: number; patch: number }

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)/

/** Parse a `process.versions.node` value; pre-release and build suffixes are ignored. */
export function parseNodeVersion(value: string): ParsedNodeVersion | null {
  const match = VERSION_PATTERN.exec(value.trim())
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

function compareVersions(left: ParsedNodeVersion, right: ParsedNodeVersion): number {
  if (left.major !== right.major) return left.major - right.major
  if (left.minor !== right.minor) return left.minor - right.minor
  return left.patch - right.patch
}

/** True when the runtime is at or above the verified floor. */
export function isSupportedNodeVersion(value: string): boolean {
  const actual = parseNodeVersion(value)
  const minimum = parseNodeVersion(MINIMUM_NODE_VERSION)
  if (!actual || !minimum) return false
  return compareVersions(actual, minimum) >= 0
}

export class NodeVersionError extends Error {
  readonly code = "unsupported_node"
  readonly version: string

  constructor(version: string) {
    super(
      `Ensemble requires Node >=${MINIMUM_NODE_VERSION} (tested lines: ${TESTED_NODE_LINES}); ` +
        `this process is running Node ${version}. Upgrade Node and restart OpenCode.`,
    )
    this.name = "NodeVersionError"
    this.version = version
  }
}

/**
 * Fail at plugin load with actionable copy instead of a downstream syntax or
 * API error. Call from every runtime entry point before host work starts.
 */
export function assertSupportedNode(version: string = process.versions.node): void {
  if (!isSupportedNodeVersion(version)) throw new NodeVersionError(version)
}
