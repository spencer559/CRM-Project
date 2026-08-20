/* Vendor-neutral PDF redaction detection and safe naming. */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

global.window = global;
require(path.join(__dirname, "..", "src", "cied-pdf-redactor.js"));
const R = global.CIEDPdfRedactor;

assert.strictEqual(R.classifyLabel("Patient Name", true).kind, "name");
assert.strictEqual(R.classifyLabel("Patient Name", true).replacement, "DOE, TEST");
assert.strictEqual(R.classifyLabel("Patient:", true).kind, "name");
assert.strictEqual(R.classifyLabel("Last Name", true).kind, "name");
assert.strictEqual(R.classifyLabel("MRN", true).kind, "id");
assert.strictEqual(R.classifyLabel("MRN", true).replacement, "00000000");
assert.strictEqual(R.classifyLabel("ID:", true).kind, "id");
assert.strictEqual(R.classifyLabel("Patient ID", true).kind, "id");
assert.strictEqual(R.classifyLabel("Device Serial Number", true).kind, "serial");
assert.strictEqual(R.classifyLabel("Address", true).replacement, "100 TEST STREET");
assert.strictEqual(R.classifyLabel("Phone", true).replacement, "000-000-0000");
assert.strictEqual(R.classifyLabel("Email", true).replacement, "test@example.invalid");
assert.strictEqual(R.classifyLabel("Interrogation Date", true).kind, "date");
assert.strictEqual(R.classifyLabel("Interrogation Date", false), null);
assert.strictEqual(R.isStandaloneIdentifier("tech@example.org").kind, "email");
assert.strictEqual(R.isStandaloneIdentifier("tech@example.org").replacement, "test@example.invalid");
assert.strictEqual(R.isStandaloneIdentifier("(555) 555-1212").replacement, "000-000-0000");
assert.strictEqual(R.isStandaloneIdentifier("BIOTRONIK - Edora 8 - 12345678 - Example, Jane - 1 / 4").kind, "name");
assert.strictEqual(R.safeOutputName(0), "redacted-cied-report.pdf");
assert.strictEqual(R.safeOutputName(2), "redacted-cied-report-3.pdf");
assert.strictEqual(R.inlineSelectableReplacement("Patient Name: Jane Example", { match: "Patient Name", replacement: "DOE, TEST" }), "Patient Name: DOE, TEST");
assert.strictEqual(R.maskAlphaNum("ABC-12345/Z9"), "XXX-00000/X0");
assert.strictEqual(R.structuredReplacement("id", "001-234567", "00000000"), "000-000000");
assert.strictEqual(R.structuredReplacement("serial", "ABC-12345", "XXXXXXXX"), "XXX-00000");
assert.strictEqual(R.structuredReplacement("phone", "+1 (425) 555-0199", "000-000-0000"), "+0 (000) 000-0000");
assert.strictEqual(R.structuredReplacement("name", "Jane Example", "DOE, TEST"), "TEST PATIENT");
assert.strictEqual(R.structuredReplacement("name", "Example, Jane", "DOE, TEST"), "DOE, TEST");
assert.strictEqual(R.dateReplacement("08/16/2026 14:35", "01/01/2000"), "01/01/2000 00:00");
assert.strictEqual(R.dateReplacement("8-6-26", "01/01/2000"), "1-1-00");
assert.strictEqual(R.dateReplacement("2026-08-16", "01/01/2000"), "2000-01-01");
assert.strictEqual(R.dateReplacement("Aug/16/2026", "01/01/2000"), "Jan/01/2000");
assert.strictEqual(R.dateReplacement("AUGUST 16, 2026", "01/01/2000"), "JANUARY 01, 2000");
assert.strictEqual(R.dateReplacement("16 Aug 2026", "01/01/2000"), "01 Jan 2000");

