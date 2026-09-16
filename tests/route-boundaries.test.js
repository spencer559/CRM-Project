#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

// site/ is the Cloudflare Pages build output directory, so every path below is also a URL path.
const root = path.join(__dirname, "..", "site");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

/* Pages publishes everything in site/ and nothing outside it. Before site/ existed the output was
   the repo root, so the README, agent briefs, tests, git hooks and iPad app source were all served
   to anyone. A new top-level entry here is a decision about what goes on the web. */
const published = ["_headers", "_redirects", "assets", "index.html", "mileage", "protected", "src", "tools", "vendor"];
assert.deepStrictEqual(fs.readdirSync(root).filter((f) => f !== ".DS_Store").sort(), published.slice().sort(),
  "site/ holds only what the website serves — keep docs, tests and tooling outside it");

const publicMileage = "mileage/index.html";
const syncClient = "mileage/mileage-sync.js";
const protectedPages = [
  "protected/index.html",
  "protected/CRM_Report_Generator.html",
  "protected/PDF_Viewer.html",
  "protected/Patient_Schedule.html",
  "protected/dashboard.html",
  "protected/auth-check.json",
];

assert(fs.existsSync(path.join(root, publicMileage)), "mileage calculator must have a public route");
assert(fs.existsSync(path.join(root, syncClient)), "mileage sync client must stay beside the calculator");
protectedPages.forEach((name) => assert(fs.existsSync(path.join(root, name)), name + " must stay protected"));

const mileageHtml = read(publicMileage);
assert(mileageHtml.includes('<script src="mileage-sync.js"></script>'), "public mileage must load its sync client locally");
assert(!/cloudflareaccess|CF_Authorization|protected\/auth-check/i.test(mileageHtml), "public mileage must not depend on Cloudflare Access");
// Anything it loaded from outside mileage/ could land behind an Access path and break it for
// signed-out users, who have only the calculator's own sync login.
const mileageRefs = Array.from(mileageHtml.matchAll(/\b(?:src|href)="([^"'+]+)"/g), (m) => m[1])
  .filter((ref) => !/^(?:https?:|data:|blob:|mailto:|#)/i.test(ref));
assert.deepStrictEqual(mileageRefs.filter((ref) => ref.startsWith("/") || ref.startsWith("..")), [],
  "public mileage must be self-contained within mileage/");

const landing = read("index.html");
assert(landing.includes('href="mileage/"'), "landing page must link directly to public mileage");
assert(landing.includes("protected/auth-check.json"), "landing page must use the single protected-session probe");
assert(!/dev\/auth-check|app\/crm-auth-check/.test(landing), "legacy per-application probes must stay removed");

const redirects = read("_redirects");
assert(redirects.includes("/app/Mileage_Calculator.html       /mileage/"), "old mileage bookmarks need a public redirect");
assert(redirects.includes("/dev/*                             /protected/:splat"), "old protected bookmarks need a compatibility redirect");

for (const retired of ["app", "dev", "auth"]) {
  assert(!fs.existsSync(path.join(root, retired)), retired + "/ must not be recreated; it blurs the auth boundary");
}
