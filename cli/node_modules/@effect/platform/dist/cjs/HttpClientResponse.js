"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.matchStatus = exports.fromWeb = exports.filterStatusOk = exports.filterStatus = exports.TypeId = void 0;
Object.defineProperty(exports, "schemaBodyJson", {
  enumerable: true,
  get: function () {
    return _HttpIncomingMessage.schemaBodyJson;
  }
});
Object.defineProperty(exports, "schemaBodyUrlParams", {
  enumerable: true,
  get: function () {
    return _HttpIncomingMessage.schemaBodyUrlParams;
  }
});
Object.defineProperty(exports, "schemaHeaders", {
  enumerable: true,
  get: function () {
    return _HttpIncomingMessage.schemaHeaders;
  }
});
exports.stream = exports.schemaNoBody = exports.schemaJson = void 0;
var internal = _interopRequireWildcard(require("./internal/httpClientResponse.js"));
var _HttpIncomingMessage = require("./HttpIncomingMessage.js");
function _getRequireWildcardCache(e) { if ("function" != typeof WeakMap) return null; var r = new WeakMap(), t = new WeakMap(); return (_getRequireWildcardCache = function (e) { return e ? t : r; })(e); }
function _interopRequireWildcard(e, r) { if (!r && e && e.__esModule) return e; if (null === e || "object" != typeof e && "function" != typeof e) return { default: e }; var t = _getRequireWildcardCache(r); if (t && t.has(e)) return t.get(e); var n = { __proto__: null }, a = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var u in e) if ("default" !== u && {}.hasOwnProperty.call(e, u)) { var i = a ? Object.getOwnPropertyDescriptor(e, u) : null; i && (i.get || i.set) ? Object.defineProperty(n, u, i) : n[u] = e[u]; } return n.default = e, t && t.set(e, n), n; }
/**
 * @since 1.0.0
 * @category type ids
 */
const TypeId = exports.TypeId = internal.TypeId;
/**
 * @since 1.0.0
 * @category constructors
 */
const fromWeb = exports.fromWeb = internal.fromWeb;
/**
 * @since 1.0.0
 * @category schema
 */
const schemaJson = exports.schemaJson = internal.schemaJson;
/**
 * @since 1.0.0
 * @category schema
 */
const schemaNoBody = exports.schemaNoBody = internal.schemaNoBody;
/**
 * @since 1.0.0
 * @category accessors
 */
const stream = exports.stream = internal.stream;
/**
 * @since 1.0.0
 * @category pattern matching
 */
const matchStatus = exports.matchStatus = internal.matchStatus;
/**
 * @since 1.0.0
 * @category filters
 */
const filterStatus = exports.filterStatus = internal.filterStatus;
/**
 * @since 1.0.0
 * @category filters
 */
const filterStatusOk = exports.filterStatusOk = internal.filterStatusOk;
//# sourceMappingURL=HttpClientResponse.js.map