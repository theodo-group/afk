"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.entriesToDisplay = void 0;
/** @internal */
const entriesToDisplay = (cursor, total, maxVisible) => {
  const max = maxVisible === undefined ? total : maxVisible;
  let startIndex = Math.min(total - max, cursor - Math.floor(max / 2));
  if (startIndex < 0) {
    startIndex = 0;
  }
  const endIndex = Math.min(startIndex + max, total);
  return {
    startIndex,
    endIndex
  };
};
exports.entriesToDisplay = entriesToDisplay;
//# sourceMappingURL=utils.js.map