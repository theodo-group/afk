import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Effectable from "effect/Effectable";
import { dual, identity } from "effect/Function";
import { globalValue } from "effect/GlobalValue";
import { pipeArguments } from "effect/Pipeable";
import * as ValidationError from "../ValidationError.js";
import * as InternalArgs from "./args.js";
import * as InternalCliApp from "./cliApp.js";
import * as InternalDescriptor from "./commandDescriptor.js";
import * as InternalOptions from "./options.js";
const CommandSymbolKey = "@effect/cli/Command";
/** @internal */
export const TypeId = /*#__PURE__*/Symbol.for(CommandSymbolKey);
const parseConfig = config => {
  const args = [];
  let argsIndex = 0;
  const options = [];
  let optionsIndex = 0;
  function parse(config) {
    const tree = {};
    for (const key in config) {
      tree[key] = parseValue(config[key]);
    }
    return tree;
  }
  function parseValue(value) {
    if (Arr.isArray(value)) {
      return {
        _tag: "Array",
        children: Arr.map(value, parseValue)
      };
    } else if (InternalArgs.isArgs(value)) {
      args.push(value);
      return {
        _tag: "Args",
        index: argsIndex++
      };
    } else if (InternalOptions.isOptions(value)) {
      options.push(value);
      return {
        _tag: "Options",
        index: optionsIndex++
      };
    } else {
      return {
        _tag: "ParsedConfig",
        tree: parse(value)
      };
    }
  }
  return {
    args,
    options,
    tree: parse(config)
  };
};
const reconstructConfigTree = (tree, args, options) => {
  const output = {};
  for (const key in tree) {
    output[key] = nodeValue(tree[key]);
  }
  return output;
  function nodeValue(node) {
    if (node._tag === "Args") {
      return args[node.index];
    } else if (node._tag === "Options") {
      return options[node.index];
    } else if (node._tag === "Array") {
      return Arr.map(node.children, nodeValue);
    } else {
      return reconstructConfigTree(node.tree, args, options);
    }
  }
};
const Prototype = {
  ...Effectable.CommitPrototype,
  [TypeId]: TypeId,
  commit() {
    return this.tag;
  },
  pipe() {
    return pipeArguments(this, arguments);
  }
};
const registeredDescriptors = /*#__PURE__*/globalValue("@effect/cli/Command/registeredDescriptors", () => new WeakMap());
const getDescriptor = self => registeredDescriptors.get(self.tag) ?? self.descriptor;
const makeProto = (descriptor, handler, tag, transform = identity) => {
  const self = Object.create(Prototype);
  self.descriptor = descriptor;
  self.handler = handler;
  self.transform = transform;
  self.tag = tag;
  return self;
};
const makeDerive = (self, options) => {
  const command = Object.create(Prototype);
  command.descriptor = options.descriptor ?? self.descriptor;
  command.handler = options.handler ?? self.handler;
  command.transform = options.transform ? (effect, opts) => options.transform(self.transform(effect, opts), opts) : self.transform;
  command.tag = self.tag;
  return command;
};
/** @internal */
export const fromDescriptor = /*#__PURE__*/dual(args => InternalDescriptor.isCommand(args[0]), (descriptor, handler) => {
  const self = makeProto(descriptor, handler ?? (_ => Effect.failSync(() => ValidationError.helpRequested(getDescriptor(self)))), Context.GenericTag(`@effect/cli/Command/(${Arr.fromIterable(InternalDescriptor.getNames(descriptor)).join("|")})`));
  return self;
});
const makeDescriptor = (name, config) => {
  const {
    args,
    options,
    tree
  } = parseConfig(config);
  return InternalDescriptor.map(InternalDescriptor.make(name, InternalOptions.all(options), InternalArgs.all(args)), ({
    args,
    options
  }) => reconstructConfigTree(tree, args, options));
};
/** @internal */
export const make = (name, config = {}, handler) => fromDescriptor(makeDescriptor(name, config), handler);
/** @internal */
export const getHelp = (self, config) => InternalDescriptor.getHelp(self.descriptor, config);
/** @internal */
export const getNames = self => InternalDescriptor.getNames(self.descriptor);
/** @internal */
export const getBashCompletions = (self, programName) => InternalDescriptor.getBashCompletions(self.descriptor, programName);
/** @internal */
export const getFishCompletions = (self, programName) => InternalDescriptor.getFishCompletions(self.descriptor, programName);
/** @internal */
export const getZshCompletions = (self, programName) => InternalDescriptor.getZshCompletions(self.descriptor, programName);
/** @internal */
export const getSubcommands = self => InternalDescriptor.getSubcommands(self.descriptor);
/** @internal */
export const getUsage = self => InternalDescriptor.getUsage(self.descriptor);
const mapDescriptor = /*#__PURE__*/dual(2, (self, f) => makeDerive(self, {
  descriptor: f(self.descriptor)
}));
/** @internal */
export const prompt = (name, prompt, handler) => makeProto(InternalDescriptor.map(InternalDescriptor.prompt(name, prompt), _ => _.value), handler, Context.GenericTag(`@effect/cli/Prompt/${name}`));
/** @internal */
export const withHandler = /*#__PURE__*/dual(2, (self, handler) => makeDerive(self, {
  handler,
  transform: identity
}));
/** @internal */
export const transformHandler = /*#__PURE__*/dual(2, (self, f) => makeDerive(self, {
  transform: f
}));
/** @internal */
export const provide = /*#__PURE__*/dual(2, (self, layer) => makeDerive(self, {
  transform: (effect, config) => Effect.provide(effect, typeof layer === "function" ? layer(config) : layer)
}));
/** @internal */
export const provideEffect = /*#__PURE__*/dual(3, (self, tag, effect_) => makeDerive(self, {
  transform: (self, config) => {
    const effect = typeof effect_ === "function" ? effect_(config) : effect_;
    return Effect.provideServiceEffect(self, tag, effect);
  }
}));
/** @internal */
export const provideEffectDiscard = /*#__PURE__*/dual(2, (self, effect_) => makeDerive(self, {
  transform: (self, config) => {
    const effect = typeof effect_ === "function" ? effect_(config) : effect_;
    return Effect.zipRight(effect, self);
  }
}));
/** @internal */
export const provideSync = /*#__PURE__*/dual(3, (self, tag, f) => makeDerive(self, {
  transform: (self, config) => {
    const service = typeof f === "function" ? f(config) : f;
    return Effect.provideService(self, tag, service);
  }
}));
/** @internal */
export const withDescription = /*#__PURE__*/dual(2, (self, help) => mapDescriptor(self, InternalDescriptor.withDescription(help)));
/** @internal */
export const withSubcommands = /*#__PURE__*/dual(2, (self, subcommands) => {
  const command = InternalDescriptor.withSubcommands(self.descriptor, Arr.map(subcommands, _ => [_.tag, _.descriptor]));
  const subcommandMap = Arr.reduce(subcommands, new Map(), (handlers, subcommand) => {
    handlers.set(subcommand.tag, subcommand);
    registeredDescriptors.set(subcommand.tag, subcommand.descriptor);
    return handlers;
  });
  function handler(args) {
    if (args.subcommand._tag === "Some") {
      const [tag, value] = args.subcommand.value;
      const subcommand = subcommandMap.get(tag);
      const subcommandEffect = subcommand.transform(subcommand.handler(value), value);
      return Effect.provideService(subcommandEffect, self.tag, args);
    }
    return self.handler(args);
  }
  return makeDerive(self, {
    descriptor: command,
    handler
  });
});
/** @internal */
export const wizard = /*#__PURE__*/dual(3, (self, prefix, config) => InternalDescriptor.wizard(self.descriptor, prefix, config));
/** @internal */
export const run = /*#__PURE__*/dual(2, (self, config) => {
  const app = InternalCliApp.make({
    ...config,
    command: self.descriptor
  });
  registeredDescriptors.set(self.tag, self.descriptor);
  const handler = args => self.transform(self.handler(args), args);
  return args => InternalCliApp.run(app, args, handler);
});
//# sourceMappingURL=command.js.map