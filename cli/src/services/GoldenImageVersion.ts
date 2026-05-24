/**
 * Stable short version hash derived from a sorted list of pre-pull image refs.
 * Shared by both Backends' Golden Image builders so the same cache list always
 * yields the same version tag regardless of provider.
 */
export const goldenVersionHash = (
  cachedImages: ReadonlyArray<string>,
): string => {
  const sorted = [...cachedImages].sort()
  const joined = sorted.join(",")
  let h = 0
  for (let i = 0; i < joined.length; i++) {
    h = ((h << 5) - h + joined.charCodeAt(i)) | 0
  }
  return `v1-${sorted.length}-${(h >>> 0).toString(16).padStart(8, "0")}`
}
