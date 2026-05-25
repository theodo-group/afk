import { describe, expect, it } from "bun:test"
import { buildUserData, type UserDataInput } from "./UserData.ts"

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
