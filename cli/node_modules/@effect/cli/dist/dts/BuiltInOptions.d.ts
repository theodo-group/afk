/**
 * @since 1.0.0
 */
import type { LogLevel } from "effect/LogLevel";
import type { Option } from "effect/Option";
import type { Command } from "./CommandDescriptor.js";
import type { HelpDoc } from "./HelpDoc.js";
import type { Options } from "./Options.js";
import type { Usage } from "./Usage.js";
/**
 * @since 1.0.0
 * @category models
 */
export type BuiltInOptions = SetLogLevel | ShowHelp | ShowCompletions | ShowWizard | ShowVersion;
/**
 * @since 1.0.0
 * @category models
 */
export interface SetLogLevel {
    readonly _tag: "SetLogLevel";
    readonly level: LogLevel;
}
/**
 * @since 1.0.0
 * @category models
 */
export interface ShowHelp {
    readonly _tag: "ShowHelp";
    readonly usage: Usage;
    readonly helpDoc: HelpDoc;
}
/**
 * @since 1.0.0
 * @category models
 */
export interface ShowCompletions {
    readonly _tag: "ShowCompletions";
    readonly shellType: BuiltInOptions.ShellType;
}
/**
 * @since 1.0.0
 * @category models
 */
export interface ShowWizard {
    readonly _tag: "ShowWizard";
    readonly command: Command<unknown>;
}
/**
 * @since 1.0.0
 * @category models
 */
export interface ShowVersion {
    readonly _tag: "ShowVersion";
}
/**
 * @since 1.0.0
 */
export declare namespace BuiltInOptions {
    /**
     * @since 1.0.0
     * @category models
     */
    type ShellType = "bash" | "fish" | "zsh";
}
/**
 * @since 1.0.0
 * @category options
 */
export declare const builtInOptions: <A>(command: Command<A>, usage: Usage, helpDoc: HelpDoc) => Options<Option<BuiltInOptions>>;
/**
 * @since 1.0.0
 * @category refinements
 */
export declare const isShowCompletions: (self: BuiltInOptions) => self is ShowCompletions;
/**
 * @since 1.0.0
 * @category refinements
 */
export declare const isShowHelp: (self: BuiltInOptions) => self is ShowHelp;
/**
 * @since 1.0.0
 * @category refinements
 */
export declare const isShowWizard: (self: BuiltInOptions) => self is ShowWizard;
/**
 * @since 1.0.0
 * @category refinements
 */
export declare const isShowVersion: (self: BuiltInOptions) => self is ShowVersion;
/**
 * @since 1.0.0
 * @category constructors
 */
export declare const showCompletions: (shellType: BuiltInOptions.ShellType) => BuiltInOptions;
/**
 * @since 1.0.0
 * @category constructors
 */
export declare const showHelp: (usage: Usage, helpDoc: HelpDoc) => BuiltInOptions;
/**
 * @since 1.0.0
 * @category constructors
 */
export declare const showWizard: (command: Command<unknown>) => BuiltInOptions;
/**
 * @since 1.0.0
 * @category constructors
 */
export declare const showVersion: BuiltInOptions;
//# sourceMappingURL=BuiltInOptions.d.ts.map