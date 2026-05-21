const ValidationErrorSymbolKey = "@effect/cli/ValidationError";
/** @internal */
export const ValidationErrorTypeId = /*#__PURE__*/Symbol.for(ValidationErrorSymbolKey);
/** @internal */
export const proto = {
  [ValidationErrorTypeId]: ValidationErrorTypeId
};
/** @internal */
export const isValidationError = u => typeof u === "object" && u != null && ValidationErrorTypeId in u;
/** @internal */
export const isCommandMismatch = self => self._tag === "CommandMismatch";
/** @internal */
export const isCorrectedFlag = self => self._tag === "CorrectedFlag";
/** @internal */
export const isHelpRequested = self => self._tag === "HelpRequested";
/** @internal */
export const isInvalidArgument = self => self._tag === "InvalidArgument";
/** @internal */
export const isInvalidValue = self => self._tag === "InvalidValue";
/** @internal */
export const isMultipleValuesDetected = self => self._tag === "MultipleValuesDetected";
/** @internal */
export const isMissingFlag = self => self._tag === "MissingFlag";
/** @internal */
export const isMissingValue = self => self._tag === "MissingValue";
/** @internal */
export const isMissingSubcommand = self => self._tag === "MissingSubcommand";
/** @internal */
export const isNoBuiltInMatch = self => self._tag === "NoBuiltInMatch";
/** @internal */
export const isUnclusteredFlag = self => self._tag === "UnclusteredFlag";
/** @internal */
export const commandMismatch = error => {
  const op = Object.create(proto);
  op._tag = "CommandMismatch";
  op.error = error;
  return op;
};
/** @internal */
export const correctedFlag = error => {
  const op = Object.create(proto);
  op._tag = "CorrectedFlag";
  op.error = error;
  return op;
};
/** @internal */
export const invalidArgument = error => {
  const op = Object.create(proto);
  op._tag = "InvalidArgument";
  op.error = error;
  return op;
};
/** @internal */
export const invalidValue = error => {
  const op = Object.create(proto);
  op._tag = "InvalidValue";
  op.error = error;
  return op;
};
/** @internal */
export const missingFlag = error => {
  const op = Object.create(proto);
  op._tag = "MissingFlag";
  op.error = error;
  return op;
};
/** @internal */
export const missingValue = error => {
  const op = Object.create(proto);
  op._tag = "MissingValue";
  op.error = error;
  return op;
};
/** @internal */
export const missingSubcommand = error => {
  const op = Object.create(proto);
  op._tag = "MissingSubcommand";
  op.error = error;
  return op;
};
/** @internal */
export const multipleValuesDetected = (error, values) => {
  const op = Object.create(proto);
  op._tag = "MultipleValuesDetected";
  op.error = error;
  op.values = values;
  return op;
};
/** @internal */
export const noBuiltInMatch = error => {
  const op = Object.create(proto);
  op._tag = "NoBuiltInMatch";
  op.error = error;
  return op;
};
/** @internal */
export const unclusteredFlag = (error, unclustered, rest) => {
  const op = Object.create(proto);
  op._tag = "UnclusteredFlag";
  op.error = error;
  op.unclustered = unclustered;
  op.rest = rest;
  return op;
};
//# sourceMappingURL=validationError.js.map