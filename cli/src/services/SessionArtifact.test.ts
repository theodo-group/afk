import { describe, expect, it } from "bun:test"
import {
  collectionBases,
  globBaseDir,
  selectArtifacts,
} from "./SessionArtifact.ts"

describe("globBaseDir", () => {
  it("stops at the first glob segment", () => {
    expect(globBaseDir("/root/.claude/projects/**/*.jsonl")).toBe(
      "/root/.claude/projects",
    )
  })

  it("returns the containing dir of a fully-literal file path", () => {
    expect(globBaseDir("/root/.claude/session.jsonl")).toBe("/root/.claude")
  })

  it("treats a leading glob as root", () => {
    expect(globBaseDir("**/*.json")).toBe("/")
  })

  it("handles a single-star filename glob", () => {
    expect(globBaseDir("/var/log/*.log")).toBe("/var/log")
  })
})

describe("collectionBases", () => {
  it("dedupes patterns sharing a base", () => {
    expect(
      collectionBases([
        "/root/.claude/projects/**/*.jsonl",
        "/root/.claude/projects/**/meta.json",
      ]),
    ).toEqual(["/root/.claude/projects"])
  })

  it("drops a base nested under another", () => {
    expect(
      collectionBases(["/root/.claude/**/*", "/root/.claude/projects/*.jsonl"]),
    ).toEqual(["/root/.claude"])
  })

  it("keeps distinct sibling bases", () => {
    expect(
      [...collectionBases(["/a/logs/*.log", "/b/out/*.json"])].sort(),
    ).toEqual(["/a/logs", "/b/out"])
  })
})

describe("selectArtifacts", () => {
  const cap = 1000
  const entries = [
    { path: "/root/.claude/projects/p/a.jsonl", size: 10 },
    { path: "/root/.claude/projects/p/q/b.jsonl", size: 999 },
    { path: "/root/.claude/projects/p/big.jsonl", size: 5000 },
    { path: "/root/.claude/projects/p/notes.txt", size: 5 },
  ]

  it("matches across path separators with ** and keeps within-cap files", () => {
    const { selected } = selectArtifacts(
      entries,
      ["/root/.claude/projects/**/*.jsonl"],
      cap,
    )
    expect(selected.map((e) => e.path)).toEqual([
      "/root/.claude/projects/p/a.jsonl",
      "/root/.claude/projects/p/q/b.jsonl",
    ])
  })

  it("reports oversized matches as skipped, never selected", () => {
    const { selected, skipped } = selectArtifacts(
      entries,
      ["/root/.claude/projects/**/*.jsonl"],
      cap,
    )
    expect(selected.some((e) => e.path.endsWith("big.jsonl"))).toBe(false)
    expect(skipped.map((e) => e.path)).toEqual([
      "/root/.claude/projects/p/big.jsonl",
    ])
  })

  it("excludes files matching no pattern", () => {
    const { selected, skipped } = selectArtifacts(
      entries,
      ["/root/.claude/projects/**/*.jsonl"],
      cap,
    )
    const all = [...selected, ...skipped].map((e) => e.path)
    expect(all).not.toContain("/root/.claude/projects/p/notes.txt")
  })
})
