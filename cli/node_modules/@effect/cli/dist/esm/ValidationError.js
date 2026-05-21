import * as InternalCommand from "./internal/commandDescriptor.js";
import * as InternalValidationError from "./internal/validationError.js";
/**
 * @since 1.0.0
 * @category symbols
 */
export const ValidationErrorTypeId = InternalValidationError.ValidationErrorTypeId;
/**
 * @since 1.0.0
 * @category refinements
 */
export const isValidationError = InternalValidationError.isValidationError;
/**
 * @since 1.0.0
 * @category refinements
 */
export const isCommandMismatch = InternalValidationError.isCommandMismatch;
/**
 * @since 1.0.0
 * @category refinements
 */
export const isCorrectedFlag = InternalValidationError.isCorrectedFlag;
/**
 * @since 1.0.0
 * @category refinements
 */
export const isHelpRequested = InternalValidationError.isHelpRequested;
/**
 * @since 1.0.0
 * @category refinements
 */
export const isInvalidArgument = InternalValidationError.isInvalidArgument;
/**
 * @since 1.0.0
 * @category refinements
 */
export const isInvalidValue = InternalValidationError.isInvalidValue;
/**
 * @since 1.0.0
 * @category refinements
 */
export const isMultipleValuesDetected = InternalValidationError.isMultipleValuesDetected;
/**
 * @since 1.0.0
 * @category refinements
 */
export const isMissingFlag = InternalValidationError.isMissingFlag;
/**
 * @since 1.0.0
 * @category refinements
 */
export const isMissingValue = InternalValidationError.isMissingValue;
/**
 * @since 1.0.0
 * @category refinements
 */
export const isMissingSubcommand = InternalValidationError.isMissingSubcommand;
/**
 * @since 1.0.0
 * @category refinements
 */
export const isNoBuiltInMatch = InternalValidationError.isNoBuiltInMatch;
/**
 * @since 1.0.0
 * @category refinements
 */
export const isUnclusteredFlag = InternalValidationError.isUnclusteredFlag;
/**
 * @since 1.0.0
 * @category constructors
 */
export const commandMismatch = InternalValidationError.commandMismatch;
/**
 * @since 1.0.0
 * @category constructors
 */
export const correctedFlag = InternalValidationError.correctedFlag;
/**
 * @since 1.0.0
 * @category constructors
 */
export const helpRequested = InternalCommand.helpRequestedError;
/**
 * @since 1.0.0
 * @category constructors
 */
export const invalidArgument = InternalValidationError.invalidArgument;
/**
 * @since 1.0.0
 * @category constructors
 */
export const invalidValue = InternalValidationError.invalidValue;
/**
 * @since 1.0.0
 * @category constructors
 */
export const keyValuesDetected = InternalValidationError.multipleValuesDetected;
/**
 * @since 1.0.0
 * @category constructors
 */
export const missingFlag = InternalValidationError.missingFlag;
/**
 * @since 1.0.0
 * @category constructors
 */
export const missingValue = InternalValidationError.missingValue;
/**
 * @since 1.0.0
 * @category constructors
 */
export const missingSubcommand = InternalValidationError.missingSubcommand;
/**
 * @since 1.0.0
 * @category constructors
 */
export const noBuiltInMatch = InternalValidationError.noBuiltInMatch;
/**
 * @since 1.0.0
 * @category constructors
 */
export const unclusteredFlag = InternalValidationError.unclusteredFlag;
//# sourceMappingURL=ValidationError.js.map