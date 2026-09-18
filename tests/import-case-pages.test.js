/* "Report import problem": the Report Generator's handoff to the case builders, and the case
 * builders' own export gate (docs/import-cases.md).
 *
 * The page logic is inline, so this pins it by source, the way the repo's other page tests do.
 * What it guards: the export and the tech's form only ever travel by postMessage to a same-origin
 * page this generator opened; the export behind the form is forgotten on every patient switch (so
 * one patient's export is never paired with another patient's form, whose identifiers are what the
 * case builder searches for); and a case file is only written after the last identifier check.
 * The de-identification itself is tested in import-case.test.js.
 *
 * Run with: node tests/import-case-pages.test.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const site = path.join(__dirname, "..", "site");
const read = (p) => fs.readFileSync(path.join(site, p), "utf8");
const gen = read("protected/CRM_Report_Generator.html");
const pdfPage = read("tools/cied-pdf-redactor.html");
const logPage = read("tools/abbott-log-redactor.html");
const panel = read("src/import-case-panel.js");

/* ---- the generator ---- */
assert.match(gen, /window\.reportImportProblem = function \(getFile, name, forced, importError\)/);
assert.match(gen, /'\.\.\/tools\/abbott-log-redactor\.html' : '\.\.\/tools\/cied-pdf-redactor\.html'\) \+ '#case=' \+ id/,
  "a .log goes to the log redactor and anything else to the PDF redactor, in case mode");
assert.match(gen, /if \(ev\.origin !== location\.origin\) return;\s*var m = ev\.data \|\| \{\}, c = CASES\[m\.id\];\s*if \(m\.type !== 'importcase:ready' \|\| !c \|\| ev\.source !== c\.win/,
  "the export is only sent to the window this page opened, on this origin");
assert.match(gen, /postMessage\(\{ type: 'importcase:load', id: m\.id, bytes: p\.bytes, payload: p\.payload \}, target, \[p\.bytes\]\)/,
  "the bytes are transferred, not copied or base64-encoded");
assert.match(gen, /window\.resetFormState = function \(\) \{ LAST_IMPORT = null; return base\.apply\(this, arguments\); \}/,
  "every form reset forgets the export behind the previous auto-fill");
assert.match(gen, /setLastOfficeBanner\(''\);\s*\/\/ A new patient[^\n]*\n\s*if \(typeof window\.forgetLastImport === 'function'\) window\.forgetLastImport\(\);/,
  "opening a patient forgets it too, including the path that does not reset the form");
const runParse = gen.slice(gen.indexOf("function runParse("), gen.indexOf("async function handleFile("));
assert(runParse.indexOf("prefillForm(") < runParse.indexOf("LAST_IMPORT = source;"),
  "the import is remembered only after its own reset, which would otherwise clear it");
assert.match(gen, /imMenu\.appendChild\(headerEl\('Report import problem'\)\)/, "the Import menu reaches a finished patient's export later");
const payload = gen.slice(gen.indexOf("return { bytes: buf, payload: {"), gen.indexOf("} };", gen.indexOf("return { bytes: buf, payload: {")));
assert.doesNotMatch(payload, /name:/, "the export's own file name (often the patient's name) is not sent");

/* ---- the case builders ---- */
for (const [label, page] of [["PDF redactor", pdfPage], ["log redactor", logPage]]) {
  assert.match(page, /<script src="\.\.\/src\/import-case\.js"><\/script>/, label + " loads the de-identifier");
  assert.match(page, /<script src="\.\.\/src\/import-case-panel\.js"><\/script>/, label + " loads the case panel");
  assert.match(page, /connect-src 'none'/, label + " makes no network requests");
  assert.match(page, /var hits=c\.scrub\.residualObject\(manifest\)\.concat\(/, label + " checks the finished case for identifiers before writing it");
  assert.match(page, /IC\.bundleName\(c\.id,/, label + " names the bundle by vendor and a random id, never after the source file");
  assert.doesNotMatch(page, /payload\.name|p\.name\b/, label + " never reads the export's file name");
  assert.match(page, /CRMImportCasePanel\.receive\(openCase,failCase\)/, label + " only enters case mode through the handshake");
}
assert.match(pdfPage, /if\(m\.caseText\)drawTextLayer\(out,m\.caseText\[n-1\]\|\|\[\]\);else addSelectableText\(/,
  "a case PDF's text layer is the de-identified items, the same text items.json holds");
assert.match(pdfPage, /el\.onclick=function\(e\)\{e\.stopPropagation\(\);if\(CASE&&box\.automatic\)return;/,
  "an automatic case box can't be clicked away: it stands for text that was already replaced");

/* ---- the panel ---- */
assert.match(panel, /if \(ev\.origin !== location\.origin \|\| done\) return;/, "the panel only accepts a case from its own origin");
assert.deepStrictEqual(panel.match(/innerHTML/g), ["innerHTML"], "the panel only clears with innerHTML; report text goes in as textContent");

console.log("import-case page checks passed");
