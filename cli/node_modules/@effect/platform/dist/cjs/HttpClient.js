"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.withTracerPropagation = exports.withTracerDisabledWhen = exports.withCookiesRef = exports.transformResponse = exports.transform = exports.tapRequest = exports.tap = exports.retryTransient = exports.retry = exports.put = exports.post = exports.patch = exports.options = exports.mapRequestInputEffect = exports.mapRequestInput = exports.mapRequestEffect = exports.mapRequest = exports.makeWith = exports.make = exports.layerMergedContext = exports.head = exports.get = exports.followRedirects = exports.filterStatusOk = exports.filterStatus = exports.filterOrFail = exports.filterOrElse = exports.execute = exports.del = exports.currentTracerPropagation = exports.currentTracerDisabledWhen = exports.catchTags = exports.catchTag = exports.catchAll = exports.TypeId = exports.HttpClient = void 0;
var internal = _interopRequireWildcard(require("./internal/httpClient.js"));
function _getRequireWildcardCache(e) { if ("function" != typeof WeakMap) return null; var r = new WeakMap(), t = new WeakMap(); return (_getRequireWildcardCache = function (e) { return e ? t : r; })(e); }
function _interopRequireWildcard(e, r) { if (!r && e && e.__esModule) return e; if (null === e || "object" != typeof e && "function" != typeof e) return { default: e }; var t = _getRequireWildcardCache(r); if (t && t.has(e)) return t.get(e); var n = { __proto__: null }, a = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var u in e) if ("default" !== u && {}.hasOwnProperty.call(e, u)) { var i = a ? Object.getOwnPropertyDescriptor(e, u) : null; i && (i.get || i.set) ? Object.defineProperty(n, u, i) : n[u] = e[u]; } return n.default = e, t && t.set(e, n), n; }
/**
 * @since 1.0.0
 * @category type ids
 */
const TypeId = exports.TypeId = internal.TypeId;
/**
 * @since 1.0.0
 * @category tags
 */
const HttpClient = exports.HttpClient = internal.tag;
/**
 * @since 1.0.0
 * @category accessors
 */
const execute = exports.execute = internal.execute;
/**
 * @since 1.0.0
 * @category accessors
 */
const get = exports.get = internal.get;
/**
 * @since 1.0.0
 * @category accessors
 */
const head = exports.head = internal.head;
/**
 * @since 1.0.0
 * @category accessors
 */
const post = exports.post = internal.post;
/**
 * @since 1.0.0
 * @category accessors
 */
const patch = exports.patch = internal.patch;
/**
 * @since 1.0.0
 * @category accessors
 */
const put = exports.put = internal.put;
/**
 * @since 1.0.0
 * @category accessors
 */
const del = exports.del = internal.del;
/**
 * @since 1.0.0
 * @category accessors
 */
const options = exports.options = internal.options;
/**
 * @since 1.0.0
 * @category error handling
 */
const catchAll = exports.catchAll = internal.catchAll;
/**
 * @since 1.0.0
 * @category error handling
 */
const catchTag = exports.catchTag = internal.catchTag;
/**
 * @since 1.0.0
 * @category error handling
 */
const catchTags = exports.catchTags = internal.catchTags;
/**
 * Filters the result of a response, or runs an alternative effect if the predicate fails.
 *
 * @since 1.0.0
 * @category filters
 */
const filterOrElse = exports.filterOrElse = internal.filterOrElse;
/**
 * Filters the result of a response, or throws an error if the predicate fails.
 *
 * @since 1.0.0
 * @category filters
 */
const filterOrFail = exports.filterOrFail = internal.filterOrFail;
/**
 * Filters responses by HTTP status code.
 *
 * @since 1.0.0
 * @category filters
 */
const filterStatus = exports.filterStatus = internal.filterStatus;
/**
 * Filters responses that return a 2xx status code.
 *
 * @since 1.0.0
 * @category filters
 */
const filterStatusOk = exports.filterStatusOk = internal.filterStatusOk;
/**
 * @since 1.0.0
 * @category constructors
 */
const makeWith = exports.makeWith = internal.makeWith;
/**
 * @since 1.0.0
 * @category constructors
 */
const make = exports.make = internal.make;
/**
 * @since 1.0.0
 * @category mapping & sequencing
 */
const transform = exports.transform = internal.transform;
/**
 * @since 1.0.0
 * @category mapping & sequencing
 */
const transformResponse = exports.transformResponse = internal.transformResponse;
/**
 * Appends a transformation of the request object before sending it.
 *
 * @since 1.0.0
 * @category mapping & sequencing
 */
const mapRequest = exports.mapRequest = internal.mapRequest;
/**
 * Appends an effectful transformation of the request object before sending it.
 *
 * @since 1.0.0
 * @category mapping & sequencing
 */
const mapRequestEffect = exports.mapRequestEffect = internal.mapRequestEffect;
/**
 * Prepends a transformation of the request object before sending it.
 *
 * @since 1.0.0
 * @category mapping & sequencing
 */
const mapRequestInput = exports.mapRequestInput = internal.mapRequestInput;
/**
 * Prepends an effectful transformation of the request object before sending it.
 *
 * @since 1.0.0
 * @category mapping & sequencing
 */
const mapRequestInputEffect = exports.mapRequestInputEffect = internal.mapRequestInputEffect;
/**
 * Retries the request based on a provided schedule or policy.
 *
 * @since 1.0.0
 * @category error handling
 */
const retry = exports.retry = internal.retry;
/**
 * Retries common transient errors, such as rate limiting, timeouts or network issues.
 *
 * Specifying a `while` predicate allows you to consider other errors as
 * transient.
 *
 * @since 1.0.0
 * @category error handling
 */
const retryTransient = exports.retryTransient = internal.retryTransient;
/**
 * Performs an additional effect after a successful request.
 *
 * @since 1.0.0
 * @category mapping & sequencing
 */
const tap = exports.tap = internal.tap;
/**
 * Performs an additional effect on the request before sending it.
 *
 * @since 1.0.0
 * @category mapping & sequencing
 */
const tapRequest = exports.tapRequest = internal.tapRequest;
/**
 * Associates a `Ref` of cookies with the client for handling cookies across requests.
 *
 * @since 1.0.0
 * @category cookies
 */
const withCookiesRef = exports.withCookiesRef = internal.withCookiesRef;
/**
 * Follows HTTP redirects up to a specified number of times.
 *
 * @since 1.0.0
 * @category redirects
 */
const followRedirects = exports.followRedirects = internal.followRedirects;
/**
 * @since 1.0.0
 * @category fiber refs
 */
const currentTracerDisabledWhen = exports.currentTracerDisabledWhen = internal.currentTracerDisabledWhen;
/**
 * Disables tracing for specific requests based on a provided predicate.
 *
 * @since 1.0.0
 * @category fiber refs
 */
const withTracerDisabledWhen = exports.withTracerDisabledWhen = internal.withTracerDisabledWhen;
/**
 * @since 1.0.0
 * @category fiber refs
 */
const currentTracerPropagation = exports.currentTracerPropagation = internal.currentTracerPropagation;
/**
 * Enables or disables tracing propagation for the request.
 *
 * @since 1.0.0
 * @category fiber refs
 */
const withTracerPropagation = exports.withTracerPropagation = internal.withTracerPropagation;
/**
 * @since 1.0.0
 */
const layerMergedContext = exports.layerMergedContext = internal.layerMergedContext;
//# sourceMappingURL=HttpClient.js.map