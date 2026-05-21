"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.makeRunMain = exports.defaultTeardown = void 0;
var Cause = _interopRequireWildcard(require("effect/Cause"));
var Effect = _interopRequireWildcard(require("effect/Effect"));
var Exit = _interopRequireWildcard(require("effect/Exit"));
var FiberRef = _interopRequireWildcard(require("effect/FiberRef"));
var FiberRefs = _interopRequireWildcard(require("effect/FiberRefs"));
var _Function = require("effect/Function");
var HashSet = _interopRequireWildcard(require("effect/HashSet"));
var Logger = _interopRequireWildcard(require("effect/Logger"));
function _getRequireWildcardCache(e) { if ("function" != typeof WeakMap) return null; var r = new WeakMap(), t = new WeakMap(); return (_getRequireWildcardCache = function (e) { return e ? t : r; })(e); }
function _interopRequireWildcard(e, r) { if (!r && e && e.__esModule) return e; if (null === e || "object" != typeof e && "function" != typeof e) return { default: e }; var t = _getRequireWildcardCache(r); if (t && t.has(e)) return t.get(e); var n = { __proto__: null }, a = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var u in e) if ("default" !== u && {}.hasOwnProperty.call(e, u)) { var i = a ? Object.getOwnPropertyDescriptor(e, u) : null; i && (i.get || i.set) ? Object.defineProperty(n, u, i) : n[u] = e[u]; } return n.default = e, t && t.set(e, n), n; }
/**
 * @since 1.0.0
 */

/**
 * @category teardown
 * @since 1.0.0
 */
const defaultTeardown = (exit, onExit) => {
  onExit(Exit.isFailure(exit) && !Cause.isInterruptedOnly(exit.cause) ? 1 : 0);
};
exports.defaultTeardown = defaultTeardown;
const addPrettyLogger = (refs, fiberId) => {
  const loggers = FiberRefs.getOrDefault(refs, FiberRef.currentLoggers);
  if (!HashSet.has(loggers, Logger.defaultLogger)) {
    return refs;
  }
  return FiberRefs.updateAs(refs, {
    fiberId,
    fiberRef: FiberRef.currentLoggers,
    value: loggers.pipe(HashSet.remove(Logger.defaultLogger), HashSet.add(Logger.prettyLoggerDefault))
  });
};
/**
 * @category constructors
 * @since 1.0.0
 */
const makeRunMain = f => (0, _Function.dual)(args => Effect.isEffect(args[0]), (effect, options) => {
  const fiber = options?.disableErrorReporting === true ? Effect.runFork(effect, {
    updateRefs: options?.disablePrettyLogger === true ? undefined : addPrettyLogger
  }) : Effect.runFork(Effect.tapErrorCause(effect, cause => {
    if (Cause.isInterruptedOnly(cause)) {
      return Effect.void;
    }
    return Effect.logError(cause);
  }), {
    updateRefs: options?.disablePrettyLogger === true ? undefined : addPrettyLogger
  });
  const teardown = options?.teardown ?? defaultTeardown;
  return f({
    fiber,
    teardown
  });
});
exports.makeRunMain = makeRunMain;
//# sourceMappingURL=Runtime.js.map