"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.unclusteredFlag = exports.proto = exports.noBuiltInMatch = exports.multipleValuesDetected = exports.missingValue = exports.missingSubcommand = exports.missingFlag = exports.isValidationError = exports.isUnclusteredFlag = exports.isNoBuiltInMatch = exports.isMultipleValuesDetected = exports.isMissingValue = exports.isMissingSubcommand = exports.isMissingFlag = exports.isInvalidValue = exports.isInvalidArgument = exports.isHelpRequested = exports.isCorrectedFlag = exports.isCommandMismatch = exports.invalidValue = exports.invalidArgument = exports.correctedFlag = exports.commandMismatch = exports.ValidationErrorTypeId = void 0;
const ValidationErrorSymbolKey = "@effect/cli/ValidationError";
/** @internal */
const ValidationErrorTypeId = exports.ValidationErrorTypeId = /*#__PURE__*/Symbol.for(ValidationErrorSymbolKey);
/** @internal */
const proto = exports.proto = {
  [ValidationErrorTypeId]: ValidationErrorTypeId
};
/** @internal */
const isValidationError = u => typeof u === "object" && u != null && ValidationErrorTypeId in u;
/** @internal */
exports.isValidationError = isValidationError;
const isCommandMismatch = self => self._tag === "CommandMismatch";
/** @internal */
exports.isCommandMismatch = isCommandMismatch;
const isCorrectedFlag = self => self._tag === "CorrectedFlag";
/** @internal */
exports.isCorrectedFlag = isCorrectedFlag;
const isHelpRequested = self => self._tag === "HelpRequested";
/** @internal */
exports.isHelpRequested = isHelpRequested;
const isInvalidArgument = self => self._tag === "InvalidArgument";
/** @internal */
exports.isInvalidArgument = isInvalidArgument;
const isInvalidValue = self => self._tag === "InvalidValue";
/** @internal */
exports.isInvalidValue = isInvalidValue;
const isMultipleValuesDetected = self => self._tag === "MultipleValuesDetected";
/** @internal */
exports.isMultipleValuesDetected = isMultipleValuesDetected;
const isMissingFlag = self => self._tag === "MissingFlag";
/** @internal */
exports.isMissingFlag = isMissingFlag;
const isMissingValue = self => self._tag === "MissingValue";
/** @internal */
exports.isMissingValue = isMissingValue;
const isMissingSubcommand = self => self._tag === "MissingSubcommand";
/** @internal */
exports.isMissingSubcommand = isMissingSubcommand;
const isNoBuiltInMatch = self => self._tag === "NoBuiltInMatch";
/** @internal */
exports.isNoBuiltInMatch = isNoBuiltInMatch;
const isUnclusteredFlag = self => self._tag === "UnclusteredFlag";
/** @internal */
exports.isUnclusteredFlag = isUnclusteredFlag;
const commandMismatch = error => {
  const op = Object.create(proto);
  op._tag = "CommandMismatch";
  op.error = error;
  return op;
};
/** @internal */
exports.commandMismatch = commandMismatch;
const correctedFlag = error => {
  const op = Object.create(proto);
  op._tag = "CorrectedFlag";
  op.error = error;
  return op;
};
/** @internal */
exports.correctedFlag = correctedFlag;
const invalidArgument = error => {
  const op = Object.create(proto);
  op._tag = "InvalidArgument";
  op.error = error;
  return op;
};
/** @internal */
exports.invalidArgument = invalidArgument;
const invalidValue = error => {
  const op = Object.create(proto);
  op._tag = "InvalidValue";
  op.error = error;
  return op;
};
/** @internal */
exports.invalidValue = invalidValue;
const missingFlag = error => {
  const op = Object.create(proto);
  op._tag = "MissingFlag";
  op.error = error;
  return op;
};
/** @internal */
exports.missingFlag = missingFlag;
const missingValue = error => {
  const op = Object.create(proto);
  op._tag = "MissingValue";
  op.error = error;
  return op;
};
/** @internal */
exports.missingValue = missingValue;
const missingSubcommand = error => {
  const op = Object.create(proto);
  op._tag = "MissingSubcommand";
  op.error = error;
  return op;
};
/** @internal */
exports.missingSubcommand = missingSubcommand;
const multipleValuesDetected = (error, values) => {
  const op = Object.create(proto);
  op._tag = "MultipleValuesDetected";
  op.error = error;
  op.values = values;
  return op;
};
/** @internal */
exports.multipleValuesDetected = multipleValuesDetected;
const noBuiltInMatch = error => {
  const op = Object.create(proto);
  op._tag = "NoBuiltInMatch";
  op.error = error;
  return op;
};
/** @internal */
exports.noBuiltInMatch = noBuiltInMatch;
const unclusteredFlag = (error, unclustered, rest) => {
  const op = Object.create(proto);
  op._tag = "UnclusteredFlag";
  op.error = error;
  op.unclustered = unclustered;
  op.rest = rest;
  return op;
};
exports.unclusteredFlag = unclusteredFlag;
//# sourceMappingURL=validationError.js.map