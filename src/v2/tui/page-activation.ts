/**
 * v5.6 T11: raw-key ownership for stacked plugin pages.
 *
 * The host keeps an earlier Ensemble page mounted when navigation pushes a
 * new page. Its renderer key listener therefore stays registered and would
 * consume keys (notably `:`) before the visible page sees them. Track the
 * mount order here and let only the newest page handle raw keys.
 */

export type PageToken = object

export type PageActivation = {
  mount(token: PageToken): void
  unmount(token: PageToken): void
  isActive(token: PageToken): boolean
  /**
   * Raw keys belong to a page only while it is the newest mount AND the
   * Ensemble route is visible. A page left mounted behind a native route must
   * never consume the native prompt's keys.
   */
  ownsRawKeys(token: PageToken, routeActive: boolean): boolean
}

export function createPageActivation(): PageActivation {
  const stack: PageToken[] = []
  return {
    mount(token) {
      if (!stack.includes(token)) stack.push(token)
    },
    unmount(token) {
      const index = stack.lastIndexOf(token)
      if (index !== -1) stack.splice(index, 1)
    },
    isActive(token) {
      return stack.length > 0 && stack[stack.length - 1] === token
    },
    ownsRawKeys(token, routeActive) {
      return routeActive && stack.length > 0 && stack[stack.length - 1] === token
    },
  }
}
