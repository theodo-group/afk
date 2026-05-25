import { Context, Effect, Layer } from "effect"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Subprocess } from "../../infra/Subprocess.ts"
import { GcpError } from "../../infra/Errors.ts"
import { makeGcloudCli } from "./gcloudCli.ts"
import { AFK_RUN_NETWORK_TAG } from "../../constants.ts"

export interface Label {
  readonly key: string
  readonly value: string
}

export interface CreateInstanceInput {
  readonly project: string
  readonly zone: string
  readonly name: string
  readonly machineType: string
  readonly image: string
  readonly serviceAccount: string
  readonly subnet: string
  readonly startupScript: string
  /** Wall-clock cap; the instance self-deletes (instance_termination_action) at expiry. */
  readonly maxRunDurationSeconds: number
  readonly labels: ReadonlyArray<Label>
}

export interface GceInstance {
  readonly name: string
  readonly id: string
  readonly status: string // PROVISIONING | STAGING | RUNNING | STOPPING | TERMINATED | …
  readonly machineType: string
  readonly zone: string
  readonly creationTimestamp?: string
  readonly labels: ReadonlyArray<Label>
}

export interface ListInstancesInput {
  readonly project: string
  readonly zone: string
  /** Label equality filters, ANDed. */
  readonly labelFilters: ReadonlyArray<Label>
}

export interface CreateImageInput {
  readonly project: string
  readonly name: string
  readonly family: string
  readonly sourceDisk: string
  readonly sourceDiskZone: string
  readonly labels: ReadonlyArray<Label>
  /**
   * Free-text image description. GCE labels can't hold a comma-joined image
   * list (charset/length limits), so the golden builder stashes the pre-pulled
   * `cachedImages` list here — the analogue of the AWS `afk:cached-images` tag.
   */
  readonly description?: string
}

export interface GceImage {
  readonly name: string
  readonly family?: string
  readonly status: string // PENDING | READY | FAILED | DELETING
  readonly creationTimestamp?: string
  readonly selfLink: string
  readonly labels: ReadonlyArray<Label>
  readonly description?: string
}

const labelsToMap = (
  raw: Readonly<Record<string, string>> | undefined,
): Label[] => Object.entries(raw ?? {}).map(([key, value]) => ({ key, value }))

const labelsArg = (labels: ReadonlyArray<Label>): string =>
  labels.map((l) => `${l.key}=${l.value}`).join(",")

const labelFilterArg = (labels: ReadonlyArray<Label>): string =>
  labels.map((l) => `labels.${l.key}=${l.value}`).join(" AND ")

// The trailing segment of a GCE machine-type / zone URL is the human name.
const lastSegment = (url: string): string => url.split("/").pop() ?? url

export class Gce extends Context.Tag("Gce")<
  Gce,
  {
    readonly createInstance: (
      input: CreateInstanceInput,
    ) => Effect.Effect<{ readonly name: string }, GcpError>
    readonly listInstances: (
      input: ListInstancesInput,
    ) => Effect.Effect<ReadonlyArray<GceInstance>, GcpError>
    readonly describeInstance: (
      project: string,
      zone: string,
      name: string,
    ) => Effect.Effect<GceInstance | null, GcpError>
    readonly deleteInstance: (
      project: string,
      zone: string,
      name: string,
    ) => Effect.Effect<void, GcpError>
    readonly startInstance: (
      project: string,
      zone: string,
      name: string,
    ) => Effect.Effect<void, GcpError>
    readonly stopInstance: (
      project: string,
      zone: string,
      name: string,
    ) => Effect.Effect<void, GcpError>

    readonly createImage: (
      input: CreateImageInput,
    ) => Effect.Effect<{ readonly name: string }, GcpError>
    readonly listImages: (
      project: string,
      family: string,
    ) => Effect.Effect<ReadonlyArray<GceImage>, GcpError>
    readonly deleteImage: (
      project: string,
      name: string,
    ) => Effect.Effect<void, GcpError>
  }
>() {}

