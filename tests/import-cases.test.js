/* Every import-problem case in tests/import-cases/, replayed through today's parsers.
 *
 * Each case is a real report that once imported badly, de-identified by the case builder and
 * installed with `node scripts/import-case.js add` after the fix (docs/import-cases.md). It asserts
 * the fields that matched the tech's finished report at that point, so a parser change that breaks
 * a report that used to import fails here. Every case also re-runs the PHI lint.
 *
 * Run with: node tests/import-cases.test.js
 */
"use strict";

const { checkAll } = require("../scripts/import-case.js");

checkAll().then(({ names, failures }) => {
  if (failures.length) {
    console.error(failures.length + " import-case failure" + (failures.length === 1 ? "" : "s") + ":\n  " + failures.join("\n  "));
    process.exitCode = 1;
    return;
  }
  console.log(names.length + " import case" + (names.length === 1 ? "" : "s") + " replayed, all passing");
}).catch((e) => { console.error(e); process.exitCode = 1; });
