import * as InternalPrompt from "../prompt.js";
import * as InternalTextPrompt from "./text.js";
/** @internal */
export const list = options => InternalTextPrompt.text(options).pipe(InternalPrompt.map(output => output.split(options.delimiter || ",")));
//# sourceMappingURL=list.js.map