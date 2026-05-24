/**
 * Auth headers for every CLI → launcher Worker call. Precedence: a Cloudflare
 * Access service token (`AFK_CF_CLIENT_ID`/`_SECRET`) wins; otherwise a
 * single-dev shared bearer (`AFK_SHARED_TOKEN`); otherwise bare (no-auth).
 */
export const cfAuthHeaders = (): Record<string, string> => {
  const id = process.env.AFK_CF_CLIENT_ID
  const secret = process.env.AFK_CF_CLIENT_SECRET
  const sharedToken = process.env.AFK_SHARED_TOKEN
  const out: Record<string, string> = { "content-type": "application/json" }
  if (id && secret) {
    out["CF-Access-Client-Id"] = id
    out["CF-Access-Client-Secret"] = secret
  } else if (sharedToken) {
    out["Authorization"] = `Bearer ${sharedToken}`
  }
  return out
}
