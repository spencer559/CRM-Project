/* Manifest-based container signatures in crmdb-store.js / crmdb-zip.js.
 *
 * A station recognizes its own .crmdb writes by content signature. Hashing the whole container
 * (SHA-256 over every byte) meant every autosave and every reconnect materialized the entire
 * database on the JS heap — the memory spike this replaces. The signature now hashes the ZIP
 * central directory's per-entry name/crc/size claims instead ("m2:" prefix), reading only a few
 * KB of tail slices. This test pins:
 *
 *   • CRMDB.manifest() reports exactly the container's entries, CRCs and sizes;
 *   • containerSig is deterministic on identical bytes, sensitive to any content change,
 *     and never confusable with a legacy full-byte sig (distinct "m2:" namespace);
 *   • a file written by a PRE-upgrade station (legacy sig in the metadata ring) is still
 *     recognized as our own — no spurious conflict prompt on the first post-upgrade reconnect;
 *   • a post-upgrade station recognizes its own write after teardown + an mtime restamp
 *     (the OneDrive case), without any conflict.
 *
 * Run with:  node tests/crmdb-manifest-sig.test.js
 */
"use strict";

const assert = require("assert");
const path = require("path");
if (!global.crypto) global.crypto = require("crypto").webcrypto;
global.window = global;

// canAutosave is computed at module load from these — define them BEFORE requiring the store so
// the desktop (bound-file) code path is exercised. Same harness as crmdb-freshness.test.js.
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

const CRMDB = require("../vendor/crmdb-zip.js");
const STORE = path.resolve(__dirname, "../src/crmdb-store.js");
function newTab() { delete require.cache[STORE]; delete global.CRMWorkspace; return require(STORE); }

async function crmdbBlob(scheduleObj, extraFiles) {
  const t = newTab();
  t._bundle.clear();
  t._bundle.set("schedule.json", new Blob([JSON.stringify(scheduleObj)]));
  (extraFiles || []).forEach(([name, text]) => t._bundle.set(name, new Blob([text])));
  return t._serialize();
}
async function blobBytes(blob) { return new Uint8Array(await blob.arrayBuffer()); }

function makeHandle(bytes, mtime) {
  const h = {
    writes: 0,
    getFile() { return Promise.resolve({ lastModified: h._mtime, arrayBuffer: () => Promise.resolve(h._bytes.buffer.slice(h._bytes.byteOffset, h._bytes.byteOffset + h._bytes.byteLength)) }); },
    createWritable() {
      const chunks = [];
      return Promise.resolve({
        write(d) { chunks.push(d); return Promise.resolve(); },
        async close() { h._bytes = new Uint8Array(await new Blob(chunks).arrayBuffer()); h._mtime += 1000; h.writes++; }
      });
    },
    queryPermission() { return Promise.resolve("granted"); },
    requestPermission() { return Promise.resolve("granted"); }
  };
  h._bytes = bytes; h._mtime = mtime;
  return h;
}

const schedOf = async (tab) => JSON.parse(await tab.readText({ prefix: "" }, "schedule.json"));

async function seedStation({ cache, cacheMod, cacheMatchesFile, fileBytes, fileMod, meta }) {
  shared.wipe();
  shared.set("bundle", await crmdbBlob(cache));
  shared.set("rev", 1);
  shared.set("fileMeta", Object.assign({ baseFileMod: cacheMod, cacheMatchesFile: cacheMatchesFile }, meta || {}));
  const handle = makeHandle(fileBytes, fileMod);
  shared.set("fileHandle", handle);
  return handle;
}

