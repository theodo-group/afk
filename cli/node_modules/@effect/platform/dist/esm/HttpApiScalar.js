/**
 * @since 1.0.0
 */
import * as Effect from "effect/Effect";
import { Api } from "./HttpApi.js";
import { Router } from "./HttpApiBuilder.js";
import * as HttpServerResponse from "./HttpServerResponse.js";
import * as internal from "./internal/httpApiScalar.js";
import * as OpenApi from "./OpenApi.js";
/**
 * @since 1.0.0
 * @category layers
 */
export const layer = options => Router.use(router => Effect.gen(function* () {
  const {
    api
  } = yield* Api;
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
//# sourceMappingURL=HttpApiScalar.js.map