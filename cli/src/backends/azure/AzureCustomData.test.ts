import { describe, expect, it } from "bun:test"
import {
  buildAzureCustomData,
  type AzureCustomDataInput,
} from "./AzureCustomData.ts"

const base: AzureCustomDataInput = {
  runId: "r1",
  mainService: "agent",
  image: "afkabc.azurecr.io/afk/widget:abc",
  command: ["claude", "go"],
  timeoutSeconds: 3600,
  retain: false,
  env: [{ name: "A", value: "it's" }],
  secretEnvNames: [],
  registry: "afkabc",
  keyVault: "afk-abc",
  storageAccount: "afkabc",
  sessionArtifactBases: [],
  sessionArtifactPrefix: "widget/r1/session-artifacts/",
  sessionArtifactMaxBytes: 1000,
}

describe("buildAzureCustomData", () => {
  it("arms a backstop past the Run timeout", () => {
    expect(buildAzureCustomData(base)).toContain(
      "systemd-run --unit=afk-backstop --on-active=4200s",
    )
  })

  it("shell-quotes env values", () => {
    expect(buildAzureCustomData(base)).toContain(`'it'\\''s'`)
  })

  it("records completion before reclaiming, and ships logs to the end", () => {
    const script = buildAzureCustomData(base)
    const shipped = script.indexOf('wait "$AFK_SHIPPER"')
    const recorded = script.indexOf("az storage entity merge")
    const reclaimed = script.lastIndexOf("'/etc/afk/reclaim.sh'")
    expect(shipped).toBeGreaterThan(0)
    expect(recorded).toBeGreaterThan(shipped)
    expect(reclaimed).toBeGreaterThan(recorded)
  })

  it("never --rm's the container the shipper still has to read", () => {
    expect(buildAzureCustomData(base)).not.toContain("--rm")
  })

  it("keeps a retained Run's containers", () => {
    const script = buildAzureCustomData({ ...base, retain: true })
    expect(script).not.toContain("docker rm -f")
    expect(script).toContain("afk-stopped-at=")
  })

  it("uploads Session Artifacts when declared", () => {
    const script = buildAzureCustomData({
      ...base,
      sessionArtifactBases: ["/root/.claude/projects"],
    })
    expect(script).toContain("az storage blob upload-batch")
    expect(script).toContain("--destination-path 'widget/r1/session-artifacts'")
  })
})
