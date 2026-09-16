/* iPad_APP/web-files.txt must list everything the three offline pages load.
 *
 * The app ships a copy of the site, and copies in exactly the files on that list. A page that
 * starts loading a new script is the easy mistake: on the web it just works, while the iPad app
 * quietly ships without the file and the feature dies there — with nothing to point at. So this
 * reads every bundled page and script, follows each local reference, and fails until the list
 * matches. deploy.sh runs it before building, so a forgotten file can't reach the iPad.
 *
 * Run with:  node tests/ipad-bundle-complete.test.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const repo = path.join(__dirname, "..");
// web-files.txt paths are relative to site/, which is also the layout the app serves them under.
const site = path.join(repo, "site");
const listFile = path.join(repo, "iPad_APP", "web-files.txt");
const listed = fs.readFileSync(listFile, "utf8").split("\n")
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));

/* Pages the app deliberately leaves out — the native shim hides the links to them. Adding a page
   here is a decision: it will not be on the iPad. */
const notBundled = new Set(["protected/dashboard.html", "protected/index.html"]);

assert.deepStrictEqual(listed.filter((f) => !fs.existsSync(path.join(site, f))), [],
  "web-files.txt lists files that no longer exist");
assert.deepStrictEqual(listed.filter((f, i) => listed.indexOf(f) !== i), [],
  "web-files.txt lists the same file twice");

const bundled = new Set(listed);
const missing = [];

for (const file of listed.filter((f) => /\.(html|js)$/.test(f))) {
  const text = fs.readFileSync(path.join(site, file), "utf8");
  const dir = path.dirname(file);
  const refs = new Set();

  // ../src/x.js, ../vendor/y.js — however it is written: <script src>, new Worker, importScripts,
  // or a bare string the page turns into a URL later.
  for (const m of text.matchAll(/(?:\.\.\/)+(?:src|vendor|assets)\/[A-Za-z0-9_\-./]+\.[a-z0-9]+/g)) {
    refs.add(path.normalize(path.join(dir, m[0])));
  }
  // Sibling pages: "PDF_Viewer.html#embed=1", 'CRM_Report_Generator.html?embed=1#slot='
  for (const m of text.matchAll(/['"(]([A-Za-z0-9_\-]+\.html)(?=['"#?])/g)) {
    refs.add(path.join(dir, m[1]));
  }

  for (const ref of refs) {
    if (bundled.has(ref) || notBundled.has(ref)) continue;
    missing.push(file + " loads " + ref);
  }
}

assert.deepStrictEqual(missing, [],
  "these are loaded by a bundled page but missing from iPad_APP/web-files.txt — add them there " +
  "(or, if they should not be on the iPad, to notBundled in this test)");

console.log("ipad bundle list covers " + listed.length + " files");
