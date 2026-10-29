import { randomUUID } from "node:crypto"

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 20)}`
}

export function now(): number {
  return Date.now()
}
