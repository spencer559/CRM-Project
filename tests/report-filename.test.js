/* Generated PDF filenames use patient last name + scheduled date while the .crmdb keeps
 * its stable internal `report.pdf` key.
 */
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

const reportHtml = fs.readFileSync(path.join(__dirname, "..", "protected", "CRM_Report_Generator.html"), "utf8");
const reportSource = functionSource(reportHtml, "generatedReportFilename");
const fields = {
  "pt-name": { value: "LASTNAME, FIRSTNAME M" },
  "pt-date": { value: "2026-08-14" }
};
const document = { getElementById: (id) => fields[id] || null };
const FixedDate = class extends Date {
  constructor() { super("2026-08-15T12:00:00Z"); }
};
const reportName = new Function("document", "Date", "return (" + reportSource + ");")(document, FixedDate);

assert.strictEqual(reportName("2026-08-13"), "LASTNAME_2026-08-13_CRM_Report.pdf",
  "the scheduled date should override the form date");
fields["pt-name"].value = "First Middle O'Brien";
assert.strictEqual(reportName(""), "O_Brien_2026-08-14_CRM_Report.pdf",
  "standalone export should use the final name token and form date");
fields["pt-name"].value = "García-López, Ana";
assert.strictEqual(reportName("not-a-date"), "Garcia-Lopez_2026-08-14_CRM_Report.pdf",
  "last names should be normalized to a safe filename");

const scheduleHtml = fs.readFileSync(path.join(__dirname, "..", "protected", "Patient_Schedule.html"), "utf8");
const scheduleSource = functionSource(scheduleHtml, "generatedReportFilename");
const state = { dates: { "2026-08-13": [{ time: "09:30", pt: "SMITH, JOHN Q" }] } };
const WS = { slotName: (time, patient) => time + "_" + patient.replace(/\W/g, "") };
const scheduleName = new Function("state", "curDate", "WS", "return (" + scheduleSource + ");")(
  state, "2026-08-13", WS
);
assert.strictEqual(scheduleName("09:30_SMITHJOHNQ", "2026-08-13"), "SMITH_2026-08-13_CRM_Report.pdf",
  "the Schedule should present the same patient/date filename");

assert.match(reportHtml, /WS\.writeFile\(dir, 'report\.pdf', pdf\)/,
  "the generated PDF should retain its stable internal database key");
assert.match(reportHtml, /attachDragOut\(b, file, live, exportName\)/,
  "drag-out should receive the friendly filename");

console.log("generated report filename tests passed");
