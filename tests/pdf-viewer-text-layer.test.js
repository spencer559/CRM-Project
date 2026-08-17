"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const viewer = fs.readFileSync(path.join(root, "protected", "PDF_Viewer.html"), "utf8");
const pdfjs = require(path.join(root, "vendor", "pdf.min.js"));

assert.strictEqual(typeof pdfjs.renderTextLayer, "function",
  "the vendored PDF.js build must provide selectable text-layer rendering");
assert.match(viewer, /page\.getTextContent\(\{ includeMarkedContent: true \}\)/,
  "active pages should request their PDF text");
assert.match(viewer, /pdfjsLib\.renderTextLayer\(\{/,
  "active pages should overlay the selectable PDF.js text layer");
assert.match(viewer, /s\.textLayer\.replaceChildren\(\)/,
  "released pages must discard text nodes rather than retaining the whole document in memory");
assert.match(viewer, /s\.task\.text\.cancel/,
  "text rendering should be cancelled when a virtual page leaves the active window");

console.log("PASS pdf-viewer-text-layer");
