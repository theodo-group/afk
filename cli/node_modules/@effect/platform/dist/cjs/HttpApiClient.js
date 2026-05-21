"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.make = exports.group = exports.endpoint = void 0;
var Context = _interopRequireWildcard(require("effect/Context"));
var Effect = _interopRequireWildcard(require("effect/Effect"));
var _Function = require("effect/Function");
var _GlobalValue = require("effect/GlobalValue");
var Option = _interopRequireWildcard(require("effect/Option"));
var ParseResult = _interopRequireWildcard(require("effect/ParseResult"));
var Schema = _interopRequireWildcard(require("effect/Schema"));
var HttpApi = _interopRequireWildcard(require("./HttpApi.js"));
var HttpApiSchema = _interopRequireWildcard(require("./HttpApiSchema.js"));
var HttpBody = _interopRequireWildcard(require("./HttpBody.js"));
var HttpClient = _interopRequireWildcard(require("./HttpClient.js"));
var HttpClientError = _interopRequireWildcard(require("./HttpClientError.js"));
var HttpClientRequest = _interopRequireWildcard(require("./HttpClientRequest.js"));
var HttpClientResponse = _interopRequireWildcard(require("./HttpClientResponse.js"));
var HttpMethod = _interopRequireWildcard(require("./HttpMethod.js"));
var UrlParams = _interopRequireWildcard(require("./UrlParams.js"));
function _getRequireWildcardCache(e) { if ("function" != typeof WeakMap) return null; var r = new WeakMap(), t = new WeakMap(); return (_getRequireWildcardCache = function (e) { return e ? t : r; })(e); }
function _interopRequireWildcard(e, r) { if (!r && e && e.__esModule) return e; if (null === e || "object" != typeof e && "function" != typeof e) return { default: e }; var t = _getRequireWildcardCache(r); if (t && t.has(e)) return t.get(e); var n = { __proto__: null }, a = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var u in e) if ("default" !== u && {}.hasOwnProperty.call(e, u)) { var i = a ? Object.getOwnPropertyDescriptor(e, u) : null; i && (i.get || i.set) ? Object.defineProperty(n, u, i) : n[u] = e[u]; } return n.default = e, t && t.set(e, n), n; }
/**
 * @since 1.0.0
 */

/**
 * @internal
 */
const makeClient = (api, options) => Effect.gen(function* () {
  const context = yield* Effect.context();
  const httpClient = (yield* HttpClient.HttpClient).pipe(options?.baseUrl === undefined ? _Function.identity : HttpClient.mapRequest(HttpClientRequest.prependUrl(options.baseUrl)), options?.transformClient === undefined ? _Function.identity : options.transformClient);
  HttpApi.reflect(api, {
    predicate: options?.predicate,
    onGroup(onGroupOptions) {
      options.onGroup?.(onGroupOptions);
    },
    onEndpoint(onEndpointOptions) {
      const {
        endpoint,
        errors,
        successes
      } = onEndpointOptions;
      const makeUrl = compilePath(endpoint.path);
      const decodeMap = {
        orElse: statusOrElse
      };
      const decodeResponse = HttpClientResponse.matchStatus(decodeMap);
      errors.forEach(({
        ast
      }, status) => {
        if (ast._tag === "None") {
          decodeMap[status] = statusCodeError;
          return;
        }
        const decode = schemaToResponse(ast.value);
        decodeMap[status] = response => Effect.flatMap(decode(response), Effect.fail);
      });
      successes.forEach(({
        ast
      }, status) => {
        decodeMap[status] = ast._tag === "None" ? responseAsVoid : schemaToResponse(ast.value);
      });
      const encodePayloadBody = endpoint.payloadSchema.pipe(Option.map(schema => {
        if (HttpMethod.hasBody(endpoint.method)) {
          return Schema.encodeUnknown(payloadSchemaBody(schema));
        }
        return Schema.encodeUnknown(schema);
      }));
      const encodeHeaders = endpoint.headersSchema.pipe(Option.map(Schema.encodeUnknown));
      const encodeUrlParams = endpoint.urlParamsSchema.pipe(Option.map(Schema.encodeUnknown));
      const endpointFn = request => Effect.gen(function* () {
        let httpRequest = HttpClientRequest.make(endpoint.method)(request && request.path ? makeUrl(request.path) : endpoint.path);
        if (request && request.payload instanceof FormData) {
          httpRequest = HttpClientRequest.bodyFormData(httpRequest, request.payload);
        } else if (encodePayloadBody._tag === "Some") {
          if (HttpMethod.hasBody(endpoint.method)) {
            const body = yield* encodePayloadBody.value(request.payload);
            httpRequest = HttpClientRequest.setBody(httpRequest, body);
          } else {
            const urlParams = yield* encodePayloadBody.value(request.payload);
            httpRequest = HttpClientRequest.setUrlParams(httpRequest, urlParams);
          }
        }
        if (encodeHeaders._tag === "Some") {
          httpRequest = HttpClientRequest.setHeaders(httpRequest, yield* encodeHeaders.value(request.headers));
        }
        if (encodeUrlParams._tag === "Some") {
          httpRequest = HttpClientRequest.appendUrlParams(httpRequest, yield* encodeUrlParams.value(request.urlParams));
        }
        const response = yield* httpClient.execute(httpRequest);
        const value = yield* options.transformResponse === undefined ? decodeResponse(response) : options.transformResponse(decodeResponse(response));
        return request?.withResponse === true ? [value, response] : value;
      }).pipe(Effect.scoped, Effect.catchIf(ParseResult.isParseError, Effect.die), Effect.mapInputContext(input => Context.merge(context, input)));
      options.onEndpoint({
        ...onEndpointOptions,
        endpointFn
      });
    }
  });
});
/**
 * @since 1.0.0
 * @category constructors
 */
