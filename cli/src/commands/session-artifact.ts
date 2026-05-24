import { Args, Command, Options, Prompt } from "@effect/cli"
import { DateTime, Duration, Effect, Option } from "effect"
import type { Terminal } from "@effect/platform"
import { RunService } from "../services/RunService.ts"
import { SessionArtifactStore } from "../services/backend/SessionArtifactStore.ts"
import { ConfigService } from "../services/ConfigService.ts"
import {
  HistoryService,
  type RunHistoryRow,
} from "../services/HistoryService.ts"
import { Output } from "../infra/Output.ts"
import { UserError } from "../infra/Errors.ts"
import { SESSION_ARTIFACT_DIR } from "../constants.ts"

const runId = Args.text({ name: "run-id" }).pipe(Args.optional)
const out = Options.directory("out", { exists: "either" }).pipe(
  Options.withDefault(SESSION_ARTIFACT_DIR),
  Options.withDescription(
    `directory to write the retrieved Session Artifact(s) into (default: ./${SESSION_ARTIFACT_DIR})`,
  ),
)

const choiceTitle = (r: RunHistoryRow): string => {
  const id = r.runId.length > 8 ? `${r.runId.slice(0, 8)}…` : r.runId
  const when = r.startedAt.replace("T", " ").replace(/\..*$/, "")
  return `${id}  ${r.status.padEnd(7)}  ${r.branch}  ${when}`
}

/** Same affordance as `afk logs`: with no run-id and a TTY, pick from recent
 * Runs rather than copying an id; without a TTY, error instead of hanging. */
const pickRunId = (
  hist: typeof HistoryService.Service,
): Effect.Effect<Option.Option<string>, UserError, Terminal.Terminal> =>
  Effect.gen(function* () {
    const since = DateTime.subtractDuration(
      yield* DateTime.now,
      Duration.days(30),
    )
    const rows = yield* hist
      .query({ since, limit: 25 })
      .pipe(
        Effect.catchAll((e) =>
          Effect.fail(new UserError({ message: String(e) })),
        ),
      )
    if (rows.length === 0) {
      return yield* Effect.fail(
        new UserError({ message: "No Runs in history to choose from." }),
      )
    }
    if (!process.stdout.isTTY) {
      return yield* Effect.fail(
        new UserError({
          message: "No run-id given and stdout is not a terminal.",
          hint: "Pass a run-id (see `afk history`).",
        }),
      )
    }
    return yield* Prompt.select({
      message: "Select a Run",
      choices: rows.map((r) => ({ title: choiceTitle(r), value: r.runId })),
      maxPerPage: 15,
    }).pipe(
      Effect.map(Option.some),
      Effect.catchTag("QuitException", () =>
        Effect.succeed(Option.none<string>()),
      ),
    )
  })

export const sessionArtifact = Command.make(
  "session-artifact",
  { runId, out },
  ({ runId, out }) =>
    Effect.gen(function* () {
      const runs = yield* RunService
      const store = yield* SessionArtifactStore
      const cfg = yield* ConfigService
      const hist = yield* HistoryService
      const output = yield* Output

      const picked =
        runId._tag === "Some"
          ? Option.some(runId.value)
          : yield* pickRunId(hist)
      if (Option.isNone(picked)) return
      const resolvedRunId = picked.value

      // findByRunId enforces the same Owner scoping as `afk logs` — you can only
      // retrieve artifacts for Runs you own.
      yield* runs.findByRunId(resolvedRunId)

      const { config, sourceRepoName } = yield* cfg.load
      const patterns = config.sessionArtifacts ?? []
      if (patterns.length === 0) {
        return yield* Effect.fail(
          new UserError({
            message: "No `sessionArtifacts` declared in afk.config.json.",
            hint: 'Add e.g. "sessionArtifacts": ["/root/.claude/projects/**/*.jsonl"] and re-run the Run.',
          }),
        )
      }

      const result = yield* store.fetch({
        runId: resolvedRunId,
        repoName: sourceRepoName,
        patterns,
        outDir: out,
      })

      for (const path of result.skipped) {
        yield* Effect.logWarning(
          `skipped (over size cap): ${path} — not retrieved`,
        )
      }

      yield* output.emit({
        data: { runId: resolvedRunId, written: result.written },
        human: (d) =>
          output.print(
            d.written.length === 0
              ? `No Session Artifact found for ${d.runId}.`
              : [
                  `Retrieved ${d.written.length} file(s) for ${d.runId}:`,
                  ...d.written.map((p) => `  ${p}`),
                ].join("\n"),
          ),
      })
    }),
)
