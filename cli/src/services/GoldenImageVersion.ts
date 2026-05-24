/**
 * Stable short version hash derived from a sorted list of pre-pull image refs,
 * plus optional `bakedContent` for backends that bake artifacts into the image
 * itself. AWS omits it (its bootstrap rides per-Run user_data, so only the cache
 * list defines the AMI). Cloudflare passes the bootstrap script: it is baked
 * into the golden container, so a bootstrap change must rotate the tag —
 * otherwise the new image pushes to the old tag and CF never rolls it out.
 */
export const goldenVersionHash = (
  cachedImages: ReadonlyArray<string>,
  bakedContent: string = "",
): string => {
  const sorted = [...cachedImages].sort()
  const joined = bakedContent
    ? `${sorted.join(",")} ${bakedContent}`
    : sorted.join(",")
  let h = 0
  for (let i = 0; i < joined.length; i++) {
    h = ((h << 5) - h + joined.charCodeAt(i)) | 0
  }
  return `v1-${sorted.length}-${(h >>> 0).toString(16).padStart(8, "0")}`
}