export const GceLive = Layer.effect(
  Gce,
  Effect.gen(function* () {
    const sub = yield* Subprocess
    const gcloud = makeGcloudCli(sub)

    // Stash the startup-script in a temp file and pass it via
    // `--metadata-from-file`. The inline `--metadata=startup-script=<value>`
    // form goes through gcloud's dict-arg parser, which trips over `[`, `]`,
    // `,` and other YAML/JSON metacharacters that show up legitimately inside
    // a compose file (e.g. `test: ["CMD", "healthcheck.sh"]`). Reading from a
    // file sidesteps that parser entirely.
    const writeStartupScript = (script: string): string => {
      const dir = mkdtempSync(join(tmpdir(), "afk-startup-"))
      const path = join(dir, "startup.sh")
      writeFileSync(path, script)
      return path
    }

    const createInstance = (input: CreateInstanceInput) =>
      Effect.gen(function* () {
        const startupScriptPath = yield* Effect.try({
          try: () => writeStartupScript(input.startupScript),
          catch: (cause) =>
            new GcpError({
              operation: "compute:instances:create",
              message: `failed to stage startup-script tempfile: ${cause}`,
            }),
        })
        return yield* gcloud.json<ReadonlyArray<{ name: string }>>(
          "compute:instances:create",
          [
            "compute",
            "instances",
            "create",
            input.name,
            `--project=${input.project}`,
            `--zone=${input.zone}`,
            `--machine-type=${input.machineType}`,
            `--image=${input.image}`,
            `--service-account=${input.serviceAccount}`,
            `--subnet=${input.subnet}`,
            // No external IP: egress is via Cloud NAT, ingress via IAP only.
            "--no-address",
            // Wall-clock backstop: GCE deletes the instance when the cap elapses.
            `--max-run-duration=${input.maxRunDurationSeconds}s`,
            "--instance-termination-action=DELETE",
            "--scopes=https://www.googleapis.com/auth/cloud-platform",
            // Network tag required by the Terraform-managed IAP allow rule (and
            // the deny-ingress catch-all). Without it the VM is unreachable.
            `--tags=${AFK_RUN_NETWORK_TAG}`,
            `--labels=${labelsArg(input.labels)}`,
            `--metadata-from-file=startup-script=${startupScriptPath}`,
          ],
        )
      })
        .pipe(
          Effect.flatMap((rows) => {
            const first = rows[0]
            return first
              ? Effect.succeed({ name: first.name })
              : Effect.fail(
                  new GcpError({
                    operation: "compute:instances:create",
                    message: "no instance returned",
                  }),
                )
          }),
        )

    const toInstance = (i: {
      name: string
      id: string
      status?: string
      machineType: string
      zone: string
      creationTimestamp?: string
      labels?: Readonly<Record<string, string>>
    }): GceInstance => ({
      name: i.name,
      id: i.id,
      status: i.status ?? "UNKNOWN",
      machineType: lastSegment(i.machineType),
      zone: lastSegment(i.zone),
      creationTimestamp: i.creationTimestamp,
      labels: labelsToMap(i.labels),
    })

    const listInstances = (input: ListInstancesInput) =>
      gcloud
        .json<
          ReadonlyArray<{
            name: string
            id: string
            status?: string
            machineType: string
            zone: string
            creationTimestamp?: string
            labels?: Readonly<Record<string, string>>
          }>
        >("compute:instances:list", [
          "compute",
          "instances",
          "list",
          `--project=${input.project}`,
          `--zones=${input.zone}`,
          `--filter=${labelFilterArg(input.labelFilters)}`,
        ])
        .pipe(Effect.map((rows) => rows.map(toInstance)))

    const describeInstance = (project: string, zone: string, name: string) =>
      gcloud
        .json<{
          name: string
          id: string
          status?: string
          machineType: string
          zone: string
          creationTimestamp?: string
          labels?: Readonly<Record<string, string>>
        }>("compute:instances:describe", [
          "compute",
          "instances",
          "describe",
          name,
          `--project=${project}`,
          `--zone=${zone}`,
        ])
        .pipe(
          Effect.map((i): GceInstance | null => toInstance(i)),
          // A vanished instance is `null`, not a failure — callers treat a
          // missing Run as "not found" rather than an API error.
          Effect.catchAll((e) =>
            e.message.includes("was not found")
              ? Effect.succeed(null)
              : Effect.fail(e),
          ),
        )

    const deleteInstance = (project: string, zone: string, name: string) =>
      gcloud.run("compute:instances:delete", [
        "compute",
        "instances",
        "delete",
        name,
        `--project=${project}`,
        `--zone=${zone}`,
        "--quiet",
      ])

    const startInstance = (project: string, zone: string, name: string) =>
      gcloud.run("compute:instances:start", [
        "compute",
        "instances",
        "start",
        name,
        `--project=${project}`,
        `--zone=${zone}`,
      ])

    // Stop a running instance and wait for the operation to settle. Required
    // before snapshotting its boot disk: GCE rejects `images create` while the
    // disk is attached to a RUNNING instance (and `--force` is unsafe because
    // the filesystem cache may still hold un-fsynced writes).
    const stopInstance = (project: string, zone: string, name: string) =>
      gcloud.run("compute:instances:stop", [
        "compute",
        "instances",
        "stop",
        name,
        `--project=${project}`,
        `--zone=${zone}`,
      ])

    const createImage = (input: CreateImageInput) =>
      gcloud
        .json<ReadonlyArray<{ name: string }>>("compute:images:create", [
          "compute",
          "images",
          "create",
          input.name,
          `--project=${input.project}`,
          `--family=${input.family}`,
          `--source-disk=${input.sourceDisk}`,
          `--source-disk-zone=${input.sourceDiskZone}`,
          `--labels=${labelsArg(input.labels)}`,
          ...(input.description ? [`--description=${input.description}`] : []),
        ])
        .pipe(
          Effect.flatMap((rows) => {
            const first = rows[0]
            return first
              ? Effect.succeed({ name: first.name })
              : Effect.succeed({ name: input.name })
          }),
        )

    const listImages = (project: string, family: string) =>
      gcloud
        .json<
          ReadonlyArray<{
            name: string
            family?: string
            status?: string
            creationTimestamp?: string
            selfLink: string
            labels?: Readonly<Record<string, string>>
            description?: string
          }>
        >("compute:images:list", [
          "compute",
          "images",
          "list",
          `--project=${project}`,
          `--filter=family=${family}`,
        ])
        .pipe(
          Effect.map((rows) =>
            rows.map<GceImage>((i) => ({
              name: i.name,
              family: i.family,
              status: i.status ?? "UNKNOWN",
              creationTimestamp: i.creationTimestamp,
              selfLink: i.selfLink,
              labels: labelsToMap(i.labels),
              description: i.description,
            })),
          ),
        )

    const deleteImage = (project: string, name: string) =>
      gcloud.run("compute:images:delete", [
        "compute",
        "images",
        "delete",
        name,
        `--project=${project}`,
        "--quiet",
      ])

    return Gce.of({
      createInstance,
      listInstances,
      describeInstance,
      deleteInstance,
      startInstance,
      stopInstance,
      createImage,
      listImages,
      deleteImage,
    })
  }),
)
