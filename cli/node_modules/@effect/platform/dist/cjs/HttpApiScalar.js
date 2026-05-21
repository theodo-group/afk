"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.layer = void 0;
var Effect = _interopRequireWildcard(require("effect/Effect"));
var _HttpApi = require("./HttpApi.js");
var _HttpApiBuilder = require("./HttpApiBuilder.js");
var HttpServerResponse = _interopRequireWildcard(require("./HttpServerResponse.js"));
var internal = _interopRequireWildcard(require("./internal/httpApiScalar.js"));
var OpenApi = _interopRequireWildcard(require("./OpenApi.js"));
function _getRequireWildcardCache(e) { if ("function" != typeof WeakMap) return null; var r = new WeakMap(), t = new WeakMap(); return (_getRequireWildcardCache = function (e) { return e ? t : r; })(e); }
function _interopRequireWildcard(e, r) { if (!r && e && e.__esModule) return e; if (null === e || "object" != typeof e && "function" != typeof e) return { default: e }; var t = _getRequireWildcardCache(r); if (t && t.has(e)) return t.get(e); var n = { __proto__: null }, a = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var u in e) if ("default" !== u && {}.hasOwnProperty.call(e, u)) { var i = a ? Object.getOwnPropertyDescriptor(e, u) : null; i && (i.get || i.set) ? Object.defineProperty(n, u, i) : n[u] = e[u]; } return n.default = e, t && t.set(e, n), n; }
/**
 * @since 1.0.0
 */

/**
 * @since 1.0.0
 * @category layers
 */
const layer = options => _HttpApiBuilder.Router.use(router => Effect.gen(function* () {
  const {
    api
  } = yield* _HttpApi.Api;
  const spec = OpenApi.fromApi(api);
  const source = options?.source;
  const defaultScript = internal.javascript;
  const src = source ? typeof source === "string" ? source : source.type === "cdn" ? `https://cdn.jsdelivr.net/npm/@scalar/api-reference@${source.version ?? "latest"}/dist/browser/standalone.min.js` : null : null;
  const scalarConfig = {
    _integration: "http",
    ...options?.scalar
  };
  const response = HttpServerResponse.html(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${spec.info.title}</title>
    ${!spec.info.description ? "" : `<meta name="description" content="${spec.info.description}"/>`}
    ${!spec.info.description ? "" : `<meta name="og:description" content="${spec.info.description}"/>`}
    <meta
      name="viewport"
      content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <script id="api-reference" type="application/json">
      ${JSON.stringify(spec)}
    </script>
    <script>
      document.getElementById('api-reference').dataset.configuration = JSON.stringify(${JSON.stringify(scalarConfig)})
    </script>
    ${src ? `<script src="${src}" crossorigin></script>` : `<script>${defaultScript}</script>`}
  </body>
</html>`);
  yield* router.get(options?.path ?? "/docs", Effect.succeed(response));
}));
exports.layer = layer;
//# sourceMappingURL=HttpApiScalar.js.map