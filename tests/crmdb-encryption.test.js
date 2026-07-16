/* Local smoke test for optional .crmdb password protection. Run with:
 *   node tests/crmdb-encryption.test.js
 */
"use strict";

const assert = require("assert");
// Node >=20 already exposes webcrypto as a getter-only global; assigning over it throws.
if (!global.crypto) global.crypto = require("crypto").webcrypto;
const sessionValues = new Map();
global.sessionStorage = {
  getItem: (key) => sessionValues.has(key) ? sessionValues.get(key) : null,
  setItem: (key, value) => sessionValues.set(key, String(value)),
  removeItem: (key) => sessionValues.delete(key)
};
global.window = global;
require("../vendor/crmdb-zip.js");
const WS = require("../src/crmdb-store.js");

async function openPlainFixture() {
  WS._bundle.clear();
  WS._bundle.set("schedule.json", new Blob([JSON.stringify({ type: "patient-schedule", version: 1, dates: {} })]));
  WS._bundle.set("patients/2026-07-13/0800_AB/report.txt", new Blob(["local-only test"]));
  const zip = await WS._serializeZip();
  await WS._ingest(await zip.arrayBuffer());
}

async function run() {
  assert.strictEqual(WS.slotName("08:00", "José O'Connor-Smith"), "0800_JOSEOCONNORSMITH");
  await openPlainFixture();
  assert.strictEqual(WS.isEncrypted(), false);

  const moved = await WS.moveDate(null, "2026-07-13", "2026-07-14");
  assert.deepStrictEqual(moved, { files: 1, overwritten: 0 });
  assert.strictEqual(WS._bundle.has("patients/2026-07-13/0800_AB/report.txt"), false);
  assert.strictEqual(await WS._bundle.get("patients/2026-07-14/0800_AB/report.txt").text(), "local-only test");
  await WS.moveDate(null, "2026-07-14", "2026-07-13");

  await WS.enableProtection("correct horse battery staple");
  const protectedBlob = await WS._serialize();
  const protectedBytes = new Uint8Array(await protectedBlob.arrayBuffer());
  assert.strictEqual(new TextDecoder().decode(protectedBytes.slice(0, 8)), "CRMDBENC");
  assert.notStrictEqual(new TextDecoder().decode(protectedBytes.slice(0, 2)), "PK");

  await WS.forget();
  const attempts = ["wrong password", "correct horse battery staple"];
  WS.onPasswordRequest = () => attempts.shift();
  await WS._ingest(protectedBytes);
  assert.strictEqual(WS.isEncrypted(), true);
  assert.strictEqual(await WS._bundle.get("patients/2026-07-13/0800_AB/report.txt").text(), "local-only test");

  let unexpectedPrompt = false;
  WS.onPasswordRequest = () => { unexpectedPrompt = true; throw new Error("unexpected password prompt"); };
  await WS._ingest(protectedBytes);
  assert.strictEqual(unexpectedPrompt, false, "the per-tab unlock should survive page-style re-ingestion");

  WS.lockSession();
  WS.onPasswordRequest = () => "correct horse battery staple";
  await WS._ingest(protectedBytes);

  await assert.rejects(() => WS.changePassword("wrong password", "a new secure password"), /Incorrect password/);
  await WS.changePassword("correct horse battery staple", "a new secure password");
  const changedBlob = await WS._serialize();

  await WS.forget();
  WS.onPasswordRequest = () => "a new secure password";
  await WS._ingest(await changedBlob.arrayBuffer());
  await assert.rejects(() => WS.disableProtection("wrong password"), /Incorrect password/);
  await WS.disableProtection("a new secure password");
  const plainBlob = await WS._serialize();
  assert.strictEqual(new TextDecoder().decode(new Uint8Array(await plainBlob.arrayBuffer()).slice(0, 2)), "PK");

  console.log("crmdb encryption: protected/unprotected round trips and password changes passed");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
