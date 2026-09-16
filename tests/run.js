#!/usr/bin/env node
/* Run every tests/*.test.js in its own process.
 *
 * Each test file installs its own fake window/document/indexedDB into the Node global scope and
 * re-requires src/crmdb-store.js to simulate separate tabs — so they cannot share a process
 * without contaminating each other. One child per file is the whole design.
 *
 * The children run side by side, one core left free: most of a file's time is spent waiting on its
 * own timers, so running them one after another took ~23s for ~5s of work. Results still print in
 * file order. TEST_JOBS=1 runs them one at a time, for chasing a failure that only shows under load.
 *
 * Run with:  node tests/run.js   (or npm test)
 */
"use strict";

const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = __dirname;
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".test.js")).sort();
const jobs = Math.max(1, Number(process.env.TEST_JOBS) || os.cpus().length - 1);

function run(f) {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(dir, f)], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ f, ok: !err, out: String(stdout || "") + String(stderr || "") });
    });
  });
}

(async () => {
  const results = new Array(files.length);
  let next = 0, printed = 0, failed = 0;

  // Print each result as soon as every file before it has finished, so the output reads in order.
  const flush = () => {
    while (printed < files.length && results[printed]) {
      const r = results[printed++];
      process.stdout.write(r.f.padEnd(38) + (r.ok ? "PASS" : "FAIL") + "\n");
      if (!r.ok) { failed++; process.stdout.write(r.out); }
    }
  };

  await Promise.all(Array.from({ length: Math.min(jobs, files.length) }, async () => {
    while (next < files.length) {
      const i = next++;
      results[i] = await run(files[i]);
      flush();
    }
  }));

  console.log("\n" + (failed ? failed + " of " + files.length + " failed" : files.length + " passed"));
  process.exit(failed ? 1 : 0);
})();
