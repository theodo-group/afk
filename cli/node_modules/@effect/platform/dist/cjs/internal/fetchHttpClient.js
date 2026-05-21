"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.requestInitTagKey = exports.layer = exports.fetchTagKey = void 0;
var Effect = _interopRequireWildcard(require("effect/Effect"));
var FiberRef = _interopRequireWildcard(require("effect/FiberRef"));
var Stream = _interopRequireWildcard(require("effect/Stream"));
var Error = _interopRequireWildcard(require("../HttpClientError.js"));
var client = _interopRequireWildcard(require("./httpClient.js"));
var internalResponse = _interopRequireWildcard(require("./httpClientResponse.js"));
function _getRequireWildcardCache(e) { if ("function" != typeof WeakMap) return null; var r = new WeakMap(), t = new WeakMap(); return (_getRequireWildcardCache = function (e) { return e ? t : r; })(e); }
function _interopRequireWildcard(e, r) { if (!r && e && e.__esModule) return e; if (null === e || "object" != typeof e && "function" != typeof e) return { default: e }; var t = _getRequireWildcardCache(r); if (t && t.has(e)) return t.get(e); var n = { __proto__: null }, a = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var u in e) if ("default" !== u && {}.hasOwnProperty.call(e, u)) { var i = a ? Object.getOwnPropertyDescriptor(e, u) : null; i && (i.get || i.set) ? Object.defineProperty(n, u, i) : n[u] = e[u]; } return n.default = e, t && t.set(e, n), n; }
/** @internal */
const fetchTagKey = exports.fetchTagKey = "@effect/platform/FetchHttpClient/Fetch";
/** @internal */
const requestInitTagKey = exports.requestInitTagKey = "@effect/platform/FetchHttpClient/FetchOptions";
const fetch = /*#__PURE__*/client.make((request, url, signal, fiber) => {
  const context = fiber.getFiberRef(FiberRef.currentContext);
  const fetch = context.unsafeMap.get(fetchTagKey) ?? globalThis.fetch;
  const options = context.unsafeMap.get(requestInitTagKey) ?? {};
  const headers = new globalThis.Headers(request.headers);
  const send = body => Effect.map(Effect.tryPromise({
    try: () => fetch(url, {
      ...options,
      method: request.method,
      headers,
      body,
      duplex: request.body._tag === "Stream" ? "half" : undefined,
      signal
    }),
    catch: cause => new Error.RequestError({
      request,
      reason: "Transport",
      cause
    })
  }), response => internalResponse.fromWeb(request, response));
  switch (request.body._tag) {
    case "Raw":
    case "Uint8Array":
      return send(request.body.body);
    case "FormData":
      return send(request.body.formData);
    case "Stream":
      return Effect.flatMap(Stream.toReadableStreamEffect(request.body.stream), send);
  }
  return send(undefined);
});
/** @internal */
const layer = exports.layer = /*#__PURE__*/client.layerMergedContext( /*#__PURE__*/Effect.succeed(fetch));
//# sourceMappingURL=fetchHttpClient.js.map