async function run() {
  assert.strictEqual(newTab().canAutosave, true, "test harness must exercise the desktop autosave path");

  /* 1. manifest() reports exactly the container's entries — names (spaces included), CRCs, sizes. */
  {
    const blob = await crmdbBlob({ v: 1 }, [["patients/2026-08-02/0930_X/My Report v2.pdf", "PDF BYTES HERE"]]);
    const man = await CRMDB.manifest(blob);
    assert.ok(Array.isArray(man), "manifest should parse our own container");
    const entries = await CRMDB.readBlob(blob);
    assert.strictEqual(man.length, entries.length, "manifest must list every entry");
    for (const e of entries) {
      const m = man.find((x) => x.name === e.name);
      assert.ok(m, "manifest missing entry: " + e.name);
      const bytes = await blobBytes(e.blob);
      assert.strictEqual(m.size, bytes.length, "size mismatch for " + e.name);
      assert.strictEqual(m.crc, CRMDB.crc32(bytes) >>> 0, "crc mismatch for " + e.name);
    }
    assert.ok(man.some((x) => x.name === "patients/2026-08-02/0930_X/My Report v2.pdf"), "space-in-name entry survived");
  }

  /* 2. containerSig: deterministic on identical bytes, sensitive to content, "m2:"-namespaced. */
  {
    const t = newTab();
    const date = new Date("2026-01-02T03:04:05Z");
    const mk = (text) => CRMDB.write([{ name: "a.txt", data: "AAA" }, { name: "b.txt", data: text }], { date });
    const sig1 = await t._containerSig(mk("BBB"));
    const sig2 = await t._containerSig(mk("BBB"));
    const sig3 = await t._containerSig(mk("BBX"));
    assert.ok(/^m2:[0-9a-f]{64}$/.test(sig1), "manifest sig format: " + sig1);
    assert.strictEqual(sig1, sig2, "identical containers must sign identically");
    assert.notStrictEqual(sig1, sig3, "a one-byte content change must change the sig");
    // Same bytes through a fresh Blob (what a reconnect reads back from disk) sign the same.
    const rebuilt = new Blob([await blobBytes(mk("BBB"))]);
    assert.strictEqual(await t._containerSig(rebuilt), sig1, "re-read bytes must sign identically");
    const legacy = await t._sigOf(mk("BBB"));
    assert.ok(!/^m2:/.test(legacy) && legacy !== sig1, "legacy and manifest sigs must never collide");
  }

  /* 3. Migration: file written by a PRE-upgrade station (legacy sig in the ring), reopened with
        unsaved local edits. Must be recognized as our own — re-pin, keep the edits, NO conflict —
        and the persisted metadata converges to an m2 sig. */
  {
    const fileBytes = await blobBytes(await crmdbBlob({ v: "OWN-OLD-WRITE" }));
    const legacySig = await newTab()._sigOf(fileBytes.buffer.slice(0));
    assert.ok(/^[0-9a-f]{64}$/.test(legacySig), "sanity: legacy sig is bare hex");
    const h = await seedStation({
      cache: { v: "LOCAL-EDITS" }, cacheMod: 1000, cacheMatchesFile: false,
      fileBytes, fileMod: 9000, meta: { baseSig: legacySig }
    });
    const s = newTab();
    let conflicts = 0; s.onConflict = () => { conflicts++; return "file"; };
    await s.stored();
    const res = await s.verifyFreshness();
    assert.strictEqual(conflicts, 0, "our own pre-upgrade write must not raise a conflict");
    assert.strictEqual(res.decision, "cache", "own bytes + local edits -> keep the cache");
    assert.strictEqual((await schedOf(s)).v, "LOCAL-EDITS", "local edits must survive the reconnect");
    assert.ok(/^m2:/.test(shared.get("fileMeta").baseSig), "metadata should now carry the m2 sig");
    await s._fileIdle();
    assert.strictEqual(h.writes, 1, "catch-up should flush the pending local edits to the file");
  }

  /* 4. Post-upgrade round trip: save, tear down, reopen after an mtime restamp (OneDrive sync).
        The write must be recognized by manifest sig alone — no conflict, no re-adopt needed. */
  {
    const fileBytes = await blobBytes(await crmdbBlob({ v: "START" }));
    const h = await seedStation({ cache: { v: "START" }, cacheMod: 5000, cacheMatchesFile: true, fileBytes, fileMod: 5000 });
    const a = newTab();
    await a.stored();
    await a.verifyFreshness();
    await a.writeFile({ prefix: "" }, "schedule.json", JSON.stringify({ v: "EDITED-HERE" }));
    await a.saveNow();
    assert.strictEqual(h.writes, 1, "saveNow must write through");
    assert.ok(/^m2:/.test(shared.get("fileMeta").baseSig), "the write should be signed with an m2 sig");
    h._mtime += 5000;                       // OneDrive re-stamps the file after syncing it up
    const b = newTab();                     // teardown + reopen on the same station
    let conflicts = 0; b.onConflict = () => { conflicts++; return "file"; };
    await b.stored();
    const res = await b.verifyFreshness();
    assert.strictEqual(conflicts, 0, "own restamped write must not raise a conflict");
    assert.ok(res.decision === "cache" || res.decision === "file", "own bytes settle without a prompt");
    assert.strictEqual((await schedOf(b)).v, "EDITED-HERE", "the saved edit must still be loaded");
    await b._fileIdle();
    assert.strictEqual(h.writes, 1, "recognizing our own bytes must not rewrite the file");
  }

  console.log("crmdb manifest sig: container identity without materializing the container — passed");
}

run().catch((e) => { console.error(e); process.exit(1); });
