/**
 * Shared fragments for the rootless-dind Golden Image Dockerfile. The Cloudflare
 * and Local Backends build the *same* artifact shape — a `docker:28-dind-rootless`
 * image with the configured cache skopeo-baked in and a `bootstrap.sh` ENTRYPOINT
 * — and diverge only in a few lines (skopeo os override, extra dirs, final user,
 * bootstrap ownership). Rather than one flag-driven builder, each Backend composes
 * these named fragments itself, so the variation lives at the call site.
 */

/** Sanitize an image ref into a filename-safe token for the OCI archive name. */
export const safeName = (imageRef: string): string =>
  imageRef.replace(/[^a-zA-Z0-9._-]+/g, "_")

/**
 * The alpine + skopeo "bake" stage: copies each cached image into an OCI archive
 * under `/out` (one `RUN` per image so layer caching is per-image), which the
 * runtime stage then `COPY`s in. `overrideOsLinux` forces `--override-os linux`
 * (the CF golden is built `linux/amd64` regardless of build host).
 */
export const skopeoBakeStage = (
  cachedImages: ReadonlyArray<string>,
  options: { readonly overrideOsLinux: boolean },
): ReadonlyArray<string> => {
  const osFlag = options.overrideOsLinux ? "--override-os linux " : ""
  return [
    `FROM alpine:3.20 AS skopeo-bake`,
    `RUN apk add --no-cache skopeo ca-certificates`,
    `WORKDIR /out`,
    ...cachedImages.map(
      (img) =>
        `RUN skopeo copy ${osFlag}docker://${img} oci-archive:/out/${safeName(img)}.tar`,
    ),
  ]
}

/** COPY the bake output into the cache dir — only when there is something to copy. */
export const cacheCopyLine = (
  cachedImages: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  cachedImages.length > 0
    ? [`COPY --from=skopeo-bake /out/ /var/afk/cache/`]
    : []

/** `mkdir -p` the given dirs, then `chown -R rootless:rootless` the given targets. */
export const ensureAfkDirs = (
  dirs: ReadonlyArray<string>,
  chownTargets: ReadonlyArray<string>,
): string =>
  `RUN mkdir -p ${dirs.join(" ")} && chown -R rootless:rootless ${chownTargets.join(" ")}`

/**
 * COPY the bootstrap script in and mark it executable. `chown` additionally hands
 * it to the rootless user (Local runs the final image as `rootless`; CF stays root).
 */
export const installBootstrap = (options: {
  readonly chown: boolean
}): ReadonlyArray<string> => [
  `COPY bootstrap.sh /var/afk/bootstrap.sh`,
  options.chown
    ? `RUN chmod +x /var/afk/bootstrap.sh && chown rootless:rootless /var/afk/bootstrap.sh`
    : `RUN chmod +x /var/afk/bootstrap.sh`,
]
