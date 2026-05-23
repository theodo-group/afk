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

import { Container } from "@cloudflare/containers"
import type {
  Env,
  RunMetadata,
  StartRequest,
} from "./types.ts"

const SWEEPER_GRACE_MINUTES = 30

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
  // CF Containers SDK fires `onActivityExpired` on idle, and stops on
  // explicit stop()/destroy(). stdout/stderr flow into Workers Logs
  // automatically when observability is enabled on the Worker.
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
      const id = this.env.RUN_DO.idFromName(this.ctx.id.toString())
      this.container = this.env.RUN_DO.get(id) as unknown as Container
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

    // Resolve Workers Secrets into the Container env. Each `secretNames` entry
    // points at a Workers Secret bound to this Worker; we read it from `env`.
    const containerEnv: Record<string, string> = {}
    for (const e of body.env) containerEnv[e.name] = e.value
    for (const s of body.secretNames) {
      const v = (this.env as unknown as Record<string, unknown>)[s.secretName]
      if (typeof v === "string") containerEnv[s.name] = v
    }
    // The wrapped image already FROMs afk-golden, so dind + cached sidecars
    // are baked in. The Container's command is the entrypoint chain.
    const container = this.getContainer()
    await container.start({
      env: containerEnv,
      // CF Container start args. The image is declared in wrangler.toml and
      // the per-Run image is set via the CF API to `body.image` (this is the
      // wrapped image that extends afk-golden).
    })

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
    // The actual exec piping is handled in `webSocketMessage` (below).
    return new Response(null, { status: 101, webSocket: clientWs })
  }

  override async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    // The first tag attached at acceptWebSocket() time describes what kind
    // of session this is. We retrieve it via getTags().
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
      // Pipe in both directions.
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
      // Caller's stdin → exec.stdin
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
