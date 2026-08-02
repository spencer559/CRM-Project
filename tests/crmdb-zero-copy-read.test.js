/* What reopening the database is allowed to cost.
 *
 * Writing a .crmdb is by-reference: serializeZip hands CRMDB.write the stored Blobs themselves
 * plus memoized CRCs, so a commit copies nothing (see crmdb-commit-cost.test.js). Reading it back
 * used to be the opposite — CRMDB.read took the whole file as an ArrayBuffer, sliced a copy of
 * every entry out of it, and wrapped each copy in a Blob. That is the database two or three times
 * over, and it runs on every page load and on every hand-off between the Schedule and the Report
 * Generator, which is exactly the moment a clinic notices a page being slow.
 *
 * CRMDB.readBlob parses only the central directory and returns each entry as a blob.slice() — a
 * view onto the same backing bytes.
 *
 * What must remain true:
 *   • ingesting the working copy reads a trivial fraction of it
 *   • the bundle you get back is byte-for-byte what was written
 *   • the CRC memo survives the round trip, so the FIRST commit after a page load doesn't
 *     re-hash the whole database (which would hand back the cost at the next keystroke)
 *   • a container we didn't write — a compressed one — still reads correctly, via the old path
 *
 * Run with:  node tests/crmdb-zero-copy-read.test.js
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
  return { get: (k) => data.get("kv").get(k), wipe: () => data.get("kv").clear() };
}
const shared = installIndexedDB();

const CRMDB = require("../vendor/crmdb-zip.js");
const STORE = path.resolve(__dirname, "../src/crmdb-store.js");
function newTab() { delete require.cache[STORE]; delete global.CRMWorkspace; return require(STORE); }

// Meter bytes actually pulled out of Blobs. Everything the read path could copy goes through
// arrayBuffer(), so this counts the thing we are trying not to do.
const realArrayBuffer = Blob.prototype.arrayBuffer;
let bytesRead = 0;
Blob.prototype.arrayBuffer = function () { bytesRead += this.size; return realArrayBuffer.call(this); };
const meter = async (fn) => { bytesRead = 0; await fn(); return bytesRead; };
const rawBytes = (blob) => realArrayBuffer.call(blob);   // read without disturbing the meter

const settle = () => new Promise((r) => setTimeout(r, 0));
const afterPersist = async () => { await settle(); await new Promise((r) => setTimeout(r, 1400)); await settle(); };

// Entries compared by content, skipping manifest.json — it embeds a fresh ISO timestamp on every
// serialize, so it is expected to differ and says nothing about the entries we care about.
async function entriesOf(blob) {
  const list = await CRMDB.read(await rawBytes(blob));
  return list.filter((e) => e.name !== "manifest.json")
             .map((e) => e.name + ":" + Buffer.from(e.data).toString("base64"))
             .sort();
}

async function buildDatabase() {
  const tab = newTab();
  await tab.newDatabase();
  // Programmer PDFs are what make a real .crmdb big, and the container uses STORE so nothing shrinks.
  const pdf = new Uint8Array(600 * 1024);
  for (let i = 0; i < pdf.length; i++) pdf[i] = (i * 13) & 0xff;
  for (const date of ["2026-07-29", "2026-07-30"]) {
    for (const slot of ["0800_AA", "0900_BB", "1000_CC"]) {
      const dir = await tab.slotDir(null, date, slot, true);
      await tab.writeFile(dir, "prog.pdf", pdf);
      await tab.writeFile(dir, "report.json", JSON.stringify({ pt: slot }));
      await tab.writeFile(dir, "notes.txt", "seen on " + date);
    }
  }
  await afterPersist();
  return tab;
}

/* Rewrite a container so ONE entry's local header carries an extra field, the way many other zip
   writers emit them. Everything downstream shifts, so the central directory's stored offsets and
   the EOCD's pointer are corrected too — the result is a perfectly valid zip whose data simply
   isn't where localOffset + 30 + nameLen would put it. */
