import * as internal from "./internal/httpClient.js";
/**
 * @since 1.0.0
 * @category type ids
 */
export const TypeId = internal.TypeId;
/**
 * @since 1.0.0
 * @category tags
 */
export const HttpClient = internal.tag;
/**
 * @since 1.0.0
 * @category accessors
 */
export const execute = internal.execute;
/**
 * @since 1.0.0
 * @category accessors
 */
export const get = internal.get;
/**
 * @since 1.0.0
 * @category accessors
 */
export const head = internal.head;
/**
 * @since 1.0.0
 * @category accessors
 */
export const post = internal.post;
/**
 * @since 1.0.0
 * @category accessors
 */
export const patch = internal.patch;
/**
 * @since 1.0.0
 * @category accessors
 */
export const put = internal.put;
/**
 * @since 1.0.0
 * @category accessors
 */
export const del = internal.del;
/**
 * @since 1.0.0
 * @category accessors
 */
export const options = internal.options;
/**
 * @since 1.0.0
 * @category error handling
 */
export const catchAll = internal.catchAll;
/**
 * @since 1.0.0
 * @category error handling
 */
export const catchTag = internal.catchTag;
/**
 * @since 1.0.0
 * @category error handling
 */
export const catchTags = internal.catchTags;
/**
 * Filters the result of a response, or runs an alternative effect if the predicate fails.
 *
 * @since 1.0.0
 * @category filters
 */
export const filterOrElse = internal.filterOrElse;
/**
 * Filters the result of a response, or throws an error if the predicate fails.
 *
 * @since 1.0.0
 * @category filters
 */
export const filterOrFail = internal.filterOrFail;
/**
 * Filters responses by HTTP status code.
 *
 * @since 1.0.0
 * @category filters
 */
export const filterStatus = internal.filterStatus;
/**
 * Filters responses that return a 2xx status code.
 *
 * @since 1.0.0
 * @category filters
 */
export const filterStatusOk = internal.filterStatusOk;
/**
 * @since 1.0.0
 * @category constructors
 */
export const makeWith = internal.makeWith;
/**
 * @since 1.0.0
 * @category constructors
 */
export const make = internal.make;
/**
 * @since 1.0.0
 * @category mapping & sequencing
 */
export const transform = internal.transform;
/**
 * @since 1.0.0
 * @category mapping & sequencing
 */
export const transformResponse = internal.transformResponse;
/**
 * Appends a transformation of the request object before sending it.
 *
 * @since 1.0.0
 * @category mapping & sequencing
 */
export const mapRequest = internal.mapRequest;
/**
 * Appends an effectful transformation of the request object before sending it.
 *
 * @since 1.0.0
 * @category mapping & sequencing
 */
export const mapRequestEffect = internal.mapRequestEffect;
/**
 * Prepends a transformation of the request object before sending it.
 *
 * @since 1.0.0
 * @category mapping & sequencing
 */
export const mapRequestInput = internal.mapRequestInput;
/**
 * Prepends an effectful transformation of the request object before sending it.
 *
 * @since 1.0.0
 * @category mapping & sequencing
 */
export const mapRequestInputEffect = internal.mapRequestInputEffect;
/**
 * Retries the request based on a provided schedule or policy.
 *
 * @since 1.0.0
 * @category error handling
 */
export const retry = internal.retry;
/**
 * Retries common transient errors, such as rate limiting, timeouts or network issues.
 *
 * Specifying a `while` predicate allows you to consider other errors as
 * transient.
 *
 * @since 1.0.0
 * @category error handling
 */
export const retryTransient = internal.retryTransient;
/**
 * Performs an additional effect after a successful request.
 *
 * @since 1.0.0
 * @category mapping & sequencing
 */
export const tap = internal.tap;
/**
 * Performs an additional effect on the request before sending it.
 *
 * @since 1.0.0
 * @category mapping & sequencing
 */
export const tapRequest = internal.tapRequest;
/**
 * Associates a `Ref` of cookies with the client for handling cookies across requests.
 *
 * @since 1.0.0
 * @category cookies
 */
export const withCookiesRef = internal.withCookiesRef;
/**
 * Follows HTTP redirects up to a specified number of times.
 *
 * @since 1.0.0
 * @category redirects
 */
export const followRedirects = internal.followRedirects;
/**
 * @since 1.0.0
 * @category fiber refs
 */
export const currentTracerDisabledWhen = internal.currentTracerDisabledWhen;
/**
 * Disables tracing for specific requests based on a provided predicate.
 *
 * @since 1.0.0
 * @category fiber refs
 */
export const withTracerDisabledWhen = internal.withTracerDisabledWhen;
/**
 * @since 1.0.0
 * @category fiber refs
 */
export const currentTracerPropagation = internal.currentTracerPropagation;
/**
 * Enables or disables tracing propagation for the request.
 *
 * @since 1.0.0
 * @category fiber refs
 */
export const withTracerPropagation = internal.withTracerPropagation;
/**
 * @since 1.0.0
 */
export const layerMergedContext = internal.layerMergedContext;
//# sourceMappingURL=HttpClient.js.map