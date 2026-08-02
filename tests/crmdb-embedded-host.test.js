"use strict";

const assert = require("assert");
const path = require("path");

const hostWorkspace = { supported: true, sentinel: "host-workspace" };
global.window = {
  CRM_EMBED: true,
  parent: { CRMWorkspace: hostWorkspace }
};

const STORE = path.resolve(__dirname, "../src/crmdb-store.js");
delete require.cache[STORE];
require(STORE);

assert.strictEqual(global.window.CRMWorkspace, hostWorkspace,
  "an embedded same-origin generator should reuse the Schedule's workspace");
assert.strictEqual(global.window.CRMWorkspaceUsesHost, true,
  "the generator needs to know callback and reload behavior is shared with its host");

console.log("PASS crmdb-embedded-host");
