/* Medtronic Arrhythmia Episode List -> focused AT/AF logbook rows. */
"use strict";

const assert = require("assert");
const path = require("path");

global.window = global;
require(path.join(__dirname, "..", "src", "engine.js"));
require(path.join(__dirname, "..", "src", "parsers", "medtronic.js"));

function line(page, y, cells) {
  return { page, y, items: cells.map(([x, str]) => ({ page, x, y, w: 30, str })) };
}

function parse(rows) {
  const lines = global.Engine.tagSections([
    line(1, 740, [[40, "Initial: Arrhythmia Episode List"]]),
    line(1, 725, [[40, "Device:"], [180, "Azure XT DR MRI W1DR01"]]),
    ...rows
  ]);
  return global.MEDTRONIC.runMap(lines, {}).EPISODES;
}

const sample = parse([
  line(1, 610, [[71,"AT/AF"],[225,"3"],[246,"Aug/04/2026"],[312,"6:31 AM"],[360,"19:55:19"],[418,"288/91"],[465,"500/136"],[526,"Rest"]]),
  line(1, 590, [[71,"AT/AF"],[225,"2"],[246,"Aug/04/2026"],[312,"6:25 AM"],[369,":01:36"],[418,"204/67"],[470,"231/68"],[526,"Rest"]]),
  line(1, 570, [[71,"AT/AF"],[225,"1"],[246,"Aug/04/2026"],[312,"6:20 AM"],[382,":36"],[423,"55/67"],[470,"194/77"],[526,"Rest"]])
]);

assert.strictEqual(sample.length, 1, "one episode that is both recent and longest should be deduplicated");
assert.deepStrictEqual(sample[0].flags, ["Recent", "Longest"]);
assert.strictEqual(sample[0].dt, "2026-08-04T06:31");
assert.strictEqual(sample[0].dur, "19:55:19");
assert.strictEqual(sample[0].rate, "136", "logbook rate should use the maximum ventricular rate");
assert.deepStrictEqual(sample[0].types, ["AF/AHR"]);
assert.strictEqual(sample[0].notes, "Episode #3", "notes should contain only the Medtronic episode number");

const split = parse([
  line(1, 610, [[71,"AT/AF"],[225,"9"],[246,"Aug/05/2026"],[312,"12:05 AM"],[382,":36"],[423,"55/67"],[470,"194/77"],[526,"Rest"]]),
  line(1, 590, [[71,"AT/AF"],[225,"8"],[246,"Aug/04/2026"],[312,"11:55 PM"],[360,"02:00:00"],[418,"210/80"],[465,"300/120"],[526,"Active"]])
]);

assert.strictEqual(split.length, 2);
assert.deepStrictEqual(split.map((e) => e.flags), [["Recent"], ["Longest"]]);
assert.strictEqual(split[0].dt, "2026-08-05T00:05", "12 AM should convert correctly");
assert.strictEqual(split[0].dur, "00:00:36", "short Medtronic durations should gain leading zero fields");

console.log("all checks passed");
