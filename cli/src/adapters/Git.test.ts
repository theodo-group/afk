import { describe, expect, it } from "bun:test"
import { changedPaths } from "./Git.ts"

describe("changedPaths — git status --porcelain", () => {
  it("returns nothing for a clean scope", () => {
    expect(changedPaths("")).toEqual([])
    expect(changedPaths("\n")).toEqual([])
  })

  it("names modified, staged and untracked paths alike", () => {
    const out = [
      " M afk.Dockerfile",
      "A  afk.compose.yml",
      "?? afk.config.json",
      "",
    ].join("\n")
    expect(changedPaths(out)).toEqual([
      "afk.Dockerfile",
      "afk.compose.yml",
      "afk.config.json",
    ])
  })

  it("keeps the new name of a rename", () => {
    expect(changedPaths("R  afk.compose.yaml -> afk.compose.yml\n")).toEqual([
      "afk.compose.yml",
    ])
  })
})
