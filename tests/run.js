#!/usr/bin/env node
/* Run every tests/*.test.js in its own process.
 *
 * Each test file installs its own fake window/document/indexedDB into the Node global scope and
 * re-requires src/crmdb-store.js to simulate separate tabs — so they cannot share a process
 * without contaminating each other. One child per file is the whole design.
 *
 * Run with:  node tests/run.js   (or npm test)
 */
"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const dir = __dirname;
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".test.js")).sort();

let failed = 0;
for (const f of files) {
  process.stdout.write(f.padEnd(38));
  try {
    execFileSync(process.execPath, [path.join(dir, f)], { stdio: "pipe" });
    console.log("PASS");
  } catch (e) {
    failed++;
    console.log("FAIL");
    process.stdout.write(String(e.stdout || "") + String(e.stderr || ""));
  }
}

console.log("\n" + (failed ? failed + " of " + files.length + " failed" : files.length + " passed"));
process.exit(failed ? 1 : 0);
