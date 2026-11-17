export function anchorsFromRenderedHtml(html: string): Set<string>
export function createRenderedAnchorResolver(
  srcDir: string,
): Promise<(markdown: string) => Set<string>>
