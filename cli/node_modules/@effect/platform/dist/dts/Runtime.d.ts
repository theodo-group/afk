import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Fiber from "effect/Fiber";
/**
 * @category model
 * @since 1.0.0
 */
export interface Teardown {
    <E, A>(exit: Exit.Exit<E, A>, onExit: (code: number) => void): void;
}
/**
 * @category teardown
 * @since 1.0.0
 */
export declare const defaultTeardown: Teardown;
/**
 * @category model
 * @since 1.0.0
 */
export interface RunMain {
    (options?: {
        readonly disableErrorReporting?: boolean | undefined;
        readonly disablePrettyLogger?: boolean | undefined;
        readonly teardown?: Teardown | undefined;
    }): <E, A>(effect: Effect.Effect<A, E>) => void;
    <E, A>(effect: Effect.Effect<A, E>, options?: {
        readonly disableErrorReporting?: boolean | undefined;
        readonly disablePrettyLogger?: boolean | undefined;
        readonly teardown?: Teardown | undefined;
    }): void;
}
/**
 * @category constructors
 * @since 1.0.0
 */
export declare const makeRunMain: (f: <E, A>(options: {
    readonly fiber: Fiber.RuntimeFiber<A, E>;
    readonly teardown: Teardown;
}) => void) => RunMain;
//# sourceMappingURL=Runtime.d.ts.map