"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.isSecurity = exports.TypeId = exports.Tag = exports.SecurityTypeId = void 0;
var Context = _interopRequireWildcard(require("effect/Context"));
var _Predicate = require("effect/Predicate");
var Schema = _interopRequireWildcard(require("effect/Schema"));
function _getRequireWildcardCache(e) { if ("function" != typeof WeakMap) return null; var r = new WeakMap(), t = new WeakMap(); return (_getRequireWildcardCache = function (e) { return e ? t : r; })(e); }
function _interopRequireWildcard(e, r) { if (!r && e && e.__esModule) return e; if (null === e || "object" != typeof e && "function" != typeof e) return { default: e }; var t = _getRequireWildcardCache(r); if (t && t.has(e)) return t.get(e); var n = { __proto__: null }, a = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var u in e) if ("default" !== u && {}.hasOwnProperty.call(e, u)) { var i = a ? Object.getOwnPropertyDescriptor(e, u) : null; i && (i.get || i.set) ? Object.defineProperty(n, u, i) : n[u] = e[u]; } return n.default = e, t && t.set(e, n), n; }
/**
 * @since 1.0.0
 */

/**
 * @since 1.0.0
 * @category type ids
 */
const TypeId = exports.TypeId = /*#__PURE__*/Symbol.for("@effect/platform/HttpApiMiddleware");
/**
 * @since 1.0.0
 * @category type ids
 */
const SecurityTypeId = exports.SecurityTypeId = /*#__PURE__*/Symbol.for("@effect/platform/HttpApiMiddleware/Security");
/**
 * @since 1.0.0
 * @category guards
 */
const isSecurity = u => (0, _Predicate.hasProperty)(u, SecurityTypeId);
/**
 * @since 1.0.0
 * @category tags
 */
exports.isSecurity = isSecurity;
const Tag = () => (id, options) => {
  const Err = globalThis.Error;
  const limit = Err.stackTraceLimit;
  Err.stackTraceLimit = 2;
  const creationError = new Err();
  Err.stackTraceLimit = limit;
  function TagClass() {}
  const TagClass_ = TagClass;
  Object.setPrototypeOf(TagClass, Object.getPrototypeOf(Context.GenericTag(id)));
  TagClass.key = id;
  Object.defineProperty(TagClass, "stack", {
    get() {
      return creationError.stack;
    }
  });
  TagClass_[TypeId] = TypeId;
  TagClass_.failure = options?.optional === true || options?.failure === undefined ? Schema.Never : options.failure;
  if (options?.provides) {
    TagClass_.provides = options.provides;
  }
  TagClass_.optional = options?.optional ?? false;
  if (options?.security) {
    if (Object.keys(options.security).length === 0) {
      throw new Error("HttpApiMiddleware.Tag: security object must not be empty");
    }
    TagClass_[SecurityTypeId] = SecurityTypeId;
    TagClass_.security = options.security;
  }
  return TagClass;
};
exports.Tag = Tag;
//# sourceMappingURL=HttpApiMiddleware.js.map