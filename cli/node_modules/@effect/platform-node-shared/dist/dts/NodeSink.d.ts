/**
 * @since 1.0.0
 */
import type { Channel } from "effect/Channel";
import type { Chunk } from "effect/Chunk";
import type { LazyArg } from "effect/Function";
import type { Sink } from "effect/Sink";
import type { Writable } from "stream";
import type { FromWritableOptions } from "./NodeStream.js";
/**
 * @category constructor
 * @since 1.0.0
 */
export declare const fromWritable: <E, A = string | Uint8Array>(evaluate: LazyArg<Writable | NodeJS.WritableStream>, onError: (error: unknown) => E, options?: FromWritableOptions) => Sink<void, A, never, E>;
/**
 * @category constructor
 * @since 1.0.0
 */
export declare const fromWritableChannel: <IE, OE, A>(writable: LazyArg<Writable | NodeJS.WritableStream>, onError: (error: unknown) => OE, options?: FromWritableOptions) => Channel<Chunk<never>, Chunk<A>, IE | OE, IE, void, unknown>;
//# sourceMappingURL=NodeSink.d.ts.map