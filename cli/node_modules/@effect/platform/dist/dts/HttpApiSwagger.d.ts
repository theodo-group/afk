import type { Layer } from "effect/Layer";
import { Api } from "./HttpApi.js";
/**
 * @since 1.0.0
 * @category layers
 */
export declare const layer: (options?: {
    readonly path?: `/${string}` | undefined;
}) => Layer<never, never, Api>;
//# sourceMappingURL=HttpApiSwagger.d.ts.map