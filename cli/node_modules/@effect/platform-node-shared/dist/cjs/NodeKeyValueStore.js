"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.layerFileSystem = void 0;
var KeyValueStore = _interopRequireWildcard(require("@effect/platform/KeyValueStore"));
var Layer = _interopRequireWildcard(require("effect/Layer"));
var FileSystem = _interopRequireWildcard(require("./NodeFileSystem.js"));
var Path = _interopRequireWildcard(require("./NodePath.js"));
function _getRequireWildcardCache(e) { if ("function" != typeof WeakMap) return null; var r = new WeakMap(), t = new WeakMap(); return (_getRequireWildcardCache = function (e) { return e ? t : r; })(e); }
function _interopRequireWildcard(e, r) { if (!r && e && e.__esModule) return e; if (null === e || "object" != typeof e && "function" != typeof e) return { default: e }; var t = _getRequireWildcardCache(r); if (t && t.has(e)) return t.get(e); var n = { __proto__: null }, a = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var u in e) if ("default" !== u && {}.hasOwnProperty.call(e, u)) { var i = a ? Object.getOwnPropertyDescriptor(e, u) : null; i && (i.get || i.set) ? Object.defineProperty(n, u, i) : n[u] = e[u]; } return n.default = e, t && t.set(e, n), n; }
/**
 * @since 1.0.0
 * @category layers
 */
const layerFileSystem = directory => Layer.provide(KeyValueStore.layerFileSystem(directory), Layer.merge(FileSystem.layer, Path.layer));
exports.layerFileSystem = layerFileSystem;
//# sourceMappingURL=NodeKeyValueStore.js.map