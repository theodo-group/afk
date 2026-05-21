"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.toString = exports.toRecord = exports.setAll = exports.set = exports.schemaStruct = exports.schemaJson = exports.schema = exports.remove = exports.makeUrl = exports.getLast = exports.getFirst = exports.getAll = exports.fromInput = exports.empty = exports.appendAll = exports.append = void 0;
var Arr = _interopRequireWildcard(require("effect/Array"));
var Either = _interopRequireWildcard(require("effect/Either"));
var _Function = require("effect/Function");
var Option = _interopRequireWildcard(require("effect/Option"));
var Schema = _interopRequireWildcard(require("effect/Schema"));
function _getRequireWildcardCache(e) { if ("function" != typeof WeakMap) return null; var r = new WeakMap(), t = new WeakMap(); return (_getRequireWildcardCache = function (e) { return e ? t : r; })(e); }
function _interopRequireWildcard(e, r) { if (!r && e && e.__esModule) return e; if (null === e || "object" != typeof e && "function" != typeof e) return { default: e }; var t = _getRequireWildcardCache(r); if (t && t.has(e)) return t.get(e); var n = { __proto__: null }, a = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var u in e) if ("default" !== u && {}.hasOwnProperty.call(e, u)) { var i = a ? Object.getOwnPropertyDescriptor(e, u) : null; i && (i.get || i.set) ? Object.defineProperty(n, u, i) : n[u] = e[u]; } return n.default = e, t && t.set(e, n), n; }
/**
 * @since 1.0.0
 */

/**
 * @since 1.0.0
 * @category constructors
 */
const fromInput = input => {
  const entries = Symbol.iterator in input ? Arr.fromIterable(input) : Object.entries(input);
  const out = [];
  for (const [key, value] of entries) {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (value[i] !== undefined) {
          out.push([key, String(value[i])]);
        }
      }
    } else if (value !== undefined) {
      out.push([key, String(value)]);
    }
  }
  return out;
};
/**
 * @since 1.0.0
 * @category schemas
 */
exports.fromInput = fromInput;
const schema = exports.schema = /*#__PURE__*/Schema.Array(Schema.Tuple(Schema.String, Schema.String)).annotations({
  identifier: "UrlParams"
});
/**
 * @since 1.0.0
 * @category constructors
 */
const empty = exports.empty = [];
/**
 * @since 1.0.0
 * @category combinators
 */
const getAll = exports.getAll = /*#__PURE__*/(0, _Function.dual)(2, (self, key) => Arr.reduce(self, [], (acc, [k, value]) => {
  if (k === key) {
    acc.push(value);
  }
  return acc;
}));
/**
 * @since 1.0.0
 * @category combinators
 */
const getFirst = exports.getFirst = /*#__PURE__*/(0, _Function.dual)(2, (self, key) => Option.map(Arr.findFirst(self, ([k]) => k === key), ([, value]) => value));
/**
 * @since 1.0.0
 * @category combinators
 */
const getLast = exports.getLast = /*#__PURE__*/(0, _Function.dual)(2, (self, key) => Option.map(Arr.findLast(self, ([k]) => k === key), ([, value]) => value));
/**
 * @since 1.0.0
 * @category combinators
 */
const set = exports.set = /*#__PURE__*/(0, _Function.dual)(3, (self, key, value) => Arr.append(Arr.filter(self, ([k]) => k !== key), [key, String(value)]));
/**
 * @since 1.0.0
 * @category combinators
 */
const setAll = exports.setAll = /*#__PURE__*/(0, _Function.dual)(2, (self, input) => {
  const toSet = fromInput(input);
  const keys = toSet.map(([k]) => k);
  return Arr.appendAll(Arr.filter(self, ([k]) => keys.includes(k)), toSet);
});
/**
 * @since 1.0.0
 * @category combinators
 */