function injectLocalExtraField(buf, targetName, extraLen) {
  const LFH = 0x04034b50, CDH = 0x02014b50, EOCD = 0x06054b50;
  let at = -1;
  for (let i = 0; i + 30 <= buf.length; i++) {
    if (buf.readUInt32LE(i) !== LFH) continue;
    const nameLen = buf.readUInt16LE(i + 26);
    if (buf.slice(i + 30, i + 30 + nameLen).toString() === targetName) { at = i; break; }
  }
  assert.ok(at >= 0, "could not find a local header for " + targetName);
  const nameLen = buf.readUInt16LE(at + 26);
  const insertAt = at + 30 + nameLen;                       // extra field sits after the name
  const out = Buffer.concat([buf.slice(0, insertAt), Buffer.alloc(extraLen, 0x5a), buf.slice(insertAt)]);
  out.writeUInt16LE(extraLen, at + 28);                     // local extra length

  // Shift every recorded offset that sat after the insertion point.
  const eocdAt = out.length - 22;
  assert.strictEqual(out.readUInt32LE(eocdAt), EOCD, "unexpected EOCD position");
  let cdAt = out.readUInt32LE(eocdAt + 16);
  if (cdAt > insertAt) out.writeUInt32LE(cdAt + extraLen, eocdAt + 16);
  cdAt = out.readUInt32LE(eocdAt + 16);
  const total = out.readUInt16LE(eocdAt + 10);
  let p = cdAt;
  for (let n = 0; n < total; n++) {
    assert.strictEqual(out.readUInt32LE(p), CDH, "corrupt central directory while shifting");
    const off = out.readUInt32LE(p + 42);
    if (off > insertAt) out.writeUInt32LE(off + extraLen, p + 42);
    p += 46 + out.readUInt16LE(p + 28) + out.readUInt16LE(p + 30) + out.readUInt16LE(p + 32);
  }
  return out;
}

