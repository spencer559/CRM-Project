/* Medtronic Micra AV timing must not populate the conventional AV-delay fields. */
"use strict";

const assert = require("assert");
const path = require("path");

global.window = global;
require(path.join(__dirname, "..", "src", "engine.js"));
require(path.join(__dirname, "..", "src", "parsers", "medtronic.js"));

function line(page, y, cells) {
  return {
    page,
    y,
    items: cells.map(([x, str]) => ({ page, x, y, w: 30, str }))
  };
}

const lines = global.Engine.tagSections([
  line(1, 700, [[40, "Final: Parameters"]]),
  line(1, 680, [[40, "Device:"], [180, "Micra AV2 MC2AVR1"]]),
  line(1, 660, [[40, "Mode"], [180, "VDD"]]),
  line(1, 640, [[40, "Sensed AV(AM-VP)"], [180, "60 ms"]])
]);

const result = global.MEDTRONIC.runMap(lines, {}).RESULT;

assert.strictEqual(result["p-mode"].v, "VDD", "Micra mode should still import");
assert.strictEqual(result["p-sav"], undefined, "Micra AM-VP timing must not import as sensed AV delay");
assert.strictEqual(result["p-pav"], undefined, "Micra must not produce a paced AV delay either");

console.log("all checks passed");