const append = exports.append = /*#__PURE__*/(0, _Function.dual)(3, (self, key, value) => Arr.append(self, [key, String(value)]));
/**
 * @since 1.0.0
 * @category combinators
 */
const appendAll = exports.appendAll = /*#__PURE__*/(0, _Function.dual)(2, (self, input) => Arr.appendAll(self, fromInput(input)));
/**
 * @since 1.0.0
 * @category combinators
 */
const remove = exports.remove = /*#__PURE__*/(0, _Function.dual)(2, (self, key) => Arr.filter(self, ([k]) => k !== key));
/**
 * @since 1.0.0
 * @category conversions
 */
const makeUrl = (url, params, hash) => {
  try {
    const urlInstance = new URL(url, baseUrl());
    for (let i = 0; i < params.length; i++) {
      const [key, value] = params[i];
      if (value !== undefined) {
        urlInstance.searchParams.append(key, value);
      }
    }
    if (hash._tag === "Some") {
      urlInstance.hash = hash.value;
    }
    return Either.right(urlInstance);
  } catch (e) {
    return Either.left(e);
  }
};
/**
 * @since 1.0.0
 * @category conversions
 */
exports.makeUrl = makeUrl;
const toString = self => new URLSearchParams(self).toString();
exports.toString = toString;
const baseUrl = () => {
  if ("location" in globalThis && globalThis.location !== undefined && globalThis.location.origin !== undefined && globalThis.location.pathname !== undefined) {
    return location.origin + location.pathname;
  }
  return undefined;
};
/**
 * Builds a `Record` containing all the key-value pairs in the given `UrlParams`
 * as `string` (if only one value for a key) or a `NonEmptyArray<string>`
 * (when more than one value for a key)
 *
 * @example
 * ```ts
 * import { UrlParams } from "@effect/platform"
 *
 * const urlParams = UrlParams.fromInput({ a: 1, b: true, c: "string", e: [1, 2, 3] })
 * const result = UrlParams.toRecord(urlParams)
 *
 * assert.deepStrictEqual(
 *   result,
 *   { "a": "1", "b": "true", "c": "string", "e": ["1", "2", "3"] }
 * )
 * ```
 *
 * @since 1.0.0
 * @category conversions
 */
const toRecord = self => {
  const out = {};
  for (const [k, value] of self) {
    const curr = out[k];
    if (curr === undefined) {
      out[k] = value;
    } else if (typeof curr === "string") {
      out[k] = [curr, value];
    } else {
      curr.push(value);
    }
  }
  return out;
};
/**
 * @since 1.0.0
 * @category schema
 */
exports.toRecord = toRecord;
const schemaJson = (schema, options) => {
  const parse = Schema.decodeUnknown(Schema.parseJson(schema), options);
  return (0, _Function.dual)(2, (self, field) => parse(Option.getOrElse(getLast(self, field), () => "")));
};
/**
 * Extract schema from all key-value pairs in the given `UrlParams`.
 *
 * @example
 * ```ts
 * import { Effect, Schema } from "effect"
 * import { UrlParams } from "@effect/platform"
 *
 * Effect.gen(function* () {
 *   const urlParams = UrlParams.fromInput({ "a": [10, "string"], "b": false })
 *   const result = yield* UrlParams.schemaStruct(Schema.Struct({
 *     a: Schema.Tuple(Schema.NumberFromString, Schema.String),
 *     b: Schema.BooleanFromString
 *   }))(urlParams)
 *
 *   assert.deepStrictEqual(result, {
 *     a: [10, "string"],
 *     b: false
 *   })
 * })
 * ```
 *
 * @since 1.0.0
 * @category schema
 */
exports.schemaJson = schemaJson;
const schemaStruct = (schema, options) => self => {
  const parse = Schema.decodeUnknown(schema, options);
  return parse(toRecord(self));
};
exports.schemaStruct = schemaStruct;
//# sourceMappingURL=UrlParams.js.map