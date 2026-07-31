/* Vendor detection in engine.js — Engine.guessVendor / Engine.scoreVendors.
 *
 * The bug this pins: a Boston Scientific LATITUDE report carrying an Abbott / St. Jude RV lead
 * was detected as "Abbott / St. Jude" and refused to import. boston.js reads the Leads table
 * verbatim ON PURPOSE, so a foreign lead's manufacturer ("St. Jude Medical") is in the page text;
 * the old first-regex-wins search then returned whichever vendor sat higher in the array. Abbott
 * has no PDF parser (their export is a scanned image), so the importer dead-ended and never
 * reached prefillForm — the whole auto-fill was walled off by one lead row.
 *
 * The fix scores vendors instead: a report's own brand is in the page furniture and repeats on
 * every page, a foreign lead is one cell on one page. These cases lock that in — plus the list
 * drift found alongside it (the engine didn't know Boston's INGENIO/VITALIO/… families, which
 * only the parser's now-deleted dead `sig` regex listed).
 *
 * Run with:  node tests/vendor-detect.test.js
 */
"use strict";

const assert = require("assert");
const path = require("path");

// engine.js is an IIFE over `window`; its only side effect (initWorker) returns immediately when
// pdfjsLib is undefined, so it loads in Node with no DOM shim at all.
global.window = global;
require(path.join(__dirname, "..", "src", "engine.js"));
const Engine = global.Engine;

/* Build the {page,x,y,w,str} item array extractItems() produces. Each argument is one page;
   the strings are that page's text items, in reading order. Geometry is irrelevant to
   detection (it reads .page and .str only), so it's filled with plausible constants. */
function items(...pages) {
  const out = [];
  pages.forEach((strs, i) => {
    strs.forEach((str, j) => out.push({ page: i + 1, x: 40 + j * 60, y: 700 - j * 12, w: 30, str }));
  });
  return out;
}

// Boston's page furniture: the footer prints on every page of a LATITUDE report.
const BOSTON_FOOTER = ["Boston Scientific Corporation", "LATITUDE NXT", "Page"];
const MEDTRONIC_FOOTER = ["Medtronic CareLink Network", "Page"];
const BIOTRONIK_FOOTER = ["BIOTRONIK Home Monitoring", "Page"];

let failures = 0;
function check(label, actual, expected) {
  try {
    assert.strictEqual(actual, expected);
    console.log("  ok   " + label);
  } catch (e) {
    failures++;
    console.log("  FAIL " + label + "\n       expected " + JSON.stringify(expected) +
                ", got " + JSON.stringify(actual));
  }
}

/* ---------- 1. the reported bug ----------
   A 7-page Boston report whose Leads table (p4) lists an Abbott RV lead. */
const bostonWithAbbottLead = items(
  [...BOSTON_FOOTER, "Patient Data Report", "Device", "ACCOLADE MRI L331/ 123456"],
  [...BOSTON_FOOTER, "Battery", "Approximate time to explant: 9.2 years"],
  [...BOSTON_FOOTER, "Leads Data", "Right Atrium", "Right Ventricle"],
  [...BOSTON_FOOTER, "Implant Date", "Manufacturer", "Model", "Serial", "Polarity", "Position",
   "May 2014", "St. Jude Medical", "Durata 7122Q", "V1234567", "Bipolar", "Right Ventricle"],
  [...BOSTON_FOOTER, "Arrhythmia Logbook"],
  [...BOSTON_FOOTER, "My Alerts"],
  [...BOSTON_FOOTER, "Programmed Parameters"]
);
check("Boston report + Abbott RV lead -> Boston", Engine.guessVendor(bostonWithAbbottLead), "Boston Scientific");

// The Abbott lead must still be VISIBLE to the parser — detection must not have filtered text out.
check("...and the Abbott lead text survives in the items",
  bostonWithAbbottLead.some((i) => /St\. Jude/.test(i.str)), true);

/* ---------- 2. single page, where page-spread carries no information ----------
   Decided by distinct strong tokens: Boston says both "Boston Scientific" and "LATITUDE";
   the foreign lead says one thing. */
check("single-page Boston + Abbott lead -> Boston", Engine.guessVendor(items(
  [...BOSTON_FOOTER, "Device", "ACCOLADE MRI L331", "Manufacturer", "St. Jude Medical", "Durata 7122Q"]
)), "Boston Scientific");

/* ---------- 3. a clean report for each vendor ---------- */
check("clean Boston", Engine.guessVendor(items(
  [...BOSTON_FOOTER, "RESONATE X4"], [...BOSTON_FOOTER, "Leads Data"]
)), "Boston Scientific");

check("clean Medtronic", Engine.guessVendor(items(
  [...MEDTRONIC_FOOTER, "Azure XT DR MRI"], [...MEDTRONIC_FOOTER, "Lead Measurements"]
)), "Medtronic");

check("clean Biotronik", Engine.guessVendor(items(
  [...BIOTRONIK_FOOTER, "Edora 8 DR-T"], [...BIOTRONIK_FOOTER, "Lead Measurements"]
)), "Biotronik");

/* ---------- 4. genuine Abbott still detects as Abbott ----------
   The importer's dead end (and its "use the Merlin .log export" advice) must still fire for a
   real Abbott PDF — the fix must not make Abbott undetectable. */
check("genuine Abbott -> Abbott", Engine.guessVendor(items(
  ["St. Jude Medical", "Merlin.net Patient Care Network", "Assurity MRI 2272"],
  ["St. Jude Medical", "Merlin.net", "Lead Measurements"]
)), "Abbott / St. Jude");

/* ---------- 5. list drift: families the engine used not to know ----------
   INGENIO/VITALIO/DYNAGEN etc. were only in boston.js's dead `sig`, so a Boston report without a
   literal "Boston Scientific"/"LATITUDE" string used to come back Unknown. */
check("Boston INGENIO with no brand string -> Boston", Engine.guessVendor(items(
  ["INGENIO MRI K174", "Leads Data", "Right Atrium"],
  ["VITALIO", "Programmed Parameters"]
)), "Boston Scientific");

/* ---------- 6. nothing recognizable ---------- */
check("empty items -> Unknown", Engine.guessVendor([]), "Unknown");
check("unrecognizable text -> Unknown", Engine.guessVendor(items(
  ["Patient Name", "Date of Birth", "Serial", "Page 1 of 2"]
)), "Unknown");

/* ---------- scoreVendors shape (the importer reads it to spot a close call) ---------- */
const ranked = Engine.scoreVendors(bostonWithAbbottLead);
check("scoreVendors ranks Boston first", ranked[0].name, "Boston Scientific");
check("scoreVendors returns every vendor", ranked.length, Engine.VENDORS.length);
check("Boston beats Abbott by a clear margin", ranked[1].score * 2 < ranked[0].score, true);

console.log(failures ? "\n" + failures + " check(s) failed" : "\nall checks passed");
process.exit(failures ? 1 : 0);
