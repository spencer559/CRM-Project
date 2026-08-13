"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const viewer = fs.readFileSync(path.join(__dirname, "..", "app", "PDF_Viewer.html"), "utf8");
const handler = viewer.slice(viewer.indexOf('$("downloadBtn").addEventListener'), viewer.indexOf("// The lesson from the importer"));

assert.ok(handler.includes("showSaveFilePicker"),
  "Download should offer a Save As file picker when the browser supports it");
assert.ok(handler.indexOf("showSaveFilePicker({") < handler.indexOf("doc.getData()"),
  "the Save As picker must open before asynchronous PDF preparation consumes user activation");
assert.match(handler, /accept:\s*\{\s*"application\/pdf":\s*\["\.pdf"\]\s*\}/,
  "the picker should be restricted to PDF files");
assert.match(handler, /handle\.createWritable\(\)[\s\S]*writable\.write\([\s\S]*writable\.close\(\)/,
  "the selected file must be written and closed");
assert.match(handler, /if \(e && e\.name === "AbortError"\) return/,
  "cancelling Save As should not trigger an unwanted fallback download");
assert.match(handler, /classicDownload\(/,
  "browsers without the picker API should retain the classic download fallback");

console.log("PASS pdf-viewer-save-location");
