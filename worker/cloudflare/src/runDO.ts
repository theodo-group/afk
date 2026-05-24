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
      case "GET /logs":
        return this.handleLogs()
      case "GET /attach":
        return this.handleAttach(req, url)
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
    const persisted: PersistedState = {
      meta,
      secrets: body.secretNames,
      ...(body.compose !== undefined ? { compose: body.compose } : {}),
      env: body.env,
      command: body.command,
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
      // Completion callback: the container ships logs + exit code here when the
      // workload ends, so `afk logs` / `afk ls` work without CF's logs API.
      ...(body.workerUrl ? { AFK_COMPLETE_URL: `${body.workerUrl}/runs/${body.runId}/complete` } : {}),
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
   * stores captured logs and flips the Run to STOPPED with its exit code. */
  private async handleComplete(req: Request): Promise<Response> {
    const { exitCode, logB64 } = (await req.json()) as {
      exitCode?: number
      logB64?: string
    }
    if (typeof logB64 === "string") {
      let log = ""
      try {
        log = new TextDecoder().decode(
          Uint8Array.from(atob(logB64), (c) => c.charCodeAt(0)),
        )
      } catch {
        log = "(could not decode log)"
      }
      await this.ctx.storage.put("log", log)
    }
    await this.ctx.storage.deleteAlarm()
    await this.markStopped("completed", exitCode)
    return Response.json({ ok: true })
  }

  /** Returns the captured workload logs (set by handleComplete). */
  private async handleLogs(): Promise<Response> {
    const log = (await this.ctx.storage.get<string>("log")) ?? ""
    return new Response(log, { headers: { "content-type": "text/plain" } })
  }

  private async handleAttach(req: Request, url: URL): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected websocket upgrade", { status: 426 })
    }
    const service = url.searchParams.get("service") ?? "agent"
    const host = url.searchParams.get("host") === "true"
    const { 0: clientWs, 1: serverWs } = new WebSocketPair()
    this.ctx.acceptWebSocket(serverWs, [
      JSON.stringify({ kind: "attach", service, host }),
    ])
    return new Response(null, { status: 101, webSocket: clientWs })
  }

  override async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const tags = this.ctx.getTags(ws)
    const first = tags[0]
    if (!first) return ws.close(1011, "missing session tag")
    const info = JSON.parse(first) as { kind: string; service?: string; host?: boolean }
    if (info.kind === "attach") {
      // The CF Containers SDK has container.exec() for spawning a process
      // inside the outer Container. We forward stdio over the WS.
      // Implementation note: CF's `exec` API is stabilising; the call shape
      // below is the documented form as of mid-2026 and may need adjustment.
      const exec = await this.getContainer().exec(
        info.host
          ? ["bash"]
          : ["docker", "compose", "-f", "/etc/afk/compose.yml", "exec", info.service ?? "agent", "bash"],
        { tty: true },
      )
      ;(async () => {
        for await (const chunk of exec.stdout) {
          try {
            ws.send(chunk)
          } catch {
            break
          }
        }
        ws.close(1000, "exec-exited")
      })()
      ;(async () => {
        const buf =
          typeof message === "string"
            ? new TextEncoder().encode(message)
            : new Uint8Array(message)
        await exec.stdin.write(buf)
      })()
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    try {
      ws.close()
    } catch {
      /* ignore */
    }
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
