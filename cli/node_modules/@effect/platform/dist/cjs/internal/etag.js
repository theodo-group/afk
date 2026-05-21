"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.toString = exports.tag = exports.layerWeak = exports.layer = exports.GeneratorTypeId = void 0;
var Context = _interopRequireWildcard(require("effect/Context"));
var Effect = _interopRequireWildcard(require("effect/Effect"));
var Layer = _interopRequireWildcard(require("effect/Layer"));
function _getRequireWildcardCache(e) { if ("function" != typeof WeakMap) return null; var r = new WeakMap(), t = new WeakMap(); return (_getRequireWildcardCache = function (e) { return e ? t : r; })(e); }
function _interopRequireWildcard(e, r) { if (!r && e && e.__esModule) return e; if (null === e || "object" != typeof e && "function" != typeof e) return { default: e }; var t = _getRequireWildcardCache(r); if (t && t.has(e)) return t.get(e); var n = { __proto__: null }, a = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var u in e) if ("default" !== u && {}.hasOwnProperty.call(e, u)) { var i = a ? Object.getOwnPropertyDescriptor(e, u) : null; i && (i.get || i.set) ? Object.defineProperty(n, u, i) : n[u] = e[u]; } return n.default = e, t && t.set(e, n), n; }
/** @internal */
const GeneratorTypeId = exports.GeneratorTypeId = /*#__PURE__*/Symbol.for("@effect/platform/Etag/Generator");
/** @internal */
const tag = exports.tag = /*#__PURE__*/Context.GenericTag("@effect/platform/Etag/Generator");
/** @internal */
const toString = self => {
  switch (self._tag) {
    case "Weak":
      return `W/"${self.value}"`;
    case "Strong":
      return `"${self.value}"`;
  }
};
exports.toString = toString;
const fromFileInfo = info => {
  const mtime = info.mtime._tag === "Some" ? info.mtime.value.getTime().toString(16) : "0";
  return `${info.size.toString(16)}-${mtime}`;
};
const fromFileWeb = file => {
  return `${file.size.toString(16)}-${file.lastModified.toString(16)}`;
};
/** @internal */
const layer = exports.layer = /*#__PURE__*/Layer.succeed(tag, /*#__PURE__*/tag.of({
  [GeneratorTypeId]: GeneratorTypeId,
  fromFileInfo(info) {
    return Effect.sync(() => ({
      _tag: "Strong",
      value: fromFileInfo(info)
    }));
  },
  fromFileWeb(file) {
    return Effect.sync(() => ({
      _tag: "Strong",
      value: fromFileWeb(file)
    }));
  }
}));
/** @internal */
const layerWeak = exports.layerWeak = /*#__PURE__*/Layer.succeed(tag, /*#__PURE__*/tag.of({
  [GeneratorTypeId]: GeneratorTypeId,
  fromFileInfo(info) {
    return Effect.sync(() => ({
      _tag: "Weak",
      value: fromFileInfo(info)
    }));
  },
  fromFileWeb(file) {
    return Effect.sync(() => ({
      _tag: "Weak",
      value: fromFileWeb(file)
    }));
  }
}));
//# sourceMappingURL=etag.js.map