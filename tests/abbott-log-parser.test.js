/* Abbott Merlin aggregate diagnostics map without inventing unavailable episode details. */
"use strict";

const assert = require("assert");
const path = require("path");

global.window = global;
require(path.join(__dirname, "..", "src", "parsers", "abbott.js"));

const FS = String.fromCharCode(0x1c);
function log(fields) {
  return fields.map((f) => [String(f[0]), f[1], String(f[2]), f[3] || ""].join(FS) + FS).join("\r\n");
}

const crt = ABBOTT.runLog(log([
  [200, "Device Model Name", "Synthetic CRT-D"],
  [301, "Mode", "DDD"],
  [2471, "LV Lead Serial Number", "XXX000"],
  [2730, "HV Lead Impedance", "55"],
  [2681, "Event Histogram Percent Paced In Ventricle", "99.99"],
  [2709, "Ventricular Paced - Lifetime (RVP)", "0.1"],
  [2710, "Ventricular Paced - Lifetime (LVP)", "0.2"],
  [2711, "Ventricular Paced - Lifetime (BP)", "99.7"],
  [2750, "AT/AF Last Cleared Date", "08/03/2026"],
  [2642, "Tachy Episodal Diagnostic Date and Time Last Cleared", "08/03/2026 13:55:45"],
  [2754, "Total Number of AT/AF Episodes Since Last Cleared", "5"],
  [2630, "Total Number of VT/VF Episodes", "2.0"],
  [2755, "Total Time in AT/AF Recent Week", "584670"]
]));

assert.strictEqual(crt.ROUTE.dtype, "CRT-D");
assert.strictEqual(crt.RESULT["pct-v"].v, "0.1", "CRT RV% must use RVP, not combined ventricular pacing");
assert.strictEqual(crt.RESULT["pct-lv"].v, "0.2");
assert.strictEqual(crt.RESULT["pct-biv"].v, "99.7");
assert.strictEqual(crt.RESULT["ep-ahr"].v, "5");
assert.strictEqual(crt.RESULT["ep-hvr"].v, "2.0");
assert.strictEqual(crt.RESULT["ep-since-date"].v, "2026-08-03");
assert.ok(!crt.RESULT["ep-af-burden"], "a unitless nonzero recent-week time must not become a fabricated burden percentage");
assert.deepStrictEqual(crt.EPISODES, [], "aggregate .logs contain no individual episode rows");

const zeroAf = ABBOTT.runLog(log([
  [200, "Device Model Name", "Synthetic PM"],
  [301, "Mode", "DDD"],
  [2750, "AT/AF Last Cleared Date", "07/07/2026"],
  [2754, "Total Number of AT/AF Episodes Since Last Cleared", "0"],
  [2755, "Total Time in AT/AF Recent Week", "0"]
]));
assert.strictEqual(zeroAf.RESULT["ep-af-burden"].v, "0");
assert.strictEqual(zeroAf.RESULT["ep-ahr"].v, "0");
assert.strictEqual(zeroAf.RESULT["ep-since-date"].v, "2026-07-07");

const mismatchedClearDates = ABBOTT.runLog(log([
  [200, "Device Model Name", "Synthetic ICD"],
  [301, "Mode", "DDD"],
  [2730, "HV Lead Impedance", "50"],
  [2750, "AT/AF Last Cleared Date", "08/01/2026"],
  [2642, "Tachy Episodal Diagnostic Date and Time Last Cleared", "08/02/2026 10:00:00"]
]));
assert.ok(!mismatchedClearDates.RESULT["ep-since-date"],
  "one shared Since date must stay blank when atrial and tachy intervals disagree");

console.log("Abbott log pacing and aggregate episode checks passed");
