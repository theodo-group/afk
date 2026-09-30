import { describe, expect, it } from "bun:test"
import { gunzipSync } from "node:zlib"
import {
  buildUserData,
  encodeUserData,
  USER_DATA_MAX_BASE64_BYTES,
  type UserDataInput,
} from "./UserData.ts"

const base: UserDataInput = {
  runId: "run-123",
  region: "eu-west-1",
  accountId: "111122223333",
  repoName: "demo",
  mainService: "agent",
  image: "111122223333.dkr.ecr.eu-west-1.amazonaws.com/afk/demo:main-abc",
  command: ["claude", "-p", "fix it"],
  timeoutSeconds: 3600,
  env: [],
  secrets: [],
  sessionArtifactBases: [],
  sessionArtifactBucket: "afk-artifacts-111122223333-eu-west-1",
  sessionArtifactMaxBytes: 25 * 1024 * 1024,
  runsTable: "afk-runs",
}

describe("buildUserData — Session Artifact collection", () => {
  it("omits the collection block and never uses --rm (container retained for post-mortem)", () => {
    const ud = buildUserData(base)
    expect(ud).not.toContain("Collect Session Artifacts")
    // The exited container must survive the instance stop for post-mortem attach.
    expect(ud).not.toContain("docker run --rm")
    expect(ud).toContain("docker run \\")
  })

  it("emits collection on the no-compose path and never removes the container", () => {
    const ud = buildUserData({
      ...base,
      sessionArtifactBases: ["/root/.claude/projects"],
    })
    expect(ud).toContain("Collect Session Artifacts")
    expect(ud).not.toContain("docker run --rm")
    expect(ud).toContain('docker cp "$AFK_CREF:$base"')
    expect(ud).toContain(
      "s3://afk-artifacts-111122223333-eu-west-1/demo/run-123/session-artifacts/",
    )
    expect(ud).toContain(`-size +${25 * 1024 * 1024}c`)
    // container is reclaimed with the instance, not torn down here
    expect(ud).not.toContain("docker rm -f")
  })

  it("collects from the compose main container and never tears the stack down", () => {
    const ud = buildUserData({
      ...base,
      compose: "services:\n  agent:\n    image: x\n",
      sessionArtifactBases: ["/root/.claude/projects"],
    })
    expect(ud).toContain("Collect Session Artifacts")
    expect(ud).toContain("ps -aq 'agent'")
    // stack must survive the instance stop for post-mortem attach
    expect(ud).not.toContain("down -v --remove-orphans")
  })
})

describe("buildUserData — completion write", () => {
  it("records the exit code on the Run's own history row", () => {
    const ud = buildUserData(base)
    expect(ud).toContain("dynamodb update-item")
    expect(ud).toContain("--table-name 'afk-runs'")
    expect(ud).toContain('--key \'{"run_id":{"S":"run-123"}}\'')
    expect(ud).toContain("SET #s = :s, stopped_at = :t, #e = :e")
    expect(ud).toContain('{"#s":"status","#e":"exit_code"}')
    expect(ud).toContain('{"N":"$RUN_EXIT"}')
  })

  it("names the table the active resource prefix resolves to", () => {
    const ud = buildUserData({ ...base, runsTable: "acme-runs" })
    expect(ud).toContain("--table-name 'acme-runs'")
    expect(ud).not.toContain("afk-runs")
  })

  it("derives the status from the exit code, matching recordComplete", () => {
    const ud = buildUserData(base)
    expect(ud).toContain(
      'if [ "$RUN_EXIT" = 0 ]; then AFK_RUN_STATUS=stopped; else AFK_RUN_STATUS=failed; fi',
    )
  })

  it("yields to whoever wrote the row first, as the sweeper does", () => {
    const ud = buildUserData(base)
    expect(ud).toContain("--condition-expression '#s = :running'")
  })

  it("runs after the workload, before shutdown, with `set -e` still off", () => {
    const ud = buildUserData(base)
    const exitCaptured = ud.indexOf("RUN_EXIT=$?")
    const write = ud.indexOf("dynamodb update-item")
    const setE = ud.indexOf("\nset -e")
    const shutdown = ud.indexOf("shutdown -h now")
    expect(exitCaptured).toBeGreaterThan(-1)
    expect(write).toBeGreaterThan(exitCaptured)
    // Inside the `set +e` region: a failed write must not abort the script
    // before it reaches `shutdown`, whatever its own `||` guard catches.
    expect(setE).toBeGreaterThan(write)
    expect(shutdown).toBeGreaterThan(setE)
  })

  it("cannot fail the script: every branch ends in an echo", () => {
    const ud = buildUserData(base)
    expect(ud).toContain('|| echo "afk-userdata: run history write failed')
  })

  it("is emitted on the compose path too", () => {
    const ud = buildUserData({
      ...base,
      compose: "services:\n  agent:\n    image: x\n",
    })
    expect(ud).toContain("dynamodb update-item")
    expect(ud.indexOf("dynamodb update-item")).toBeGreaterThan(
      ud.indexOf("--exit-code-from"),
    )
  })
})

describe("encodeUserData", () => {
  it("gzips before base64 so the payload fits EC2's ceiling", () => {
    // A compose-sized script: repetitive YAML is exactly what compresses well.
    const script =
      "#!/bin/bash\n" + "services:\n  db:\n    image: mysql:8.0\n".repeat(400)
    const encoded = encodeUserData(script)
    const plain = Buffer.from(script, "utf8").toString("base64")
    expect(encoded.length).toBeLessThan(plain.length / 3)
    expect(encoded.length).toBeLessThan(USER_DATA_MAX_BASE64_BYTES)
    // cloud-init identifies gzip by its magic bytes; keep them intact.
    const raw = Buffer.from(encoded, "base64")
    expect(raw[0]).toBe(0x1f)
    expect(raw[1]).toBe(0x8b)
  })

  it("round-trips to the exact script", () => {
    const script = "#!/bin/bash\necho 'héllo'\n"
    const back = gunzipSync(
      Buffer.from(encodeUserData(script), "base64"),
    ).toString("utf8")
    expect(back).toBe(script)
  })
})