const items = [
  { text: "Patient Name", x: 10, y: 10, width: 75, height: 10 },
  { text: "Jane Example", x: 100, y: 10, width: 70, height: 10 },
  { text: "MRN", x: 10, y: 30, width: 25, height: 10 },
  { text: "123456", x: 100, y: 30, width: 45, height: 10 },
  { text: "Interrogation Date", x: 10, y: 50, width: 90, height: 10 },
  { text: "08/16/2026", x: 120, y: 50, width: 65, height: 10 },
  { text: "Mode", x: 10, y: 70, width: 30, height: 10 },
  { text: "DDDR", x: 100, y: 70, width: 35, height: 10 }
];

let found = R.detect(items, 200, 100, { strictDates: true });
assert(found.some((x) => x.kind === "name" && /Patient/.test(x.source)));
assert(found.some((x) => x.kind === "id"));
assert(found.some((x) => x.kind === "date"));
assert(!found.some((x) => x.source === "Mode"), "clinical programming values must remain visible");

found = R.detect(items, 200, 100, { strictDates: false });
assert(!found.some((x) => x.kind === "date"), "date detection must follow the review checkbox");

const inlineFound = R.detect([{ text: "Patient Name: Jane Example", x: 10, y: 10, width: 150, height: 10 }], 200, 100, { strictDates: true });
assert.strictEqual(inlineFound[0].replacement, "TEST PATIENT");
assert.strictEqual(inlineFound[0].selectableReplacement, "Patient Name: TEST PATIENT", "inline labels must survive with only synthetic data");

const structuredItems = [
  { text: "Serial Number", x: 10, y: 10, width: 70, height: 10 },
  { text: "ABC-12345", x: 100, y: 10, width: 60, height: 10 },
  { text: "Date of Visit", x: 10, y: 30, width: 70, height: 10 },
  { text: "Aug/16/2026", x: 100, y: 30, width: 70, height: 10 }
];
const structuredFound = R.detect(structuredItems, 200, 100, { strictDates: true });
assert(structuredFound.some((x) => x.kind === "serial" && x.replacement === "XXX-00000"));
assert(structuredFound.some((x) => x.kind === "date" && x.replacement === "Jan/01/2000"));

const manual = R.manualBox(90, 50, 10, 20, 200, 100);
assert.deepStrictEqual(manual.rect, { x: 0.05, y: 0.2, w: 0.4, h: 0.3 });
assert.strictEqual(R.manualBox(1, 1, 2, 2, 100, 100), null);

const safeLayer = R.selectableText(items, [
  { rect: { x: 0.48, y: 0.07, w: 0.4, h: 0.17 }, automatic: true, replacement: "DOE, TEST" },
  { rect: { x: 0.48, y: 0.27, w: 0.3, h: 0.17 }, automatic: false, replacement: "" }
], 200, 100);
assert(safeLayer.some((x) => x.text === "Mode"), "unredacted labels must remain selectable");
assert(safeLayer.some((x) => x.text === "DDDR"), "unredacted clinical values must remain selectable");
assert(!safeLayer.some((x) => x.text === "Jane Example"), "automatic-box PHI must be absent from the rebuilt text layer");
assert(!safeLayer.some((x) => x.text === "123456"), "manual-box text must be absent from the rebuilt text layer");
assert.strictEqual(safeLayer.filter((x) => x.text === "DOE, TEST").length, 1, "an automatic box gets one type-shaped selectable placeholder");

/* Shape-preserving replacements must never echo the source item's own text. pdf.js hands back
   whole-line items on some vendor layouts (the Biotronik header above is one), so a replacement
   that only rewrites digits would carry every surrounding letter straight into the export. */
assert.strictEqual(R.structuredReplacement("phone", "Contact John Smith at 555-123-4567", "000-000-0000"), "000-000-0000",
  "a phone sharing a text item with a name must fall back to the generic placeholder");
assert.strictEqual(R.structuredReplacement("phone", "555-1212 (home) Dr. Roe", "000-000-0000"), "000-000-0000",
  "a labelled phone value with trailing free text must not keep that text");
assert.strictEqual(R.dateReplacement("Interrogation 01/02/2026 by Dr. Jane Roe", "01/01/2000"), "01/01/2000",
  "a date sharing a text item with a provider name must drop the tail");
assert.strictEqual(R.dateReplacement("08/16/2026 14:35 Rest", "01/01/2000"), "01/01/2000",
  "only a clock/time-zone tail may survive; an ordinary word must not");
