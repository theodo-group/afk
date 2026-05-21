import * as InternalPrimitive from "./internal/primitive.js";
/**
 * @since 1.0.0
 * @category symbol
 */
export const PrimitiveTypeId = InternalPrimitive.PrimitiveTypeId;
/**
 * @since 1.0.0
 * @category Predicates
 */
export const isBool = InternalPrimitive.isBool;
/**
 * Represents a boolean value.
 *
 * True values can be passed as one of: `["true", "1", "y", "yes" or "on"]`.
 * False value can be passed as one of: `["false", "o", "n", "no" or "off"]`.
 *
 * @since 1.0.0
 * @category constructors
 */
export const boolean = InternalPrimitive.boolean;
/**
 * @since 1.0.0
 * @category constructors
 */
export const choice = InternalPrimitive.choice;
/**
 * Represents a date in ISO-8601 format, such as `2007-12-03T10:15:30`.
 *
 * @since 1.0.0
 * @category constructors
 */
export const date = InternalPrimitive.date;
/**
 * Represents a floating point number.
 *
 * @since 1.0.0
 * @category constructors
 */
export const float = InternalPrimitive.float;
/**
 * Returns a text representation of the valid choices for a primitive type, if
 * any.
 *
 * @since 1.0.0
 * @category combinators
 */
export const getChoices = InternalPrimitive.getChoices;
/**
 * Returns help documentation for a primitive type.
 *
 * @since 1.0.0
 * @category combinators
 */
export const getHelp = InternalPrimitive.getHelp;
/**
 * Returns a string representation of the primitive type.
 *
 * @since 1.0.0
 * @category combinators
 */
export const getTypeName = InternalPrimitive.getTypeName;
/**
 * Represents an integer.
 *
 * @since 1.0.0
 * @category constructors
 */
export const integer = InternalPrimitive.integer;
/**
 * Represents a user-defined piece of text.
 *
 * @since 1.0.0
 * @category constructors
 */
export const text = InternalPrimitive.text;
/**
 * Validates that the specified value, if any, matches the specified primitive
 * type.
 *
 * @since 1.0.0
 * @category combinators
 */
export const validate = InternalPrimitive.validate;
/**
 * Runs a wizard that will prompt the user for input matching the specified
 * primitive type.
 *
 * @since 1.0.0
 * @category combinators
 */
export const wizard = InternalPrimitive.wizard;
//# sourceMappingURL=Primitive.js.map