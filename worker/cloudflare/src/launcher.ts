/**
 * AFK launcher Worker — HTTP/WSS surface the CLI's Cloudflare Backend talks to.
 *
 * Routes (all behind Cloudflare Access service-token auth, except `/health`):
 *
 *   POST   /runs                       launch a Run     → 200 { runId, ... }
 *   GET    /runs                       list mine (or --all)   → 200 { runs: [...] }
 *   GET    /runs/:id                   findByRunId      → 200 RunSummary
 *   DELETE /runs/:id                   kill             → 200 { ok: true }
 *   WS     /runs/:id/attach            interactive shell
 *   GET    /history                    persistent rows from D1
 *   POST   /secrets/:name              proxy to Workers Secrets (admin)
 *   DELETE /secrets/:name              proxy to Workers Secrets (admin)
 *   GET    /secrets                    list developer secrets
 *   POST   /team/:name                 create CF Access service token for a developer
 *   DELETE /team/:name                 revoke
 *   GET    /team                       list
 *   GET    /health                     liveness probe
 *
 * RunDO and RegistryDO are exported below for the Durable Object runtime.
 */

import { Hono } from "hono"
import { authenticate, isOwner } from "./auth.ts"
import { RunContainer, RunDO } from "./runDO.ts"
import { RegistryDO } from "./registryDO.ts"
import type { Env, RunSummary, StartRequest } from "./types.ts"

export { RunDO, RunContainer, RegistryDO }

const app = new Hono<{ Bindings: Env }>()

// Caller principal middleware. Falls through for /health.
app.use("/*", async (c, next) => {
  if (c.req.path === "/health") return next()
  // The Run's container posts its completion callback here without Access
  // creds; it's authorized by the unguessable runId in the path.
  if (c.req.method === "POST" && c.req.path.endsWith("/complete")) return next()
  const caller = await authenticate(c.req.raw, c.env)
  if (!caller) return c.json({ error: "unauthorized" }, 401)
  c.set("caller" as never, caller as never)
  await next()
})

app.get("/health", (c) => c.json({ ok: true }))

// Completion callback from the Run's container (logs + exit code).
app.post("/runs/:id/complete", async (c) => {
  const stub = c.env.RUN_DO.get(c.env.RUN_DO.idFromName(c.req.param("id")))
  return stub.fetch(
    new Request("https://run/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: await c.req.text(),
    }),
  )
})

// Read a Run's captured logs. Forwards `?service=<name>` to the RunDO.
app.get("/runs/:id/logs", async (c) => {
  const stub = c.env.RUN_DO.get(c.env.RUN_DO.idFromName(c.req.param("id")))
  const search = new URL(c.req.url).search
  const r = await stub.fetch(new Request(`https://run/logs${search}`))
  return new Response(await r.text(), { headers: { "content-type": "text/plain" } })
})

// --- Runs ---

app.post("/runs", async (c) => {
  const caller = c.get("caller" as never) as { id: string }
  const body = (await c.req.json()) as StartRequest
  const id = c.env.RUN_DO.idFromName(body.runId)
  const stub = c.env.RUN_DO.get(id)
  const res = await stub.fetch(
    new Request("https://run/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, owner: caller.id }),
    }),
  )
  const startResp = (await res.json()) as { runId: string; resourceId: string; startedAt: string }

  // The RunDO registers itself in the index (PROVISIONING) before starting the
  // container and flips it to RUNNING after — so we only record D1 history here.
  await c.env.DB.prepare(
    `INSERT INTO runs
     (run_id, owner, repo, branch, sha, image, resource_id, status, started_at, timeout_hours, backend_details)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'RUNNING', ?, ?, ?)`,
  )
    .bind(
      body.runId,
      caller.id,
      body.repoName,
      body.branch,
      body.sha,
      body.image,
      startResp.resourceId,
      startResp.startedAt,
      body.timeoutHours,
      JSON.stringify({ instanceTier: body.instanceTier ?? "standard-1" }),
    )
    .run()

  return c.json(startResp)
})

