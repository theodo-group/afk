"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.makeNetChannel = exports.makeNet = exports.layerNet = exports.fromDuplex = exports.NetSocket = void 0;
var Socket = _interopRequireWildcard(require("@effect/platform/Socket"));
var Channel = _interopRequireWildcard(require("effect/Channel"));
var Context = _interopRequireWildcard(require("effect/Context"));
var Deferred = _interopRequireWildcard(require("effect/Deferred"));
var Effect = _interopRequireWildcard(require("effect/Effect"));
var FiberSet = _interopRequireWildcard(require("effect/FiberSet"));
var Layer = _interopRequireWildcard(require("effect/Layer"));
var Scope = _interopRequireWildcard(require("effect/Scope"));
var Net = _interopRequireWildcard(require("node:net"));
function _getRequireWildcardCache(e) { if ("function" != typeof WeakMap) return null; var r = new WeakMap(), t = new WeakMap(); return (_getRequireWildcardCache = function (e) { return e ? t : r; })(e); }
function _interopRequireWildcard(e, r) { if (!r && e && e.__esModule) return e; if (null === e || "object" != typeof e && "function" != typeof e) return { default: e }; var t = _getRequireWildcardCache(r); if (t && t.has(e)) return t.get(e); var n = { __proto__: null }, a = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var u in e) if ("default" !== u && {}.hasOwnProperty.call(e, u)) { var i = a ? Object.getOwnPropertyDescriptor(e, u) : null; i && (i.get || i.set) ? Object.defineProperty(n, u, i) : n[u] = e[u]; } return n.default = e, t && t.set(e, n), n; }
/**
 * @since 1.0.0
 */

/**
 * @since 1.0.0
 * @category tags
 */
const NetSocket = exports.NetSocket = /*#__PURE__*/Context.GenericTag("@effect/platform-node/NodeSocket/NetSocket");
/**
 * @since 1.0.0
 * @category constructors
 */
const makeNet = options => fromDuplex(Effect.acquireRelease(Effect.async(resume => {
  const conn = Net.createConnection(options);
  conn.on("connect", () => {
    conn.removeAllListeners();
    resume(Effect.succeed(conn));
  });
  conn.on("error", cause => {
    resume(Effect.fail(new Socket.SocketGenericError({
      reason: "Open",
      cause
    })));
  });
  return Effect.sync(() => {
    conn.destroy();
  });
}), conn => Effect.sync(() => {
  if (conn.closed === false) {
    if ("destroySoon" in conn) {
      conn.destroySoon();
    } else {
      ;
      conn.destroy();
    }
  }
  conn.removeAllListeners();
})));
/**
 * @since 1.0.0
 * @category constructors
 */
exports.makeNet = makeNet;
const fromDuplex = open => Effect.withFiberRuntime(fiber => {
  let currentSocket;
  const latch = Effect.unsafeMakeLatch(false);
  const openContext = fiber.currentContext;
  const run = handler => Effect.scopedWith(scope => Effect.gen(function* () {
    const fiberSet = yield* FiberSet.make().pipe(Scope.extend(scope));
    const conn = yield* Scope.extend(open, scope);
    const run = yield* Effect.provideService(FiberSet.runtime(fiberSet)(), NetSocket, conn);
    function onData(chunk) {
      const result = handler(chunk);
      if (Effect.isEffect(result)) {
        run(result);
      }
    }
    function onEnd() {
      Deferred.unsafeDone(fiberSet.deferred, Effect.void);
    }
    function onError(cause) {
      Deferred.unsafeDone(fiberSet.deferred, Effect.fail(new Socket.SocketGenericError({
        reason: "Read",
        cause
      })));
    }
    function onClose(hadError) {
      Deferred.unsafeDone(fiberSet.deferred, Effect.fail(new Socket.SocketCloseError({
        reason: "Close",
        code: hadError ? 1006 : 1000
      })));
    }
    yield* Scope.addFinalizer(scope, Effect.sync(() => {
      conn.off("data", onData);
      conn.off("end", onEnd);
      conn.off("error", onError);
      conn.off("close", onClose);
    }));
    conn.on("data", onData);
    conn.on("end", onEnd);
    conn.on("error", onError);
    conn.on("close", onClose);
    currentSocket = conn;
    yield* latch.open;
    return yield* FiberSet.join(fiberSet);
  })).pipe(Effect.mapInputContext(input => Context.merge(openContext, input)), Effect.ensuring(Effect.sync(() => {
    latch.unsafeClose();
    currentSocket = undefined;
  })), Effect.interruptible);
  const write = chunk => latch.whenOpen(Effect.async(resume => {
    const conn = currentSocket;
    if (Socket.isCloseEvent(chunk)) {
      conn.destroy(chunk.code > 1000 ? new Error(`closed with code ${chunk.code}`) : undefined);
      return resume(Effect.void);
    }
    currentSocket.write(chunk, cause => {
      resume(cause ? Effect.fail(new Socket.SocketGenericError({
        reason: "Write",
        cause
      })) : Effect.void);
    });
  }));
  const writer = Effect.acquireRelease(Effect.succeed(write), () => Effect.sync(() => {
    if (!currentSocket || currentSocket.writableEnded) return;
    currentSocket.end();
  }));
  return Effect.succeed(Socket.Socket.of({
    [Socket.TypeId]: Socket.TypeId,
    run,
    runRaw: run,
    writer
  }));
});
/**
 * @since 1.0.0
 * @category constructors
 */
exports.fromDuplex = fromDuplex;
const makeNetChannel = options => Channel.unwrapScoped(Effect.map(makeNet(options), Socket.toChannelWith()));
/**
 * @since 1.0.0
 * @category layers
 */
exports.makeNetChannel = makeNetChannel;
const layerNet = options => Layer.effect(Socket.Socket, makeNet(options));
exports.layerNet = layerNet;
//# sourceMappingURL=NodeSocket.js.map