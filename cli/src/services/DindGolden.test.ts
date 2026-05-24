import { describe, expect, test } from "bun:test"
import {
  cacheCopyLine,
  ensureAfkDirs,
  installBootstrap,
  safeName,
  skopeoBakeStage,
} from "./DindGolden.ts"

describe("safeName", () => {
  test("replaces registry/tag punctuation with underscores", () => {
    expect(safeName("postgres:16")).toBe("postgres_16")
    expect(safeName("docker.io/library/redis:7")).toBe(
      "docker.io_library_redis_7",
    )
  })
})

describe("skopeoBakeStage", () => {
  test("CF shape forces --override-os linux, one RUN per image", () => {
    expect(
      skopeoBakeStage(["postgres:16", "redis:7"], { overrideOsLinux: true }),
    ).toEqual([
      `FROM alpine:3.20 AS skopeo-bake`,
      `RUN apk add --no-cache skopeo ca-certificates`,
      `WORKDIR /out`,
      `RUN skopeo copy --override-os linux docker://postgres:16 oci-archive:/out/postgres_16.tar`,
      `RUN skopeo copy --override-os linux docker://redis:7 oci-archive:/out/redis_7.tar`,
    ])
  })

  test("Local shape omits the os override; empty cache yields just the stage", () => {
    expect(skopeoBakeStage(["node:20"], { overrideOsLinux: false })).toEqual([
      `FROM alpine:3.20 AS skopeo-bake`,
      `RUN apk add --no-cache skopeo ca-certificates`,
      `WORKDIR /out`,
      `RUN skopeo copy docker://node:20 oci-archive:/out/node_20.tar`,
    ])
    expect(skopeoBakeStage([], { overrideOsLinux: false })).toEqual([
      `FROM alpine:3.20 AS skopeo-bake`,
      `RUN apk add --no-cache skopeo ca-certificates`,
      `WORKDIR /out`,
    ])
  })
})

describe("cacheCopyLine", () => {
  test("emits the COPY only when there is a cache to copy", () => {
    expect(cacheCopyLine(["postgres:16"])).toEqual([
      `COPY --from=skopeo-bake /out/ /var/afk/cache/`,
    ])
    expect(cacheCopyLine([])).toEqual([])
  })
})

describe("ensureAfkDirs", () => {
  test("CF dirs/chown targets", () => {
    expect(
      ensureAfkDirs(["/var/afk/cache", "/var/log"], ["/var/afk", "/var/log"]),
    ).toBe(
      `RUN mkdir -p /var/afk/cache /var/log && chown -R rootless:rootless /var/afk /var/log`,
    )
  })

  test("Local dirs/chown targets", () => {
    expect(
      ensureAfkDirs(["/var/afk/cache", "/var/afk/run"], ["/var/afk"]),
    ).toBe(
      `RUN mkdir -p /var/afk/cache /var/afk/run && chown -R rootless:rootless /var/afk`,
    )
  })
})

describe("installBootstrap", () => {
  test("CF: chmod only", () => {
    expect(installBootstrap({ chown: false })).toEqual([
      `COPY bootstrap.sh /var/afk/bootstrap.sh`,
      `RUN chmod +x /var/afk/bootstrap.sh`,
    ])
  })

  test("Local: chmod + chown to rootless", () => {
    expect(installBootstrap({ chown: true })).toEqual([
      `COPY bootstrap.sh /var/afk/bootstrap.sh`,
      `RUN chmod +x /var/afk/bootstrap.sh && chown rootless:rootless /var/afk/bootstrap.sh`,
    ])
  })
})
