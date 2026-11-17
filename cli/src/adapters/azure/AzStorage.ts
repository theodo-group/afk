import { Context, Effect, Layer } from "effect"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Subprocess } from "../../infra/Subprocess.ts"
import { AzureError } from "../../infra/Errors.ts"
import { makeAzCli } from "./azCli.ts"

/** A Table Storage entity, every property a string (afk writes nothing else). */
export type TableEntity = Readonly<Record<string, string>>

/** The partition every afk history row lives in: keyed by run id alone. */
export const RUNS_PARTITION = "runs"

const LOGIN = ["--auth-mode", "login"] as const

/** `key=value` argv entries, dropping Table Storage's own read-only fields. */
const entityArgs = (entity: TableEntity): ReadonlyArray<string> =>
  Object.entries(entity)
    .filter(([k]) => k !== "Timestamp" && k !== "etag" && !k.includes("@"))
    .map(([k, v]) => `${k}=${v}`)

const asEntity = (raw: Record<string, unknown>): TableEntity =>
  Object.fromEntries(
    Object.entries(raw)
      .filter(([, v]) => v !== null && v !== undefined && typeof v !== "object")
      .map(([k, v]) => [k, String(v)]),
  )

/**
 * Azure Storage data-plane adapter (Blob + Table), always signed in as the
 * caller (`--auth-mode login`) — no account key ever leaves Azure. The Table
 * half is the run index (the DynamoDB / Firestore analogue); the Blob half
 * carries Session Artifacts and the log objects a live Run ships.
 */
export class AzStorage extends Context.Tag("AzStorage")<
  AzStorage,
  {
    /** A blob's content, or `undefined` when it does not exist (yet). */
    readonly readBlob: (
      account: string,
      container: string,
      name: string,
    ) => Effect.Effect<string | undefined, AzureError>
    /** Names of the blobs under `prefix`. */
    readonly listBlobs: (
      account: string,
      container: string,
      prefix: string,
    ) => Effect.Effect<ReadonlyArray<string>, AzureError>
    /** Download every blob under `prefix` into `destDir`, keeping full names. */
    readonly downloadPrefix: (input: {
      readonly account: string
      readonly container: string
      readonly prefix: string
      readonly destDir: string
    }) => Effect.Effect<void, AzureError>

    /** Insert, or replace whole, the entity at its PartitionKey/RowKey. */
    readonly upsertEntity: (
      account: string,
      table: string,
      entity: TableEntity,
    ) => Effect.Effect<void, AzureError>
    /** Merge properties into an existing entity. */
    readonly mergeEntity: (
      account: string,
      table: string,
      entity: TableEntity,
    ) => Effect.Effect<void, AzureError>
    readonly getEntity: (
      account: string,
      table: string,
      partitionKey: string,
      rowKey: string,
    ) => Effect.Effect<TableEntity | undefined, AzureError>
    /** OData `$filter` query; every match, in the service's key order. */
    readonly queryEntities: (
      account: string,
      table: string,
      filter: string | undefined,
    ) => Effect.Effect<ReadonlyArray<TableEntity>, AzureError>
  }
>() {}

export const AzStorageLive = Layer.effect(
  AzStorage,
  Effect.gen(function* () {
    const sub = yield* Subprocess
    const az = makeAzCli(sub)

    const readBlob = (account: string, container: string, name: string) =>
      Effect.acquireUseRelease(
        Effect.sync(() => mkdtempSync(join(tmpdir(), "afk-blob-"))),
        (dir) => {
          const file = join(dir, "blob")
          return az
            .run("storage:blob:download", [
              "storage",
              "blob",
              "download",
              "--account-name",
              account,
              "--container-name",
              container,
              "--name",
              name,
              "--file",
              file,
              "--no-progress",
              ...LOGIN,
            ])
            .pipe(
              Effect.map(() => readFileSync(file, "utf8")),
              Effect.catchIf(
                (e) => e.message.includes("BlobNotFound"),
                () => Effect.succeed(undefined),
              ),
            )
        },
        (dir) =>
          Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
      )

    const listBlobs = (account: string, container: string, prefix: string) =>
      az
        .json<ReadonlyArray<{ readonly name: string }>>("storage:blob:list", [
          "storage",
          "blob",
          "list",
          "--account-name",
          account,
          "--container-name",
          container,
          "--prefix",
          prefix,
          ...LOGIN,
        ])
        .pipe(Effect.map((blobs) => blobs.map((b) => b.name)))

    const downloadPrefix = (input: {
      readonly account: string
      readonly container: string
      readonly prefix: string
      readonly destDir: string
    }) =>
      az.run("storage:blob:download-batch", [
        "storage",
        "blob",
        "download-batch",
        "--account-name",
        input.account,
        "--source",
        input.container,
        "--destination",
        input.destDir,
        "--pattern",
        `${input.prefix}*`,
        "--no-progress",
        ...LOGIN,
      ])

    const entityOp =
      (verb: "insert" | "merge", extra: ReadonlyArray<string>) =>
      (account: string, table: string, entity: TableEntity) =>
        az.run(`storage:entity:${verb}`, [
          "storage",
          "entity",
          verb,
          "--account-name",
          account,
          "--table-name",
          table,
          ...extra,
          "--entity",
          ...entityArgs(entity),
          ...LOGIN,
        ])

    const getEntity = (
      account: string,
      table: string,
      partitionKey: string,
      rowKey: string,
    ) =>
      az
        .json<Record<string, unknown>>("storage:entity:show", [
          "storage",
          "entity",
          "show",
          "--account-name",
          account,
          "--table-name",
          table,
          "--partition-key",
          partitionKey,
          "--row-key",
          rowKey,
          ...LOGIN,
        ])
        .pipe(
          Effect.map(asEntity),
          Effect.catchIf(
            (e) => e.message.includes("ResourceNotFound"),
            () => Effect.succeed(undefined),
          ),
        )

    // `entity query` answers `{ items, nextMarker }`; older az builds answer a
    // bare array. Accept both.
    const queryEntities = (
      account: string,
      table: string,
      filter: string | undefined,
    ) =>
      az
        .json<
          | ReadonlyArray<Record<string, unknown>>
          | { readonly items?: ReadonlyArray<Record<string, unknown>> }
        >("storage:entity:query", [
          "storage",
          "entity",
          "query",
          "--account-name",
          account,
          "--table-name",
          table,
          ...(filter !== undefined ? ["--filter", filter] : []),
          ...LOGIN,
        ])
        .pipe(
          Effect.map((r) =>
            Array.isArray(r)
              ? r
              : ((r as { items?: ReadonlyArray<Record<string, unknown>> })
                  .items ?? []),
          ),
          Effect.map((rows) => rows.map(asEntity)),
        )

    return AzStorage.of({
      readBlob,
      listBlobs,
      downloadPrefix,
      upsertEntity: entityOp("insert", ["--if-exists", "replace"]),
      mergeEntity: entityOp("merge", []),
      getEntity,
      queryEntities,
    })
  }),
)
