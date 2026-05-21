import * as InternalArgs from "./internal/args.js";
/**
 * @since 1.0.0
 * @category symbols
 */
export const ArgsTypeId = InternalArgs.ArgsTypeId;
/**
 * @since 1.0.0
 * @category refinements
 */
export const isArgs = InternalArgs.isArgs;
/**
 * @since 1.0.0
 * @category constructors
 */
export const all = InternalArgs.all;
/**
 * @since 1.0.0
 * @category combinators
 */
export const atLeast = InternalArgs.atLeast;
/**
 * @since 1.0.0
 * @category combinators
 */
export const atMost = InternalArgs.atMost;
/**
 * @since 1.0.0
 * @category combinators
 */
export const between = InternalArgs.between;
/**
 * Creates a boolean argument.
 *
 * Can optionally provide a custom argument name (defaults to `"boolean"`).
 *
 * @since 1.0.0
 * @category constructors
 */
export const boolean = InternalArgs.boolean;
/**
 * Creates a choice argument.
 *
 * Can optionally provide a custom argument name (defaults to `"choice"`).
 *
 * @since 1.0.0
 * @category constructors
 */
export const choice = InternalArgs.choice;
/**
 * Creates a date argument.
 *
 * Can optionally provide a custom argument name (defaults to `"date"`).
 *
 * @since 1.0.0
 * @category constructors
 */
export const date = InternalArgs.date;
/**
 * Creates a directory argument.
 *
 * Can optionally provide a custom argument name (defaults to `"directory"`).
 *
 * @since 1.0.0
 * @category constructors
 */
export const directory = InternalArgs.directory;
/**
 * Creates a file argument.
 *
 * Can optionally provide a custom argument name (defaults to `"file"`).
 *
 * @since 1.0.0
 * @category constructors
 */
export const file = InternalArgs.file;
/**
 * Creates a file argument that reads its contents.
 *
 * Can optionally provide a custom argument name (defaults to `"file"`).
 *
 * @since 1.0.0
 * @category constructors
 */
export const fileContent = InternalArgs.fileContent;
/**
 * Creates a file argument that reads and parses its contents.
 *
 * Can optionally provide a custom argument name (defaults to `"file"`).
 *
 * @since 1.0.0
 * @category constructors
 */
export const fileParse = InternalArgs.fileParse;
/**
 * Creates a file argument that reads, parses and validates its contents.
 *
 * Can optionally provide a custom argument name (defaults to `"file"`).
 *
 * @since 1.0.0
 * @category constructors
 */
export const fileSchema = InternalArgs.fileSchema;
/**
 * Creates a file argument that reads it's contents.
 *
 * Can optionally provide a custom argument name (defaults to `"file"`).
 *
 * @since 1.0.0
 * @category constructors
 */
export const fileText = InternalArgs.fileText;
/**
 * Creates a floating point number argument.
 *
 * Can optionally provide a custom argument name (defaults to `"float"`).
 *
 * @since 1.0.0
 * @category constructors
 */
export const float = InternalArgs.float;
/**
 * @since 1.0.0
 * @category combinators
 */
export const getHelp = InternalArgs.getHelp;
/**
 * @since 1.0.0
 * @category combinators
 */
export const getIdentifier = InternalArgs.getIdentifier;
/**
 * @since 1.0.0
 * @category combinators
 */
export const getMinSize = InternalArgs.getMinSize;
/**
 * @since 1.0.0
 * @category combinators
 */
export const getMaxSize = InternalArgs.getMaxSize;
/**
 * @since 1.0.0
 * @category combinators
 */
export const getUsage = InternalArgs.getUsage;
/**
 * Creates an integer argument.
 *
 * Can optionally provide a custom argument name (defaults to `"integer"`).
 *
 * @since 1.0.0
 * @category constructors
 */
export const integer = InternalArgs.integer;
/**
 * @since 1.0.0
 * @category mapping
 */
export const map = InternalArgs.map;
/**
 * @since 1.0.0
 * @category mapping
 */
export const mapEffect = InternalArgs.mapEffect;
/**
 * @since 1.0.0
 * @category mapping
 */
export const mapTryCatch = InternalArgs.mapTryCatch;
/**
 * @since 1.0.0
 * @category combinators
 */
export const optional = InternalArgs.optional;
/**
 *  Creates an empty argument.
 *
 * @since 1.0.0
 * @category constructors
 */
export const none = InternalArgs.none;
/**
 * Creates a path argument.
 *
 * Can optionally provide a custom argument name (defaults to `"path"`).
 *
 * @since 1.0.0
 * @category constructors
 */
export const path = InternalArgs.path;
/**
 * @since 1.0.0
 * @category combinators
 */
export const repeated = InternalArgs.repeated;
/**
 * Creates a text argument.
 *
 * Can optionally provide a custom argument name (defaults to `"redacted"`).
 *
 * @since 1.0.0
 * @category constructors
 */
export const redacted = InternalArgs.redacted;
/**
 * Creates a text argument.
 *
 * Can optionally provide a custom argument name (defaults to `"secret"`).
 *
 * @since 1.0.0
 * @category constructors
 */
export const secret = InternalArgs.secret;
/**
 * Creates a text argument.
 *
 * Can optionally provide a custom argument name (defaults to `"text"`).
 *
 * @since 1.0.0
 * @category constructors
 */
export const text = InternalArgs.text;
/**
 * @since 1.0.0
 * @category combinators
 */
export const validate = InternalArgs.validate;
/**
 * @since 1.0.0
 * @category combinators
 */
export const withDefault = InternalArgs.withDefault;
/**
 * @since 1.0.0
 * @category combinators
 */
export const withFallbackConfig = InternalArgs.withFallbackConfig;
/**
 * @since 1.0.0
 * @category combinators
 */
export const withDescription = InternalArgs.withDescription;
/**
 * @since 1.0.0
 * @category combinators
 */
export const withSchema = InternalArgs.withSchema;
/**
 * @since 1.0.0
 * @category combinators
 */
export const wizard = InternalArgs.wizard;
//# sourceMappingURL=Args.js.map