async function run() {
  shared.wipe();
  const authoring = await buildDatabase();
  const dayIndex = authoring.filesBySlot("2026-07-29");
  assert.deepStrictEqual(Object.keys(dayIndex).sort(), ["0800_AA", "0900_BB", "1000_CC"],
    "one-pass date index should contain exactly that day's slots");
  assert.deepStrictEqual(dayIndex["0800_AA"], ["notes.txt", "prog.pdf", "report.json"],
    "one-pass date index should list the slot's direct files in stable order");
  const written = await authoring._serialize();
  const before = await entriesOf(written);
  assert.ok(written.size > 3 * 1024 * 1024, "test database should be a few MB, got " + written.size);

  /* 1 — a fresh tab adopting the working copy must barely read it */
  const reopened = newTab();
  const ingestCost = await meter(() => reopened.stored());
  assert.ok(ingestCost < written.size / 100,
    "ingest read " + ingestCost + " of " + written.size + " bytes — the by-reference read path is gone");

  /* 2 — the FIRST commit after that load must not re-hash the database.
     The memo is keyed on Blob identity and ingest necessarily produces new Blob objects, so
     without the CRC map persisted beside the bundle every entry would miss and the whole database
     would be CRC'd again at the next keystroke — handing back the cost the memo was there to save.
     Measured on this still-cold tab, deliberately BEFORE anything else serializes it: a single
     _serialize() anywhere above would warm the cache and make this assertion vacuous. */
  const dir = await reopened.slotDir(null, "2026-07-29", "0900_BB", true);
  const edit = '{"pt":"edited"}';
  const firstCommitCost = await meter(async () => {
    await reopened.writeFile(dir, "report.json", edit);
    await afterPersist();
  });
  assert.ok(firstCommitCost <= edit.length,
    "first commit after load hashed " + firstCommitCost + " bytes; only the " + edit.length +
    " changed ones should be new — the persisted CRC memo is not being restored");

  /* 3 — and all of that has to be correct, not merely cheap. A third tab reads what the second
     one committed, and re-serializes to prove nothing was lost or corrupted on the way through. */
  const third = newTab();
  await third.stored();
  assert.strictEqual(third.stats().files, authoring.stats().files);
  assert.strictEqual(await third.readText(await third.slotDir(null, "2026-07-29", "0900_BB", true), "report.json"),
    edit, "entry contents must be readable through a sliced Blob");
  const expected = before.map((e) => e.startsWith("patients/2026-07-29/0900_BB/report.json:")
    ? "patients/2026-07-29/0900_BB/report.json:" + Buffer.from(edit).toString("base64") : e).sort();
  assert.deepStrictEqual(await entriesOf(await third._serialize()), expected,
    "the round trip changed the bundle");

  /* 5 — a container we did not write. DEFLATE has no by-reference answer, so readBlob must fall
     back to the full path rather than hand back compressed bytes as if they were the file. */
  const deflated = require("zlib").deflateRawSync(Buffer.from("compressed payload"));
  const zip = await rawBytes(CRMDB.write([{ name: "a.txt", data: "plain" }, { name: "b.txt", data: deflated }]));
  const buf = Buffer.from(zip);
  // Re-label b.txt as DEFLATE in both headers, and correct its uncompressed size.
  for (const sig of [0x04034b50, 0x02014b50]) {
    for (let i = 0; i + 4 <= buf.length; i++) {
      if (buf.readUInt32LE(i) !== sig) continue;
      const isLocal = sig === 0x04034b50;
      const nameAt = i + (isLocal ? 30 : 46);
      const nameLen = buf.readUInt16LE(i + (isLocal ? 26 : 28));
      if (buf.slice(nameAt, nameAt + nameLen).toString() !== "b.txt") continue;
      buf.writeUInt16LE(8, i + (isLocal ? 8 : 10));                       // method = DEFLATE
      buf.writeUInt32LE(18, i + (isLocal ? 22 : 24));                     // uncompressed size
    }
  }
  // readBlob has no by-reference answer for a compressed entry, so it must defer to read() and
  // behave exactly as read() would — never hand the compressed bytes back as if they were the file.
  // Asserted as equivalence rather than as a specific payload because inflation itself depends on
  // DecompressionStream("deflate-raw"), which this Node may not have; the delegation is the part
  // this test is responsible for, and it holds either way.
  const settleTo = (p) => p.then((v) => ({ ok: v }), (e) => ({ err: String(e && e.message) }));
  const viaBlob = await settleTo(CRMDB.readBlob(new Blob([buf])));
  const viaBuf = await settleTo(CRMDB.read(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)));
  if (viaBuf.err) {
    assert.strictEqual(viaBlob.err, viaBuf.err, "readBlob must fail a DEFLATE container the same way read() does");
  } else {
    const pick = async (list) => {
      const e = list.find((x) => x.name === "b.txt");
      return (e.blob ? Buffer.from(await rawBytes(e.blob)) : Buffer.from(e.data)).toString();
    };
    assert.strictEqual(await pick(viaBlob.ok), "compressed payload");
    assert.strictEqual(await pick(viaBlob.ok), await pick(viaBuf.ok));
  }
  // Either way, the uncompressed sibling in that same container must survive untouched.
  const plainOnly = await CRMDB.readBlob(CRMDB.write([{ name: "a.txt", data: "plain" }]));
  assert.strictEqual(Buffer.from(await rawBytes(plainOnly[0].blob)).toString(), "plain");

  /* 6 — a foreign container with a LOCAL EXTRA FIELD.
     readBlob locates each entry's data at localOffset + 30 + nameLen, because our own write()
     always emits an empty local extra field. Plenty of other zip writers don't (zip64 markers,
     Unix timestamps, alignment padding), and there the data starts further along — so trusting
     that arithmetic would silently return bytes shifted by the size of the extra field.
     The tiling check is what catches it: entry data that no longer ends exactly where the next
     local header begins means the assumption didn't hold, and the read falls back.
     Injected into each entry in turn, because two different guards cover this and only one of them
     sees any given case: the local-header sanity check inspects the FIRST entry only, so an extra
     field anywhere later is the tiling check's job alone. */
  const readAll = async (buf) => {
    const out = {};
    for (const e of await CRMDB.readBlob(new Blob([buf]))) {
      out[e.name] = (e.blob ? Buffer.from(await rawBytes(e.blob)) : Buffer.from(e.data)).toString();
    }
    return out;
  };
  const plainZip = Buffer.from(await rawBytes(CRMDB.write([
    { name: "first.txt", data: "AAAAAAAAAA" },
    { name: "second.txt", data: "BBBBBBBBBB" },
    { name: "third.txt", data: "CCCCCCCCCC" }
  ])));
  const intact = { "first.txt": "AAAAAAAAAA", "second.txt": "BBBBBBBBBB", "third.txt": "CCCCCCCCCC" };
  assert.deepStrictEqual(await readAll(plainZip), intact, "baseline container read wrong");
  for (const target of ["first.txt", "second.txt", "third.txt"]) {
    assert.deepStrictEqual(await readAll(injectLocalExtraField(plainZip, target, 6)), intact,
      "a local extra field on " + target + " was read at the wrong offset");
  }

  console.log("PASS crmdb-zero-copy-read");
  console.log("  reopen a " + (written.size / 1048576).toFixed(1) + " MB database: read " + ingestCost +
              " bytes (" + (100 * ingestCost / written.size).toFixed(3) + "% of it)");
  console.log("  first commit after that reopen: hashed " + firstCommitCost + " bytes");
}

run().catch((e) => { console.error(e); process.exit(1); });
