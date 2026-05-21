"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.withPreResponseHandler = exports.currentPreResponseHandlers = exports.appendPreResponseHandler = void 0;
var Effect = _interopRequireWildcard(require("effect/Effect"));
var FiberRef = _interopRequireWildcard(require("effect/FiberRef"));
var _Function = require("effect/Function");
var _GlobalValue = require("effect/GlobalValue");
var Option = _interopRequireWildcard(require("effect/Option"));
function _getRequireWildcardCache(e) { if ("function" != typeof WeakMap) return null; var r = new WeakMap(), t = new WeakMap(); return (_getRequireWildcardCache = function (e) { return e ? t : r; })(e); }
function _interopRequireWildcard(e, r) { if (!r && e && e.__esModule) return e; if (null === e || "object" != typeof e && "function" != typeof e) return { default: e }; var t = _getRequireWildcardCache(r); if (t && t.has(e)) return t.get(e); var n = { __proto__: null }, a = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var u in e) if ("default" !== u && {}.hasOwnProperty.call(e, u)) { var i = a ? Object.getOwnPropertyDescriptor(e, u) : null; i && (i.get || i.set) ? Object.defineProperty(n, u, i) : n[u] = e[u]; } return n.default = e, t && t.set(e, n), n; }
/** @internal */
const currentPreResponseHandlers = exports.currentPreResponseHandlers = /*#__PURE__*/(0, _GlobalValue.globalValue)( /*#__PURE__*/Symbol.for("@effect/platform/HttpApp/preResponseHandlers"), () => FiberRef.unsafeMake(Option.none()));
/** @internal */
const appendPreResponseHandler = handler => FiberRef.update(currentPreResponseHandlers, Option.match({
  onNone: () => Option.some(handler),
  onSome: prev => Option.some((request, response) => Effect.flatMap(prev(request, response), response => handler(request, response)))
}));
/** @internal */
exports.appendPreResponseHandler = appendPreResponseHandler;
const withPreResponseHandler = exports.withPreResponseHandler = /*#__PURE__*/(0, _Function.dual)(2, (self, handler) => Effect.locallyWith(self, currentPreResponseHandlers, Option.match({
  onNone: () => Option.some(handler),
  onSome: prev => Option.some((request, response) => Effect.flatMap(prev(request, response), response => handler(request, response)))
})));
//# sourceMappingURL=httpApp.js.map