app.get("/runs", async (c) => {
  const caller = c.get("caller" as never) as { id: string }
  const all = c.req.query("all") === "true"
  const registryId = c.env.REGISTRY_DO.idFromName("singleton")
  const registry = c.env.REGISTRY_DO.get(registryId)
  const ownerFilter = all ? "" : `?owner=${encodeURIComponent(caller.id)}`
  const r = await registry.fetch(new Request(`https://registry/list${ownerFilter}`))
  return c.json(await r.json())
})

app.get("/runs/:id", async (c) => {
  const id = c.env.RUN_DO.idFromName(c.req.param("id"))
  const stub = c.env.RUN_DO.get(id)
  const r = await stub.fetch(new Request("https://run/status"))
  const meta = (await r.json()) as RunSummary | { status: "STOPPED" }
  return c.json(meta)
})

app.delete("/runs/:id", async (c) => {
  const caller = c.get("caller" as never) as { id: string }
  const runId = c.req.param("id")
  // Authorization: only the owner can kill (unless admin scope is added later).
  const registryId = c.env.REGISTRY_DO.idFromName("singleton")
  const registry = c.env.REGISTRY_DO.get(registryId)
  const r = await registry.fetch(new Request("https://registry/list"))
  const { runs } = (await r.json()) as { runs: Array<{ runId: string; owner: string }> }
  const row = runs.find((x) => x.runId === runId)
  if (!row) return c.json({ error: "not found" }, 404)
  if (!isOwner(caller as never, row.owner)) {
    return c.json({ error: "forbidden" }, 403)
  }
  const id = c.env.RUN_DO.idFromName(runId)
  const stub = c.env.RUN_DO.get(id)
  await stub.fetch(new Request("https://run/kill", { method: "POST" }))
  return c.json({ ok: true })
})

app.get("/runs/:id/attach", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") {
    return c.json({ error: "upgrade required" }, 426)
  }
  const id = c.env.RUN_DO.idFromName(c.req.param("id"))
  const stub = c.env.RUN_DO.get(id)
  const url = new URL(c.req.url)
  return stub.fetch(
    new Request(`https://run/attach${url.search}`, {
      headers: c.req.raw.headers,
    }),
  )
})

// --- History ---

app.get("/history", async (c) => {
  const caller = c.get("caller" as never) as { id: string }
  const all = c.req.query("all") === "true"
  const since = c.req.query("since") ?? "7d"
  const branch = c.req.query("branch")
  const limit = Number(c.req.query("limit") ?? "100")

  const sinceMs = parseDurationMs(since)
  const sinceIso = new Date(Date.now() - sinceMs).toISOString()

  const params: unknown[] = [sinceIso]
  let sql = "SELECT * FROM runs WHERE started_at >= ?"
  if (!all) {
    sql += " AND owner = ?"
    params.push(caller.id)
  }
  if (branch) {
    sql += " AND branch = ?"
    params.push(branch)
  }
  sql += " ORDER BY started_at DESC LIMIT ?"
  params.push(limit)

  const rs = await c.env.DB.prepare(sql).bind(...params).all()
  return c.json({ rows: rs.results })
})

const parseDurationMs = (s: string): number => {
  const m = /^(\d+)\s*([smhd])$/i.exec(s.trim())
  if (!m) return 7 * 86_400_000
  const n = Number(m[1])
  const unit = m[2]!.toLowerCase()
  return unit === "s"
    ? n * 1000
    : unit === "m"
      ? n * 60_000
      : unit === "h"
        ? n * 3_600_000
        : n * 86_400_000
}

// --- Secrets (admin) ---
// Implementation: PATCH the Worker's own secrets via the CF API. Requires
// `CF_API_TOKEN` to be set as a Worker secret with `Workers Scripts:Edit`
// on this Worker. See `afk team add` docs.

