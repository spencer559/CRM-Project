/* One "report finished" tick, shared by the Report Generator and the Schedule.
 *
 * The tick sits in the Report Generator's app bar (left of Files) and in the Schedule's Done
 * column, and it is ONE field: r.done on the schedule row, living in schedule.json inside the
 * .crmdb — the same arrangement as the precharted Remote status (see crmdb-schedule-rm-share).
 * The write-back mechanics are pinned by that test; what's pinned here is that both pages agree
 * on the field, that the tick can't outlive the patient it belongs to, and that the Schedule's
 * table still counts its own columns correctly with a new one in it.
 *
 * Run with:  node tests/report-done-tick.test.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const read = (f) => fs.readFileSync(path.join(__dirname, "..", "protected", f), "utf8");
const report = read("CRM_Report_Generator.html");
const sched = read("Patient_Schedule.html");

/* ---- Report Generator: where the tick sits, and when it means anything ---- */

const donePos = report.indexOf('id="done-toggle"');
const filesPos = report.indexOf('id="files-btn"');
const menuPos = report.indexOf('id="menu-btn"');
assert.ok(donePos >= 0 && donePos < filesPos && filesPos < menuPos,
  "the Done tick belongs in the app bar to the LEFT of the Files menu");
assert.match(report, /<input type="checkbox" id="report-done" disabled>/,
  "the tick starts disabled — with no patient open there is no report to mark done");

assert.match(report, /function updateFilesBtn\(\)[\s\S]{0,900}?updateDoneToggle\(ready\)/,
  "the tick must be enabled/disabled through the same slot hook the Files menu uses");
assert.match(report, /function updateDoneToggle\(ready\)[\s\S]{0,400}?if \(!ready\) box\.checked = false/,
  "losing the patient must clear the tick, not leave it showing someone else's state");
assert.match(report, /function openSlot[\s\S]{0,600}?b\.checked = false; updateDoneToggle/,
  "switching patients must clear the tick before the incoming row is read");

/* ---- Report Generator: the tick is schedule state, read and written on the row ---- */

assert.match(report, /box\.checked = !!\(row && row\.done\)/,
  "the tick must be read from r.done on the matching schedule row");
assert.match(report, /function pushDoneToSchedule\(\)[\s\S]{0,400}?pushRowFields\(\{ done: !!el\.checked/,
  "ticking must write r.done back to the schedule row");
assert.match(report, /pushRowField\('rm', el\.value \|\| ''\)/,
  "the precharted status must still write back through the shared row-field path");
assert.match(report, /var same = names\.every\(function \(field\)[\s\S]{0,300}?if \(same\) return;/,
  "an unchanged value must not rewrite schedule.json, however many fields are pushed at once");
assert.match(report, /\(typeof value === 'boolean'\) \? \(!!row\[field\] === value\)/,
  "booleans must still be compared as booleans, not stringified");
assert.match(report, /box\.addEventListener\('change', function \(\) \{[\s\S]{0,160}?pushDoneToSchedule\(\)/,
  "the write-back must be wired to the checkbox's change event");

/* ---- Schedule: the Done column, and the row field behind it ---- */

const doneHead = sched.indexOf('<th class="done"');
const cernerHead = sched.indexOf('<th class="cerner"');
const rmHead = sched.indexOf(">Remote</th>");
assert.ok(rmHead >= 0 && rmHead < doneHead && doneHead < cernerHead,
  "Done belongs between Remote and Cerner — the report is finished before it is filed");
assert.match(sched, /data-i="' \+ i \+ '" data-f="done"/,
  "the column's checkbox must edit r.done through the row-field delegation");
assert.match(sched, /"Report finished"/,
  "an unticked box still says plainly what the column means");
assert.match(sched, /if \(r\.done === undefined\) r\.done = false;/,
  "a database written before the Done column must read as not-done, not as undefined");
assert.match(sched, /rows\(\)\.push\(\{[^}]*done: false,/,
  "a new appointment starts not done");

/* The rows spanning the full table (notes, and the CRM panel) have to grow with it, or the
   layout tears the moment a note or an open report is on screen. */
const head = sched.slice(sched.indexOf("<thead>"), sched.indexOf("</thead>"));
assert.strictEqual((head.match(/<th\b[^>]*>/g) || []).length, 14,
  "the appointment table should have 14 columns");
assert.ok(!/colspan="13"/.test(sched), "no full-width row may still be spanning 13 columns");
assert.strictEqual((sched.match(/colspan="14"/g) || []).length, 2,
  "both the notes row and the CRM panel row must span the whole table");

/* ---- The tick records when, and the day says what is left ---- */

assert.match(report, /doneAt: el\.checked \? Date\.now\(\) : 0/,
  "ticking records WHEN, so the Schedule can show it on the row");
assert.match(sched, /if \(r\.doneAt === undefined\) r\.doneAt = 0;/,
  "a database written before the stamp reads as unstamped, not undefined");
assert.match(sched, /if \(el\.dataset\.f === "done"\) r\.doneAt = el\.checked \? Date\.now\(\) : 0;/,
  "ticking from the Schedule side must stamp the same way the report side does");
assert.match(sched, /el\.dataset\.f === "done"\) renderCounts\(\)/,
  "ticking must refresh the day's counts, or the number left goes stale on screen");
assert.match(sched, /left \+ " report" \+ \(left === 1 \? "" : "s"\) \+ " left"/,
  "the day's counts must answer the question Done exists for: what is still on my list?");
// Deliberately NOT tracked: whether a report was edited after its tick. It was built, tried, and
// removed as noise — the tick is a personal marker, not a claim about the report's contents.
assert.ok(!/doneStale/.test(report) && !/doneStale/.test(sched),
  "no staleness tracking on the Done tick");

console.log("PASS report-done-tick");
