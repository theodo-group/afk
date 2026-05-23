/**
 * Auth for the launcher Worker. Two modes:
 *
 *   1. Cloudflare Access service tokens (production).
 *      The Worker is fronted by Cloudflare Access; CF stamps a JWT plus
 *      `Cf-Access-Authenticated-User-Email` and `Cf-Access-Client-Id` on
 *      requests it lets through. We read the client-id as the Owner.
 *
 *   2. Single-dev shared bearer (escape hatch).
 *      For solo developers who haven't set up Access. The CLI sends
 *      `Authorization: Bearer <token>`, the Worker validates against
 *      a `AFK_SHARED_TOKEN` secret it was deployed with, and the Owner is
 *      hardcoded to "local".
 *
 * The DEVELOPERS_KV namespace maps client-id → display name so `afk ls --all`
 * etc. can show humans, not opaque service-token IDs.
 */

import type { CallerPrincipal, Env } from "./types.ts"

const SHARED_LOCAL_OWNER = "local"

export async function authenticate(
  req: Request,
  env: Env,
): Promise<CallerPrincipal | null> {
  // Access service token path.
  const clientId = req.headers.get("Cf-Access-Client-Id")
  if (clientId) {
    const displayName =
      (await env.DEVELOPERS_KV.get(`client-id:${clientId}`)) ?? clientId
    return { id: clientId, displayName }
  }
  // Fallback: shared bearer (single-dev mode).
  const sharedToken = (env as unknown as { AFK_SHARED_TOKEN?: string }).AFK_SHARED_TOKEN
  if (!sharedToken) return null
  const auth = req.headers.get("Authorization")
  if (!auth || !auth.startsWith("Bearer ")) return null
  if (auth.slice("Bearer ".length) !== sharedToken) return null
  return { id: SHARED_LOCAL_OWNER, displayName: "local" }
}

export const isOwner = (caller: CallerPrincipal, runOwner: string): boolean =>
  caller.id === runOwner
