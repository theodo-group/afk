"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.writeInput = exports.writeEffect = exports.toUint8Array = exports.toString = exports.toReadableNever = exports.toReadable = exports.pipeThroughSimple = exports.pipeThroughDuplex = exports.fromReadableChannel = exports.fromReadable = exports.fromDuplex = void 0;
var _Error = require("@effect/platform/Error");
var Cause = _interopRequireWildcard(require("effect/Cause"));
var Channel = _interopRequireWildcard(require("effect/Channel"));
var Chunk = _interopRequireWildcard(require("effect/Chunk"));
var Effect = _interopRequireWildcard(require("effect/Effect"));
var Exit = _interopRequireWildcard(require("effect/Exit"));
var _Function = require("effect/Function");
var Mailbox = _interopRequireWildcard(require("effect/Mailbox"));
var Runtime = _interopRequireWildcard(require("effect/Runtime"));
var Scope = _interopRequireWildcard(require("effect/Scope"));
var Stream = _interopRequireWildcard(require("effect/Stream"));
var _nodeStream = require("node:stream");
function _getRequireWildcardCache(e) { if ("function" != typeof WeakMap) return null; var r = new WeakMap(), t = new WeakMap(); return (_getRequireWildcardCache = function (e) { return e ? t : r; })(e); }
function _interopRequireWildcard(e, r) { if (!r && e && e.__esModule) return e; if (null === e || "object" != typeof e && "function" != typeof e) return { default: e }; var t = _getRequireWildcardCache(r); if (t && t.has(e)) return t.get(e); var n = { __proto__: null }, a = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var u in e) if ("default" !== u && {}.hasOwnProperty.call(e, u)) { var i = a ? Object.getOwnPropertyDescriptor(e, u) : null; i && (i.get || i.set) ? Object.defineProperty(n, u, i) : n[u] = e[u]; } return n.default = e, t && t.set(e, n), n; }
/** @internal */
const fromReadable = (evaluate, onError, {
  chunkSize
} = {}) => Stream.fromChannel(fromReadableChannel(evaluate, onError, chunkSize ? Number(chunkSize) : undefined));
/** @internal */
exports.fromReadable = fromReadable;
const toString = (readable, options) => {
  const maxBytesNumber = options.maxBytes ? Number(options.maxBytes) : undefined;
  return Effect.acquireUseRelease(Effect.sync(() => {
    const stream = readable();
    stream.setEncoding(options.encoding ?? "utf8");
    return stream;
  }), stream => Effect.async(resume => {
    let string = "";
    let bytes = 0;
    stream.once("error", err => {
      resume(Effect.fail(options.onFailure(err)));
    });
    stream.once("end", () => {
      resume(Effect.succeed(string));
    });
    stream.on("data", chunk => {
      string += chunk;
      bytes += Buffer.byteLength(chunk);
      if (maxBytesNumber && bytes > maxBytesNumber) {
        resume(Effect.fail(options.onFailure(new Error("maxBytes exceeded"))));
      }
    });
  }), stream => Effect.sync(() => {
    if ("closed" in stream && !stream.closed) {
      stream.destroy();
    }
  }));
};
/** @internal */
exports.toString = toString;
const toUint8Array = (readable, options) => {
  const maxBytesNumber = options.maxBytes ? Number(options.maxBytes) : undefined;
  return Effect.acquireUseRelease(Effect.sync(readable), stream => Effect.async(resume => {
    let buffer = Buffer.alloc(0);
    let bytes = 0;
    stream.once("error", err => {
      resume(Effect.fail(options.onFailure(err)));
    });
    stream.once("end", () => {
      resume(Effect.succeed(buffer));
    });
    stream.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      bytes += chunk.length;
      if (maxBytesNumber && bytes > maxBytesNumber) {
        resume(Effect.fail(options.onFailure(new Error("maxBytes exceeded"))));
      }
    });
  }), stream => Effect.sync(() => {
    if ("closed" in stream && !stream.closed) {
      stream.destroy();
    }
  }));
};
/** @internal */
exports.toUint8Array = toUint8Array;
const fromDuplex = (evaluate, onError, options = {}) => Channel.acquireUseRelease(Effect.tap(Effect.zip(Effect.sync(evaluate), Mailbox.make()), ([duplex, mailbox]) => readableOffer(duplex, mailbox, onError)), ([duplex, mailbox]) => Channel.embedInput(readableTake(duplex, mailbox, options.chunkSize ? Number(options.chunkSize) : undefined), writeInput(duplex, cause => mailbox.failCause(cause), options)), ([duplex, mailbox]) => Effect.zipRight(Effect.sync(() => {
  if (!duplex.closed) {
    duplex.destroy();
  }
}), mailbox.shutdown));
/** @internal */
exports.fromDuplex = fromDuplex;
const pipeThroughDuplex = exports.pipeThroughDuplex = /*#__PURE__*/(0, _Function.dual)(args => Stream.StreamTypeId in args[0], (self, duplex, onError, options) => Stream.pipeThroughChannelOrFail(self, fromDuplex(duplex, onError, options)));
/** @internal */
const pipeThroughSimple = exports.pipeThroughSimple = /*#__PURE__*/(0, _Function.dual)(2, (self, duplex) => Stream.pipeThroughChannelOrFail(self, fromDuplex(duplex, error => (0, _Error.SystemError)({
  module: "Stream",
  method: "pipeThroughSimple",
  pathOrDescriptor: "",
  reason: "Unknown",
  message: String(error)
}))));
/** @internal */
const fromReadableChannel = (evaluate, onError, chunkSize) => Channel.acquireUseRelease(Effect.tap(Effect.zip(Effect.sync(evaluate), Mailbox.make()), ([readable, mailbox]) => readableOffer(readable, mailbox, onError)), ([readable, mailbox]) => readableTake(readable, mailbox, chunkSize), ([readable, mailbox]) => Effect.zipRight(Effect.sync(() => {
  if ("closed" in readable && !readable.closed) {
    readable.destroy();
  }
}), mailbox.shutdown));
/** @internal */
exports.fromReadableChannel = fromReadableChannel;
const writeInput = (writable, onFailure, {
  encoding,
  endOnDone = true
} = {}, onDone = Effect.void) => {
  const write = writeEffect(writable, encoding);
  const close = endOnDone ? Effect.async(resume => {
    if ("closed" in writable && writable.closed) {
      resume(Effect.void);
    } else {
      writable.once("finish", () => resume(Effect.void));
      writable.end();
    }
  }) : Effect.void;
  return {
    awaitRead: () => Effect.void,
    emit: write,
    error: cause => Effect.zipRight(close, onFailure(cause)),
    done: _ => Effect.zipRight(close, onDone)
  };
};
/** @internal */
exports.writeInput = writeInput;
const writeEffect = (writable, encoding) => chunk => chunk.length === 0 ? Effect.void : Effect.async(resume => {
  const iterator = chunk[Symbol.iterator]();
  let next = iterator.next();
  function loop() {
    const item = next;
    next = iterator.next();
    const success = writable.write(item.value, encoding);
    if (next.done) {
      resume(Effect.void);
    } else if (success) {
      loop();
    } else {
      writable.once("drain", loop);
    }
  }
  loop();
});
exports.writeEffect = writeEffect;
const readableOffer = (readable, mailbox, onError) => Effect.sync(() => {
  readable.on("readable", () => {
    mailbox.unsafeOffer(void 0);
  });
  readable.on("error", err => {
    mailbox.unsafeDone(Exit.fail(onError(err)));
  });
  readable.on("end", () => {
    mailbox.unsafeDone(Exit.void);
  });
  if (readable.readable) {
    mailbox.unsafeOffer(void 0);
  }
});
const readableTake = (readable, mailbox, chunkSize) => {
  const read = readChunkChannel(readable, chunkSize);
  const loop = Channel.flatMap(mailbox.takeAll, ([, done]) => done ? read : Channel.zipRight(read, loop));
  return loop;
};
const readChunkChannel = (readable, chunkSize) => Channel.suspend(() => {
  const arr = [];
  let chunk = readable.read(chunkSize);
  if (chunk === null) {
    return Channel.void;
  }
  while (chunk !== null) {
    arr.push(chunk);
    chunk = readable.read(chunkSize);
  }
  return Channel.write(Chunk.unsafeFromArray(arr));
});
class StreamAdapter extends _nodeStream.Readable {
  runtime;
  stream;
  scope;
  pull;
  constructor(runtime, stream) {
    super({});
    this.runtime = runtime;
    this.stream = stream;
    this.scope = Effect.runSync(Scope.make());
    const pull = Stream.toPull(this.stream).pipe(Scope.extend(this.scope), Runtime.runSync(this.runtime), Effect.map(Chunk.toReadonlyArray), Effect.catchAll(error => error._tag === "None" ? Effect.succeed(null) : Effect.fail(error.value)));
    const runFork = Runtime.runFork(this.runtime);
    this.pull = function (done) {
      runFork(pull).addObserver(exit => {
        done(exit._tag === "Failure" ? new Error("failure in StreamAdapter", {
          cause: Cause.squash(exit.cause)
        }) : null, exit._tag === "Success" ? exit.value : null);
      });
    };
  }
  _read(_size) {
    this.pull((error, data) => {
      if (error !== null) {
        this._destroy(error, () => {});
      } else if (data === null) {
        this.push(null);
      } else {
        for (let i = 0; i < data.length; i++) {
          const chunk = data[i];
          if (typeof chunk === "string") {
            this.push(chunk, "utf8");
          } else {
            this.push(chunk);
          }
        }
      }
    });
  }
  _destroy(_error, callback) {
    Runtime.runFork(this.runtime)(Scope.close(this.scope, Exit.void)).addObserver(exit => {
      callback(exit._tag === "Failure" ? Cause.squash(exit.cause) : null);
    });
  }
}
/** @internal */
const toReadable = stream => Effect.map(Effect.runtime(), runtime => new StreamAdapter(runtime, stream));
/** @internal */
exports.toReadable = toReadable;
const toReadableNever = stream => new StreamAdapter(Runtime.defaultRuntime, stream);
exports.toReadableNever = toReadableNever;
//# sourceMappingURL=stream.js.map