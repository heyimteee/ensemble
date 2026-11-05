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