assert.strictEqual(R.dateReplacement("08/16/2026 14:35 EST", "01/01/2000"), "01/01/2000 00:00 EST",
  "a genuine time-zone tail still rides along with its digits zeroed");
assert.strictEqual(R.isStandaloneIdentifier("(555)123-4567").kind, "phone",
  "a parenthesized area code with no following separator is still a phone number");
assert.strictEqual(R.isStandaloneIdentifier("1234567890"), null,
  "a bare digit run must not be mistaken for a phone number");

/* Vendor headers routinely stack a value directly beneath its label rather than beside it. */
const stacked = R.detect([
  { text: "Patient Name", x: 40, y: 40, width: 60, height: 10 },
  { text: "Date of Birth", x: 200, y: 40, width: 62, height: 10 },
  { text: "SMITH, JOHN Q", x: 40, y: 56, width: 65, height: 10 },
  { text: "01/02/1960", x: 200, y: 56, width: 50, height: 10 }
], 612, 792, { strictDates: true });
assert(stacked.some((b) => b.source === "Patient Name" && b.replacement === "DOE, TEST" && b.rect.y > 0.06),
  "a label must redact the x-overlapping value on the row beneath it");
assert(stacked.some((b) => b.source === "Date of Birth" && b.replacement === "01/01/2000"),
  "each stacked label must claim its own column");

/* Two labels side by side: the left one has no value of its own and must not box its neighbour. */
const adjacent = R.detect([
  { text: "Name:", x: 40, y: 40, width: 26, height: 10 },
  { text: "DOB:", x: 200, y: 40, width: 22, height: 10 },
  { text: "01/02/1960", x: 260, y: 40, width: 50, height: 10 }
], 612, 792, { strictDates: true });
assert(!adjacent.some((b) => b.kind === "name"),
  "a label with no value must not fall back to boxing the adjacent label");
assert(adjacent.some((b) => b.kind === "dob" && b.replacement === "01/01/2000"),
  "the adjacent label still redacts its own value");

const html = fs.readFileSync(path.join(__dirname, "..", "tools", "CIED PDF Redactor.html"), "utf8");
assert.match(html, /connect-src 'none'/, "PHI tool must prohibit network access");
assert.match(html, /toDataURL\("image\/jpeg"/, "output must be rasterized to remove hidden PDF content");
assert.match(html, /renderingMode:"invisible"/, "output must rebuild a selectable troubleshooting text layer");
assert.match(html, /CIEDPdfRedactor\.selectableText/, "selectable output must pass through the redaction filter");
assert.match(html, /added\.map\(function\(m,fileIndex\)\{return scanAllPages/, "every newly loaded PDF must scan every page before it is added to the workspace");
assert.match(html, /function scanAllPages\(m,onProgress\)/, "all-page scanning must not depend on opening pages in the viewer");
assert.match(html, /state\.boxes\.filter\(function\(box\)\{return !box\.automatic\}\)\.concat\(detected\)/, "rescanning all pages must retain manual boxes");
assert.match(html, /Auto-detect all pages/, "the manual rescan control must cover the complete report");
assert.match(html, /height:clamp\(680px,78vh,840px\)/, "the desktop preview must use the taller 1080p-oriented pane");
assert.match(html, /availableW\/base\.width,availableH\/base\.height/, "preview scaling must fit both page width and page height");
assert.match(html, /stage-wrap"\)\.addEventListener\("wheel"/, "the preview must intercept wheel navigation");
assert.match(html, /goPage\(pageNo\+\(ev\.deltaY>0\?1:-1\)/, "each wheel direction must navigate by complete pages");
assert.match(html, /\{passive:false\}/, "wheel navigation must be able to cancel native scrolling");
assert.match(html, /setProperties\(\{title:"Redacted CIED Report"/, "output must replace original metadata");
assert.doesNotMatch(html, /m\.filename[^\n]*a\.download/, "output filename must not reuse a potentially identifying source filename");

console.log("CIED PDF redactor detection and privacy checks passed");
