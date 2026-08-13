"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const report = fs.readFileSync(path.join(__dirname, "..", "app", "CRM_Report_Generator.html"), "utf8");

const patientPos = report.indexOf('id="patient-btn"');
const officePos = report.indexOf('id="last-office-status"');
const savedPos = report.indexOf('id="save-status"');
assert.ok(patientPos >= 0 && patientPos < officePos && officePos < savedPos,
  "Last Office must sit between the patient name and Saved status in the app bar");
assert.match(report, /id="last-office-status" hidden/,
  "the Last Office banner item should be absent when the schedule field is blank");
assert.match(report, /setLastOfficeBanner\(row && row\.lastOff\)/,
  "the banner must read Last Office from the matching schedule row");
assert.match(report, /'Last Office: ' \+ \(m \? m\[2\] \+ '\/' \+ m\[3\] \+ '\/' \+ m\[1\] : raw\)/,
  "the schedule's ISO date should be displayed in familiar MM/DD/YYYY form");
assert.match(report, /function openSlot[\s\S]{0,250}?setLastOfficeBanner\(''\)/,
  "switching patients must clear the prior patient's date before the new row loads");
assert.match(report, /if \(slotKey\(\) !== expectedSlot\) return/,
  "a slow schedule read must not put the prior patient's date into a newly selected patient");

console.log("PASS report-generator-last-office-banner");
