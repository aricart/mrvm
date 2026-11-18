import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdits, findString, stringSpans } from "../src/jsonedit.ts";

test("jsonedit - finds strings by path in jsonc", () => {
  const text = `{
  // a comment with "quotes"
  "version": "1.0.0", /* block */
  "imports": { "@x/a": "jsr:@x/a@1.0.0", "esc\\"aped": "v" },
  "list": ["a", { "b": "c" }],
  "n": 1, "t": true, "z": null,
}
`;
  const spans = stringSpans(text);
  assert.equal(findString(spans, ["version"])?.value, "1.0.0");
  assert.equal(findString(spans, ["imports", "@x/a"])?.value, "jsr:@x/a@1.0.0");
  assert.equal(findString(spans, ["imports", 'esc"aped'])?.value, "v");
  assert.equal(findString(spans, ["list", "1", "b"])?.value, "c");
});

test("jsonedit - edits keep everything else byte for byte", () => {
  const text = `{"version":"1.0.0",   "x" : [ "1.0.0" ] }\n`;
  const spans = stringSpans(text);
  const v = findString(spans, ["version"])!;
  const out = applyEdits(text, [{ start: v.start, end: v.end, value: "2.0.0" }]);
  assert.equal(out, `{"version":"2.0.0",   "x" : [ "1.0.0" ] }\n`);
});

test("jsonedit - rejects invalid json", () => {
  assert.throws(() => stringSpans(`{"a": }`), /unexpected token/);
  assert.throws(() => stringSpans(`{"a": "b"} x`), /after the document/);
});
