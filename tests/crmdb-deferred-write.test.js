/* What a typing-debounce write is allowed to cost.
 *
 * Committing re-serializes the ENTIRE database: serializeZip walks every file, CRC-32s every byte
 * in a JS loop, and concatenates the result into one Blob. On a clinic-sized .crmdb (tens of MB of
 * accumulated programmer PDFs — the container uses STORE, so nothing ever shrinks) that is a
 * multi-hundred-millisecond block of the main thread.
 *
 * The report generator's live sync fires every time typing pauses, and it used to force a full
 * commit each time — which is what made the page hitch all through a visit, worse the bigger the
 * database got. It now stages with { defer: true } and commits on its own slow cadence.
 *
 * What must remain true:
 *   • a deferred write costs NO serialization
 *   • the staged bytes are still readable, and still land in the shared copy when something commits
 *   • an ordinary write is unaffected
 *
 * Run with:  node tests/crmdb-deferred-write.test.js
 */
"use strict";

const assert = require("assert");
const path = require("path");
if (!global.crypto) global.crypto = require("crypto").webcrypto;
global.window = global;

// No File System Access pickers → canAutosave is false, so newDatabase() takes the no-file-handle
// path. That is all this test wants: an open database backed only by the IndexedDB working copy,
// with no OneDrive write-through in the way of counting serializations.

Object.defineProperty(global, "navigator", { value: {}, configurable: true, writable: true });
global.URL = { createObjectURL: function () { return "blob:x"; }, revokeObjectURL: function () {} };
global.document = {
  body: { appendChild: function () {}, removeChild: function () {} },
  createElement: function () { return { style: {}, click: function () {}, remove: function () {}, set href(v) {}, get href() { return ""; } }; }
};

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
        req.result = { objectStoreNames: { contains: (n) => data.has(n) }, createObjectStore: (n) => { if (!data.has(n)) data.set(n, new Map()); return {}; }, transaction: (n) => makeTx(n), close() {} };
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    }
  };
  return { get: (k) => data.get("kv").get(k), set: (k, v) => data.get("kv").set(k, v), wipe: () => data.get("kv").clear() };
}
const shared = installIndexedDB();

require("../vendor/crmdb-zip.js");
const STORE = path.resolve(__dirname, "../src/crmdb-store.js");
function newTab() { delete require.cache[STORE]; delete global.CRMWorkspace; return require(STORE); }

// Count every full-bundle serialization, which is the expensive thing we are trying not to do.
// CRMDB.write is the synchronous heart of it, so counting calls counts main-thread blocks.
const realWrite = global.CRMDB.write;
let serializations = 0;
global.CRMDB.write = function () { serializations++; return realWrite.apply(this, arguments); };

const settle = () => new Promise((r) => setTimeout(r, 0));

async function station() {
  shared.wipe();
  const tab = newTab();
  await tab.newDatabase();     // sets opened, seeds schedule.json, publishes the working copy
  await settle();
  return tab;
}

// What another page would pick up: the shared working copy, not this tab's memory.
async function sharedCopyHas(name, dirPrefix) {
  const t = newTab();
  await t.stored();
  return t.readText({ prefix: dirPrefix || "" }, name);
}

async function run() {
  const dir = { prefix: "patients/2026-07-29/0800_AB/" };

  /* 1. A deferred write serializes nothing at all. */
  {
    const tab = await station();
    const before = serializations;

    // 20 typing pauses' worth of live sync
    for (let i = 0; i < 20; i++) {
      await tab.writeFile(dir, "report.json", JSON.stringify({ edit: i }), { defer: true });
    }
    await settle();

    assert.strictEqual(serializations, before,
      "a deferred write must not serialize the database — that is the freeze this exists to avoid " +
      "(saw " + (serializations - before) + " serializations across 20 staged writes)");

    // ...and the staged bytes are real: readable immediately from the working copy.
    assert.strictEqual(JSON.parse(await tab.readText(dir, "report.json")).edit, 19,
      "staged writes must still be readable in this tab");
  }

  /* 2. Staged work is not lost — the next commit carries all of it, in one serialization. */
  {
    const tab = await station();
    for (let i = 0; i < 20; i++) {
      await tab.writeFile(dir, "report.json", JSON.stringify({ edit: i }), { defer: true });
    }
    const before = serializations;
    await tab.flush();                       // what leaving / tab-hide / the 30s cadence does
    await settle();

    assert.strictEqual(serializations, before + 1,
      "20 staged edits must cost exactly ONE serialization when they are finally committed");
    assert.strictEqual(JSON.parse(await sharedCopyHas("report.json", dir.prefix)).edit, 19,
      "every staged edit must reach the shared copy the Schedule reads");
  }

  /* 3. An ordinary (non-deferred) write is unchanged: it still schedules its own commit. */
  {
    const tab = await station();
    const before = serializations;
    await tab.writeFile(dir, "report.pdf", "PDF-BYTES");
    // persist() is debounced ~1.2s; wait past it rather than reaching into the timer.
    await new Promise((r) => setTimeout(r, 1600));
    assert.ok(serializations > before,
      "a normal write must still persist on its own — only the live-sync path opts out");
    assert.strictEqual(await sharedCopyHas("report.pdf", dir.prefix), "PDF-BYTES");
  }

  /* 4. The cost scales with database size, so confirm the saving is proportional and not a wash:
        one commit for a visit's worth of edits instead of one per pause. */
  {
    const tab = await station();
    const PAUSES = 40;
    const before = serializations;
    for (let i = 0; i < PAUSES; i++) {
      await tab.writeFile(dir, "report.json", JSON.stringify({ edit: i }), { defer: true });
    }
    await tab.flush();
    await settle();
    const cost = serializations - before;
    assert.strictEqual(cost, 1,
      "a " + PAUSES + "-pause visit must serialize once, not " + PAUSES + " times (saw " + cost + ")");
  }

  console.log("crmdb deferred write: the live sync no longer re-serializes the database on every typing pause — passed");
}

run().catch((e) => { console.error(e); process.exit(1); });
