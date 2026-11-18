// finds string values in json (or jsonc) text by their path, so mrvm can
// rewrite a version without reformatting the file: everything outside the
// edited strings stays byte for byte the same.

/**
 * A string value in the text: its path from the root, the decoded value, and
 * the span of the literal including its quotes.
 */
export interface StringSpan {
  path: string[];
  value: string;
  start: number;
  end: number;
}

/**
 * One replacement of a string value.
 */
export interface TextEdit {
  start: number;
  end: number;
  value: string;
}

class Scanner {
  i = 0;
  spans: StringSpan[] = [];
  readonly text: string;
  readonly file: string;
  constructor(text: string, file: string) {
    this.text = text;
    this.file = file;
  }

  fail(msg: string): never {
    const before = this.text.slice(0, this.i);
    const line = before.split("\n").length;
    throw new Error(`${this.file}:${line}: ${msg}`);
  }

  // whitespace and jsonc comments
  skip() {
    const t = this.text;
    while (this.i < t.length) {
      const c = t[this.i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        this.i++;
      } else if (t.startsWith("//", this.i)) {
        const nl = t.indexOf("\n", this.i);
        this.i = nl === -1 ? t.length : nl + 1;
      } else if (t.startsWith("/*", this.i)) {
        const close = t.indexOf("*/", this.i + 2);
        if (close === -1) this.fail("unterminated comment");
        this.i = close + 2;
      } else {
        break;
      }
    }
  }

  string(): { value: string; start: number; end: number } {
    const start = this.i;
    if (this.text[this.i] !== '"') this.fail("expected a string");
    this.i++;
    while (this.i < this.text.length) {
      const c = this.text[this.i];
      if (c === "\\") {
        this.i += 2;
      } else if (c === '"') {
        this.i++;
        const end = this.i;
        return { value: JSON.parse(this.text.slice(start, end)), start, end };
      } else {
        this.i++;
      }
    }
    this.fail("unterminated string");
  }

  value(path: string[]) {
    this.skip();
    const c = this.text[this.i];
    if (c === "{") return this.object(path);
    if (c === "[") return this.array(path);
    if (c === '"') {
      const s = this.string();
      this.spans.push({ path, ...s });
      return;
    }
    // number, true, false, null
    const m = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(
      this.text.slice(this.i),
    );
    if (!m) this.fail("unexpected token");
    this.i += m[0].length;
  }

  object(path: string[]) {
    this.i++; // {
    this.skip();
    if (this.text[this.i] === "}") {
      this.i++;
      return;
    }
    while (true) {
      this.skip();
      // jsonc allows a trailing comma
      if (this.text[this.i] === "}") {
        this.i++;
        return;
      }
      const key = this.string().value;
      this.skip();
      if (this.text[this.i] !== ":") this.fail("expected ':'");
      this.i++;
      this.value([...path, key]);
      this.skip();
      if (this.text[this.i] === ",") {
        this.i++;
      } else if (this.text[this.i] === "}") {
        this.i++;
        return;
      } else {
        this.fail("expected ',' or '}'");
      }
    }
  }

  array(path: string[]) {
    this.i++; // [
    let n = 0;
    while (true) {
      this.skip();
      if (this.text[this.i] === "]") {
        this.i++;
        return;
      }
      this.value([...path, String(n++)]);
      this.skip();
      if (this.text[this.i] === ",") {
        this.i++;
      } else if (this.text[this.i] === "]") {
        this.i++;
        return;
      } else {
        this.fail("expected ',' or ']'");
      }
    }
  }
}

/**
 * Every string value in a json or jsonc document, with its path and span.
 *
 * @throws if the text isn't valid json/jsonc
 */
export function stringSpans(text: string, file = "<json>"): StringSpan[] {
  const s = new Scanner(text, file);
  s.value([]);
  s.skip();
  if (s.i !== text.length) s.fail("unexpected content after the document");
  return s.spans;
}

/**
 * The string value at a path, or undefined.
 */
export function findString(
  spans: StringSpan[],
  path: string[],
): StringSpan | undefined {
  return spans.find((s) =>
    s.path.length === path.length && s.path.every((p, i) => p === path[i])
  );
}

/**
 * Applies replacements of string values; the rest of the text is unchanged.
 *
 * @throws if two edits overlap
 */
export function applyEdits(text: string, edits: TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].end > sorted[i - 1].start) {
      throw new Error("overlapping edits");
    }
  }
  let out = text;
  for (const e of sorted) {
    out = out.slice(0, e.start) + JSON.stringify(e.value) + out.slice(e.end);
  }
  return out;
}
