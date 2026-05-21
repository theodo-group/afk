import * as FileSystem from "@effect/platform/FileSystem";
import * as Effect from "effect/Effect";
import * as Ini from "ini";
import * as Toml from "toml";
import * as Yaml from "yaml";
/** @internal */
export const fileParsers = {
  json: content => JSON.parse(content),
  yaml: content => Yaml.parse(content),
  yml: content => Yaml.parse(content),
  ini: content => Ini.parse(content),
  toml: content => Toml.parse(content),
  tml: content => Toml.parse(content)
};
/** @internal */
export const read = path => Effect.flatMap(FileSystem.FileSystem, fs => Effect.matchEffect(fs.readFile(path), {
  onFailure: error => Effect.fail(`Could not read file (${path}): ${error}`),
  onSuccess: content => Effect.succeed([path, content])
}));
/** @internal */
export const readString = path => Effect.flatMap(FileSystem.FileSystem, fs => Effect.matchEffect(fs.readFileString(path), {
  onFailure: error => Effect.fail(`Could not read file (${path}): ${error}`),
  onSuccess: content => Effect.succeed([path, content])
}));
/** @internal */
export const parse = (path, content, format) => {
  const parser = fileParsers[format ?? path.split(".").pop()];
  if (parser === undefined) {
    return Effect.fail(`Unsupported file format: ${format}`);
  }
  return Effect.try({
    try: () => parser(content),
    catch: e => `Could not parse ${format} file (${path}): ${e}`
  });
};
//# sourceMappingURL=files.js.map