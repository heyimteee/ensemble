export interface BuiltSiteAnchorResult {
  failures: string[]
  pages: number
  links: number
  anchors: number
}

export function checkBuiltSiteAnchors(
  distDir: string,
  options?: { base?: string },
): BuiltSiteAnchorResult
