/* Conditional form controls restored programmatically do not emit change events. Verify that the
 * report loader explicitly refreshes the reprogramming-table visibility after restoring values,
 * so a saved "Changes made: Yes" report reopens with its retained rows visible.
 *
 * Run with: node tests/report-generator-conditional-restore.test.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "../app/CRM_Report_Generator.html"), "utf8");

function functionBody(name) {
  const start = source.indexOf("function " + name + "(");
  assert.notStrictEqual(start, -1, name + " must exist");
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open + 1, i);
  }
  assert.fail("Could not find the end of " + name);
}

const restore = functionBody("applyFormData");
const valuesAt = restore.indexOf("applyValues(d); // second pass");
const visibilityAt = restore.indexOf("updateReprogTable()");

assert.ok(valuesAt >= 0, "applyFormData must finish restoring dynamic form values");
assert.ok(visibilityAt > valuesAt,
  "applyFormData must refresh reprogramming-table visibility after the saved Yes/No radio is restored");

console.log("report generator conditional restore tests passed");
