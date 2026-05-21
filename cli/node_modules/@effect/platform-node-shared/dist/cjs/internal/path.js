"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.layerWin32 = exports.layerPosix = exports.layer = void 0;
var _Error = require("@effect/platform/Error");
var _Path = require("@effect/platform/Path");
var Effect = _interopRequireWildcard(require("effect/Effect"));
var Layer = _interopRequireWildcard(require("effect/Layer"));
var NodePath = _interopRequireWildcard(require("node:path"));
var NodeUrl = _interopRequireWildcard(require("node:url"));
function _getRequireWildcardCache(e) { if ("function" != typeof WeakMap) return null; var r = new WeakMap(), t = new WeakMap(); return (_getRequireWildcardCache = function (e) { return e ? t : r; })(e); }
function _interopRequireWildcard(e, r) { if (!r && e && e.__esModule) return e; if (null === e || "object" != typeof e && "function" != typeof e) return { default: e }; var t = _getRequireWildcardCache(r); if (t && t.has(e)) return t.get(e); var n = { __proto__: null }, a = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var u in e) if ("default" !== u && {}.hasOwnProperty.call(e, u)) { var i = a ? Object.getOwnPropertyDescriptor(e, u) : null; i && (i.get || i.set) ? Object.defineProperty(n, u, i) : n[u] = e[u]; } return n.default = e, t && t.set(e, n), n; }
const fromFileUrl = url => Effect.try({
  try: () => NodeUrl.fileURLToPath(url),
  catch: error => (0, _Error.BadArgument)({
    module: "Path",
    method: "fromFileUrl",
    message: `${error}`
  })
});
const toFileUrl = path => Effect.try({
  try: () => NodeUrl.pathToFileURL(path),
  catch: error => (0, _Error.BadArgument)({
    module: "Path",
    method: "toFileUrl",
    message: `${error}`
  })
});
/** @internal */
const layerPosix = exports.layerPosix = /*#__PURE__*/Layer.succeed(_Path.Path, /*#__PURE__*/_Path.Path.of({
  [_Path.TypeId]: _Path.TypeId,
  ...NodePath.posix,
  fromFileUrl,
  toFileUrl
}));
/** @internal */
const layerWin32 = exports.layerWin32 = /*#__PURE__*/Layer.succeed(_Path.Path, /*#__PURE__*/_Path.Path.of({
  [_Path.TypeId]: _Path.TypeId,
  ...NodePath.win32,
  fromFileUrl,
  toFileUrl
}));
/** @internal */
const layer = exports.layer = /*#__PURE__*/Layer.succeed(_Path.Path, /*#__PURE__*/_Path.Path.of({
  [_Path.TypeId]: _Path.TypeId,
  ...NodePath,
  fromFileUrl,
  toFileUrl
}));
//# sourceMappingURL=path.js.map