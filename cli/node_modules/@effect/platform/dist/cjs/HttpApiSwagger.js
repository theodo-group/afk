"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.layer = void 0;
var Effect = _interopRequireWildcard(require("effect/Effect"));
var _HttpApi = require("./HttpApi.js");
var _HttpApiBuilder = require("./HttpApiBuilder.js");
var HttpServerResponse = _interopRequireWildcard(require("./HttpServerResponse.js"));
var internal = _interopRequireWildcard(require("./internal/httpApiSwagger.js"));
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
  const response = HttpServerResponse.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${spec.info.title} Documentation</title>
  <style>${internal.css}</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script>
    ${internal.javascript}
    window.onload = () => {
      window.ui = SwaggerUIBundle({
        spec: ${JSON.stringify(spec)},
        dom_id: '#swagger-ui',
      });
    };
  </script>
</body>
</html>`);
  yield* router.get(options?.path ?? "/docs", Effect.succeed(response));
}));
exports.layer = layer;
//# sourceMappingURL=HttpApiSwagger.js.map