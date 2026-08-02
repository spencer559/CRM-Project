/* What a page handoff is allowed to wait for.
 *
 * Navigating Schedule -> CRM Report Generator flushes first, and the flush used to run the whole
 * save: serialize, publish to IndexedDB, AND write the multi-megabyte .crmdb back to a OneDrive-
 * synced file. Only the first two are the handoff — the other page reads the working copy out of
 * IndexedDB — so waiting on the file write just made switching pages feel slow, and a save already
 * in flight made it slower still by holding the queue.
 *
 * The file write now runs on its own background queue. That is only safe because an interrupted
 * write is recognized by signature instead of mistaken for another station's edit (see
 * crmdb-selfwrite.test.js), and because any page that verifies itself catches the file up.
 *
 * Run with:  node tests/crmdb-handoff.test.js
 */
"use strict";

const assert = require("assert");
const path = require("path");
if (!global.crypto) global.crypto = require("crypto").webcrypto;
global.window = global;

global.showOpenFilePicker = function () {};
global.showSaveFilePicker = function () {};

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

// A OneDrive-backed file whose writes take real time — the cost the handoff should not be paying.
function makeHandle(bytes, mtime, writeMs) {
  const h = {
    writes: 0,
    writeMs: writeMs || 0,
    getFile() { return Promise.resolve({ lastModified: h._mtime, arrayBuffer: () => Promise.resolve(h._bytes.buffer.slice(h._bytes.byteOffset, h._bytes.byteOffset + h._bytes.byteLength)) }); },
    createWritable() {
      const chunks = [];
      return Promise.resolve({
        write(d) { chunks.push(d); return Promise.resolve(); },
        async close() {
          if (h.writeMs) await new Promise((r) => setTimeout(r, h.writeMs));
          h._bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
          h._mtime += 1000; h.writes++;
        }
      });
    },
    queryPermission() { return Promise.resolve("granted"); },
    requestPermission() { return Promise.resolve("granted"); }
  };
  h._bytes = bytes; h._mtime = mtime;
  return h;
}

const writeSched = (tab, obj) => tab.writeFile({ prefix: "" }, "schedule.json", JSON.stringify(obj));
const schedOfBundle = async () => {
  // What the OTHER page would pick up: the working copy in IndexedDB, not this tab's memory.
  const t = newTab();
  await t.stored();
  return JSON.parse(await t.readText({ prefix: "" }, "schedule.json"));
};

async function station(writeMs) {
  shared.wipe();
  const seed = newTab();
  seed._bundle.clear();
  seed._bundle.set("schedule.json", new Blob([JSON.stringify({ v: "ORIGINAL" })]));
  const h = makeHandle(new Uint8Array(await (await seed._serialize()).arrayBuffer()), 5000, writeMs);
  shared.set("fileHandle", h);
  seed._setFileHandleForTest(h);
  seed._markAuthoritativeForTest();
  await seed.verifyFreshness();
  await seed.saveNow();
  await seed._fileIdle();
  return { h, seed };
}

async function run() {
  /* 1. The handoff waits for IndexedDB, not for the file. */
  {
    const { h, seed } = await station(120);
    const writesBefore = h.writes;
    await writeSched(seed, { v: "HANDOFF" });

    const t = Date.now();
    await seed.flush();
    const flushMs = Date.now() - t;

    assert.strictEqual(h.writes, writesBefore,
      "flush() returned only after the file write — that is the cost the page switch was paying");
    assert.ok(flushMs < 100, "flush() should not be waiting on a 120ms file write (took " + flushMs + "ms)");
    assert.strictEqual((await schedOfBundle()).v, "HANDOFF",
      "the other page must still find the latest edits in the shared working copy");

    // The write is not skipped, just not waited for.
    await seed._fileIdle();
    assert.strictEqual(h.writes, writesBefore + 1, "the background write-through must still reach the file");
  }

  /* 2. A save already in flight must not hold up the next handoff. */
  {
    const { h, seed } = await station(150);
    const writesBefore = h.writes;
    await writeSched(seed, { v: "FIRST" });
    await seed.flush();
    await new Promise((r) => setTimeout(r, 5)); // let the slow file write become the active one

    await writeSched(seed, { v: "SECOND" });
    const t = Date.now();
    await seed.flush();
    await writeSched(seed, { v: "THIRD" });
    await seed.flush();
    const flushMs = Date.now() - t;
    assert.ok(flushMs < 100, "a handoff queued behind an in-flight file write (took " + flushMs + "ms)");
    assert.strictEqual((await schedOfBundle()).v, "THIRD");
    await seed._fileIdle();
    assert.strictEqual(h.writes, writesBefore + 2,
      "slow storage should write the active snapshot and only the newest pending snapshot");
  }

  /* 3. The file still catches up: a page that verifies itself finishes a write the previous page
        never got to, without the caller asking. */
  {
    const { h, seed } = await station(0);
    await writeSched(seed, { v: "NEVER-REACHED-THE-FILE" });
    await seed.flush();                        // committed to IndexedDB; page then "goes away"
    const writesBefore = h.writes;             // (the background write is captured below)
    await seed._fileIdle();
    assert.strictEqual(h.writes, writesBefore + 1, "sanity: this station's own flush wrote the file");

    // Now the harder case: a commit that reached IndexedDB with no file write at all.
    shared.set("fileMeta", Object.assign({}, shared.get("fileMeta"), { cacheMatchesFile: false }));
    const next = newTab();
    await next.stored();
    const before = h.writes;
    await next.verifyFreshness();
    await next._fileIdle();
    assert.strictEqual(h.writes, before + 1,
      "a verified page holding unsaved work must bring the file up to date on its own");
  }

  console.log("crmdb handoff: page switches wait for the working copy, not for the OneDrive write — passed");
}

run().catch((e) => { console.error(e); process.exit(1); });
