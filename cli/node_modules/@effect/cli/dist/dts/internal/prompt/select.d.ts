import * as Terminal from "@effect/platform/Terminal";
import * as Effect from "effect/Effect";
import type * as Prompt from "../../Prompt.js";
interface SelectOptions<A> extends Required<Prompt.Prompt.SelectOptions<A>> {
}
export declare function handleClear<A>(options: SelectOptions<A>): Effect.Effect<string, never, Terminal.Terminal>;
export {};
//# sourceMappingURL=select.d.ts.map