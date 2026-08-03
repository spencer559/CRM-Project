"use strict";

const assert = require("assert");
const path = require("path");

// A normal standalone workspace is enough to exercise the value-normalization boundary.
global.window = {};
const STORE = path.resolve(__dirname, "../src/crmdb-store.js");
delete require.cache[STORE];
const workspace = require(STORE);

const local = new Blob(["%PDF-1.7\nbody\n%%EOF"], { type: "application/pdf" });
assert.strictEqual(workspace._toBlobForTest(local), local,
  "same-realm Blobs should retain their identity and zero-copy behavior");

// Cross-realm instanceof cannot be reproduced with Node's single WHATWG Blob constructor, but
// this is the exact observable brand and surface presented by a File created in a same-origin
// iframe. It must be recognized before toBlob reaches its String(data) fallback.
const iframeFileShape = {
  size: 20,
  type: "application/pdf",
  slice() {},
  get [Symbol.toStringTag]() { return "File"; }
};
assert.strictEqual(iframeFileShape instanceof Blob, false);
assert.strictEqual(workspace._isBlobLikeForTest(iframeFileShape), true,
  "a genuine cross-realm File brand must not be serialized as '[object File]'");

assert.strictEqual(workspace._isBlobLikeForTest({
  size: 20,
  slice() {},
  get [Symbol.toStringTag]() { return "NotAFile"; }
}), false, "arbitrary objects must not be accepted as Blob data");

console.log("PASS crmdb-cross-realm-blob");
