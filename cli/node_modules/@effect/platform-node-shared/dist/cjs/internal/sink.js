"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.fromWritableChannel = exports.fromWritable = void 0;
var Channel = _interopRequireWildcard(require("effect/Channel"));
var Deferred = _interopRequireWildcard(require("effect/Deferred"));
var Effect = _interopRequireWildcard(require("effect/Effect"));
var Sink = _interopRequireWildcard(require("effect/Sink"));
var _stream = require("./stream.js");
function _getRequireWildcardCache(e) { if ("function" != typeof WeakMap) return null; var r = new WeakMap(), t = new WeakMap(); return (_getRequireWildcardCache = function (e) { return e ? t : r; })(e); }
function _interopRequireWildcard(e, r) { if (!r && e && e.__esModule) return e; if (null === e || "object" != typeof e && "function" != typeof e) return { default: e }; var t = _getRequireWildcardCache(r); if (t && t.has(e)) return t.get(e); var n = { __proto__: null }, a = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var u in e) if ("default" !== u && {}.hasOwnProperty.call(e, u)) { var i = a ? Object.getOwnPropertyDescriptor(e, u) : null; i && (i.get || i.set) ? Object.defineProperty(n, u, i) : n[u] = e[u]; } return n.default = e, t && t.set(e, n), n; }
/** @internal */
const fromWritable = (evaluate, onError, options) => Sink.fromChannel(fromWritableChannel(evaluate, onError, options));
/** @internal */
exports.fromWritable = fromWritable;
const fromWritableChannel = (writable, onError, options) => Channel.flatMap(Effect.zip(Effect.sync(() => writable()), Deferred.make()), ([writable, deferred]) => Channel.embedInput(writableOutput(writable, deferred, onError), (0, _stream.writeInput)(writable, cause => Deferred.failCause(deferred, cause), options, Deferred.complete(deferred, Effect.void))));
exports.fromWritableChannel = fromWritableChannel;
const writableOutput = (writable, deferred, onError) => Effect.suspend(() => {
  function handleError(err) {
    Deferred.unsafeDone(deferred, Effect.fail(onError(err)));
  }
  writable.on("error", handleError);
  return Effect.ensuring(Deferred.await(deferred), Effect.sync(() => {
    writable.removeListener("error", handleError);
  }));
});
//# sourceMappingURL=sink.js.map