import { dual } from "effect/Function";
/** @internal */
export const builtIn = option => ({
  _tag: "BuiltIn",
  option
});
/** @internal */
export const userDefined = (leftover, value) => ({
  _tag: "UserDefined",
  leftover,
  value
});
/** @internal */
export const isBuiltIn = self => self._tag === "BuiltIn";
/** @internal */
export const isUserDefined = self => self._tag === "UserDefined";
/** @internal */
export const map = /*#__PURE__*/dual(2, (self, f) => isUserDefined(self) ? userDefined(self.leftover, f(self.value)) : self);
//# sourceMappingURL=commandDirective.js.map