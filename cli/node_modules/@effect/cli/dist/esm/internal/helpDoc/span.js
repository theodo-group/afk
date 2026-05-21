import * as Ansi from "@effect/printer-ansi/Ansi";
import * as Doc from "@effect/printer-ansi/AnsiDoc";
import * as Color from "@effect/printer-ansi/Color";
import * as Arr from "effect/Array";
import { dual } from "effect/Function";
/** @internal */
export const text = value => ({
  _tag: "Text",
  value
});
/** @internal */
export const empty = /*#__PURE__*/text("");
/** @internal */
export const space = /*#__PURE__*/text(" ");
/** @internal */
export const code = value => highlight(value, Color.white);
/** @internal */
export const error = value => highlight(value, Color.red);
/** @internal */
export const highlight = (value, color) => ({
  _tag: "Highlight",
  value: typeof value === "string" ? text(value) : value,
  color
});
/** @internal */
export const strong = value => ({
  _tag: "Strong",
  value: typeof value === "string" ? text(value) : value
});
/** @internal */
export const uri = value => ({
  _tag: "URI",
  value
});
/** @internal */
export const weak = value => ({
  _tag: "Weak",
  value: typeof value === "string" ? text(value) : value
});
/** @internal */
export const isSequence = self => self._tag === "Sequence";
/** @internal */
export const isStrong = self => self._tag === "Strong";
/** @internal */
export const isText = self => self._tag === "Text";
/** @internal */
export const isUri = self => self._tag === "URI";
/** @internal */
export const isWeak = self => self._tag === "Weak";
/** @internal */
export const concat = /*#__PURE__*/dual(2, (self, that) => ({
  _tag: "Sequence",
  left: self,
  right: that
}));
export const getText = self => {
  switch (self._tag) {
    case "Text":
    case "URI":
      {
        return self.value;
      }
    case "Highlight":
    case "Weak":
    case "Strong":
      {
        return getText(self.value);
      }
    case "Sequence":
      {
        return getText(self.left) + getText(self.right);
      }
  }
};
/** @internal */
export const spans = spans => {
  const elements = Arr.fromIterable(spans);
  if (Arr.isNonEmptyReadonlyArray(elements)) {
    return elements.slice(1).reduce(concat, elements[0]);
  }
  return empty;
};
/** @internal */
export const isEmpty = self => size(self) === 0;
/** @internal */
export const size = self => {
  switch (self._tag) {
    case "Text":
    case "URI":
      {
        return self.value.length;
      }
    case "Highlight":
    case "Strong":
    case "Weak":
      {
        return size(self.value);
      }
    case "Sequence":
      {
        return size(self.left) + size(self.right);
      }
  }
};
/** @internal */
export const toAnsiDoc = self => {
  switch (self._tag) {
    case "Highlight":
      {
        return Doc.annotate(toAnsiDoc(self.value), Ansi.color(self.color));
      }
    case "Sequence":
      {
        return Doc.cat(toAnsiDoc(self.left), toAnsiDoc(self.right));
      }
    case "Strong":
      {
        return Doc.annotate(toAnsiDoc(self.value), Ansi.bold);
      }
    case "Text":
      {
        return Doc.text(self.value);
      }
    case "URI":
      {
        return Doc.annotate(Doc.text(self.value), Ansi.underlined);
      }
    case "Weak":
      {
        return Doc.annotate(toAnsiDoc(self.value), Ansi.black);
      }
  }
};
//# sourceMappingURL=span.js.map