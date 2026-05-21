import * as Terminal from "@effect/platform/Terminal";
import * as Ansi from "@effect/printer-ansi/Ansi";
import * as Doc from "@effect/printer-ansi/AnsiDoc";
import * as Optimize from "@effect/printer/Optimize";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as InternalPrompt from "../prompt.js";
import { Action } from "./action.js";
import * as InternalAnsiUtils from "./ansi-utils.js";
const renderBeep = /*#__PURE__*/Doc.render(Doc.beep, {
  style: "pretty"
});
function handleClear(options) {
  return (state, _) => {
    return Effect.gen(function* () {
      const terminal = yield* Terminal.Terminal;
      const columns = yield* terminal.columns;
      const resetCurrentLine = Doc.cat(Doc.eraseLine, Doc.cursorLeft);
      const clearError = Option.match(state.error, {
        onNone: () => Doc.empty,
        onSome: error => Doc.cursorDown(InternalAnsiUtils.lines(error, columns)).pipe(Doc.cat(InternalAnsiUtils.eraseText(`\n${error}`, columns)))
      });
      const clearOutput = InternalAnsiUtils.eraseText(options.message, columns);
      return clearError.pipe(Doc.cat(clearOutput), Doc.cat(resetCurrentLine), Optimize.optimize(Optimize.Deep), Doc.render({
        style: "pretty",
        options: {
          lineWidth: columns
        }
      }));
    });
  };
}
const NEWLINE_REGEX = /\r?\n/;
function renderError(state, pointer) {
  return Option.match(state.error, {
    onNone: () => Doc.empty,
    onSome: error => {
      const errorLines = error.split(NEWLINE_REGEX);
      if (Arr.isNonEmptyReadonlyArray(errorLines)) {
        const annotateLine = line => Doc.annotate(Doc.text(line), Ansi.combine(Ansi.italicized, Ansi.red));
        const prefix = Doc.cat(Doc.annotate(pointer, Ansi.red), Doc.space);
        const lines = Arr.map(errorLines, str => annotateLine(str));
        return Doc.cursorSavePosition.pipe(Doc.cat(Doc.hardLine), Doc.cat(prefix), Doc.cat(Doc.align(Doc.vsep(lines))), Doc.cat(Doc.cursorRestorePosition));
      }
      return Doc.empty;
    }
  });
}
function renderParts(state, submitted = false) {
  return Arr.reduce(state.dateParts, Doc.empty, (doc, part, currentIndex) => {
    const partDoc = Doc.text(part.toString());
    if (currentIndex === state.cursor && !submitted) {
      const annotation = Ansi.combine(Ansi.underlined, Ansi.cyanBright);
      return Doc.cat(doc, Doc.annotate(partDoc, annotation));
    }
    return Doc.cat(doc, partDoc);
  });
}
function renderOutput(leadingSymbol, trailingSymbol, parts, options) {
  const annotateLine = line => Doc.annotate(Doc.text(line), Ansi.bold);
  const prefix = Doc.cat(leadingSymbol, Doc.space);
  return Arr.match(options.message.split(/\r?\n/), {
    onEmpty: () => Doc.hsep([prefix, trailingSymbol, parts]),
    onNonEmpty: promptLines => {
      const lines = Arr.map(promptLines, line => annotateLine(line));
      return prefix.pipe(Doc.cat(Doc.nest(Doc.vsep(lines), 2)), Doc.cat(Doc.space), Doc.cat(trailingSymbol), Doc.cat(Doc.space), Doc.cat(parts));
    }
  });
}
function renderNextFrame(state, options) {
  return Effect.gen(function* () {
    const terminal = yield* Terminal.Terminal;
    const columns = yield* terminal.columns;
    const figures = yield* InternalAnsiUtils.figures;
    const leadingSymbol = Doc.annotate(Doc.text("?"), Ansi.cyanBright);
    const trailingSymbol = Doc.annotate(figures.pointerSmall, Ansi.blackBright);
    const parts = renderParts(state);
    const promptMsg = renderOutput(leadingSymbol, trailingSymbol, parts, options);
    const errorMsg = renderError(state, figures.pointerSmall);
    return Doc.cursorHide.pipe(Doc.cat(promptMsg), Doc.cat(errorMsg), Optimize.optimize(Optimize.Deep), Doc.render({
      style: "pretty",
      options: {
        lineWidth: columns
      }
    }));
  });
}
function renderSubmission(state, options) {
  return Effect.gen(function* () {
    const terminal = yield* Terminal.Terminal;
    const columns = yield* terminal.columns;
    const figures = yield* InternalAnsiUtils.figures;
    const leadingSymbol = Doc.annotate(figures.tick, Ansi.green);
    const trailingSymbol = Doc.annotate(figures.ellipsis, Ansi.blackBright);
    const parts = renderParts(state, true);
    const promptMsg = renderOutput(leadingSymbol, trailingSymbol, parts, options);
    return promptMsg.pipe(Doc.cat(Doc.hardLine), Optimize.optimize(Optimize.Deep), Doc.render({
      style: "pretty",
      options: {
        lineWidth: columns
      }
    }));
  });
}
function processUp(state) {
  state.dateParts[state.cursor].increment();
  return Action.NextFrame({
    state: {
      ...state,
      typed: ""
    }
  });
}
function processDown(state) {
  state.dateParts[state.cursor].decrement();
  return Action.NextFrame({
    state: {
      ...state,
      typed: ""
    }
  });
}
function processCursorLeft(state) {
  const previousPart = state.dateParts[state.cursor].previousPart();
  return Option.match(previousPart, {
    onNone: () => Action.Beep(),
    onSome: previous => Action.NextFrame({
      state: {
        ...state,
        typed: "",
        cursor: state.dateParts.indexOf(previous)
      }
    })
  });
}
function processCursorRight(state) {
  const nextPart = state.dateParts[state.cursor].nextPart();
  return Option.match(nextPart, {
    onNone: () => Action.Beep(),
    onSome: next => Action.NextFrame({
      state: {
        ...state,
        typed: "",
        cursor: state.dateParts.indexOf(next)
      }
    })
  });
}
function processNext(state) {
  const nextPart = state.dateParts[state.cursor].nextPart();
  const cursor = Option.match(nextPart, {
    onNone: () => state.dateParts.findIndex(part => !part.isToken()),
    onSome: next => state.dateParts.indexOf(next)
  });
  return Action.NextFrame({
    state: {
      ...state,
      cursor
    }
  });
}
function defaultProcessor(value, state) {
  if (/\d/.test(value)) {
    const typed = state.typed + value;
    state.dateParts[state.cursor].setValue(typed);
    return Action.NextFrame({
      state: {
        ...state,
        typed
      }
    });
  }
  return Action.Beep();
}
const defaultLocales = {
  months: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
  monthsShort: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  weekdays: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
  weekdaysShort: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
};
function handleRender(options) {
  return (state, action) => {
    return Action.$match(action, {
      Beep: () => Effect.succeed(renderBeep),
      NextFrame: ({
        state
      }) => renderNextFrame(state, options),
      Submit: () => renderSubmission(state, options)
    });
  };
}
function handleProcess(options) {
  return (input, state) => {
    switch (input.key.name) {
      case "left":
        {
          return Effect.succeed(processCursorLeft(state));
        }
      case "right":
        {
          return Effect.succeed(processCursorRight(state));
        }
      case "k":
      case "up":
        {
          return Effect.succeed(processUp(state));
        }
      case "j":
      case "down":
        {
          return Effect.succeed(processDown(state));
        }
      case "tab":
        {
          return Effect.succeed(processNext(state));
        }
      case "enter":
      case "return":
        {
          return Effect.match(options.validate(state.value), {
            onFailure: error => Action.NextFrame({
              state: {
                ...state,
                error: Option.some(error)
              }
            }),
            onSuccess: value => Action.Submit({
              value
            })
          });
        }
      default:
        {
          const value = Option.getOrElse(input.input, () => "");
          return Effect.succeed(defaultProcessor(value, state));
        }
    }
  };
}
/** @internal */
export const date = options => {
  const opts = {
    initial: new Date(),
    dateMask: "YYYY-MM-DD HH:mm:ss",
    validate: Effect.succeed,
    ...options,
    locales: {
      ...defaultLocales,
      ...options.locales
    }
  };
  const dateParts = makeDateParts(opts.dateMask, opts.initial, opts.locales);
  const initialCursorPosition = dateParts.findIndex(part => !part.isToken());
  const initialState = {
    dateParts,
    typed: "",
    cursor: initialCursorPosition,
    value: opts.initial,
    error: Option.none()
  };
  return InternalPrompt.custom(initialState, {
    render: handleRender(opts),
    process: handleProcess(opts),
    clear: handleClear(opts)
  });
};
const DATE_PART_REGEX = /\\(.)|"((?:\\["\\]|[^"])+)"|(D[Do]?|d{3,4}|d)|(M{1,4})|(YY(?:YY)?)|([aA])|([Hh]{1,2})|(m{1,2})|(s{1,2})|(S{1,4})|./g;
const regexGroups = {
  1: ({
    token,
    ...opts
  }) => new Token({
    token: token.replace(/\\(.)/g, "$1"),
    ...opts
  }),
  2: opts => new Day(opts),
  3: opts => new Month(opts),
  4: opts => new Year(opts),
  5: opts => new Meridiem(opts),
  6: opts => new Hours(opts),
  7: opts => new Minutes(opts),
  8: opts => new Seconds(opts),
  9: opts => new Milliseconds(opts)
};
const makeDateParts = (dateMask, date, locales) => {
  const parts = [];
  let result = null;
  // eslint-disable-next-line no-cond-assign
  while (result = DATE_PART_REGEX.exec(dateMask)) {
    const match = result.shift();
    const index = result.findIndex(group => group !== undefined);
    if (index in regexGroups) {
      const token = result[index] || match;
      parts.push(regexGroups[index]({
        token,
        date,
        parts,
        locales
      }));
    } else {
      parts.push(new Token({
        token: result[index] || match,
        date,
        parts,
        locales
      }));
    }
  }
  const orderedParts = parts.reduce((array, element) => {
    const lastElement = array[array.length - 1];
    if (element.isToken() && lastElement !== undefined && lastElement.isToken()) {
      lastElement.setValue(element.token);
    } else {
      array.push(element);
    }
    return array;
  }, Arr.empty());
  parts.splice(0, parts.length, ...orderedParts);
  return parts;
};
class DatePart {
  token;
  date;
  parts;
  locales;
  constructor(params) {
    this.token = params.token;
    this.locales = params.locales;
    this.date = params.date || new Date();
    this.parts = params.parts || [this];
  }
  /**
   * Returns `true` if this `DatePart` is a `Token`, `false` otherwise.
   */
  isToken() {
    return false;
  }
  /**
   * Retrieves the next date part in the list of parts.
   */
  nextPart() {
    return Arr.findFirstIndex(this.parts, part => part === this).pipe(Option.flatMap(currentPartIndex => Arr.findFirst(this.parts.slice(currentPartIndex + 1), part => !part.isToken())));
  }
  /**
   * Retrieves the previous date part in the list of parts.
   */
  previousPart() {
    return Arr.findFirstIndex(this.parts, part => part === this).pipe(Option.flatMap(currentPartIndex => Arr.findLast(this.parts.slice(0, currentPartIndex), part => !part.isToken())));
  }
  toString() {
    return String(this.date);
  }
}
class Token extends DatePart {
  increment() {}
  decrement() {}
  setValue(value) {
    this.token = this.token + value;
  }
  isToken() {
    return true;
  }
  toString() {
    return this.token;
  }
}
class Milliseconds extends DatePart {
  increment() {
    this.date.setMilliseconds(this.date.getMilliseconds() + 1);
  }
  decrement() {
    this.date.setMilliseconds(this.date.getMilliseconds() - 1);
  }
  setValue(value) {
    this.date.setMilliseconds(Number.parseInt(value.slice(-this.token.length)));
  }
  toString() {
    const millis = `${this.date.getMilliseconds()}`;
    return millis.padStart(4, "0").substring(0, this.token.length);
  }
}
class Seconds extends DatePart {
  increment() {
    this.date.setSeconds(this.date.getSeconds() + 1);
  }
  decrement() {
    this.date.setSeconds(this.date.getSeconds() - 1);
  }
  setValue(value) {
    this.date.setSeconds(Number.parseInt(value.slice(-2)));
  }
  toString() {
    const seconds = `${this.date.getSeconds()}`;
    return this.token.length > 1 ? seconds.padStart(2, "0") : seconds;
  }
}
class Minutes extends DatePart {
  increment() {
    this.date.setMinutes(this.date.getMinutes() + 1);
  }
  decrement() {
    this.date.setMinutes(this.date.getMinutes() - 1);
  }
  setValue(value) {
    this.date.setMinutes(Number.parseInt(value.slice(-2)));
  }
  toString() {
    const minutes = `${this.date.getMinutes()}`;
    return this.token.length > 1 ? minutes.padStart(2, "0") : minutes;
  }
}
class Hours extends DatePart {
  increment() {
    this.date.setHours(this.date.getHours() + 1);
  }
  decrement() {
    this.date.setHours(this.date.getHours() - 1);
  }
  setValue(value) {
    this.date.setHours(Number.parseInt(value.slice(-2)));
  }
  toString() {
    const hours = /h/.test(this.token) ? this.date.getHours() % 12 || 12 : this.date.getHours();
    return this.token.length > 1 ? `${hours}`.padStart(2, "0") : `${hours}`;
  }
}
class Day extends DatePart {
  increment() {
    this.date.setDate(this.date.getDate() + 1);
  }
  decrement() {
    this.date.setDate(this.date.getDate() - 1);
  }
  setValue(value) {
    this.date.setDate(Number.parseInt(value.slice(-2)));
  }
  toString() {
    const date = this.date.getDate();
    const day = this.date.getDay();
    return Match.value(this.token).pipe(Match.when("DD", () => `${date}`.padStart(2, "0")), Match.when("Do", () => `${date}${this.ordinalIndicator(date)}`), Match.when("d", () => `${day + 1}`), Match.when("ddd", () => this.locales.weekdaysShort[day]), Match.when("dddd", () => this.locales.weekdays[day]), Match.orElse(() => `${date}`));
  }
  ordinalIndicator(day) {
    return Match.value(day % 10).pipe(Match.when(1, () => "st"), Match.when(2, () => "nd"), Match.when(3, () => "rd"), Match.orElse(() => "th"));
  }
}
class Month extends DatePart {
  increment() {
    this.date.setMonth(this.date.getMonth() + 1);
  }
  decrement() {
    this.date.setMonth(this.date.getMonth() - 1);
  }
  setValue(value) {
    const month = Number.parseInt(value.slice(-2)) - 1;
    this.date.setMonth(month < 0 ? 0 : month);
  }
  toString() {
    const month = this.date.getMonth();
    return Match.value(this.token.length).pipe(Match.when(2, () => `${month + 1}`.padStart(2, "0")), Match.when(3, () => this.locales.monthsShort[month]), Match.when(4, () => this.locales.months[month]), Match.orElse(() => `${month + 1}`));
  }
}
class Year extends DatePart {
  increment() {
    this.date.setFullYear(this.date.getFullYear() + 1);
  }
  decrement() {
    this.date.setFullYear(this.date.getFullYear() - 1);
  }
  setValue(value) {
    this.date.setFullYear(Number.parseInt(value.slice(-4)));
  }
  toString() {
    const year = `${this.date.getFullYear()}`.padStart(4, "0");
    return this.token.length === 2 ? year.substring(-2) : year;
  }
}
class Meridiem extends DatePart {
  increment() {
    this.date.setHours((this.date.getHours() + 12) % 24);
  }
  decrement() {
    this.increment();
  }
  setValue(_value) {}
  toString() {
    const meridiem = this.date.getHours() > 12 ? "pm" : "am";
    return /A/.test(this.token) ? meridiem.toUpperCase() : meridiem;
  }
}
//# sourceMappingURL=date.js.map