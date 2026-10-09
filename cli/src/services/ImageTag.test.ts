import { describe, it, expect } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CONTENT_TAG_PREFIX,
  UnhashableSourceError,
  contentTag,
  copySources,
} from "./ImageTag.ts"

describe("copySources", () => {
  it("lists local COPY and ADD sources, not the destination", () => {
    expect(
      copySources("FROM node\nCOPY bin/a.sh /tmp/a.sh\nADD x y /dst/\n"),
    ).toEqual(["bin/a.sh", "x", "y"])
  })

  it("skips flags, --from copies and remote ADD", () => {
    const df = [
      "COPY --chown=1000:1000 --chmod=755 bin/a.sh /a",
      "COPY --from=builder /out /out",
      "ADD https://example.com/f.tgz /f.tgz",
    ].join("\n")
    expect(copySources(df)).toEqual(["bin/a.sh"])
  })

  it("reads the JSON form and backslash-continued lines", () => {
    expect(copySources('COPY ["a b", "/dst"]')).toEqual(["a b"])
    expect(copySources("COPY a \\\n  b /dst")).toEqual(["a", "b"])
  })

  it("refuses globs and variables", () => {
    expect(() => copySources("COPY *.sh /dst")).toThrow(UnhashableSourceError)
    expect(() => copySources("COPY $SRC /dst")).toThrow(UnhashableSourceError)
  })
})

describe("contentTag", () => {
  const ctx = () => {
    const dir = mkdtempSync(join(tmpdir(), "afk-tag-"))
    mkdirSync(join(dir, "bin"))
    writeFileSync(join(dir, "bin", "a.sh"), "echo a\n")
    writeFileSync(join(dir, "unrelated.txt"), "x")
    return dir
  }
  const base = {
    dockerfile: "FROM node\nCOPY bin /bin\n",
    entrypoint: "#!/bin/sh\n",
    platform: "linux/amd64",
  }

  it("is stable and prefixed", () => {
    const dir = ctx()
    const t = contentTag({ ...base, contextDir: dir })
    expect(t.startsWith(CONTENT_TAG_PREFIX)).toBe(true)
    expect(t).toBe(contentTag({ ...base, contextDir: dir }))
    expect(t).toMatch(/^c-[0-9a-f]{16}$/)
  })

  it("ignores files the Dockerfile does not copy", () => {
    const dir = ctx()
    const before = contentTag({ ...base, contextDir: dir })
    writeFileSync(join(dir, "unrelated.txt"), "changed")
    expect(contentTag({ ...base, contextDir: dir })).toBe(before)
  })

  it("changes with the Dockerfile, the entrypoint, the platform and a copied file", () => {
    const dir = ctx()
    const before = contentTag({ ...base, contextDir: dir })
    expect(
      contentTag({
        ...base,
        contextDir: dir,
        dockerfile: `${base.dockerfile}RUN true\n`,
      }),
    ).not.toBe(before)
    expect(
      contentTag({ ...base, contextDir: dir, entrypoint: "#!/bin/bash\n" }),
    ).not.toBe(before)
    expect(
      contentTag({ ...base, contextDir: dir, platform: "linux/arm64" }),
    ).not.toBe(before)
    writeFileSync(join(dir, "bin", "a.sh"), "echo b\n")
    expect(contentTag({ ...base, contextDir: dir })).not.toBe(before)
  })

  it("refuses a source missing from the context", () => {
    expect(() =>
      contentTag({ ...base, contextDir: ctx(), dockerfile: "COPY nope /x" }),
    ).toThrow(UnhashableSourceError)
  })
})
