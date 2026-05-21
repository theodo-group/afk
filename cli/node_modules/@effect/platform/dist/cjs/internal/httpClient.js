"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.withTracerPropagation = exports.withTracerDisabledWhen = exports.withCookiesRef = exports.transformResponse = exports.transform = exports.tapRequest = exports.tap = exports.tag = exports.retryTransient = exports.retry = exports.put = exports.post = exports.patch = exports.options = exports.mapRequestInputEffect = exports.mapRequestInput = exports.mapRequestEffect = exports.mapRequest = exports.makeWith = exports.make = exports.layerMergedContext = exports.head = exports.get = exports.followRedirects = exports.filterStatusOk = exports.filterStatus = exports.filterOrFail = exports.filterOrElse = exports.execute = exports.del = exports.currentTracerPropagation = exports.currentTracerDisabledWhen = exports.catchTags = exports.catchTag = exports.catchAll = exports.TypeId = void 0;
var Cause = _interopRequireWildcard(require("effect/Cause"));
var Context = _interopRequireWildcard(require("effect/Context"));
var Effect = _interopRequireWildcard(require("effect/Effect"));
var FiberRef = _interopRequireWildcard(require("effect/FiberRef"));
var _Function = require("effect/Function");
var _GlobalValue = require("effect/GlobalValue");
var Inspectable = _interopRequireWildcard(require("effect/Inspectable"));
var Layer = _interopRequireWildcard(require("effect/Layer"));
var _Pipeable = require("effect/Pipeable");
var Predicate = _interopRequireWildcard(require("effect/Predicate"));
var Ref = _interopRequireWildcard(require("effect/Ref"));
var Schedule = _interopRequireWildcard(require("effect/Schedule"));
var Scope = _interopRequireWildcard(require("effect/Scope"));
var Cookies = _interopRequireWildcard(require("../Cookies.js"));
var Headers = _interopRequireWildcard(require("../Headers.js"));
var Error = _interopRequireWildcard(require("../HttpClientError.js"));
var TraceContext = _interopRequireWildcard(require("../HttpTraceContext.js"));
var UrlParams = _interopRequireWildcard(require("../UrlParams.js"));
var internalRequest = _interopRequireWildcard(require("./httpClientRequest.js"));
var internalResponse = _interopRequireWildcard(require("./httpClientResponse.js"));
function _getRequireWildcardCache(e) { if ("function" != typeof WeakMap) return null; var r = new WeakMap(), t = new WeakMap(); return (_getRequireWildcardCache = function (e) { return e ? t : r; })(e); }
function _interopRequireWildcard(e, r) { if (!r && e && e.__esModule) return e; if (null === e || "object" != typeof e && "function" != typeof e) return { default: e }; var t = _getRequireWildcardCache(r); if (t && t.has(e)) return t.get(e); var n = { __proto__: null }, a = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var u in e) if ("default" !== u && {}.hasOwnProperty.call(e, u)) { var i = a ? Object.getOwnPropertyDescriptor(e, u) : null; i && (i.get || i.set) ? Object.defineProperty(n, u, i) : n[u] = e[u]; } return n.default = e, t && t.set(e, n), n; }
/** @internal */
const TypeId = exports.TypeId = /*#__PURE__*/Symbol.for("@effect/platform/HttpClient");
/** @internal */
const tag = exports.tag = /*#__PURE__*/Context.GenericTag("@effect/platform/HttpClient");
/** @internal */
const currentTracerDisabledWhen = exports.currentTracerDisabledWhen = /*#__PURE__*/(0, _GlobalValue.globalValue)( /*#__PURE__*/Symbol.for("@effect/platform/HttpClient/tracerDisabledWhen"), () => FiberRef.unsafeMake(_Function.constFalse));
/** @internal */
const withTracerDisabledWhen = exports.withTracerDisabledWhen = /*#__PURE__*/(0, _Function.dual)(2, (self, pred) => Effect.locally(self, currentTracerDisabledWhen, pred));
/** @internal */
const currentTracerPropagation = exports.currentTracerPropagation = /*#__PURE__*/(0, _GlobalValue.globalValue)( /*#__PURE__*/Symbol.for("@effect/platform/HttpClient/currentTracerPropagation"), () => FiberRef.unsafeMake(true));
/** @internal */
const withTracerPropagation = exports.withTracerPropagation = /*#__PURE__*/(0, _Function.dual)(2, (self, enabled) => Effect.locally(self, currentTracerPropagation, enabled));
const ClientProto = {
  [TypeId]: TypeId,
  pipe() {
    return (0, _Pipeable.pipeArguments)(this, arguments);
  },
  ...Inspectable.BaseProto,
  toJSON() {
    return {
      _id: "@effect/platform/HttpClient"
    };
  },
  get(url, options) {
    return this.execute(internalRequest.get(url, options));
  },
  head(url, options) {
    return this.execute(internalRequest.head(url, options));
  },
  post(url, options) {
    return this.execute(internalRequest.post(url, options));
  },
  put(url, options) {
    return this.execute(internalRequest.put(url, options));
  },
  patch(url, options) {
    return this.execute(internalRequest.patch(url, options));
  },
  del(url, options) {
    return this.execute(internalRequest.del(url, options));
  },
  options(url, options) {
    return this.execute(internalRequest.options(url, options));
  }
};
const isClient = u => Predicate.hasProperty(u, TypeId);
/** @internal */
const makeWith = (postprocess, preprocess) => {
  const self = Object.create(ClientProto);
  self.preprocess = preprocess;
  self.postprocess = postprocess;
  self.execute = function (request) {
    return postprocess(preprocess(request));
  };
  return self;
};
/** @internal */
exports.makeWith = makeWith;
const make = f => makeWith(effect => Effect.flatMap(effect, request => Effect.withFiberRuntime(fiber => {
  const scope = Context.unsafeGet(fiber.getFiberRef(FiberRef.currentContext), Scope.Scope);
  const controller = new AbortController();
  const addAbort = Scope.addFinalizer(scope, Effect.sync(() => controller.abort()));
  const urlResult = UrlParams.makeUrl(request.url, request.urlParams, request.hash);
  if (urlResult._tag === "Left") {
    return Effect.fail(new Error.RequestError({
      request,
      reason: "InvalidUrl",
      cause: urlResult.left
    }));
  }
  const url = urlResult.right;
  const tracerDisabled = !fiber.getFiberRef(FiberRef.currentTracerEnabled) || fiber.getFiberRef(currentTracerDisabledWhen)(request);
  if (tracerDisabled) {
    return Effect.zipRight(addAbort, f(request, url, controller.signal, fiber));
  }
  return Effect.zipRight(addAbort, Effect.useSpan(`http.client ${request.method}`, {
    kind: "client",
    captureStackTrace: false
  }, span => {
    span.attribute("http.request.method", request.method);
    span.attribute("server.address", url.origin);
    if (url.port !== "") {
      span.attribute("server.port", +url.port);
    }
    span.attribute("url.full", url.toString());
    span.attribute("url.path", url.pathname);
    span.attribute("url.scheme", url.protocol.slice(0, -1));
    const query = url.search.slice(1);
    if (query !== "") {
      span.attribute("url.query", query);
    }
    const redactedHeaderNames = fiber.getFiberRef(Headers.currentRedactedNames);
    const redactedHeaders = Headers.redact(request.headers, redactedHeaderNames);
    for (const name in redactedHeaders) {
      span.attribute(`http.request.header.${name}`, String(redactedHeaders[name]));
    }
    request = fiber.getFiberRef(currentTracerPropagation) ? internalRequest.setHeaders(request, TraceContext.toHeaders(span)) : request;
    return Effect.tap(Effect.withParentSpan(f(request, url, controller.signal, fiber), span), response => {
      span.attribute("http.response.status_code", response.status);
      const redactedHeaders = Headers.redact(response.headers, redactedHeaderNames);
      for (const name in redactedHeaders) {
        span.attribute(`http.response.header.${name}`, String(redactedHeaders[name]));
      }
    });
  }));
})), Effect.succeed);
exports.make = make;
const {
  /** @internal */
  del,
  /** @internal */
  execute,
  /** @internal */
  get,
  /** @internal */
  head,
  /** @internal */
  options,
  /** @internal */
  patch,
  /** @internal */
  post,
  /** @internal */
  put
} = /*#__PURE__*/Effect.serviceFunctions(tag);
/** @internal */
exports.put = put;
exports.post = post;
exports.patch = patch;
exports.options = options;
exports.head = head;
exports.get = get;
exports.execute = execute;
exports.del = del;
const transform = exports.transform = /*#__PURE__*/(0, _Function.dual)(2, (self, f) => {
  const client = self;
  return makeWith(Effect.flatMap(request => f(client.postprocess(Effect.succeed(request)), request)), client.preprocess);
});
/** @internal */
const filterStatus = exports.filterStatus = /*#__PURE__*/(0, _Function.dual)(2, (self, f) => transformResponse(self, Effect.flatMap(internalResponse.filterStatus(f))));
/** @internal */
const filterStatusOk = self => transformResponse(self, Effect.flatMap(internalResponse.filterStatusOk));
/** @internal */
exports.filterStatusOk = filterStatusOk;
const transformResponse = exports.transformResponse = /*#__PURE__*/(0, _Function.dual)(2, (self, f) => {
  const client = self;
  return makeWith(request => f(client.postprocess(request)), client.preprocess);
});
/** @internal */
const catchTag = exports.catchTag = /*#__PURE__*/(0, _Function.dual)(3, (self, tag, f) => transformResponse(self, Effect.catchTag(tag, f)));
/** @internal */
const catchTags = exports.catchTags = /*#__PURE__*/(0, _Function.dual)(2, (self, cases) => transformResponse(self, Effect.catchTags(cases)));
/** @internal */
const catchAll = exports.catchAll = /*#__PURE__*/(0, _Function.dual)(2, (self, f) => transformResponse(self, Effect.catchAll(f)));
/** @internal */
const filterOrElse = exports.filterOrElse = /*#__PURE__*/(0, _Function.dual)(3, (self, f, orElse) => transformResponse(self, Effect.filterOrElse(f, orElse)));
/** @internal */
const filterOrFail = exports.filterOrFail = /*#__PURE__*/(0, _Function.dual)(3, (self, f, orFailWith) => transformResponse(self, Effect.filterOrFail(f, orFailWith)));
/** @internal */
const mapRequest = exports.mapRequest = /*#__PURE__*/(0, _Function.dual)(2, (self, f) => {
  const client = self;
  return makeWith(client.postprocess, request => Effect.map(client.preprocess(request), f));
});
/** @internal */
const mapRequestEffect = exports.mapRequestEffect = /*#__PURE__*/(0, _Function.dual)(2, (self, f) => {
  const client = self;
  return makeWith(client.postprocess, request => Effect.flatMap(client.preprocess(request), f));
});
/** @internal */
const mapRequestInput = exports.mapRequestInput = /*#__PURE__*/(0, _Function.dual)(2, (self, f) => {
  const client = self;
  return makeWith(client.postprocess, request => client.preprocess(f(request)));
});
/** @internal */
const mapRequestInputEffect = exports.mapRequestInputEffect = /*#__PURE__*/(0, _Function.dual)(2, (self, f) => {
  const client = self;
  return makeWith(client.postprocess, request => Effect.flatMap(f(request), client.preprocess));
});
/** @internal */
const retry = exports.retry = /*#__PURE__*/(0, _Function.dual)(2, (self, policy) => transformResponse(self, Effect.retry(policy)));
/** @internal */
const retryTransient = exports.retryTransient = /*#__PURE__*/(0, _Function.dual)(2, (self, options) => transformResponse(self, Effect.retry({
  while: Schedule.ScheduleTypeId in options || options.while === undefined ? isTransientError : Predicate.or(isTransientError, options.while),
  schedule: Schedule.ScheduleTypeId in options ? options : options.schedule,
  times: Schedule.ScheduleTypeId in options ? undefined : options.times
})));
const isTransientError = error => Predicate.hasProperty(error, Cause.TimeoutExceptionTypeId) || isTransientHttpError(error);
const isTransientHttpError = error => Error.isHttpClientError(error) && (error._tag === "RequestError" && error.reason === "Transport" || error._tag === "ResponseError" && error.response.status >= 429);
/** @internal */
const tap = exports.tap = /*#__PURE__*/(0, _Function.dual)(2, (self, f) => transformResponse(self, Effect.tap(f)));
/** @internal */
const tapRequest = exports.tapRequest = /*#__PURE__*/(0, _Function.dual)(2, (self, f) => {
  const client = self;
  return makeWith(client.postprocess, request => Effect.tap(client.preprocess(request), f));
});
/** @internal */
const withCookiesRef = exports.withCookiesRef = /*#__PURE__*/(0, _Function.dual)(2, (self, ref) => {
  const client = self;
  return makeWith(request => Effect.tap(client.postprocess(request), response => Ref.update(ref, cookies => Cookies.merge(cookies, response.cookies))), request => Effect.flatMap(client.preprocess(request), request => Effect.map(Ref.get(ref), cookies => Cookies.isEmpty(cookies) ? request : internalRequest.setHeader(request, "cookie", Cookies.toCookieHeader(cookies)))));
});
/** @internal */
const followRedirects = exports.followRedirects = /*#__PURE__*/(0, _Function.dual)(args => isClient(args[0]), (self, maxRedirects) => {
  const client = self;
  return makeWith(request => {
    const loop = (request, redirects) => Effect.flatMap(client.postprocess(Effect.succeed(request)), response => response.status >= 300 && response.status < 400 && response.headers.location && redirects < (maxRedirects ?? 10) ? loop(internalRequest.setUrl(request, response.headers.location), redirects + 1) : Effect.succeed(response));
    return Effect.flatMap(request, request => loop(request, 0));
  }, client.preprocess);
});
/** @internal */
const layerMergedContext = effect => Layer.effect(tag, Effect.flatMap(Effect.context(), context => Effect.map(effect, client => transformResponse(client, Effect.mapInputContext(input => Context.merge(context, input))))));
exports.layerMergedContext = layerMergedContext;
//# sourceMappingURL=httpClient.js.map