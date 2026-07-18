import { describe, it, expect } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { patchWranglerToml } from "./CfToml.ts"

const tomlWith = (instanceTypeLine: string): string =>
  [
    `[[containers]]`,
    `class_name = "RunContainer"`,
    `max_instances = 200`,
    instanceTypeLine,
    ``,
  ].join("\n")

const writeTemp = (content: string): string => {
  const path = join(mkdtempSync(join(tmpdir(), "afk-cftoml-")), "wrangler.toml")
  writeFileSync(path, content)
  return path
}

describe("patchWranglerToml instanceType", () => {
  it("patches a named tier over a named tier", () => {
    const path = writeTemp(tomlWith(`instance_type = "standard-1"`))
    patchWranglerToml(path, { instanceType: "standard-4" })
    expect(readFileSync(path, "utf8")).toContain(`instance_type = "standard-4"`)
  })

  it("renders a custom spec as an inline table", () => {
    const path = writeTemp(tomlWith(`instance_type = "standard-1"`))
    patchWranglerToml(path, {
      instanceType: { vcpu: 2, memoryMib: 8192, diskMb: 16000 },
    })
    expect(readFileSync(path, "utf8")).toContain(
      `instance_type = { vcpu = 2, memory_mib = 8192, disk_mb = 16000 }`,
    )
  })

  it("omits disk_mb when the spec has none", () => {
    const path = writeTemp(tomlWith(`instance_type = "standard-1"`))
    patchWranglerToml(path, { instanceType: { vcpu: 4, memoryMib: 12288 } })
    expect(readFileSync(path, "utf8")).toContain(
      `instance_type = { vcpu = 4, memory_mib = 12288 }`,
    )
  })

  it("re-patches over a previously-written inline table (idempotent form change)", () => {
    const path = writeTemp(
      tomlWith(`instance_type = { vcpu = 2, memory_mib = 8192 }`),
    )
    patchWranglerToml(path, { instanceType: "basic" })
    const out = readFileSync(path, "utf8")
    expect(out).toContain(`instance_type = "basic"`)
    expect(out).not.toContain("memory_mib")
  })
})
