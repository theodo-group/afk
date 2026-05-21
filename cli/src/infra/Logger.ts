import { Logger, LogLevel } from "effect"

export type Verbosity = "quiet" | "normal" | "verbose"

export const logLevelFor = (v: Verbosity): LogLevel.LogLevel => {
  switch (v) {
    case "quiet":
      return LogLevel.Error
    case "verbose":
      return LogLevel.Debug
    case "normal":
      return LogLevel.Info
  }
}

export const consoleLogger = Logger.replace(
  Logger.defaultLogger,
  Logger.make(({ logLevel, message }) => {
    const prefix =
      logLevel === LogLevel.Error
        ? "[error]"
        : logLevel === LogLevel.Warning
          ? "[warn]"
          : logLevel === LogLevel.Debug
            ? "[debug]"
            : ""
    const text = Array.isArray(message) ? message.join(" ") : String(message)
    const line = prefix ? `${prefix} ${text}` : text
    if (logLevel === LogLevel.Error || logLevel === LogLevel.Warning) {
      console.error(line)
    } else {
      console.log(line)
    }
  }),
)
