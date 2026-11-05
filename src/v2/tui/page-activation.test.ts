import test from "node:test"
import assert from "node:assert/strict"
import { createPageActivation } from "./page-activation.ts"

test("the newest mounted page owns raw keys", () => {
  const pages = createPageActivation()
  const first = {}
  const second = {}
  pages.mount(first)
  assert.equal(pages.isActive(first), true)
  pages.mount(second)
  assert.equal(pages.isActive(first), false)
  assert.equal(pages.isActive(second), true)
})

test("an inactive route never consumes a raw key", () => {
  const pages = createPageActivation()
  const page = {}
  pages.mount(page)
  assert.equal(pages.ownsRawKeys(page, true), true, "the active route on the newest page owns keys")
  assert.equal(pages.ownsRawKeys(page, false), false, "a hidden Ensemble page never consumes a native key")
})

test("only the newest page on the active route owns raw keys", () => {
  const pages = createPageActivation()
  const first = {}
  const second = {}
  pages.mount(first)
  pages.mount(second)
  assert.equal(pages.ownsRawKeys(first, true), false, "a stale stacked page never consumes a key")
  assert.equal(pages.ownsRawKeys(second, true), true)
})

test("unmounting the top page reactivates the page beneath", () => {
  const pages = createPageActivation()
  const first = {}
  const second = {}
  pages.mount(first)
  pages.mount(second)
  pages.unmount(second)
  assert.equal(pages.isActive(second), false)
  assert.equal(pages.isActive(first), true)
})

test("mount and unmount are idempotent and ignore unknown tokens", () => {
  const pages = createPageActivation()
  const only = {}
  pages.mount(only)
  pages.mount(only)
  pages.unmount({})
  assert.equal(pages.isActive(only), true)
  pages.unmount(only)
  pages.unmount(only)
  assert.equal(pages.isActive(only), false)
})
