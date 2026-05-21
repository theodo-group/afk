"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.toUint8Array = exports.toString = exports.toReadableNever = exports.toReadable = exports.pipeThroughSimple = exports.pipeThroughDuplex = exports.fromReadableChannel = exports.fromReadable = exports.fromDuplex = void 0;
var internal = _interopRequireWildcard(require("./internal/stream.js"));
function _getRequireWildcardCache(e) { if ("function" != typeof WeakMap) return null; var r = new WeakMap(), t = new WeakMap(); return (_getRequireWildcardCache = function (e) { return e ? t : r; })(e); }
function _interopRequireWildcard(e, r) { if (!r && e && e.__esModule) return e; if (null === e || "object" != typeof e && "function" != typeof e) return { default: e }; var t = _getRequireWildcardCache(r); if (t && t.has(e)) return t.get(e); var n = { __proto__: null }, a = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var u in e) if ("default" !== u && {}.hasOwnProperty.call(e, u)) { var i = a ? Object.getOwnPropertyDescriptor(e, u) : null; i && (i.get || i.set) ? Object.defineProperty(n, u, i) : n[u] = e[u]; } return n.default = e, t && t.set(e, n), n; }
/**
 * @category constructors
 * @since 1.0.0
 */
const fromReadable = exports.fromReadable = internal.fromReadable;
/**
 * @category constructors
 * @since 1.0.0
 */
const fromReadableChannel = exports.fromReadableChannel = internal.fromReadableChannel;
/**
 * @category constructors
 * @since 1.0.0
 */
const fromDuplex = exports.fromDuplex = internal.fromDuplex;
/**
 * @category combinators
 * @since 1.0.0
 */
const pipeThroughDuplex = exports.pipeThroughDuplex = internal.pipeThroughDuplex;
/**
 * @category combinators
 * @since 1.0.0
 */
const pipeThroughSimple = exports.pipeThroughSimple = internal.pipeThroughSimple;
/**
 * @since 1.0.0
 * @category conversions
 */
const toReadable = exports.toReadable = internal.toReadable;
/**
 * @since 1.0.0
 * @category conversions
 */
const toReadableNever = exports.toReadableNever = internal.toReadableNever;
/**
 * @since 1.0.0
 * @category conversions
 */
const toString = exports.toString = internal.toString;
/**
 * @since 1.0.0
 * @category conversions
 */
const toUint8Array = exports.toUint8Array = internal.toUint8Array;
//# sourceMappingURL=NodeStream.js.map