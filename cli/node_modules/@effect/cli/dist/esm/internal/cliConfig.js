import * as Context from "effect/Context";
import { dual } from "effect/Function";
import * as Layer from "effect/Layer";
/** @internal */
export const make = params => ({
  ...defaultConfig,
  ...params
});
/** @internal */
export const Tag = /*#__PURE__*/Context.GenericTag("@effect/cli/CliConfig");
/** @internal */
export const defaultConfig = {
  isCaseSensitive: false,
  autoCorrectLimit: 2,
  finalCheckBuiltIn: false,
  showAllNames: true,
  showBuiltIns: true,
  showTypes: true
};
/** @internal */
export const defaultLayer = /*#__PURE__*/Layer.succeed(Tag, defaultConfig);
/** @internal */
export const layer = config => Layer.succeed(Tag, make(config));
/** @internal */
export const normalizeCase = /*#__PURE__*/dual(2, (self, text) => self.isCaseSensitive ? text : text.toLowerCase());
//# sourceMappingURL=cliConfig.js.map