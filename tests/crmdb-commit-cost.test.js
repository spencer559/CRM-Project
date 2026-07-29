/* What a COMMIT is allowed to cost, independent of how often one happens.
 *
 * tests/crmdb-deferred-write.test.js caps how MANY times we serialize. This caps how EXPENSIVE
 * one serialization is — the other half of the same problem, and the half that gets worse every
 * time a programmer PDF is attached, because the container uses STORE and nothing ever shrinks.
 *
 * A .crmdb is a ZIP, so every entry needs a CRC-32. Done naively that means reading every Blob and
 * running the JS crc32 loop over every byte of the whole database on every commit: at 53 MB that
 * measured ~145 ms of a ~155 ms serialize, even when a single note had changed. Since a Blob is
 * immutable and bset() installs a new Blob whenever content changes, an unchanged file's CRC can
 * never change either — so it is computed once and memoized on the Blob.
 *
 * What must remain true:
 *   • committing twice with nothing changed re-reads NO file bytes
 *   • editing one file re-reads only that file
 *   • renaming/moving a file (same Blob, new path) re-reads nothing — a CRC covers content, not name
 *   • a replaced file is re-read, i.e. the memo can never serve a stale CRC
 *   • the bytes written are still a valid .crmdb that reads back identically
 *
 * Run with:  node tests/crmdb-commit-cost.test.js
 */
"use strict";

const assert = require("assert");
const path = require("path");
if (!global.crypto) global.crypto = require("crypto").webcrypto;
global.window = global;

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
  return { wipe: () => data.get("kv").clear() };
}
const shared = installIndexedDB();

require("../vendor/crmdb-zip.js");
const realCrc32 = global.CRMDB.crc32;

// Measure how many stored bytes a commit pulls out of the bundle.
//
// Deliberately instrumented at Blob.prototype.arrayBuffer rather than at crc32: reading a Blob is
// the only way to get at a stored file's bytes, whatever the serializer does with them afterwards.
// (Patching CRMDB.crc32 would prove nothing — write() hashes through a closure-local crc32 that a
// patch on the public API never sees, so a regression would silently read as "0 bytes hashed".)
// Only the region around a serialize is metered, so reading the RESULT never counts as input.
const realArrayBuffer = Blob.prototype.arrayBuffer;
let readBytes = 0, readCalls = 0, metering = false;
Blob.prototype.arrayBuffer = function () {
  if (metering) { readBytes += this.size; readCalls++; }
  return realArrayBuffer.apply(this, arguments);
};
async function costOf(fn) {
  readBytes = 0; readCalls = 0; metering = true;
  try { var out = await fn(); } finally { metering = false; }
  return { bytes: readBytes, calls: readCalls, out: out };
}

const STORE = path.resolve(__dirname, "../src/crmdb-store.js");
function newTab() { delete require.cache[STORE]; delete global.CRMWorkspace; return require(STORE); }
const settle = () => new Promise((r) => setTimeout(r, 0));

async function station() {
  shared.wipe();
  const tab = newTab();
  await tab.newDatabase();
  await settle();
  return tab;
}

// A few sizeable "programmer PDFs" — big enough that a re-read is unmistakable in the byte count.
const PDF_SIZE = 512 * 1024;
function pdfBytes(seed) {
  const b = Buffer.alloc(PDF_SIZE);
  for (let i = 0; i < PDF_SIZE; i += 4093) b[i] = (seed + i) & 0xFF;   // cheap, non-uniform filler
  return b;
}

async function fill(tab, n) {
  for (let i = 0; i < n; i++) {
    const dir = { prefix: `patients/2026-07-${String(1 + i).padStart(2, "0")}/0800_PT${i}/` };
    await tab.writeFile(dir, `interrogation-${i}.pdf`, pdfBytes(i), { defer: true });
    await tab.writeFile(dir, "notes.txt", "note\n".repeat(50), { defer: true });
  }
}

