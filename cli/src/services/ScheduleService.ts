import { Context, Effect, Either, Layer, Schema } from "effect"
import { parse as parseYaml } from "yaml"
import { Git } from "../adapters/Git.ts"
import { BuildService } from "./BuildService.ts"
import { ConfigService } from "./ConfigService.ts"
import { Compute } from "./backend/Compute.ts"
import { ScheduleStore, type StoredEntry } from "./backend/ScheduleStore.ts"
import { ScheduleFile } from "../schema/Schedule.ts"
import { firstDueAt, parseTrigger, validateEntries } from "./Triggers.ts"
import {
  AwsError,
  CloudflareError,
  ConfigError,
  DockerError,
  GcpError,
  GitError,
  UserError,
} from "../infra/Errors.ts"
import { DEFAULT_REGION, DEFAULT_TIMEOUT_HOURS } from "../constants.ts"

export interface SubmitReport {
  readonly scheduleId: string
  readonly image: string
  readonly imageSkipped: boolean
  readonly entries: ReadonlyArray<StoredEntry>
  /** Entries left as they stood because their Run was already in flight. */
  readonly preserved: ReadonlyArray<string>
  readonly removed: number
}

type SubmitError =
  | UserError
  | AwsError
  | CloudflareError
  | GcpError
  | DockerError
  | GitError
  | ConfigError

/**
 * The developer's side of a [[Schedule]]: submitting one, reading it back,
 * withdrawing it. The tick is the other side and lives in `Scheduler`.
 *
 * Submit is where every refusal belongs. It runs four gates cheapest-first so
 * a typo never costs a ten-minute build, and so an expired session is found
 * before any row is written.
 */
export class ScheduleService extends Context.Tag("ScheduleService")<
  ScheduleService,
  {
    readonly submit: (input: {
      readonly content: string
      readonly source: string
    }) => Effect.Effect<SubmitReport, SubmitError>
    readonly list: (
      scheduleId?: string,
    ) => Effect.Effect<ReadonlyArray<StoredEntry>, SubmitError>
    readonly cancel: (scheduleId: string) => Effect.Effect<number, SubmitError>
  }
>() {}

export const ScheduleServiceLive = Layer.effect(
  ScheduleService,
  Effect.gen(function* () {
    const git = yield* Git
    const build = yield* BuildService
    const cfg = yield* ConfigService
    const compute = yield* Compute
    const store = yield* ScheduleStore

    return ScheduleService.of({
      submit: ({ content, source }) =>
        Effect.gen(function* () {
          // Read the clock once and inject it: every gate and every Entry's
          // first occurrence is resolved against the same instant.
          const submittedAt = new Date()

          // (a) Schema + graph. Nothing is built and nothing is written until
          // the whole file is sound, and every problem is reported at once.
          const raw = yield* Effect.try({
            try: () => parseYaml(content) as unknown,
            catch: (cause) =>
              new UserError({
                message: `${source} is not valid YAML: ${String(cause)}`,
              }),
          })
          const file = yield* Schema.decodeUnknown(ScheduleFile)(raw).pipe(
            Effect.mapError(
              (e) =>
                new UserError({
                  message: `${source} is not a Schedule: ${String(e)}`,
                  hint: "A Schedule is `schedule: <id>` plus `entries:`, each with id, ref, command and trigger.",
                }),
            ),
          )
          const problems = validateEntries(
            file.entries.map((e) => ({ id: e.id, trigger: e.trigger })),
            submittedAt.getTime(),
          )
          if (problems.length > 0) {
            return yield* Effect.fail(
              new UserError({
                message: `${source} is not a valid Schedule:\n  - ${problems.join("\n  - ")}`,
              }),
            )
          }

          // (b) Every ref exists on origin — at the developer's desk, not at
          // 3am. One ls-remote per distinct ref; no work tree needed.
          const { config } = yield* cfg.load
          const refs = [...new Set(file.entries.map((e) => e.ref))]
          yield* Effect.all(
            refs.map((ref) => git.resolveRemoteRef(config.gitUrl, ref)),
            { concurrency: 4 },
          )

          // (c) Build the environment once and pin it on every Entry. The
          // image is the environment, identical for all of them, so one build
          // serves the whole Schedule rather than one per branch.
          const region = config.aws?.region ?? DEFAULT_REGION
          const built = yield* build.build({ region })

          // (d) Write. An expired session surfaces here, before any row lands.
          const owner = yield* compute.callerPrincipal
          const submittedAtIso = submittedAt.toISOString()
          const defaultTimeout =
            config.defaultTimeoutHours ?? DEFAULT_TIMEOUT_HOURS

          const entries = file.entries.map((e): StoredEntry => {
            const parsed = parseTrigger(e.trigger)
            // validateEntries already refused anything unparseable.
            const dueMs = Either.isRight(parsed)
              ? firstDueAt(parsed.right, submittedAt.getTime())
              : undefined
            return {
              scheduleId: file.schedule,
              entryId: e.id,
              state: "pending",
              trigger: e.trigger,
              ref: e.ref,
              command: e.command,
              image: built.image,
              owner: owner.id,
              timeoutHours: e.timeoutHours ?? defaultTimeout,
              onDemand: e.onDemand ?? false,
              ...(e.instanceType ? { instanceType: e.instanceType } : {}),
              submittedAt: submittedAtIso,
              launchAttempts: 0,
              ...(dueMs !== undefined
                ? { notBefore: new Date(dueMs).toISOString() }
                : {}),
            }
          })

          const result = yield* store.replace(file.schedule, entries)
          return {
            scheduleId: file.schedule,
            image: built.image,
            imageSkipped: built.skipped,
            entries,
            preserved: result.preserved,
            removed: result.removed,
          }
        }),

      list: (scheduleId) => store.list(scheduleId),
      cancel: (scheduleId) => store.cancel(scheduleId),
    })
  }),
)
