import { Context, Effect, Layer } from "effect"
import { Subprocess } from "../../infra/Subprocess.ts"
import { AwsError } from "../../infra/Errors.ts"
import { makeAwsCli } from "./awsCli.ts"

/**
 * Thin wrapper over the `aws dynamodb` CLI. We pass DynamoDB JSON
 * (typed-attribute) form on the wire and convert at the call site.
 */
export type AttrValue =
  | { readonly S: string }
  | { readonly N: string }
  | { readonly BOOL: boolean }
  | { readonly NULL: true }

export type Item = Readonly<Record<string, AttrValue>>

export interface PutItemInput {
  readonly region: string
  readonly table: string
  readonly item: Item
}

export interface UpdateItemInput {
  readonly region: string
  readonly table: string
  readonly key: Item
  readonly updateExpression: string
  readonly expressionAttributeNames?: Readonly<Record<string, string>>
  readonly expressionAttributeValues?: Readonly<Record<string, AttrValue>>
}

export interface QueryInput {
  readonly region: string
  readonly table: string
  readonly indexName?: string
  readonly keyConditionExpression: string
  readonly filterExpression?: string
  readonly expressionAttributeNames?: Readonly<Record<string, string>>
  readonly expressionAttributeValues: Readonly<Record<string, AttrValue>>
  readonly scanIndexForward?: boolean
  readonly limit?: number
}

export interface ScanInput {
  readonly region: string
  readonly table: string
  readonly filterExpression?: string
  readonly expressionAttributeNames?: Readonly<Record<string, string>>
  readonly expressionAttributeValues?: Readonly<Record<string, AttrValue>>
  readonly limit?: number
}

export class DynamoDb extends Context.Tag("DynamoDb")<
  DynamoDb,
  {
    readonly putItem: (input: PutItemInput) => Effect.Effect<void, AwsError>
    readonly updateItem: (
      input: UpdateItemInput,
    ) => Effect.Effect<void, AwsError>
    readonly query: (
      input: QueryInput,
    ) => Effect.Effect<ReadonlyArray<Item>, AwsError>
    readonly scan: (
      input: ScanInput,
    ) => Effect.Effect<ReadonlyArray<Item>, AwsError>
  }
>() {}

export const DynamoDbLive = Layer.effect(
  DynamoDb,
  Effect.gen(function* () {
    const sub = yield* Subprocess
    const aws = makeAwsCli(sub)

    return DynamoDb.of({
      putItem: (input) =>
        aws.run("dynamodb:PutItem", [
          "dynamodb",
          "put-item",
          "--region",
          input.region,
          "--table-name",
          input.table,
          "--item",
          JSON.stringify(input.item),
        ]),

      updateItem: (input) => {
        const args: string[] = [
          "dynamodb",
          "update-item",
          "--region",
          input.region,
          "--table-name",
          input.table,
          "--key",
          JSON.stringify(input.key),
          "--update-expression",
          input.updateExpression,
        ]
        if (input.expressionAttributeNames) {
          args.push(
            "--expression-attribute-names",
            JSON.stringify(input.expressionAttributeNames),
          )
        }
        if (input.expressionAttributeValues) {
          args.push(
            "--expression-attribute-values",
            JSON.stringify(input.expressionAttributeValues),
          )
        }
        return aws.run("dynamodb:UpdateItem", args)
      },

      query: (input) => {
        const args: string[] = [
          "dynamodb",
          "query",
          "--region",
          input.region,
          "--table-name",
          input.table,
          "--key-condition-expression",
          input.keyConditionExpression,
          "--expression-attribute-values",
          JSON.stringify(input.expressionAttributeValues),
        ]
        if (input.indexName) args.push("--index-name", input.indexName)
        if (input.filterExpression) {
          args.push("--filter-expression", input.filterExpression)
        }
        if (input.expressionAttributeNames) {
          args.push(
            "--expression-attribute-names",
            JSON.stringify(input.expressionAttributeNames),
          )
        }
        if (input.scanIndexForward === false)
          args.push("--no-scan-index-forward")
        if (input.limit !== undefined) args.push("--limit", String(input.limit))
        return aws
          .json<{ Items: ReadonlyArray<Item> }>("dynamodb:Query", args)
          .pipe(Effect.map((r) => r.Items ?? []))
      },

      scan: (input) => {
        const args: string[] = [
          "dynamodb",
          "scan",
          "--region",
          input.region,
          "--table-name",
          input.table,
        ]
        if (input.filterExpression) {
          args.push("--filter-expression", input.filterExpression)
        }
        if (input.expressionAttributeNames) {
          args.push(
            "--expression-attribute-names",
            JSON.stringify(input.expressionAttributeNames),
          )
        }
        if (input.expressionAttributeValues) {
          args.push(
            "--expression-attribute-values",
            JSON.stringify(input.expressionAttributeValues),
          )
        }
        if (input.limit !== undefined) args.push("--limit", String(input.limit))
        return aws
          .json<{ Items: ReadonlyArray<Item> }>("dynamodb:Scan", args)
          .pipe(Effect.map((r) => r.Items ?? []))
      },
    })
  }),
)

// ---------- helpers ----------

export const S = (v: string): AttrValue => ({ S: v })
export const N = (v: number | string): AttrValue => ({ N: String(v) })
export const B = (v: boolean): AttrValue => ({ BOOL: v })

export const readS = (item: Item, k: string): string | undefined =>
  "S" in (item[k] ?? {}) ? (item[k] as { S: string }).S : undefined
export const readN = (item: Item, k: string): number | undefined => {
  const v = item[k]
  if (v && "N" in v) {
    const n = Number(v.N)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}
export const readB = (item: Item, k: string): boolean | undefined =>
  item[k] && "BOOL" in item[k]!
    ? (item[k] as { BOOL: boolean }).BOOL
    : undefined