async function run() {
  const N = 8;   // 8 slots ≈ 4 MB, plenty to make an unwanted full pass obvious

  /* 1. The first commit pays for every byte exactly once — and only once. */
  {
    const tab = await station();
    await fill(tab, N);
    const cold = await costOf(() => tab._serializeZip());
    assert.ok(cold.bytes >= N * PDF_SIZE,
      "the first commit must read every stored byte (saw " + cold.bytes + " for " + (N * PDF_SIZE) + " of PDFs)");

    const warm = await costOf(() => tab._serializeZip());
    assert.strictEqual(warm.bytes, 0,
      "a second commit with nothing changed must re-read NO file bytes (re-read " + warm.bytes + " bytes in " + warm.calls + " reads)");
  }

  /* 2. Editing one file costs that one file, not the database. */
  {
    const tab = await station();
    await fill(tab, N);
    await tab._serializeZip();                       // warm the memo

    const dir = { prefix: "patients/2026-07-01/0800_PT0/" };
    const note = JSON.stringify({ edit: 1 });
    await tab.writeFile(dir, "report.json", note, { defer: true });

    const cost = await costOf(() => tab._serializeZip());
    assert.ok(cost.bytes < 4096,
      "committing after one small edit must read only that file, not the whole database " +
      "(read " + cost.bytes + " bytes)");
    assert.strictEqual(cost.calls, 1, "exactly one file should have been read (saw " + cost.calls + ")");
  }

  /* 3. A move re-keys the same Blob under a new path. A CRC covers content, not the name, so a
        whole-day move — which touches every file in that day — must still hash nothing. */
  {
    const tab = await station();
    await fill(tab, N);
    await tab._serializeZip();

    // The moves are inside the meter too: neither re-keying nor the commit that follows it may
    // touch a byte of the moved files.
    const cost = await costOf(async () => {
      await tab.moveDate(null, "2026-07-01", "2026-08-15");
      await tab.moveSlot(null, "2026-07-02", "0800_PT1", "0930_PT1");
      await tab._serializeZip();
    });
    assert.strictEqual(cost.bytes, 0,
      "moving files must not re-read their contents (re-read " + cost.bytes + " bytes)");
  }

  /* 4. The memo must never serve a stale CRC: replacing a file's contents re-reads it. This is the
        correctness half — a wrong CRC would produce a .crmdb that fails validation in any zip tool. */
  {
    const tab = await station();
    await fill(tab, N);
    await tab._serializeZip();

    const dir = { prefix: "patients/2026-07-01/0800_PT0/" };
    await tab.writeFile(dir, "interrogation-0.pdf", pdfBytes(999), { defer: true });   // same path, new bytes

    const cost = await costOf(() => tab._serializeZip());
    assert.ok(cost.bytes >= PDF_SIZE,
      "a replaced file must be re-read, never served from the memo (read only " + cost.bytes + ")");

    // ...and the emitted container is still valid, with the NEW bytes and a CRC that matches them.
    const bytes = new Uint8Array(await cost.out.arrayBuffer());
    const back = await global.CRMDB.read(bytes);
    const got = back.find((e) => e.name === dir.prefix + "interrogation-0.pdf");
    assert.ok(got, "replaced file missing from the serialized container");
    assert.ok(Buffer.from(got.data).equals(pdfBytes(999)), "serialized container holds stale bytes");

    // Walk the local headers and check every CRC against the bytes actually stored beside it.
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let checked = 0;
    for (let i = 0; i + 30 < bytes.length; i++) {
      if (dv.getUint32(i, true) !== 0x04034b50) continue;
      const nameLen = dv.getUint16(i + 26, true), extraLen = dv.getUint16(i + 28, true);
      const size = dv.getUint32(i + 22, true);
      const start = i + 30 + nameLen + extraLen;
      if (start + size > bytes.length) continue;
      assert.strictEqual(dv.getUint32(i + 14, true), realCrc32(bytes.subarray(start, start + size)),
        "local-header CRC does not match the bytes stored beside it");
      checked++;
    }
    assert.ok(checked > N, "expected to verify every entry's CRC, only saw " + checked);
  }

  /* 5. A pruned file drops out of the memo with its Blob — retention must not leak CRCs. */
  {
    const tab = await station();
    await fill(tab, N);
    await tab._serializeZip();
    const res = await tab.pruneFilesBefore("2026-07-05");
    assert.ok(res.files > 0, "expected the retention prune to remove files");
    const cost = await costOf(() => tab._serializeZip());
    assert.strictEqual(cost.bytes, 0, "committing after a prune must not re-read the survivors");
  }

  console.log("crmdb commit cost: an unchanged file is never re-read or re-CRC'd — a commit now costs the delta, not the database — passed");
}

run().catch((e) => { console.error(e); process.exit(1); });
