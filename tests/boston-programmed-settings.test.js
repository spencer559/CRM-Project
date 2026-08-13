/* Boston programmed-settings scoping.
 *
 * Boston's Heart Rate Variability page can repeat a "Sensed AV Delay" that is not
 * present in the active Brady programming. The parser must not import that reference
 * value, but it must continue to import a real SAV from the Brady settings block.
 *
 * Run with: node tests/boston-programmed-settings.test.js
 */
"use strict";

const assert = require("assert");
const path = require("path");

global.window = global;
require(path.join(__dirname, "..", "src", "engine.js"));
require(path.join(__dirname, "..", "src", "parsers", "boston.js"));

function line(page, y, cells) {
  return {
    page,
    y,
    items: cells.map(([x, str]) => ({ page, x, y, w: 30, str }))
  };
}

function parse(lines) {
  return global.BOSTON.runMap(lines, {}).RESULT;
}

let result = parse([
  line(1, 700, [[40, "Device"], [275, "DYNAGEN ICD D153/ 199166"]]),
  line(1, 400, [[40, "Brady Settings"]]),
  line(1, 390, [[50, "Mode"], [250, "DDI"]]),
  line(1, 380, [[50, "Lower Rate Limit"], [250, "45 ppm"]]),
  line(1, 370, [[50, "Paced AV Delay"], [250, "300"], [275, "ms"]]),
  line(2, 700, [[40, "Heart Rate Variability"]]),
  line(2, 680, [[50, "Footprint"], [260, "44 %"], [320, "Sensed AV Delay"], [525, "300 ms"]])
]);

assert.strictEqual(result["p-mode"].v, "DDI", "active Brady mode should import");
assert.strictEqual(result["p-pav"].v, "300", "programmed paced AV delay should import");
assert.strictEqual(result["p-sav"].v, "", "HRV sensed AV reference must not import");

result = parse([
  line(1, 700, [[40, "Device"], [275, "ACCOLADE MRI L331/ 123456"]]),
  line(1, 500, [[40, "Brady"]]),
  line(1, 490, [[50, "Normal Settings"]]),
  line(1, 480, [[55, "Mode"], [250, "DDD"]]),
  line(1, 470, [[55, "Sensed AV Delay"], [245, "120 - 180 ms"]]),
  line(1, 460, [[55, "Paced AV Delay"], [245, "150 - 210 ms"]]),
  line(2, 700, [[40, "Heart Rate Variability"]]),
  line(2, 680, [[50, "Footprint"], [260, "50 %"], [320, "Sensed AV Delay"], [525, "300 ms"]])
]);

assert.strictEqual(result["p-sav"].v, "120", "programmed SAV minimum should import");
assert.strictEqual(result["p-sav-hi"].v, "180", "programmed SAV maximum should import");
assert.strictEqual(result["p-pav"].v, "150", "programmed PAV minimum should import");
assert.strictEqual(result["p-pav-hi"].v, "210", "programmed PAV maximum should import");
assert.strictEqual(result["dyn-av"].v, "Yes", "real programmed ranges should remain dynamic");

console.log("all checks passed");
