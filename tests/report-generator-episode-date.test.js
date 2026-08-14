/* The Stored Episodes header date is persistent, parser-addressable, and exported. */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "app", "CRM_Report_Generator.html"), "utf8");

assert.match(html, /class="episode-date"[\s\S]*?<input type="date" id="ep-since-date"/,
  "the Stored Episodes header should contain a parser-addressable date input");
assert.match(html, /epSince=usDate\(val\('ep-since-date'\)\)/,
  "the vector PDF should include the episode start date");
assert.match(html, /epSince=usDate\(v\('ep-since-date'\)\)/,
  "the printable report should include the episode start date");
assert.match(html, /epSum\.push\('Since: ' \+ usDate\(val\('ep-since-date'\)\)\)/,
  "the compact text report should include the episode start date");
assert.doesNotMatch(html, /el\.id === 'ep-since-date'.*return/,
  "the generic form serializer must not exclude the episode start date");

console.log("report generator episode-date checks passed");
