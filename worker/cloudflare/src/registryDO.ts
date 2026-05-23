/**
 * Small Durable Object that holds the index of live Runs. One global instance
 * per Worker (id derived from a fixed name). Used by `GET /runs` to enumerate
 * Runs without needing to fan out to every per-Run DO.
 */

import { DurableObject } from "cloudflare:workers"
import type { Env, RunMetadata } from "./types.ts"

export class RegistryDO extends DurableObject<Env> {
  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    switch (`${req.method} ${url.pathname}`) {
      case "POST /add":
        return this.handleAdd(req)
      case "POST /remove":
        return this.handleRemove(req)
      case "POST /update-status":
        return this.handleUpdateStatus(req)
      case "GET /list":
        return this.handleList(url)
      default:
        return new Response("Not Found", { status: 404 })
    }
  }

  private async handleAdd(req: Request): Promise<Response> {
    const meta = (await req.json()) as RunMetadata
    await this.ctx.storage.put(`run:${meta.runId}`, meta)
    return Response.json({ ok: true })
  }

  private async handleRemove(req: Request): Promise<Response> {
    const { runId } = (await req.json()) as { runId: string }
    await this.ctx.storage.delete(`run:${runId}`)
    return Response.json({ ok: true })
  }

  private async handleUpdateStatus(req: Request): Promise<Response> {
    const { runId, status, stoppedAt } = (await req.json()) as {
      runId: string
      status: RunMetadata["status"]
      stoppedAt?: string
    }
    const cur = await this.ctx.storage.get<RunMetadata>(`run:${runId}`)
    if (!cur) return Response.json({ ok: false, error: "not found" }, { status: 404 })
    const next = { ...cur, status, ...(stoppedAt ? { stoppedAt } : {}) }
    await this.ctx.storage.put(`run:${runId}`, next)
    return Response.json({ ok: true })
  }

  private async handleList(url: URL): Promise<Response> {
    const ownerFilter = url.searchParams.get("owner")
    const map = await this.ctx.storage.list<RunMetadata>({ prefix: "run:" })
    const out: RunMetadata[] = []
    for (const meta of map.values()) {
      if (ownerFilter && meta.owner !== ownerFilter) continue
      out.push(meta)
    }
    return Response.json({ runs: out })
  }
}
