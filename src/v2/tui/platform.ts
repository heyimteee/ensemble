export function isMacPlatform(platform: string = process.platform): boolean {
  return platform === "darwin"
}

export function platformBind(bind: string, mac = isMacPlatform()): string {
  return mac ? bind.replace(/^ctrl\+/, "super+") : bind
}

export function platformLabel(label: string, mac = isMacPlatform()): string {
  return mac ? label.replace(/ctrl/gi, "Cmd") : label
}

export function navModifier(mac = isMacPlatform()): string {
  return mac ? "Cmd" : "Ctrl"
}
