"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.layer = exports.RequestInit = exports.Fetch = void 0;
var Context = _interopRequireWildcard(require("effect/Context"));
var internal = _interopRequireWildcard(require("./internal/fetchHttpClient.js"));
function _getRequireWildcardCache(e) { if ("function" != typeof WeakMap) return null; var r = new WeakMap(), t = new WeakMap(); return (_getRequireWildcardCache = function (e) { return e ? t : r; })(e); }
function _interopRequireWildcard(e, r) { if (!r && e && e.__esModule) return e; if (null === e || "object" != typeof e && "function" != typeof e) return { default: e }; var t = _getRequireWildcardCache(r); if (t && t.has(e)) return t.get(e); var n = { __proto__: null }, a = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var u in e) if ("default" !== u && {}.hasOwnProperty.call(e, u)) { var i = a ? Object.getOwnPropertyDescriptor(e, u) : null; i && (i.get || i.set) ? Object.defineProperty(n, u, i) : n[u] = e[u]; } return n.default = e, t && t.set(e, n), n; }
/**
 * @since 1.0.0
 */

/**
 * @since 1.0.0
 * @category tags
 */
class Fetch extends /*#__PURE__*/Context.Tag(internal.fetchTagKey)() {}
/**
 * @since 1.0.0
 * @category tags
 */
exports.Fetch = Fetch;
class RequestInit extends /*#__PURE__*/Context.Tag(internal.requestInitTagKey)() {}
/**
 * @since 1.0.0
 * @category layers
 */
exports.RequestInit = RequestInit;
const layer = exports.layer = internal.layer;
//# sourceMappingURL=FetchHttpClient.js.map