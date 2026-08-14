/* Stored programmer exports must download as original bytes, never decoded/re-encoded text. */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

function functionSource(source, name) {
  const start = source.indexOf("function " + name + "(");
  assert.notStrictEqual(start, -1, name + " must exist");
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  assert.fail("Could not find the end of " + name);
}

const html = fs.readFileSync(path.join(__dirname, "..", "dev", "Patient_Schedule.html"), "utf8");
const source = functionSource(html, "savePatientFile");

assert.match(html, /data-download=/, "each Files-menu row should include a save-original control");
assert.match(source, /writable\.write\(payload\)/, "the file picker must receive the original byte payload");
assert.match(source, /navigator\.share\(\{ files: \[payload\] \}\)/, "iPad should receive the original File through the share sheet");
assert.match(source, /URL\.createObjectURL\(payload\)/, "classic downloads must point directly at the byte payload");
assert.doesNotMatch(source, /\.text\(|TextDecoder|TextEncoder/, "saving must never decode or re-encode Abbott log contents");

(async function () {
  let downloaded = null;
  const anchor = { click() {}, remove() {} };
  const savePatientFile = new Function("window", "navigator", "document", "URL", "setTimeout", "setWsStatus", "File",
    "return (" + source + ");")(
    {}, {}, { body: { appendChild() {} }, createElement: () => anchor },
    { createObjectURL: (blob) => { downloaded = blob; return "blob:test"; }, revokeObjectURL() {} },
    (fn) => fn(), () => {}, function FileUnavailable() { throw new Error("unexpected File reconstruction"); }
  );
  const bytes = Uint8Array.from([0x32, 0x2e, 0x30, 0x1c, 0x56, 0x00, 0xff]);
  const original = new Blob([bytes], { type: "text/plain" });
  Object.defineProperty(original, "name", { value: "old-abbott.log" });
  savePatientFile(original, original.name);
  assert.strictEqual(downloaded, original, "same-name exports should hand the stored Blob directly to the browser");
  assert.deepStrictEqual(new Uint8Array(await downloaded.arrayBuffer()), bytes,
    "the downloaded bytes must retain FS, NUL, and non-text byte values exactly");
  console.log("patient file byte-preserving download checks passed");
})().catch((e) => { console.error(e); process.exitCode = 1; });
