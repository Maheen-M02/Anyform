import { randomBytes } from 'node:crypto'

export type IdPrefix = 'upl' | 'job' | 'out'

const ID_PATTERN = /^(upl|job|out)_[A-Za-z0-9_-]{22}$/

/** 128-bit random, URL-safe identifier with a type prefix. */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomBytes(16).toString('base64url')}`
}

export function isId(value: unknown, prefix?: IdPrefix): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value) && (!prefix || value.startsWith(`${prefix}_`))
}
