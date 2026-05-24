import { expect, test } from "bun:test"
import { isExpired, retainedUntilIso } from "./retention.ts"

const FINISHED = "2026-05-01T00:00:00.000Z"
const finishedMs = Date.parse(FINISHED)
const DAY = 86_400_000

test("retainedUntilIso adds exactly retentionDays", () => {
  expect(retainedUntilIso(FINISHED, 7)).toBe("2026-05-08T00:00:00.000Z")
  expect(retainedUntilIso(FINISHED, 0)).toBe(FINISHED)
})

test("isExpired is false just before the window closes", () => {
  expect(isExpired(FINISHED, finishedMs + 7 * DAY - 1, 7)).toBe(false)
})

test("isExpired is false exactly at the boundary (strict >)", () => {
  expect(isExpired(FINISHED, finishedMs + 7 * DAY, 7)).toBe(false)
})

test("isExpired is true just after the window closes", () => {
  expect(isExpired(FINISHED, finishedMs + 7 * DAY + 1, 7)).toBe(true)
})

test("retentionDays of 0 expires immediately after finish", () => {
  expect(isExpired(FINISHED, finishedMs, 0)).toBe(false)
  expect(isExpired(FINISHED, finishedMs + 1, 0)).toBe(true)
})
