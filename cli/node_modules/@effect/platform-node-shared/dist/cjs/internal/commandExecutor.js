"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.layer = void 0;
var Command = _interopRequireWildcard(require("@effect/platform/Command"));
var CommandExecutor = _interopRequireWildcard(require("@effect/platform/CommandExecutor"));
var FileSystem = _interopRequireWildcard(require("@effect/platform/FileSystem"));
var Deferred = _interopRequireWildcard(require("effect/Deferred"));
var Effect = _interopRequireWildcard(require("effect/Effect"));
var _Function = require("effect/Function");
var Inspectable = _interopRequireWildcard(require("effect/Inspectable"));
var Layer = _interopRequireWildcard(require("effect/Layer"));
var Option = _interopRequireWildcard(require("effect/Option"));
var Sink = _interopRequireWildcard(require("effect/Sink"));
var Stream = _interopRequireWildcard(require("effect/Stream"));
var ChildProcess = _interopRequireWildcard(require("node:child_process"));
var _error = require("./error.js");
var _sink = require("./sink.js");
var _stream = require("./stream.js");
function _getRequireWildcardCache(e) { if ("function" != typeof WeakMap) return null; var r = new WeakMap(), t = new WeakMap(); return (_getRequireWildcardCache = function (e) { return e ? t : r; })(e); }
function _interopRequireWildcard(e, r) { if (!r && e && e.__esModule) return e; if (null === e || "object" != typeof e && "function" != typeof e) return { default: e }; var t = _getRequireWildcardCache(r); if (t && t.has(e)) return t.get(e); var n = { __proto__: null }, a = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var u in e) if ("default" !== u && {}.hasOwnProperty.call(e, u)) { var i = a ? Object.getOwnPropertyDescriptor(e, u) : null; i && (i.get || i.set) ? Object.defineProperty(n, u, i) : n[u] = e[u]; } return n.default = e, t && t.set(e, n), n; }
const inputToStdioOption = stdin => typeof stdin === "string" ? stdin : "pipe";
const outputToStdioOption = output => typeof output === "string" ? output : "pipe";
const toError = err => err instanceof globalThis.Error ? err : new globalThis.Error(String(err));
const toPlatformError = (method, error, command) => {
  const flattened = Command.flatten(command).reduce((acc, curr) => {
    const command = `${curr.command} ${curr.args.join(" ")}`;
    return acc.length === 0 ? command : `${acc} | ${command}`;
  }, "");
  return (0, _error.handleErrnoException)("Command", method)(error, [flattened]);
};
const ProcessProto = {
  [CommandExecutor.ProcessTypeId]: CommandExecutor.ProcessTypeId,
  ...Inspectable.BaseProto,
  toJSON() {
    return {
      _id: "@effect/platform/CommandExecutor/Process",
      pid: this.pid
    };
  }
};
const runCommand = fileSystem => command => {
  switch (command._tag) {
    case "StandardCommand":
      {
        const spawn = Effect.flatMap(Deferred.make(), exitCode => Effect.async(resume => {
          const handle = ChildProcess.spawn(command.command, command.args, {
            stdio: [inputToStdioOption(command.stdin), outputToStdioOption(command.stdout), outputToStdioOption(command.stderr)],
            cwd: Option.getOrElse(command.cwd, _Function.constUndefined),
            shell: command.shell,
            env: {
              ...process.env,
              ...Object.fromEntries(command.env)
            }
          });
          handle.on("error", err => {
            resume(Effect.fail(toPlatformError("spawn", err, command)));
          });
          handle.on("exit", (...args) => {
            Deferred.unsafeDone(exitCode, Effect.succeed(args));
          });
          handle.on("spawn", () => {
            resume(Effect.succeed([handle, exitCode]));
          });
          return Effect.sync(() => {
            handle.kill("SIGTERM");
          });
        }));
        return (0, _Function.pipe)(
        // Validate that the directory is accessible
        Option.match(command.cwd, {
          onNone: () => Effect.void,
          onSome: dir => fileSystem.access(dir)
        }), Effect.zipRight(Effect.acquireRelease(spawn, ([handle, exitCode]) => Effect.flatMap(Deferred.isDone(exitCode), done => done ? Effect.void : Effect.suspend(() => {
          if (handle.kill("SIGTERM")) {
            return Deferred.await(exitCode);
          }
          return Effect.void;
        })))), Effect.map(([handle, exitCodeDeferred]) => {
          let stdin = Sink.drain;
          if (handle.stdin !== null) {
            stdin = (0, _sink.fromWritable)(() => handle.stdin, err => toPlatformError("toWritable", toError(err), command));
          }
          const exitCode = Effect.flatMap(Deferred.await(exitCodeDeferred), ([code, signal]) => {
            if (code !== null) {
              return Effect.succeed(CommandExecutor.ExitCode(code));
            }
            // If code is `null`, then `signal` must be defined. See the NodeJS
            // documentation for the `"exit"` event on a `child_process`.
            // https://nodejs.org/api/child_process.html#child_process_event_exit
            return Effect.fail(toPlatformError("exitCode", new globalThis.Error(`Process interrupted due to receipt of signal: ${signal}`), command));
          });
          const isRunning = Effect.negate(Deferred.isDone(exitCodeDeferred));
          const kill = (signal = "SIGTERM") => Effect.suspend(() => handle.kill(signal) ? Effect.asVoid(Deferred.await(exitCodeDeferred)) : Effect.fail(toPlatformError("kill", new globalThis.Error("Failed to kill process"), command)));
          const pid = CommandExecutor.ProcessId(handle.pid);
          const stderr = (0, _stream.fromReadable)(() => handle.stderr, err => toPlatformError("fromReadable(stderr)", toError(err), command));
          let stdout = (0, _stream.fromReadable)(() => handle.stdout, err => toPlatformError("fromReadable(stdout)", toError(err), command));
          // TODO: add Sink.isSink
          if (typeof command.stdout !== "string") {
            stdout = Stream.transduce(stdout, command.stdout);
          }
          return Object.assign(Object.create(ProcessProto), {
            pid,
            exitCode,
            isRunning,
            kill,
            stdin,
            stderr,
            stdout
          });
        }), typeof command.stdin === "string" ? _Function.identity : Effect.tap(process => Effect.forkDaemon(Stream.run(command.stdin, process.stdin))));
      }
    case "PipedCommand":
      {
        const flattened = Command.flatten(command);
        if (flattened.length === 1) {
          return (0, _Function.pipe)(flattened[0], runCommand(fileSystem));
        }
        const head = flattened[0];
        const tail = flattened.slice(1);
        const initial = tail.slice(0, tail.length - 1);
        const last = tail[tail.length - 1];
        const stream = initial.reduce((stdin, command) => (0, _Function.pipe)(Command.stdin(command, stdin), runCommand(fileSystem), Effect.map(process => process.stdout), Stream.unwrapScoped), (0, _Function.pipe)(runCommand(fileSystem)(head), Effect.map(process => process.stdout), Stream.unwrapScoped));
        return (0, _Function.pipe)(Command.stdin(last, stream), runCommand(fileSystem));
      }
  }
};
/** @internal */
const layer = exports.layer = /*#__PURE__*/Layer.effect(CommandExecutor.CommandExecutor, /*#__PURE__*/(0, _Function.pipe)(FileSystem.FileSystem, /*#__PURE__*/Effect.map(fileSystem => CommandExecutor.makeExecutor(runCommand(fileSystem)))));
//# sourceMappingURL=commandExecutor.js.map