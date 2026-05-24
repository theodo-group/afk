/**
 * Per-Run Durable Object: owns one CF Container instance, sets the timeout
 * backstop alarm, captures stdout/stderr to Workers Logs, exposes the WS
 * attach + log-tail endpoints.
 *
 * One DO per Run, keyed by `DurableObject.idFromName(runId)`. The Registry DO
 * keeps a separate index for `afk ls`.
 *
 * NOTE: this file is intentionally framework-light — no Hono — because DO
 * fetch handlers are usually small enough to dispatch by URL.
 */

import { DurableObject } from "cloudflare:workers"
import { Container } from "@cloudflare/containers"
import type {
  Env,
  RunMetadata,
  StartRequest,
} from "./types.ts"

const SWEEPER_GRACE_MINUTES = 30

/** UTF-8-safe base64 (Workers `btoa` is Latin1-only). */
const utf8ToBase64 = (s: string): string => {
  const bytes = new TextEncoder().encode(s)
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

interface PersistedState {
  readonly meta: RunMetadata
  readonly secrets: ReadonlyArray<{ name: string; secretName: string }>
  readonly compose?: string
  readonly env: ReadonlyArray<{ name: string; value: string }>
  readonly command: ReadonlyArray<string>
  /** Secret the container echoes back on its log/complete callbacks, so the
   *  Worker can authenticate them without CF Access creds (the container has
   *  none). Replaces trusting the bare, unguessable runId. */
  readonly completeToken?: string
}

/** Container subclass the binding refers to. The class itself only needs to
 *  exist; the lifecycle hooks below stream stdout into Workers Logs. */
export class RunContainer extends Container<Env> {
  // stdout/stderr flow into Workers Logs automatically once observability is
  // enabled on the Worker.
  override sleepAfter = "8h"  // upper bound; the RunDO alarm enforces the real timeout
}

export class RunDO extends DurableObject<Env> {
  private container: Container | null = null

  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    switch (`${req.method} ${url.pathname}`) {
      case "POST /start":
        return this.handleStart(req)
      case "GET /status":
        return this.handleStatus()
      case "POST /kill":
        return this.handleKill()
      case "POST /complete":
        return this.handleComplete(req)
      case "POST /logs-progress":
        return this.handleLogsProgress(req)
      case "POST /session-artifact":
        return this.handleSessionArtifactUpload(req)
      case "GET /session-artifact":
        return this.handleSessionArtifactDownload()
      case "GET /logs":
        return this.handleLogs(url)
      case "GET /ssh-target":
        return this.handleSshTarget()
      case "GET /logs-stream":
        return this.handleLogsStream(req)
      default:
        return new Response("Not Found", { status: 404 })
    }
  }

  /** Timeout backstop. Fires `startedAt + timeoutHours + grace`. */
  override async alarm(): Promise<void> {
    const state = await this.ctx.storage.get<PersistedState>("state")
    if (!state) return
    if (state.meta.status === "STOPPED") return
    try {
      const container = this.getContainer()
      await container.stop("timeout")
    } catch {
      /* container may already be gone */
    }
    await this.markStopped("timeout", undefined)
  }

  private getContainer(): Container {
    if (!this.container) {
      // Address the RUN_CONTAINER binding (the Container class), NOT RUN_DO —
      // a RunDO stub has no Container methods like start()/stop(), which threw
      // `The RPC receiver does not implement the method "start"` on every Run.
      const id = this.env.RUN_CONTAINER.idFromName(this.ctx.id.toString())
      this.container = this.env.RUN_CONTAINER.get(id) as unknown as Container
    }
    return this.container
  }

  // --- HTTP handlers ---

  private async handleStart(req: Request): Promise<Response> {
    const body = (await req.json()) as StartRequest & { owner: string }
    const startedAt = new Date().toISOString()
    const meta: RunMetadata = {
      runId: body.runId,
      owner: body.owner,
      branch: body.branch,
      sha: body.sha,
      image: body.image,
      repoName: body.repoName,
      startedAt,
      timeoutHours: body.timeoutHours,
      status: "PROVISIONING",
      mainService: body.mainService,
      instanceTier: body.instanceTier ?? "standard-1",
    }
    // Per-Run callback secret: the container echoes this on /complete and
    // /logs-progress so the Worker can authenticate those (CF-Access-exempt)
    // callbacks. Replaces trusting the bare runId in the URL.
    const completeToken = crypto.randomUUID()
    const persisted: PersistedState = {
      meta,
      secrets: body.secretNames,
      ...(body.compose !== undefined ? { compose: body.compose } : {}),
      env: body.env,
      command: body.command,
      completeToken,
    }
    await this.ctx.storage.put("state", persisted)

    // Register in the index NOW (PROVISIONING), before container.start(), so
    // the subsequent markRunning() update lands on an existing row. (The
    // launcher used to add the row after /start returned, which raced the
    // RUNNING update and left every Run stuck at PROVISIONING.)
    await this.addToRegistry(meta)

    // Assemble the *workload* env file (forwarded into the inner `docker run`/
    // `docker compose` by golden's bootstrap). This is the dev's plain env plus
    // resolved Workers Secrets — same shape as the AWS run.env.
    const runEnvLines: string[] = []
    for (const e of body.env) runEnvLines.push(`${e.name}=${e.value}`)
    for (const s of body.secretNames) {
      // Workers Secrets are stored by the /secrets route under an `AFK_SECRET_`
      // prefix; resolve with the same prefix (s.secretName is the bare name).
      const v = (this.env as unknown as Record<string, unknown>)[`AFK_SECRET_${s.secretName}`]
      if (typeof v === "string") runEnvLines.push(`${s.name}=${v}`)
    }
    const runEnvB64 = utf8ToBase64(runEnvLines.join("\n") + "\n")

    // Mint a short-lived pull credential so the container can pull the wrapped
    // image from the CF managed registry (the golden image only has the engine).
    const cred = await this.mintRegistryPullCredential()

    // Control env consumed by golden's bootstrap.sh to run the workload. The
    // golden image (declared in wrangler.toml) is the fixed Container image;
    // the per-Run wrapper image runs *inside* it via Docker.
    const controlEnv: Record<string, string> = {
      AFK_IMAGE: body.image,
      AFK_COMMAND: (body.command ?? []).join(" "),
      AFK_MAIN_SERVICE: body.mainService,
      AFK_RUN_ENV_B64: runEnvB64,
      AFK_TIMEOUT_SECONDS: String(Math.floor(body.timeoutHours * 3600)),
      ...(cred ? { AFK_REGISTRY_USER: cred.username, AFK_REGISTRY_PASSWORD: cred.password } : {}),
      ...(body.compose !== undefined ? { AFK_COMPOSE_YML: body.compose } : {}),
      // Per-Run callback secret (echoed on /complete + /logs-progress).
      AFK_COMPLETE_TOKEN: completeToken,
      // Completion callback: the container ships logs + exit code here when the
      // workload ends, so `afk logs` / `afk ls` work without CF's logs API.
      ...(body.workerUrl ? { AFK_COMPLETE_URL: `${body.workerUrl}/runs/${body.runId}/complete` } : {}),
      // Incremental log push while the workload runs (so `afk logs --follow`
      // streams a live Run instead of waiting for the final callback).
      ...(body.workerUrl ? { AFK_PROGRESS_URL: `${body.workerUrl}/runs/${body.runId}/logs-progress` } : {}),
      // Session Artifact collection: bases to copy out + where to upload the
      // gzipped tar. Only set when the dev declared artifacts and we have a URL.
      ...((body.sessionArtifactBases ?? []).length > 0 && body.workerUrl
        ? {
            AFK_ARTIFACT_BASES: (body.sessionArtifactBases ?? []).join(" "),
            AFK_ARTIFACT_URL: `${body.workerUrl}/runs/${body.runId}/session-artifact`,
            AFK_ARTIFACT_MAX_BYTES: String(
              body.sessionArtifactMaxBytes ?? 26_214_400,
            ),
          }
        : {}),
    }
    const container = this.getContainer()
    // NB: the @cloudflare/containers SDK option is `envVars`, NOT `env` —
    // passing `env` is silently ignored (the container gets no vars, so the
    // golden bootstrap sees no AFK_IMAGE and just idles).
    await container.start({ envVars: controlEnv })

    // Schedule timeout backstop.
    const deadline =
      Date.now() +
      body.timeoutHours * 3600_000 +
      SWEEPER_GRACE_MINUTES * 60_000
    await this.ctx.storage.setAlarm(deadline)

    await this.markRunning()
    return Response.json({
      runId: body.runId,
      resourceId: this.ctx.id.toString(),
      status: "PROVISIONING",
      startedAt,
    })
  }

  private async handleStatus(): Promise<Response> {
    const state = await this.ctx.storage.get<PersistedState>("state")
    if (!state) return Response.json({ status: "STOPPED" })
    return Response.json(state.meta)
  }

  private async handleKill(): Promise<Response> {
    try {
      await this.getContainer().stop("killed-by-cli")
    } catch {
      /* already gone */
    }
    await this.ctx.storage.deleteAlarm()
    await this.markStopped("killed-by-cli", undefined)
    return Response.json({ ok: true })
  }

  /** Completion callback POSTed by the golden bootstrap when the workload ends:
   * stores the per-service log map and flips the Run to STOPPED with its exit
   * code. Keys are compose service names, values base64 (per-service, like the
   * AWS per-service awslogs streams). */
  private async handleComplete(req: Request): Promise<Response> {
    const denied = await this.checkRunToken(req)
    if (denied) return denied
    const { exitCode, services } = (await req.json()) as {
      exitCode?: number
      services?: Record<string, string>
    }
    if (services && typeof services === "object") {
      await this.ctx.storage.put("logs", this.decodeServices(services))
    }
    await this.ctx.storage.deleteAlarm()
    await this.markStopped("completed", exitCode)
    return Response.json({ ok: true })
  }

  /** Incremental log push from the running container (the golden poller).
   *  Overwrites the stored per-service snapshot with the latest cumulative
   *  copy so `afk logs --follow` streams a live Run. Does NOT touch status or
   *  the alarm — only /complete ends the Run. */
  private async handleLogsProgress(req: Request): Promise<Response> {
    const denied = await this.checkRunToken(req)
    if (denied) return denied
    const { services } = (await req.json()) as {
      services?: Record<string, string>
    }
    if (services && typeof services === "object") {
      await this.ctx.storage.put("logs", this.decodeServices(services))
    }
    return Response.json({ ok: true })
  }

  /** R2 key for this Run's Session Artifact tarball. Keyed by repo + runId,
   *  mirroring the AWS S3 prefix layout. */
  private artifactKey(meta: RunMetadata): string {
    return `${meta.repoName}/${meta.runId}/session-artifacts.tar.gz`
  }

  /** Session Artifact upload from the golden bootstrap: a base64 gzipped tar of
   *  the collected base dirs. Authenticated by the per-Run token (like
   *  /complete), decoded, and stored in R2. Independent of /complete — it never
   *  touches Run status. */
  private async handleSessionArtifactUpload(req: Request): Promise<Response> {
    const denied = await this.checkRunToken(req)
    if (denied) return denied
    const state = await this.ctx.storage.get<PersistedState>("state")
    if (!state) return Response.json({ error: "unknown run" }, { status: 404 })
    const { tarGzB64 } = (await req.json()) as { tarGzB64?: string }
    if (!tarGzB64) return Response.json({ ok: true })
    const bytes = Uint8Array.from(atob(tarGzB64), (c) => c.charCodeAt(0))
    await this.env.ARTIFACTS.put(this.artifactKey(state.meta), bytes)
    return Response.json({ ok: true })
  }

  /** Session Artifact download for `afk session-artifact`. Returns the stored
   *  tarball base64-encoded as JSON `{ tarGzB64 }`, or `{}` when none was
   *  collected. (Owner auth is enforced upstream by the launcher, as for logs.) */
  private async handleSessionArtifactDownload(): Promise<Response> {
    const state = await this.ctx.storage.get<PersistedState>("state")
    if (!state) return Response.json({})
    const obj = await this.env.ARTIFACTS.get(this.artifactKey(state.meta))
    if (!obj) return Response.json({})
    const buf = new Uint8Array(await obj.arrayBuffer())
    let bin = ""
    for (const b of buf) bin += String.fromCharCode(b)
    return Response.json({ tarGzB64: btoa(bin) })
  }

  /** Authenticate a container callback by the per-Run token. The container has
   *  no CF Access creds, so these routes are Access-exempt and gated here. */
  private async checkRunToken(req: Request): Promise<Response | null> {
    const state = await this.ctx.storage.get<PersistedState>("state")
    const expected = state?.completeToken
    const provided = req.headers.get("X-AFK-Run-Token")
    if (!expected || !provided || provided !== expected) {
      return Response.json({ error: "invalid run token" }, { status: 403 })
    }
    return null
  }

  /** Decode a base64 per-service log map (keys are service names). */
  private decodeServices(services: Record<string, string>): Record<string, string> {
    const decoded: Record<string, string> = {}
    for (const [name, b64] of Object.entries(services)) {
      try {
        decoded[name] = new TextDecoder().decode(
          Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)),
        )
      } catch {
        decoded[name] = "(could not decode log)"
      }
    }
    return decoded
  }

  /** Returns captured logs (set by handleComplete). `?service=<name>` returns
   * one service; without it, every service concatenated behind a header. */
  private async handleLogs(url: URL): Promise<Response> {
    const logs =
      (await this.ctx.storage.get<Record<string, string>>("logs")) ?? {}
    const service = url.searchParams.get("service")
    if (service !== null) {
      return new Response(logs[service] ?? "", {
        headers: { "content-type": "text/plain" },
      })
    }
    const names = Object.keys(logs)
    const body =
      names.length === 1
        ? logs[names[0]!] ?? ""
        : names.map((n) => `==> ${n} <==\n${logs[n]}`).join("\n")
    return new Response(body, { headers: { "content-type": "text/plain" } })
  }

  /** Resolve the CF Container instance id backing this Run, so the CLI can run
   *  `wrangler containers ssh <instanceId>`. Owner auth is enforced upstream by
   *  the launcher; here we only translate runId → instance id.
   *
   *  We do NOT proxy an interactive shell ourselves: `container.exec()` is
   *  pipe-based (no PTY, no resize — see workers-types ContainerExecOptions), so
   *  it can't host a real terminal. Cloudflare's own `wrangler containers ssh`
   *  allocates a proper PTY, so attach shells out to it from the CLI instead. */
  private async handleSshTarget(): Promise<Response> {
    const state = await this.ctx.storage.get<PersistedState>("state")
    if (!state || state.meta.status === "STOPPED") {
      return Response.json(
        { error: "Run is not running — `wrangler containers ssh` needs a live instance." },
        { status: 409 },
      )
    }
    try {
      const instanceId = await this.resolveInstanceId()
      if (!instanceId) {
        return Response.json(
          { error: "Could not resolve a running Container instance for this Run." },
          { status: 404 },
        )
      }
      return Response.json({ instanceId })
    } catch (e) {
      return Response.json({ error: String(e) }, { status: 502 })
    }
  }

  /**
   * Resolve the runtime Container instance id for this Run.
   *
   * The `@cloudflare/containers` SDK exposes no API for a DO to read its own
   * Container's instance id, so we go through the CF REST API: find the
   * `RunContainer` application, list its instances, and correlate the one
   * backing THIS RunDO. The correlation key is the Container DO id
   * (`RUN_CONTAINER.idFromName(runDOid)` — see `getContainer()`), from which CF
   * derives the instance.
   *
   * LIVE-VERIFY: the REST paths and the instance field that carries the DO id
   * are unconfirmed against a live account (the public API reference 404s on
   * the containers section as of 2026-05). The three marked lines are the only
   * places to adjust once a real instance can be inspected. See IMPROVEMENTS.md
   * #11.
   */
  private async resolveInstanceId(): Promise<string | null> {
    const apiToken = this.env.CF_API_TOKEN
    const accountId = this.env.CF_ACCOUNT_ID
    if (!apiToken || !accountId) {
      throw new Error("Worker missing CF_API_TOKEN / CF_ACCOUNT_ID secrets")
    }
    const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/containers`
    const auth = { Authorization: `Bearer ${apiToken}` }

    // The Container DO that backs this Run (mirrors getContainer()).
    const containerDoId = this.env.RUN_CONTAINER.idFromName(
      this.ctx.id.toString(),
    ).toString()

    // 1. Find the RunContainer application.            // LIVE-VERIFY: path + shape
    const appsRes = await fetch(`${base}/applications`, { headers: auth })
    const appsBody = (await appsRes.json()) as {
      result?: Array<{ id: string; name?: string; class_name?: string }>
    }
    const app = (appsBody.result ?? []).find(
      (a) => a.class_name === "RunContainer" || (a.name ?? "").includes("RunContainer"),
    )
    if (!app) return null

    // 2. List its instances.                           // LIVE-VERIFY: path + shape
    const insRes = await fetch(`${base}/applications/${app.id}/instances`, {
      headers: auth,
    })
    const insBody = (await insRes.json()) as { result?: Array<Record<string, unknown>> }
    const instances = insBody.result ?? []

    // 3. Correlate to this Run's Container DO.          // LIVE-VERIFY: which field
    const match = instances.find((i) =>
      [i["durable_object_id"], i["name"], i["id"]].some(
        (v) => typeof v === "string" && v === containerDoId,
      ),
    )
    const id = match?.["id"]
    return typeof id === "string" ? id : null
  }

  private async handleLogsStream(_req: Request): Promise<Response> {
    // Logs are persisted by Workers Logs (because observability=true). For
    // historical reads, the CLI queries the Workers Logs API directly. For
    // follow-mode, the CLI subscribes via a Tail Worker. Either way, this
    // endpoint isn't where streaming happens — kept stubbed so the routing
    // table is unambiguous.
    return Response.json(
      {
        message:
          "Container logs are in Workers Logs. Use the CLI's logs path which queries Workers Logs / Tail Workers directly.",
      },
      { status: 200 },
    )
  }

  // --- state transitions ---

  private async markRunning(): Promise<void> {
    const state = await this.ctx.storage.get<PersistedState>("state")
    if (!state) return
    const next: PersistedState = {
      ...state,
      meta: { ...state.meta, status: "RUNNING" },
    }
    await this.ctx.storage.put("state", next)
    await this.updateRegistry(next.meta)
  }

  private async markStopped(
    reason: string,
    exitCode: number | undefined,
  ): Promise<void> {
    const state = await this.ctx.storage.get<PersistedState>("state")
    if (!state) return
    const stoppedAt = new Date().toISOString()
    const next: PersistedState = {
      ...state,
      meta: { ...state.meta, status: "STOPPED" },
    }
    await this.ctx.storage.put("state", next)
    await this.updateRegistry(next.meta, stoppedAt)
    await this.recordHistory(next.meta, stoppedAt, exitCode, reason)
  }

  /** Mint a short-lived pull credential for registry.cloudflare.com so the
   *  container can `docker pull` the wrapped image. Returns null (best-effort)
   *  if the Worker lacks CF_API_TOKEN/CF_ACCOUNT_ID. */
  private async mintRegistryPullCredential(): Promise<{ username: string; password: string } | null> {
    const apiToken = this.env.CF_API_TOKEN
    const accountId = this.env.CF_ACCOUNT_ID
    if (!apiToken || !accountId) return null
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/containers/registries/registry.cloudflare.com/credentials`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ expiration_minutes: 360, permissions: ["pull"] }),
      },
    )
    const body = (await res.json()) as {
      success: boolean
      result?: { username: string; password: string }
    }
    if (!res.ok || !body.success || !body.result) {
      throw new Error(`could not mint registry pull credential: ${JSON.stringify(body)}`)
    }
    return { username: body.result.username, password: body.result.password }
  }

  private async addToRegistry(meta: RunMetadata): Promise<void> {
    const id = this.env.REGISTRY_DO.idFromName("singleton")
    const stub = this.env.REGISTRY_DO.get(id)
    await stub.fetch(new Request("https://registry/add", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(meta),
    }))
  }

  private async updateRegistry(
    meta: RunMetadata,
    stoppedAt?: string,
  ): Promise<void> {
    const id = this.env.REGISTRY_DO.idFromName("singleton")
    const stub = this.env.REGISTRY_DO.get(id)
    await stub.fetch(new Request("https://registry/update-status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId: meta.runId,
        status: meta.status,
        ...(stoppedAt ? { stoppedAt } : {}),
      }),
    }))
  }

  private async recordHistory(
    meta: RunMetadata,
    stoppedAt: string,
    exitCode: number | undefined,
    reason: string,
  ): Promise<void> {
    await this.env.DB.prepare(
      `UPDATE runs SET status = ?, stopped_at = ?, exit_code = ?,
       backend_details = json_patch(coalesce(backend_details, '{}'), ?)
       WHERE run_id = ?`,
    )
      .bind(
        "STOPPED",
        stoppedAt,
        exitCode ?? null,
        JSON.stringify({ stopReason: reason }),
        meta.runId,
      )
      .run()
  }
}
