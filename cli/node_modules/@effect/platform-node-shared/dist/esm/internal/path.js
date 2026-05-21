import { BadArgument } from "@effect/platform/Error";
import { Path, TypeId } from "@effect/platform/Path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodePath from "node:path";
import * as NodeUrl from "node:url";
const fromFileUrl = url => Effect.try({
  try: () => NodeUrl.fileURLToPath(url),
  catch: error => BadArgument({
    module: "Path",
    method: "fromFileUrl",
    message: `${error}`
  })
});
const toFileUrl = path => Effect.try({
  try: () => NodeUrl.pathToFileURL(path),
  catch: error => BadArgument({
    module: "Path",
    method: "toFileUrl",
    message: `${error}`
  })
});
/** @internal */
export const layerPosix = /*#__PURE__*/Layer.succeed(Path, /*#__PURE__*/Path.of({
  [TypeId]: TypeId,
  ...NodePath.posix,
  fromFileUrl,
  toFileUrl
}));
/** @internal */
export const layerWin32 = /*#__PURE__*/Layer.succeed(Path, /*#__PURE__*/Path.of({
  [TypeId]: TypeId,
  ...NodePath.win32,
  fromFileUrl,
  toFileUrl
}));
/** @internal */
export const layer = /*#__PURE__*/Layer.succeed(Path, /*#__PURE__*/Path.of({
  [TypeId]: TypeId,
  ...NodePath,
  fromFileUrl,
  toFileUrl
}));
//# sourceMappingURL=path.js.map