import { describe, it, expect } from "bun:test"
import { Either } from "effect"
import { resolveRunByIdPrefix } from "./RunIdPrefix.ts"
import type { Run } from "../schema/Run.ts"

const mkRun = (id: string): Run =>
  ({
    runId: id as Run["runId"],
    resourceId: `i-${id}`,
    status: "RUNNING",
    owner: "u-1",
    branch: "main",
    sha: "deadbeef",
    image: "img",
    backend: "aws",
  }) as Run

const runs: ReadonlyArray<Run> = [
  mkRun("295f1be2-2028-4a8a-bb21-d98b9e3f06cb"),
  mkRun("ab12cd34-7777-1111-2222-333344445555"),
  mkRun("ab12ef56-9999-1111-2222-333344445555"),
]

describe("resolveRunByIdPrefix", () => {
  it("resolves an unambiguous prefix", () => {
    const r = resolveRunByIdPrefix("295f1be2", runs)
    expect(Either.isRight(r)).toBe(true)
    if (Either.isRight(r)) {
      expect(String(r.right.runId)).toBe("295f1be2-2028-4a8a-bb21-d98b9e3f06cb")
    }
  })

  it("resolves an exact id", () => {
    const full = "ab12cd34-7777-1111-2222-333344445555"
    const r = resolveRunByIdPrefix(full, runs)
    expect(Either.isRight(r)).toBe(true)
    if (Either.isRight(r)) expect(String(r.right.runId)).toBe(full)
  })

  it("fails with not-found when nothing matches", () => {
    const r = resolveRunByIdPrefix("zzzzzz", runs)
    expect(Either.isLeft(r)).toBe(true)
    if (Either.isLeft(r)) {
      expect(r.left._tag).toBe("UserError")
      expect(r.left.message).toContain("not found")
    }
  })

  it("fails with an ambiguous prefix listing candidates", () => {
    const r = resolveRunByIdPrefix("ab12", runs)
    expect(Either.isLeft(r)).toBe(true)
    if (Either.isLeft(r)) {
      expect(r.left._tag).toBe("UserError")
      expect(r.left.message).toContain("ambiguous")
      expect(r.left.hint ?? "").toContain("ab12cd34")
      expect(r.left.hint ?? "").toContain("ab12ef56")
    }
  })

  it("prefers an exact id match over a prefix that would otherwise be ambiguous", () => {
    const shadowed: ReadonlyArray<Run> = [
      mkRun("abc"),
      mkRun("abcdef-1111-2222-3333-444455556666"),
    ]
    const r = resolveRunByIdPrefix("abc", shadowed)
    expect(Either.isRight(r)).toBe(true)
    if (Either.isRight(r)) expect(String(r.right.runId)).toBe("abc")
  })
})
