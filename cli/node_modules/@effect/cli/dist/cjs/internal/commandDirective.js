"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.userDefined = exports.map = exports.isUserDefined = exports.isBuiltIn = exports.builtIn = void 0;
var _Function = require("effect/Function");
/** @internal */
const builtIn = option => ({
  _tag: "BuiltIn",
  option
});
/** @internal */
exports.builtIn = builtIn;
const userDefined = (leftover, value) => ({
  _tag: "UserDefined",
  leftover,
  value
});
/** @internal */
exports.userDefined = userDefined;
const isBuiltIn = self => self._tag === "BuiltIn";
/** @internal */
exports.isBuiltIn = isBuiltIn;
const isUserDefined = self => self._tag === "UserDefined";
/** @internal */
exports.isUserDefined = isUserDefined;
const map = exports.map = /*#__PURE__*/(0, _Function.dual)(2, (self, f) => isUserDefined(self) ? userDefined(self.leftover, f(self.value)) : self);
//# sourceMappingURL=commandDirective.js.map