import { Context, Effect, Layer } from "effect"
import { Subprocess } from "../../infra/Subprocess.ts"
import { GcpError } from "../../infra/Errors.ts"
import { makeGcloudCli } from "./gcloudCli.ts"

/**
 * Firestore (Native mode) adapter — the GCP analogue of `DynamoDb`, backing the
 * Run index. `gcloud firestore` has no document CRUD, so this talks the
 * Firestore REST API directly with the gcloud access token (mirroring the
 * DynamoDB typed-item approach: values cross the wire as Firestore typed-value
 * documents and convert at the call site). Requests go through `curl` so all
 * shelling stays in `Subprocess` (code-style.md §5).
 */
export type FieldValue =
  | { readonly stringValue: string }
  | { readonly integerValue: string }
  | { readonly booleanValue: boolean }
  | { readonly nullValue: null }

export type Fields = Readonly<Record<string, FieldValue>>

interface FirestoreDocument {
  readonly name?: string
  readonly fields?: Fields
}

export interface QueryFilter {
  readonly field: string
  readonly op: "EQUAL" | "GREATER_THAN_OR_EQUAL"
  readonly value: FieldValue
}

export interface QueryInput {
  readonly project: string
  readonly collection: string
  readonly filters: ReadonlyArray<QueryFilter>
  readonly orderByField?: string
  readonly descending?: boolean
  readonly limit?: number
}

export class Firestore extends Context.Tag("Firestore")<
  Firestore,
  {
    readonly putDoc: (input: {
      readonly project: string
      readonly collection: string
      readonly docId: string
      readonly fields: Fields
    }) => Effect.Effect<void, GcpError>
    readonly getDoc: (input: {
      readonly project: string
      readonly collection: string
      readonly docId: string
    }) => Effect.Effect<Fields | null, GcpError>
    readonly queryDocs: (
      input: QueryInput,
    ) => Effect.Effect<ReadonlyArray<Fields>, GcpError>
  }
>() {}

const base = (project: string) =>
  `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`

export const FirestoreLive = Layer.effect(
  Firestore,
  Effect.gen(function* () {
    const sub = yield* Subprocess
    const gcloud = makeGcloudCli(sub)

    // Firestore has no `gcloud` document CRUD, so we hit the REST API with a
    // short-lived token. Fetched per-call (cheap, always fresh) rather than
    // taking an Auth dependency — keeps this adapter self-contained like the
    // AWS adapters.
    const accessToken = gcloud.text("auth:print-access-token", [
      "auth",
      "print-access-token",
    ])

    const curlJson = <T>(
      operation: string,
      args: ReadonlyArray<string>,
    ): Effect.Effect<T, GcpError> =>
      accessToken.pipe(
        Effect.flatMap((token) =>
          sub
            .runJson<T>("curl", [
              "-s",
              "-H",
              `Authorization: Bearer ${token}`,
              "-H",
              "Content-Type: application/json",
              ...args,
            ])
            .pipe(
              Effect.mapError((e) =>
                e._tag === "ParseError"
                  ? new GcpError({ operation, message: String(e.cause) })
                  : new GcpError({ operation, message: e.stderr }),
              ),
            ),
        ),
      )

    const putDoc = (input: {
      project: string
      collection: string
      docId: string
      fields: Fields
    }) =>
      curlJson<unknown>("firestore:patch", [
        "-X",
        "PATCH",
        `${base(input.project)}/${input.collection}/${input.docId}`,
        "-d",
        JSON.stringify({ fields: input.fields }),
      ]).pipe(Effect.asVoid)

    const getDoc = (input: {
      project: string
      collection: string
      docId: string
    }) =>
      curlJson<FirestoreDocument & { error?: unknown }>("firestore:get", [
        `${base(input.project)}/${input.collection}/${input.docId}`,
      ]).pipe(Effect.map((doc) => (doc.error ? null : (doc.fields ?? null))))

    const queryDocs = (input: QueryInput) => {
      const where =
        input.filters.length === 1
          ? {
              fieldFilter: {
                field: { fieldPath: input.filters[0]!.field },
                op: input.filters[0]!.op,
                value: input.filters[0]!.value,
              },
            }
          : input.filters.length > 1
            ? {
                compositeFilter: {
                  op: "AND",
                  filters: input.filters.map((f) => ({
                    fieldFilter: {
                      field: { fieldPath: f.field },
                      op: f.op,
                      value: f.value,
                    },
                  })),
                },
              }
            : undefined
      const structuredQuery = {
        from: [{ collectionId: input.collection }],
        ...(where ? { where } : {}),
        ...(input.orderByField
          ? {
              orderBy: [
                {
                  field: { fieldPath: input.orderByField },
                  direction: input.descending ? "DESCENDING" : "ASCENDING",
                },
              ],
            }
          : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      }
      return curlJson<ReadonlyArray<{ document?: FirestoreDocument }>>(
        "firestore:runQuery",
        [
          "-X",
          "POST",
          `${base(input.project)}:runQuery`,
          "-d",
          JSON.stringify({ structuredQuery }),
        ],
      ).pipe(
        Effect.map((rows) =>
          rows
            .map((r) => r.document?.fields)
            .filter((f): f is Fields => f !== undefined),
        ),
      )
    }

    return Firestore.of({ putDoc, getDoc, queryDocs })
  }),
)

// ---------- helpers (mirror DynamoDb's S/N/B/readS/readN/readB) ----------

export const sv = (v: string): FieldValue => ({ stringValue: v })
export const iv = (v: number | string): FieldValue => ({
  integerValue: String(v),
})
export const bv = (v: boolean): FieldValue => ({ booleanValue: v })

export const readSv = (f: Fields, k: string): string | undefined => {
  const v = f[k]
  return v && "stringValue" in v ? v.stringValue : undefined
}
export const readIv = (f: Fields, k: string): number | undefined => {
  const v = f[k]
  if (v && "integerValue" in v) {
    const n = Number(v.integerValue)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}
export const readBv = (f: Fields, k: string): boolean | undefined => {
  const v = f[k]
  return v && "booleanValue" in v ? v.booleanValue : undefined
}
