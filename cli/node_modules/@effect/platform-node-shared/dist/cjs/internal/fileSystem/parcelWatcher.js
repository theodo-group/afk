"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.layer = void 0;
var Error = _interopRequireWildcard(require("@effect/platform/Error"));
var FileSystem = _interopRequireWildcard(require("@effect/platform/FileSystem"));
var ParcelWatcher = _interopRequireWildcard(require("@parcel/watcher"));
var Chunk = _interopRequireWildcard(require("effect/Chunk"));
var Effect = _interopRequireWildcard(require("effect/Effect"));
var Layer = _interopRequireWildcard(require("effect/Layer"));
var Option = _interopRequireWildcard(require("effect/Option"));
var Stream = _interopRequireWildcard(require("effect/Stream"));
function _getRequireWildcardCache(e) { if ("function" != typeof WeakMap) return null; var r = new WeakMap(), t = new WeakMap(); return (_getRequireWildcardCache = function (e) { return e ? t : r; })(e); }
function _interopRequireWildcard(e, r) { if (!r && e && e.__esModule) return e; if (null === e || "object" != typeof e && "function" != typeof e) return { default: e }; var t = _getRequireWildcardCache(r); if (t && t.has(e)) return t.get(e); var n = { __proto__: null }, a = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var u in e) if ("default" !== u && {}.hasOwnProperty.call(e, u)) { var i = a ? Object.getOwnPropertyDescriptor(e, u) : null; i && (i.get || i.set) ? Object.defineProperty(n, u, i) : n[u] = e[u]; } return n.default = e, t && t.set(e, n), n; }
const watchParcel = path => Stream.asyncScoped(emit => Effect.acquireRelease(Effect.tryPromise({
  try: () => ParcelWatcher.subscribe(path, (error, events) => {
    if (error) {
      emit.fail(Error.SystemError({
        reason: "Unknown",
        module: "FileSystem",
        method: "watch",
        pathOrDescriptor: path,
        message: error.message
      }));
    } else {
      emit.chunk(Chunk.unsafeFromArray(events.map(event => {
        switch (event.type) {
          case "create":
            {
              return FileSystem.WatchEventCreate({
                path: event.path
              });
            }
          case "update":
            {
              return FileSystem.WatchEventUpdate({
                path: event.path
              });
            }
          case "delete":
            {
              return FileSystem.WatchEventRemove({
                path: event.path
              });
            }
        }
      })));
    }
  }),
  catch: error => Error.SystemError({
    reason: "Unknown",
    module: "FileSystem",
    method: "watch",
    pathOrDescriptor: path,
    message: error.message
  })
}), sub => Effect.promise(() => sub.unsubscribe())));
const backend = /*#__PURE__*/FileSystem.WatchBackend.of({
  register(path, stat) {
    if (stat.type !== "Directory") {
      return Option.none();
    }
    return Option.some(watchParcel(path));
  }
});
const layer = exports.layer = /*#__PURE__*/Layer.succeed(FileSystem.WatchBackend, backend);
//# sourceMappingURL=parcelWatcher.js.map