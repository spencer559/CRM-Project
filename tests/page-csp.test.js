/* Every page the site serves carries its own CSP and loads nothing from a third party.
 *
 * All pages on the origin share localStorage with the Report Generator's PHI autosave
 * (`crm-digital`), so a page without a CSP, or one pulling a CDN script or stylesheet, is a hole in
 * every other page's boundary. The PDF Extraction Harness shipped with neither: no CSP and a Google
 * Fonts stylesheet, on a page that opens real programmer exports.
 *
 * Run with:  node tests/page-csp.test.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const site = path.join(__dirname, "..", "site");

function htmlFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return htmlFiles(p);
    return e.name.endsWith(".html") ? [p] : [];
  });
}

const pages = htmlFiles(site);
assert.ok(pages.length >= 10, "expected to find the site's pages, found " + pages.length);

const problems = [];
for (const file of pages) {
  const name = path.relative(site, file);
  const html = fs.readFileSync(file, "utf8");
  if (!/<meta http-equiv="Content-Security-Policy" content="[^"]*default-src[^"]*"/.test(html)) {
    problems.push(name + ": no Content-Security-Policy meta tag with a default-src");
  }
  // Only the page's own markup: an inline library (the mileage page embeds xlsx-js-style) can
  // contain the text "<script src=" without it being a tag the browser will load.
  for (const m of html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="(https?:)?\/\/[^"]*"/gi)) {
    problems.push(name + ": loads a third-party resource: " + m[0].slice(0, 120));
  }
}

assert.deepStrictEqual(problems, [],
  "pages must ship their own CSP and self-host every script, stylesheet and font (see AGENTS.md)");

console.log("CSP and self-hosting checked on " + pages.length + " pages");
