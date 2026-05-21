import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberRef from "effect/FiberRef";
import { constFalse, dual } from "effect/Function";
import { globalValue } from "effect/GlobalValue";
import * as Inspectable from "effect/Inspectable";
import * as Layer from "effect/Layer";
import { pipeArguments } from "effect/Pipeable";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Cookies from "../Cookies.js";
import * as Headers from "../Headers.js";
import * as Error from "../HttpClientError.js";
import * as TraceContext from "../HttpTraceContext.js";
import * as UrlParams from "../UrlParams.js";
import * as internalRequest from "./httpClientRequest.js";
import * as internalResponse from "./httpClientResponse.js";
/** @internal */
export const TypeId = /*#__PURE__*/Symbol.for("@effect/platform/HttpClient");
/** @internal */
export const tag = /*#__PURE__*/Context.GenericTag("@effect/platform/HttpClient");
/** @internal */
export const currentTracerDisabledWhen = /*#__PURE__*/globalValue( /*#__PURE__*/Symbol.for("@effect/platform/HttpClient/tracerDisabledWhen"), () => FiberRef.unsafeMake(constFalse));
/** @internal */
export const withTracerDisabledWhen = /*#__PURE__*/dual(2, (self, pred) => Effect.locally(self, currentTracerDisabledWhen, pred));
/** @internal */
export const currentTracerPropagation = /*#__PURE__*/globalValue( /*#__PURE__*/Symbol.for("@effect/platform/HttpClient/currentTracerPropagation"), () => FiberRef.unsafeMake(true));
/** @internal */
export const withTracerPropagation = /*#__PURE__*/dual(2, (self, enabled) => Effect.locally(self, currentTracerPropagation, enabled));
const ClientProto = {
  [TypeId]: TypeId,
  pipe() {
    return pipeArguments(this, arguments);
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
export const makeWith = (postprocess, preprocess) => {
  const self = Object.create(ClientProto);
  self.preprocess = preprocess;
  self.postprocess = postprocess;
  self.execute = function (request) {
    return postprocess(preprocess(request));
  };
  return self;
};
/** @internal */
export const make = f => makeWith(effect => Effect.flatMap(effect, request => Effect.withFiberRuntime(fiber => {
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
export const {
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
export const transform = /*#__PURE__*/dual(2, (self, f) => {
  const client = self;
  return makeWith(Effect.flatMap(request => f(client.postprocess(Effect.succeed(request)), request)), client.preprocess);
});
/** @internal */
export const filterStatus = /*#__PURE__*/dual(2, (self, f) => transformResponse(self, Effect.flatMap(internalResponse.filterStatus(f))));
/** @internal */
export const filterStatusOk = self => transformResponse(self, Effect.flatMap(internalResponse.filterStatusOk));
/** @internal */
export const transformResponse = /*#__PURE__*/dual(2, (self, f) => {
  const client = self;
  return makeWith(request => f(client.postprocess(request)), client.preprocess);
});
/** @internal */
export const catchTag = /*#__PURE__*/dual(3, (self, tag, f) => transformResponse(self, Effect.catchTag(tag, f)));
/** @internal */
export const catchTags = /*#__PURE__*/dual(2, (self, cases) => transformResponse(self, Effect.catchTags(cases)));
/** @internal */
export const catchAll = /*#__PURE__*/dual(2, (self, f) => transformResponse(self, Effect.catchAll(f)));
/** @internal */
export const filterOrElse = /*#__PURE__*/dual(3, (self, f, orElse) => transformResponse(self, Effect.filterOrElse(f, orElse)));
/** @internal */
export const filterOrFail = /*#__PURE__*/dual(3, (self, f, orFailWith) => transformResponse(self, Effect.filterOrFail(f, orFailWith)));
/** @internal */
export const mapRequest = /*#__PURE__*/dual(2, (self, f) => {
  const client = self;
  return makeWith(client.postprocess, request => Effect.map(client.preprocess(request), f));
});
/** @internal */
export const mapRequestEffect = /*#__PURE__*/dual(2, (self, f) => {
  const client = self;
  return makeWith(client.postprocess, request => Effect.flatMap(client.preprocess(request), f));
});
/** @internal */
export const mapRequestInput = /*#__PURE__*/dual(2, (self, f) => {
  const client = self;
  return makeWith(client.postprocess, request => client.preprocess(f(request)));
});
/** @internal */
export const mapRequestInputEffect = /*#__PURE__*/dual(2, (self, f) => {
  const client = self;
  return makeWith(client.postprocess, request => Effect.flatMap(f(request), client.preprocess));
});
/** @internal */
export const retry = /*#__PURE__*/dual(2, (self, policy) => transformResponse(self, Effect.retry(policy)));
/** @internal */
export const retryTransient = /*#__PURE__*/dual(2, (self, options) => transformResponse(self, Effect.retry({
  while: Schedule.ScheduleTypeId in options || options.while === undefined ? isTransientError : Predicate.or(isTransientError, options.while),
  schedule: Schedule.ScheduleTypeId in options ? options : options.schedule,
  times: Schedule.ScheduleTypeId in options ? undefined : options.times
})));
const isTransientError = error => Predicate.hasProperty(error, Cause.TimeoutExceptionTypeId) || isTransientHttpError(error);
const isTransientHttpError = error => Error.isHttpClientError(error) && (error._tag === "RequestError" && error.reason === "Transport" || error._tag === "ResponseError" && error.response.status >= 429);
/** @internal */
export const tap = /*#__PURE__*/dual(2, (self, f) => transformResponse(self, Effect.tap(f)));
/** @internal */
export const tapRequest = /*#__PURE__*/dual(2, (self, f) => {
  const client = self;
  return makeWith(client.postprocess, request => Effect.tap(client.preprocess(request), f));
});
/** @internal */
export const withCookiesRef = /*#__PURE__*/dual(2, (self, ref) => {
  const client = self;
  return makeWith(request => Effect.tap(client.postprocess(request), response => Ref.update(ref, cookies => Cookies.merge(cookies, response.cookies))), request => Effect.flatMap(client.preprocess(request), request => Effect.map(Ref.get(ref), cookies => Cookies.isEmpty(cookies) ? request : internalRequest.setHeader(request, "cookie", Cookies.toCookieHeader(cookies)))));
});
/** @internal */
export const followRedirects = /*#__PURE__*/dual(args => isClient(args[0]), (self, maxRedirects) => {
  const client = self;
  return makeWith(request => {
    const loop = (request, redirects) => Effect.flatMap(client.postprocess(Effect.succeed(request)), response => response.status >= 300 && response.status < 400 && response.headers.location && redirects < (maxRedirects ?? 10) ? loop(internalRequest.setUrl(request, response.headers.location), redirects + 1) : Effect.succeed(response));
    return Effect.flatMap(request, request => loop(request, 0));
  }, client.preprocess);
});
/** @internal */
export const layerMergedContext = effect => Layer.effect(tag, Effect.flatMap(Effect.context(), context => Effect.map(effect, client => transformResponse(client, Effect.mapInputContext(input => Context.merge(context, input))))));
//# sourceMappingURL=httpClient.js.map