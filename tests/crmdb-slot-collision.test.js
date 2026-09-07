/* Renaming a patient must never quietly land on top of another one's files.
 *
 * Slot folders are named from time + normalized patient name, so two different appointments can
 * produce one key — 08:00 "Demo, A-B" and 08:00 "Demo, AB" both give 0800_DEMOAB. moveSlot used to
 * copy straight into the destination prefix, destroying whatever was already there with no trace.
 * Until visits carry stable IDs the only safe answer is to refuse, so the caller can report it and
 * leave both folders intact.
 *
 * Run with:  node tests/crmdb-slot-collision.test.js
 */
"use strict";

const assert = require("assert");
const path = require("path");
if (!global.crypto) global.crypto = require("crypto").webcrypto;
global.window = global;
Object.defineProperty(global, "navigator", { value: {}, configurable: true, writable: true });
global.URL = { createObjectURL: function () { return "blob:x"; }, revokeObjectURL: function () {} };
global.document = {
  hidden: false,
  addEventListener: function () {},
  body: { appendChild() {}, removeChild() {} },
  createElement: () => ({ style: {}, click() {}, remove() {}, set href(v) {}, get href() { return ""; } })
};
global.addEventListener = function () {};

function installIndexedDB() {
  const data = new Map([["kv", new Map()]]);
  function makeTx(storeName) {
    const ops = [];
    const tx = { oncomplete: null, onerror: null, error: null, objectStore: () => store };
    const store = {
      get(k) { const rq = {}; ops.push(() => { rq.result = data.get(storeName).get(k); if (rq.onsuccess) rq.onsuccess(); }); return rq; },
      put(v, k) { const rq = {}; ops.push(() => { data.get(storeName).set(k, v); if (rq.onsuccess) rq.onsuccess(); }); return rq; },
      delete(k) { const rq = {}; ops.push(() => { data.get(storeName).delete(k); if (rq.onsuccess) rq.onsuccess(); }); return rq; }
    };
    queueMicrotask(() => {
      try { while (ops.length) ops.shift()(); } catch (e) { tx.error = e; if (tx.onerror) tx.onerror(); return; }
      if (tx.oncomplete) tx.oncomplete();
    });
    return tx;
  }
  global.indexedDB = {
    open() {
      const req = {};
      queueMicrotask(() => {
        req.result = {
          objectStoreNames: { contains: (n) => data.has(n) },
          createObjectStore: (n) => { if (!data.has(n)) data.set(n, new Map()); return {}; },
          transaction: (n) => makeTx(n), close() {}
        };
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    }
  };
  return { wipe: () => data.get("kv").clear() };
}
const shared = installIndexedDB();

require("../vendor/crmdb-zip.js");
const STORE = path.resolve(__dirname, "../src/crmdb-store.js");
function newTab() { delete require.cache[STORE]; delete global.CRMWorkspace; return require(STORE); }
const settle = () => new Promise((r) => setTimeout(r, 0));
const DATE = "2026-09-07";

async function run() {
  // The collision is real, not hypothetical: these two names normalize to one folder.
  {
    const tab = newTab();
    assert.strictEqual(tab.slotName("08:00", "Demo, A-B"), tab.slotName("08:00", "Demo, AB"),
      "this test is only meaningful while distinct names can still collide");
  }

  shared.wipe();
  const tab = newTab();
  await tab.newDatabase();
  await settle();

  const alice = { prefix: "patients/" + DATE + "/0800_DEMOAB/" };
  const bob = { prefix: "patients/" + DATE + "/0830_OTHER/" };
  await tab.writeFile(alice, "report.json", JSON.stringify({ patient: "the one already there" }));
  await tab.writeFile(bob, "report.json", JSON.stringify({ patient: "the one being renamed" }));
  await settle();

  /* 1. Refuse, and say why in terms the caller can show. */
  await assert.rejects(
    () => tab.moveSlot(null, DATE, "0830_OTHER", "0800_DEMOAB"),
    /already has files at 0800_DEMOAB/,
    "moving onto an occupied slot must be refused, not silently merged"
  );

  /* 2. Nothing moved, and neither patient lost anything. */
  assert.strictEqual(JSON.parse(await tab.readText(alice, "report.json")).patient, "the one already there",
    "the destination's files must survive a refused move");
  assert.strictEqual(JSON.parse(await tab.readText(bob, "report.json")).patient, "the one being renamed",
    "the source's files must stay put when the move is refused");

  /* 3. A genuinely free destination still moves, and the old folder is gone. */
  assert.strictEqual(await tab.moveSlot(null, DATE, "0830_OTHER", "0900_FREE"), true);
  const moved = { prefix: "patients/" + DATE + "/0900_FREE/" };
  assert.strictEqual(JSON.parse(await tab.readText(moved, "report.json")).patient, "the one being renamed");
  await assert.rejects(() => tab.readText(bob, "report.json"), /not found/,
    "a completed move leaves nothing behind at the old slot");

  /* 4. A slot with no files is not "occupied" — renaming an empty appointment is fine. */
  assert.strictEqual(await tab.moveSlot(null, DATE, "1000_EMPTY", "1030_EMPTY"), false,
    "an empty source reports nothing moved rather than failing");

  console.log("PASS an occupied slot refuses the move instead of overwriting a patient's files");
}

run().catch((e) => { console.error(e); process.exit(1); });