app.post("/secrets/:name", async (c) => {
  const apiToken = c.env.CF_API_TOKEN
  const accountId = c.env.CF_ACCOUNT_ID
  if (!apiToken || !accountId) {
    return c.json(
      { error: "Worker missing CF_API_TOKEN / CF_ACCOUNT_ID secrets" },
      500,
    )
  }
  const name = `AFK_SECRET_${c.req.param("name")}`
  const { value } = (await c.req.json()) as { value: string }
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${getScriptName(c.env)}/secrets`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name, text: value, type: "secret_text" }),
    },
  )
  if (!r.ok) return c.json({ error: await r.text() }, 502)
  return c.json({ ok: true })
})

app.delete("/secrets/:name", async (c) => {
  const apiToken = c.env.CF_API_TOKEN
  const accountId = c.env.CF_ACCOUNT_ID
  if (!apiToken || !accountId) {
    return c.json({ error: "Worker missing API token" }, 500)
  }
  const name = `AFK_SECRET_${c.req.param("name")}`
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${getScriptName(c.env)}/secrets/${name}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${apiToken}` } },
  )
  if (!r.ok) return c.json({ error: await r.text() }, 502)
  return c.json({ ok: true })
})

app.get("/secrets", (c) => {
  // Best-effort: Workers offers no secret-listing API, so we infer from env keys.
  const names: string[] = []
  for (const k of Object.keys(c.env as Record<string, unknown>)) {
    if (k.startsWith("AFK_SECRET_")) names.push(k.slice("AFK_SECRET_".length))
  }
  return c.json({ secrets: names })
})

// --- Team (developer service tokens) ---

app.post("/team/:name", async (c) => {
  const apiToken = c.env.CF_API_TOKEN
  const accountId = c.env.CF_ACCOUNT_ID
  if (!apiToken || !accountId) return c.json({ error: "Worker missing API token" }, 500)
  const name = c.req.param("name")
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/access/service_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: `afk:${name}` }),
    },
  )
  if (!r.ok) return c.json({ error: await r.text() }, 502)
  const created = (await r.json()) as {
    result: { id: string; client_id: string; client_secret: string }
  }
  await c.env.DEVELOPERS_KV.put(`client-id:${created.result.client_id}`, name)
  return c.json({
    name,
    clientId: created.result.client_id,
    clientSecret: created.result.client_secret,
  })
})

app.get("/team", async (c) => {
  const list = await c.env.DEVELOPERS_KV.list({ prefix: "client-id:" })
  const rows: Array<{ name: string; clientId: string }> = []
  for (const k of list.keys) {
    const name = await c.env.DEVELOPERS_KV.get(k.name)
    rows.push({
      name: name ?? "?",
      clientId: k.name.replace("client-id:", ""),
    })
  }
  return c.json({ members: rows })
})

app.delete("/team/:name", async (c) => {
  // Best-effort: this requires knowing the service-token id. The CLI passes it
  // via the body so we don't have to query Cloudflare here.
  const { clientId, tokenId } = (await c.req.json()) as {
    clientId: string
    tokenId: string
  }
  const apiToken = c.env.CF_API_TOKEN
  const accountId = c.env.CF_ACCOUNT_ID
  if (!apiToken || !accountId) return c.json({ error: "Worker missing API token" }, 500)
  await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/access/service_tokens/${tokenId}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${apiToken}` } },
  )
  await c.env.DEVELOPERS_KV.delete(`client-id:${clientId}`)
  return c.json({ ok: true })
})

/** The Worker's own script name, for self-targeting CF API calls (the secrets
 *  routes PUT/DELETE against `/workers/scripts/<name>/secrets`). Set as a
 *  [vars] entry in wrangler.toml. Worker vars live on `env`, never on
 *  globalThis — reading globalThis here was the original bug (empty name →
 *  the CF API misrouted to the script-upload endpoint). */
const getScriptName = (env: Env): string => {
  return env.WORKER_NAME ?? "afk-launcher"
}

export default app
