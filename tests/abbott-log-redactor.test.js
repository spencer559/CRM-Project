/* Abbott redaction changes only selected value bytes and preserves encoding/control structure. */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const CRMDB = require(path.join(__dirname, "..", "vendor", "crmdb-zip.js"));

global.window = global;
require(path.join(__dirname, "..", "src", "abbott-log-redactor.js"));
const R = global.AbbottLogRedactor;
const FS = String.fromCharCode(0x1c);

const redactorHtml = fs.readFileSync(path.join(__dirname, "..", "tools", "CIED Abbott Log Redactor.html"), "utf8");
assert.match(redactorHtml, /function outputBytes\(m\)\{return AbbottLogRedactor\.redact\(m\)\}/,
  "ZIP downloads must receive raw redacted bytes");
assert.match(redactorHtml, /data:outputBytes\(m\)/,
  "ZIP entries must not use checksum-less Blob values");
assert.match(redactorHtml, /URL\.createObjectURL\(blob\)/,
  "single-file downloads must use a direct object-URL download");
assert.doesNotMatch(redactorHtml, /navigator\.share/,
  "downloads must not disappear into a rejected Web Share promise");

assert.strictEqual(R.isSensitive("Vendor-specific label", "2430"), true,
  "known Abbott PHI codes must be selected even when their labels vary");

function withBom(bytes, encoding) {
  const bom = encoding === "utf-8" ? Uint8Array.from([0xef,0xbb,0xbf])
    : encoding === "utf-16le" ? Uint8Array.from([0xff,0xfe]) : Uint8Array.from([0xfe,0xff]);
  const out = new Uint8Array(bom.length + bytes.length + 1);
  out.set(bom); out.set(bytes, bom.length); out[out.length - 1] = 0xff;
  return out;
}

function fixture(encoding) {
  const text = [
    ["2430","Patient Name","DOE, JANE",""],
    ["2431","Patient Date of Birth","05/04/1955 00:00:00",""],
    ["202","Device Serial Number","ABC-12345",""],
    ["301","Mode","DDD",""]
  ].map((p) => p.join(FS) + FS).join("\r\n");
  return withBom(R.encodeText(text, encoding), encoding);
}

for (const encoding of ["utf-8", "utf-16le", "utf-16be"]) {
  const original = fixture(encoding);
  const parsed = R.parse(original, "synthetic.log");
  assert.strictEqual(parsed.encoding, encoding);
  assert.strictEqual(parsed.rows.length, 4);
  assert.strictEqual(parsed.rows.find((r) => r.code === "2430").replacement, "REDACTED");
  assert.strictEqual(parsed.rows.find((r) => r.code === "2431").replacement, "01/01/1900 00:00:00");
  assert.strictEqual(parsed.rows.find((r) => r.code === "202").replacement, "XXX-00000");
  assert.strictEqual(parsed.rows.find((r) => r.code === "301").redact, false);

  const output = R.redact(parsed);
  assert.strictEqual(output[output.length - 1], 0xff, encoding + " must preserve unknown trailing bytes");
  const bomLength = encoding === "utf-8" ? 3 : 2;
  assert.deepStrictEqual(Array.from(output.slice(0, bomLength)), Array.from(original.slice(0, bomLength)),
    encoding + " BOM must be unchanged");
  const reparsed = R.parse(output, "redacted.log");
  const values = Object.fromEntries(reparsed.rows.map((r) => [r.code, r.value]));
  assert.strictEqual(values["2430"], "REDACTED");
  assert.strictEqual(values["2431"], "01/01/1900 00:00:00");
  assert.strictEqual(values["202"], "XXX-00000");
  assert.strictEqual(values["301"], "DDD", "unselected clinical fields must remain unchanged");
}

console.log("Abbott log redactor byte-preservation checks passed");

(async function testZipDownloadPayload() {
  const parsed = R.parse(fixture("utf-8"), "synthetic.log");
  const expected = R.redact(parsed);
  const zip = CRMDB.write([{ name: "synthetic.redacted.log", data: expected }]);
  const entries = await CRMDB.read(await zip.arrayBuffer());
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].name, "synthetic.redacted.log");
  assert.deepStrictEqual(entries[0].data, expected,
    "download-all ZIP must contain the exact redacted log bytes");
  console.log("Abbott redacted ZIP download checks passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
