#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

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