const make = (api, options) => {
  const client = {};
  return makeClient(api, {
    ...options,
    onGroup({
      group
    }) {
      if (group.topLevel) return;
      client[group.identifier] = {};
    },
    onEndpoint({
      endpoint,
      endpointFn,
      group
    }) {
      ;
      (group.topLevel ? client : client[group.identifier])[endpoint.name] = endpointFn;
    }
  }).pipe(Effect.map(() => client));
};
/**
 * @since 1.0.0
 * @category constructors
 */
exports.make = make;
const group = (api, groupId, options) => {
  const client = {};
  return makeClient(api, {
    ...options,
    predicate: ({
      group
    }) => group.identifier === groupId,
    onEndpoint({
      endpoint,
      endpointFn
    }) {
      client[endpoint.name] = endpointFn;
    }
  }).pipe(Effect.map(() => client));
};
/**
 * @since 1.0.0
 * @category constructors
 */
exports.group = group;
const endpoint = (api, groupName, endpointName, options) => {
  let client = undefined;
  return makeClient(api, {
    ...options,
    predicate: ({
      endpoint,
      group
    }) => group.identifier === groupName && endpoint.name === endpointName,
    onEndpoint({
      endpointFn
    }) {
      client = endpointFn;
    }
  }).pipe(Effect.map(() => client));
};
// ----------------------------------------------------------------------------
exports.endpoint = endpoint;
const paramsRegex = /:([^/:.]+)/g;
const compilePath = path => {
  const segments = path.split(paramsRegex);
  const len = segments.length;
  if (len === 1) {
    return _ => path;
  }
  return params => {
    let url = segments[0];
    for (let i = 1; i < len; i++) {
      if (i % 2 === 0) {
        url += segments[i];
      } else {
        url += params[segments[i]];
      }
    }
    return url;
  };
};
const schemaToResponse = ast => {
  const schema = Schema.make(ast);
  const encoding = HttpApiSchema.getEncoding(ast);
  const decode = Schema.decodeUnknown(schema);
  switch (encoding.kind) {
    case "Json":
      {
        return response => Effect.flatMap(responseJson(response), decode);
      }
    case "UrlParams":
      {
        return HttpClientResponse.schemaBodyUrlParams(schema);
      }
    case "Uint8Array":
      {
        return response => response.arrayBuffer.pipe(Effect.map(buffer => new Uint8Array(buffer)), Effect.flatMap(decode));
      }
    case "Text":
      {
        return response => Effect.flatMap(response.text, decode);
      }
  }
};
const responseJson = response => Effect.flatMap(response.text, text => text === "" ? Effect.void : Effect.try({
  try: () => JSON.parse(text),
  catch: cause => new HttpClientError.ResponseError({
    reason: "Decode",
    request: response.request,
    response,
    cause
  })
}));
const statusOrElse = response => Effect.fail(new HttpClientError.ResponseError({
  reason: "Decode",
  request: response.request,
  response
}));
const statusCodeError = response => Effect.fail(new HttpClientError.ResponseError({
  reason: "StatusCode",
  request: response.request,
  response
}));
const responseAsVoid = _response => Effect.void;
const HttpBodyFromSelf = /*#__PURE__*/Schema.declare(HttpBody.isHttpBody);
const payloadSchemaBody = schema => {
  const members = schema.ast._tag === "Union" ? schema.ast.types : [schema.ast];
  return Schema.Union(...members.map(bodyFromPayload));
};
const bodyFromPayloadCache = /*#__PURE__*/(0, _GlobalValue.globalValue)("@effect/platform/HttpApiClient/bodyFromPayloadCache", () => new WeakMap());
const bodyFromPayload = ast => {
  if (bodyFromPayloadCache.has(ast)) {
    return bodyFromPayloadCache.get(ast);
  }
  const schema = Schema.make(ast);
  const encoding = HttpApiSchema.getEncoding(ast);
  const transform = Schema.transformOrFail(HttpBodyFromSelf, schema, {
    decode(fromA, _, ast) {
      return ParseResult.fail(new ParseResult.Forbidden(ast, fromA, "encode only schema"));
    },
    encode(toI, _, ast) {
      switch (encoding.kind) {
        case "Json":
          {
            return HttpBody.json(toI).pipe(ParseResult.mapError(error => new ParseResult.Type(ast, toI, `Could not encode as JSON: ${error}`)));
          }
        case "Text":
          {
            if (typeof toI !== "string") {
              return ParseResult.fail(new ParseResult.Type(ast, toI, "Expected a string"));
            }
            return ParseResult.succeed(HttpBody.text(toI));
          }
        case "UrlParams":
          {
            return ParseResult.succeed(HttpBody.urlParams(UrlParams.fromInput(toI)));
          }
        case "Uint8Array":
          {
            if (!(toI instanceof Uint8Array)) {
              return ParseResult.fail(new ParseResult.Type(ast, toI, "Expected a Uint8Array"));
            }
            return ParseResult.succeed(HttpBody.uint8Array(toI));
          }
      }
    }
  });
  bodyFromPayloadCache.set(ast, transform);
  return transform;
};
//# sourceMappingURL=HttpApiClient.js.map