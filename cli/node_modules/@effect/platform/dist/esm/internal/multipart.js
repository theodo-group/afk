import * as Channel from "effect/Channel";
import * as Chunk from "effect/Chunk";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberRef from "effect/FiberRef";
import { dual } from "effect/Function";
import { globalValue } from "effect/GlobalValue";
import * as Inspectable from "effect/Inspectable";
import * as Mailbox from "effect/Mailbox";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as MP from "multipasta";
import { TypeIdError } from "../Error.js";
import * as FileSystem from "../FileSystem.js";
import * as IncomingMessage from "../HttpIncomingMessage.js";
import * as Path from "../Path.js";
/** @internal */
export const TypeId = /*#__PURE__*/Symbol.for("@effect/platform/Multipart");
/** @internal */
export const isPart = u => Predicate.hasProperty(u, TypeId);
/** @internal */
export const isField = u => isPart(u) && u._tag === "Field";
/** @internal */
export const isFile = u => isPart(u) && u._tag === "File";
/** @internal */
export const isPersistedFile = u => Predicate.hasProperty(u, TypeId) && Predicate.isTagged(u, "PersistedFile");
/** @internal */
export const ErrorTypeId = /*#__PURE__*/Symbol.for("@effect/platform/Multipart/MultipartError");
/** @internal */
export class MultipartError extends /*#__PURE__*/TypeIdError(ErrorTypeId, "MultipartError") {
  get message() {
    return this.reason;
  }
}
/** @internal */
export const maxParts = /*#__PURE__*/globalValue("@effect/platform/Multipart/maxParts", () => FiberRef.unsafeMake(Option.none()));
/** @internal */
export const withMaxParts = /*#__PURE__*/dual(2, (effect, count) => Effect.locally(effect, maxParts, count));
/** @internal */
export const maxFieldSize = /*#__PURE__*/globalValue("@effect/platform/Multipart/maxFieldSize", () => FiberRef.unsafeMake(FileSystem.Size(10 * 1024 * 1024)));
/** @internal */
export const withMaxFieldSize = /*#__PURE__*/dual(2, (effect, size) => Effect.locally(effect, maxFieldSize, FileSystem.Size(size)));
/** @internal */
export const maxFileSize = /*#__PURE__*/globalValue("@effect/platform/Multipart/maxFileSize", () => FiberRef.unsafeMake(Option.none()));
/** @internal */
export const withMaxFileSize = /*#__PURE__*/dual(2, (effect, size) => Effect.locally(effect, maxFileSize, Option.map(size, FileSystem.Size)));
/** @internal */
export const fieldMimeTypes = /*#__PURE__*/globalValue("@effect/platform/Multipart/fieldMimeTypes", () => FiberRef.unsafeMake(Chunk.make("application/json")));
/** @internal */
export const withFieldMimeTypes = /*#__PURE__*/dual(2, (effect, mimeTypes) => Effect.locally(effect, fieldMimeTypes, Chunk.fromIterable(mimeTypes)));
/** @internal */
export const FileSchema = /*#__PURE__*/Schema.declare(isPersistedFile, {
  identifier: "PersistedFile",
  jsonSchema: {
    type: "string",
    format: "binary"
  }
});
/** @internal */
export const FilesSchema = /*#__PURE__*/Schema.Array(FileSchema);
/** @internal */
export const SingleFileSchema = /*#__PURE__*/Schema.transform( /*#__PURE__*/FilesSchema.pipe( /*#__PURE__*/Schema.itemsCount(1)), FileSchema, {
  strict: true,
  decode: ([file]) => file,
  encode: file => [file]
});
/** @internal */
export const schemaPersisted = (schema, options) => {
  const parse = Schema.decodeUnknown(schema, options);
  return persisted => parse(persisted);
};
/** @internal */
export const schemaJson = (schema, options) => {
  const fromJson = Schema.parseJson(schema);
  return dual(2, (persisted, field) => Effect.map(Schema.decodeUnknown(Schema.Struct({
    [field]: fromJson
  }), options)(persisted), _ => _[field]));
};
/** @internal */
export const makeConfig = headers => Effect.withFiberRuntime(fiber => {
  const mimeTypes = fiber.getFiberRef(fieldMimeTypes);
  return Effect.succeed({
    headers,
    maxParts: Option.getOrUndefined(fiber.getFiberRef(maxParts)),
    maxFieldSize: Number(fiber.getFiberRef(maxFieldSize)),
    maxPartSize: fiber.getFiberRef(maxFileSize).pipe(Option.map(Number), Option.getOrUndefined),
    maxTotalSize: fiber.getFiberRef(IncomingMessage.maxBodySize).pipe(Option.map(Number), Option.getOrUndefined),
    isFile: mimeTypes.length === 0 ? undefined : info => !Chunk.some(mimeTypes, _ => info.contentType.includes(_)) && MP.defaultIsFile(info)
  });
});
/** @internal */
export const makeChannel = (headers, bufferSize = 16) => Channel.acquireUseRelease(Effect.all([makeConfig(headers), Mailbox.make(bufferSize)]), ([config, mailbox]) => {
  let partsBuffer = [];
  let exit = Option.none();
  const input = {
    awaitRead: () => Effect.void,
    emit(element) {
      return mailbox.offer(element);
    },
    error(cause) {
      exit = Option.some(Exit.failCause(cause));
      return mailbox.end;
    },
    done(_value) {
      return mailbox.end;
    }
  };
  const parser = MP.make({
    ...config,
    onField(info, value) {
      partsBuffer.push(new FieldImpl(info.name, info.contentType, MP.decodeField(info, value)));
    },
    onFile(info) {
      let chunks = [];
      let finished = false;
      const take = Channel.suspend(() => {
        if (chunks.length === 0) {
          return finished ? Channel.void : Channel.zipRight(pump, take);
        }
        const chunk = Chunk.unsafeFromArray(chunks);
        chunks = [];
        return finished ? Channel.write(chunk) : Channel.zipRight(Channel.write(chunk), Channel.zipRight(pump, take));
      });
      partsBuffer.push(new FileImpl(info, take));
      return function (chunk) {
        if (chunk === null) {
          finished = true;
        } else {
          chunks.push(chunk);
        }
      };
    },
    onError(error_) {
      exit = Option.some(Exit.fail(convertError(error_)));
    },
    onDone() {
      exit = Option.some(Exit.void);
    }
  });
  const pump = Channel.flatMap(mailbox.takeAll, ([chunks, done]) => Channel.sync(() => {
    Chunk.forEach(chunks, Chunk.forEach(parser.write));
    if (done) {
      parser.end();
    }
  }));
  const partsChannel = Channel.flatMap(pump, () => {
    if (partsBuffer.length === 0) {
      return exit._tag === "None" ? partsChannel : writeExit(exit.value);
    }
    const chunk = Chunk.unsafeFromArray(partsBuffer);
    partsBuffer = [];
    return Channel.zipRight(Channel.write(chunk), exit._tag === "None" ? partsChannel : writeExit(exit.value));
  });
  return Channel.embedInput(partsChannel, input);
}, ([, mailbox]) => mailbox.shutdown);
const writeExit = self => self._tag === "Success" ? Channel.void : Channel.failCause(self.cause);
function convertError(cause) {
  switch (cause._tag) {
    case "ReachedLimit":
      {
        switch (cause.limit) {
          case "MaxParts":
            {
              return new MultipartError({
                reason: "TooManyParts",
                cause
              });
            }
          case "MaxFieldSize":
            {
              return new MultipartError({
                reason: "FieldTooLarge",
                cause
              });
            }
          case "MaxPartSize":
            {
              return new MultipartError({
                reason: "FileTooLarge",
                cause
              });
            }
          case "MaxTotalSize":
            {
              return new MultipartError({
                reason: "BodyTooLarge",
                cause
              });
            }
        }
      }
    default:
      {
        return new MultipartError({
          reason: "Parse",
          cause
        });
      }
  }
}
class PartBase extends Inspectable.Class {
  [TypeId];
  constructor() {
    super();
    this[TypeId] = TypeId;
  }
}
class FieldImpl extends PartBase {
  key;
  contentType;
  value;
  _tag = "Field";
  constructor(key, contentType, value) {
    super();
    this.key = key;
    this.contentType = contentType;
    this.value = value;
  }
  toJSON() {
    return {
      _id: "@effect/platform/Multipart/Part",
      _tag: "Field",
      key: this.key,
      contentType: this.contentType,
      value: this.value
    };
  }
}
class FileImpl extends PartBase {
  _tag = "File";
  key;
  name;
  contentType;
  content;
  constructor(info, channel) {
    super();
    this.key = info.name;
    this.name = info.filename ?? info.name;
    this.contentType = info.contentType;
    this.content = Stream.fromChannel(channel);
  }
  toJSON() {
    return {
      _id: "@effect/platform/Multipart/Part",
      _tag: "File",
      key: this.key,
      name: this.name,
      contentType: this.contentType
    };
  }
}
const defaultWriteFile = (path, file) => Effect.flatMap(FileSystem.FileSystem, fs => Effect.mapError(Stream.run(file.content, fs.sink(path)), cause => new MultipartError({
  reason: "InternalError",
  cause
})));
/** @internal */
export const toPersisted = (stream, writeFile = defaultWriteFile) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path_ = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped();
  const persisted = Object.create(null);
  yield* Stream.runForEach(stream, part => {
    if (part._tag === "Field") {
      if (!(part.key in persisted)) {
        persisted[part.key] = part.value;
      } else if (typeof persisted[part.key] === "string") {
        persisted[part.key] = [persisted[part.key], part.value];
      } else {
        ;
        persisted[part.key].push(part.value);
      }
      return Effect.void;
    } else if (part.name === "") {
      return Effect.void;
    }
    const file = part;
    const path = path_.join(dir, path_.basename(file.name).slice(-128));
    const filePart = new PersistedFileImpl(file.key, file.name, file.contentType, path);
    if (Array.isArray(persisted[part.key])) {
      ;
      persisted[part.key].push(filePart);
    } else {
      persisted[part.key] = [filePart];
    }
    return writeFile(path, file);
  });
  return persisted;
}).pipe(Effect.catchTags({
  SystemError: cause => Effect.fail(new MultipartError({
    reason: "InternalError",
    cause
  })),
  BadArgument: cause => Effect.fail(new MultipartError({
    reason: "InternalError",
    cause
  }))
}));
class PersistedFileImpl extends PartBase {
  key;
  name;
  contentType;
  path;
  _tag = "PersistedFile";
  constructor(key, name, contentType, path) {
    super();
    this.key = key;
    this.name = name;
    this.contentType = contentType;
    this.path = path;
  }
  toJSON() {
    return {
      _id: "@effect/platform/Multipart/Part",
      _tag: "PersistedFile",
      key: this.key,
      name: this.name,
      contentType: this.contentType,
      path: this.path
    };
  }
}
//# sourceMappingURL=multipart.js.map