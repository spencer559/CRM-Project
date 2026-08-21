/* "Download patients" lays the day out as <date>/<patient>/<file> before anything is written. */
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

const html = fs.readFileSync(path.join(__dirname, "..", "protected", "Patient_Schedule.html"), "utf8");

assert.match(html, /id="dlPatientsBtn"[^>]*onclick="downloadPatients\(\)"/,
  "the schedule needs a Download patients button beside Print schedule");
assert.ok(html.indexOf('onclick="printSchedule()"') < html.indexOf('id="dlPatientsBtn"'),
  "Download patients belongs next to Print schedule, after it");

/* The picker must be opened from the click itself: awaiting anything first spends the transient
   user activation the File System Access API requires, and the dialog never appears. */
const clickHandler = html.slice(html.indexOf("window.downloadPatients = function"),
  html.indexOf("function validateGeneratedPdf"));
assert.ok(clickHandler.indexOf("pickExportDestination()") < clickHandler.indexOf("withPanelFilesFresh"),
  "the destination dialog must open before the report finalize, or user activation is lost");
assert.match(functionSource(html, "pickExportDestination"), /showDirectoryPicker\(\{[^}]*mode: 'readwrite'/,
  "the desktop path must ask for a writable directory so real folders can be created");
assert.match(functionSource(html, "pickExportDestination"), /showSaveFilePicker/,
  "browsers without a directory picker still get a file dialog for the .zip fallback");
assert.match(functionSource(html, "readPlanFiles"), /getFile\(\)/,
  "planned files must travel as stored bytes");
assert.doesNotMatch(functionSource(html, "readPlanFiles"), /\.text\(|TextDecoder|TextEncoder/,
  "exporting must never decode or re-encode a programmer file");

const scope = ["isProgrammerReport", "isScheduleReport", "chipOrder", "chartReportFilename", "safeFolderName", "buildPatientExportPlan"]
  .map((name) => functionSource(html, name)).join("\n");
const { buildPatientExportPlan, safeFolderName, chartReportFilename } =
  new Function(scope + "\nreturn { buildPatientExportPlan: buildPatientExportPlan, safeFolderName: safeFolderName, chartReportFilename: chartReportFilename };")();

/* ---- folder names have to survive Explorer ---- */
assert.strictEqual(safeFolderName("Doe, John"), "Doe, John", "an ordinary name is left alone");
assert.strictEqual(safeFolderName('Smith/Jones: "Bo" <x>?'), "Smith-Jones- -Bo- -x--",
  "every character Windows reserves is replaced, not dropped silently");
assert.strictEqual(safeFolderName("Ng, Mary."), "Ng, Mary", "Explorer refuses a trailing dot");
assert.strictEqual(safeFolderName("con"), "con_", "reserved device names cannot be folders");
assert.strictEqual(safeFolderName("   "), "Unnamed patient", "a blank name still needs a folder");

/* ---- the plan ---- */
const plan = buildPatientExportPlan("2026-08-21", [
  { slot: "0800_DOEJOHN", time: "08:00", pt: "Doe, John", names: ["report.json", "report.txt", "report.pdf", "MDT_export.pdf"] },
  { slot: "0900_ROENOFILES", time: "09:00", pt: "Roe, Jane", names: ["report.json"] },
  { slot: "1030_DOEJOHN", time: "10:30", pt: "Doe, John", names: ["abbott.log"] },
  { slot: "1100_LEEPAT", time: "11:00", pt: "Lee, Pat", names: [] }
]);

assert.strictEqual(plan.date, "2026-08-21");
assert.strictEqual(plan.skipped, 2, "patients whose only files are support files get no folder");
assert.deepStrictEqual(plan.folders.map((f) => f.folder), ["Doe, John 0800", "Doe, John 1030"],
  "a name used twice in one day carries its appointment time, both times");

assert.deepStrictEqual(plan.folders[0].files, [
  { stored: "report.pdf", out: "Doe_2026-08-21_CRM_Report.pdf" },
  { stored: "MDT_export.pdf", out: "MDT_export.pdf" }
], "the generated report is renamed for the chart; programmer exports keep their own names");
assert.strictEqual(plan.folders[0].slot, "0800_DOEJOHN", "each folder remembers the slot it reads from");

assert.strictEqual(chartReportFilename("Doe, John", "2026-08-21"), "Doe_2026-08-21_CRM_Report.pdf");
assert.strictEqual(chartReportFilename("", "2026-08-21"), "Patient_2026-08-21_CRM_Report.pdf");

/* Distinct patients that sanitize to the same folder must not overwrite each other either. */
const clash = buildPatientExportPlan("2026-08-21", [
  { slot: "a", time: "08:00", pt: "A/B", names: ["x.pdf"] },
  { slot: "b", time: "08:00", pt: "A:B", names: ["y.pdf"] }
]);
assert.deepStrictEqual(clash.folders.map((f) => f.folder), ["A-B 0800", "A-B 0800 (2)"],
  "two names that sanitize alike still get one folder each");

console.log("patient folder export plan checks passed");
