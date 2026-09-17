/* The working copy must survive an app restart on WebKit, whose IndexedDB stores slices wrongly.
 *
 * WebKit gets two things wrong, and the zero-copy container runs into both:
 *   1. It writes a Blob into IndexedDB one backing part at a time, each part WHOLE: a slice() goes
 *      to disk as the entire buffer or file it was cut from, while the record keeps the size it was
 *      given. Reads in the same process come from the original Blob and look right; after a restart
 *      they come from disk. Every container this store commits is built from slices, so relaunching
 *      the iPad app read the working copy back as "crmdb: corrupt central directory" and the
 *      Schedule opened as "Database is closed".
 *   2. A Blob read back after a restart is backed by the record's file, and overwriting or deleting
 *      the record deletes that file while the Blob is still in use: every later read of it fails
 *      with NotFoundError. A bundle sliced from the working copy loses its unchanged entries at the
 *      next commit.
 * Both measured in the iOS 18.0 Simulator; see "WebKit's IndexedDB and Blobs" in
 * src/crmdb-store.js, and docs/crmdb.md.
 *
 * Node's Blob does neither, so this file models WebKit: every Blob records which ranges of which
 * whole buffers it is made of, the fake IndexedDB's restart() replaces each stored Blob with what
 * WebKit's disk holds (every part's whole buffer, reporting the original size), and a restored Blob
 * stops being readable once its record is overwritten or deleted.
 *
 * What must remain true:
 *   • the model reproduces the field failure when the store does not flatten (the control), and a
 *     Chromium commit still copies nothing
 *   • on WebKit, a database opened the way the app opens one reads back intact after a restart
 *   • after that restart, commit after commit and the file write-through still read every entry
 *   • staged edits holding slices replay intact from the journal after a crash and a restart, and
 *     survive the journal row being rewritten
 *   • IndexedDB is handed only whole parts, in bounded groups, never one whole-container read
 *   • a protected database is whole already, is not copied again, and survives a restart too
 *
 * Run with:  node tests/crmdb-webkit-idb-slices.test.js
 */
"use strict";

const assert = require("assert");
const path = require("path");
if (!global.crypto) global.crypto = require("crypto").webcrypto;
global.window = global;
// The app's shim supplies these, so the store takes its bound-file path. canAutosave is computed at
// module load, so they must exist before the first require.
let pickedHandle = null;
global.showOpenFilePicker = () => Promise.resolve([pickedHandle]);
global.showSaveFilePicker = () => Promise.reject(new Error("not used"));
global.URL = { createObjectURL: () => "blob:x", revokeObjectURL() {} };
global.document = {
  hidden: false, addEventListener() {},
  body: { appendChild() {}, removeChild() {} },
  createElement: () => ({ style: {}, click() {}, remove() {}, set href(v) {}, get href() { return ""; } })
};
global.addEventListener = function () {};
// A restart loses sessionStorage, so a protected database must ask for its password again.
global.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };

// The iPad app's WKWebView, and desktop Chrome for the control. The store reads these at load.
const WEBKIT = { vendor: "Apple Computer, Inc.", userAgent: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148" };
const CHROME = { vendor: "Google Inc.", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36" };
function engine(nav) { Object.defineProperty(global, "navigator", { value: nav, configurable: true, writable: true }); }

/* ------------------------------------------------------------ WebKit's Blob, as IndexedDB sees it */
const NativeBlob = global.Blob;
const PARTS = Symbol("parts");
// A part is { buf, start, end }: a range of one whole buffer, where `buf` is a flat Blob of raw
// bytes. A modelled Blob's own bytes are always assembled straight from buffer ranges, so Node never
// has to slice a Blob made of slices (Node 18 returns wrong bytes for that).
let handingOver = null;
function partsOf(list) {
  const out = [];
  for (const p of list) {
    if (p && p[PARTS]) { out.push(...p[PARTS]); continue; }
    const buf = new NativeBlob([p]);
    if (buf.size) out.push({ buf, start: 0, end: buf.size });
  }
  return out;
}
const isWhole = (p) => p.start === 0 && p.end === p.buf.size;
class WebKitBlob extends NativeBlob {
  constructor(list = [], opts) {
    const parts = handingOver || partsOf(Array.from(list));
    handingOver = null;
    super(parts.map((p) => isWhole(p) ? p.buf : p.buf.slice(p.start, p.end)), opts);
    this[PARTS] = parts;
  }
  slice(start, end, type) {
    const size = this.size;
    const clamp = (v, d) => v === undefined ? d : v < 0 ? Math.max(size + v, 0) : Math.min(v, size);
    const s = clamp(start, 0), e = Math.max(s, clamp(end, size)), out = [];
    let at = 0;
    for (const p of this[PARTS]) {
      const len = p.end - p.start, from = Math.max(s, at), to = Math.min(e, at + len);
      if (from < to) out.push({ buf: p.buf, start: p.start + from - at, end: p.start + to - at });
      at += len;
    }
    handingOver = out;
    return new WebKitBlob([], { type });
  }
}
global.Blob = WebKitBlob;

// Meter what the store reads. A regression to one arrayBuffer() of the whole container would show
// up here as a read the size of the container.
const realArrayBuffer = NativeBlob.prototype.arrayBuffer;
const { ReadableStream } = require("stream/web");
const realText = NativeBlob.prototype.text;
let reads = [], streamed = [];
// Buffers whose IndexedDB record has since been overwritten or deleted: WebKit has deleted the file.
const deletedFiles = new WeakSet();
function gone(blob) {
  if (!blob[PARTS].some((p) => deletedFiles.has(p.buf))) return null;
  const e = new Error("The object can not be found here."); e.name = "NotFoundError";
  return Promise.reject(e);
}
WebKitBlob.prototype.arrayBuffer = function () { reads.push(this.size); return gone(this) || realArrayBuffer.call(this); };
WebKitBlob.prototype.text = function () { return gone(this) || realText.call(this); };
// Chunked, like WebKit's. Node 18's own stream() starts with one arrayBuffer() of the whole Blob,
// which is not what the store's copy costs on the engine it runs on.
WebKitBlob.prototype.stream = function () {
  streamed.push(this);
  const blob = this;
  let at = 0;
  return new ReadableStream({
    async pull(controller) {
      if (at >= blob.size) { controller.close(); return; }
      const end = Math.min(blob.size, at + 65536);
      await gone(blob);
      controller.enqueue(new Uint8Array(await realArrayBuffer.call(blob.slice(at, end))));
      at = end;
    }
  });
};
// Unmetered, but honest about a deleted file.
const bytesOf = async (blob) => { await gone(blob); return Buffer.from(await realArrayBuffer.call(blob)); };

/* ------------------------------------------------------- IndexedDB, with a process restart */
function installIndexedDB() {
  const kv = new Map(), onDisk = new Map(), files = new Map();   // key -> restored buffers it owns
  function replaced(k) { (files.get(k) || []).forEach((buf) => deletedFiles.add(buf)); files.delete(k); }
  function makeTx() {
    const ops = [];
    const tx = { oncomplete: null, onerror: null, onabort: null, error: null, objectStore: () => store };
    const store = {
      get(k) { const rq = {}; ops.push(() => { rq.result = kv.get(k); if (rq.onsuccess) rq.onsuccess(); }); return rq; },
      put(v, k) { const rq = {}; ops.push(() => { replaced(k); kv.set(k, v); if (rq.onsuccess) rq.onsuccess(); }); return rq; },
      delete(k) { const rq = {}; ops.push(() => { replaced(k); kv.delete(k); if (rq.onsuccess) rq.onsuccess(); }); return rq; }
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
        req.result = { objectStoreNames: { contains: () => true }, createObjectStore: () => ({}), transaction: makeTx, close() {} };
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    }
  };
  // What a stored Blob becomes once the process that wrote it is gone: every part's WHOLE buffer,
  // end to end, still reporting the size it was stored with.
  async function fromDisk(key, owner, blob) {
    const parts = blob[PARTS] || [{ buf: blob, start: 0, end: blob.size }];
    const disk = new Uint8Array(await realArrayBuffer.call(new NativeBlob(parts.map((p) => p.buf))));
    onDisk.set(key, disk.length);
    const out = new WebKitBlob([disk]), recorded = blob.size;
    files.set(owner, (files.get(owner) || []).concat(out[PARTS][0].buf));
    if (disk.length !== recorded) Object.defineProperty(out, "size", { get: () => recorded });
    return out;
  }
  async function reload(key, owner, v) {
    if (v instanceof NativeBlob) return fromDisk(key, owner, v);
    if (v && Object.getPrototypeOf(v) === Object.prototype) {
      const o = {};
      for (const [k, x] of Object.entries(v)) o[k] = await reload(key + "." + k, owner, x);
      return o;
    }
    return v;
  }
  return {
    get: (k) => kv.get(k),
    wipe: () => { kv.clear(); onDisk.clear(); files.clear(); },
    diskBytes: (k) => onDisk.get(k),
    async restart() { files.clear(); for (const [k, v] of [...kv]) kv.set(k, await reload(k, k, v)); }
  };
}
const shared = installIndexedDB();

const CRMDB = require("../site/vendor/crmdb-zip.js");
const STORE = path.resolve(__dirname, "../site/src/crmdb-store.js");
const tabs = [];
function newTab() { delete require.cache[STORE]; delete global.CRMWorkspace; const t = require(STORE); tabs.push(t); return t; }
const settle = () => new Promise((r) => setTimeout(r, 0));
const paused = () => new Promise((r) => setTimeout(r, 400));   // past the journal's 250ms debounce
// Retire every instance (forget() cancels its timers), wipe IndexedDB, and load the store as `nav`.
async function fresh(nav) {
  while (tabs.length) { const t = tabs.pop(); try { await t.forget(); } catch (e) {} }
  await settle();
  shared.wipe();
  engine(nav);
  return newTab();
}

/* ------------------------------------------------------------- a synthetic database */
const DATE = "2026-09-16", ALPHA = "0800_TESTPATIENTALPHA", BRAVO = "0900_SAMPLEBRAVO";
function noise(n, seed) {
  const u = new Uint8Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; u[i] = s & 255; }
  return u;
}
const te = new TextEncoder();
const FILES = {
  "schedule.json": te.encode(JSON.stringify({ type: "patient-schedule", version: 1, dates: { [DATE]: [
    { time: "08:00", patient: "Testpatient, Alpha" }, { time: "09:00", patient: "Sample, Bravo" }] } })),
  [`patients/${DATE}/${ALPHA}/report.json`]: te.encode(JSON.stringify({ finding: "synthetic" })),
  [`patients/${DATE}/${ALPHA}/report.pdf`]: noise(180000, 11),
  // Big enough that the copy for IndexedDB has to come in more than one group.
  [`patients/${DATE}/${ALPHA}/PROG_EXPORT.pdf`]: noise(9 * 1024 * 1024, 12),
  [`patients/${DATE}/${BRAVO}/report.json`]: te.encode(JSON.stringify({ finding: "synthetic too" })),
  [`patients/${DATE}/${BRAVO}/report.pdf`]: noise(240000, 13)
};
// The .crmdb on disk, and a handle that serves it the way crm-native-shim's does: getFile() is one
// whole Blob (fetch().blob() wrapped in a File) carrying the file's real mtime.
async function containerBytes(files) {
  return new Uint8Array(await realArrayBuffer.call(CRMDB.write(Object.entries(files).map(([name, data]) => ({ name, data })))));
}
function appFileHandle(bytes) {
  const h = {
    kind: "file", name: "schedule.crmdb", bytes, mtime: 1789000000000,
    getFile() { const f = new WebKitBlob([h.bytes]); f.name = h.name; f.lastModified = h.mtime; return Promise.resolve(f); },
    createWritable() {
      const chunks = [];
      return Promise.resolve({
        write(d) { chunks.push(d); return Promise.resolve(); },
        async close() { h.bytes = new Uint8Array(await realArrayBuffer.call(new WebKitBlob(chunks))); h.mtime += 1000; }
      });
    },
    queryPermission: () => Promise.resolve("granted"),
    requestPermission: () => Promise.resolve("granted")
  };
  return h;
}
async function assertIntact(tab, files, label) {
  assert.deepStrictEqual([...tab._bundle.keys()].sort(), Object.keys(files).sort(), label + ": the same paths");
  for (const [name, bytes] of Object.entries(files)) {
    assert.ok((await bytesOf(tab._bundle.get(name))).equals(Buffer.from(bytes)), label + ": " + name + " byte-for-byte");
  }
}
// A restart, as far as the store can tell: IndexedDB now reads from disk, and a new page loads.
async function relaunch() { await shared.restart(); return newTab(); }

async function run() {
  const bytes = await containerBytes(FILES);

  /* 1. The control. Chromium stores slices correctly, so the store must not pay to copy there.
   *    Under WebKit's IndexedDB, that same unflattened container is the field failure. */
  {
    const tab = await fresh(CHROME);
    pickedHandle = appFileHandle(bytes);
    await tab.connect();
    const stored = shared.get("bundle");
    assert.ok(stored[PARTS].some((p) => !isWhole(p)), "control: the committed container is made of slices");

    const dir = { prefix: `patients/${DATE}/${BRAVO}/` };
    await tab.writeFile(dir, "report.json", JSON.stringify({ finding: "edited" }), { defer: true });
    reads = []; streamed = [];
    await tab.flush();
    await tab._fileIdle();
    const readThisCommit = reads.reduce((a, b) => a + b, 0);
    assert.strictEqual(streamed.length, 0, "Chromium: a commit must not copy the container for IndexedDB");
    // The edited entry's CRC, plus the file write-through signing the central directory: kilobytes.
    assert.ok(readThisCommit < 64 * 1024, "Chromium: a commit reads kilobytes, not " + readThisCommit + " bytes");

    const next = await relaunch();
    assert.strictEqual(await next.stored(), null, "control: the unflattened working copy cannot be reopened");
    assert.match(String(next.lastOpenError()), /corrupt central directory/,
      "control: the model reproduces the error the iPad app reported");
    assert.ok(shared.diskBytes("bundle") > shared.get("bundle").size,
      "control: WebKit wrote more bytes than the record says it holds");
  }

  /* 2. THE POINT: on WebKit, open the database the way the app does, relaunch, and it reopens. */
  let relaunched;
  {
    const tab = await fresh(WEBKIT);
    pickedHandle = appFileHandle(bytes);
    reads = []; streamed = [];
    await tab.connect();
    const stored = shared.get("bundle");
    assert.ok(stored[PARTS].every(isWhole), "IndexedDB must be handed only whole parts");
    assert.ok(streamed.length > 0, "the copy is streamed");
    assert.ok(Math.max(...reads) < stored.size, "no single read of the whole container while flattening it");
    assert.ok(stored[PARTS].length > 1 && Math.max(...stored[PARTS].map((p) => p.end - p.start)) < stored.size,
      "the copy is built from bounded groups, not one database-sized buffer");

    relaunched = await relaunch();
    assert.ok(await relaunched.stored(), "after a relaunch the working copy reopens");
    assert.strictEqual(relaunched.lastOpenError(), null);
    assert.strictEqual(shared.diskBytes("bundle"), shared.get("bundle").size, "WebKit wrote exactly the container");
    await assertIntact(relaunched, FILES, "after a relaunch");
  }

  /* 3. The steady state after a relaunch, where each commit replaces the record the page loaded from.
   *    Commit after commit, and the write-through to the .crmdb that follows each, must still read
   *    every entry, and what they publish must survive the next relaunch. */
  let third;
  const edited = Object.assign({}, FILES, {
    [`patients/${DATE}/${ALPHA}/report.json`]: te.encode(JSON.stringify({ finding: "edited after relaunch" })),
    [`patients/${DATE}/${BRAVO}/report.json`]: te.encode(JSON.stringify({ finding: "edited again" }))
  });
  {
    await relaunched.verifyFreshness();            // what the page does on load, before any save
    await relaunched.writeFile({ prefix: `patients/${DATE}/${ALPHA}/` }, "report.json",
      JSON.stringify({ finding: "edited after relaunch" }), { defer: true });
    await relaunched.flush();
    await relaunched._fileIdle();
    assert.ok(shared.get("bundle")[PARTS].every(isWhole), "a commit after a relaunch hands IndexedDB whole parts too");
    assert.strictEqual(relaunched.saveState.state, "file", "the first commit after a relaunch reaches the file: " + relaunched.saveState.detail);

    await relaunched.writeFile({ prefix: `patients/${DATE}/${BRAVO}/` }, "report.json",
      JSON.stringify({ finding: "edited again" }), { defer: true });
    await relaunched.flush();
    await relaunched._fileIdle();
    assert.strictEqual(relaunched.saveState.state, "file", "so does the second: " + relaunched.saveState.detail);
    await assertIntact(relaunched, edited, "two commits after a relaunch");
    const onFile = await CRMDB.read(pickedHandle.bytes);
    assert.deepStrictEqual(onFile.map((e) => e.name).filter((n) => n !== "manifest.json").sort(), Object.keys(edited).sort(),
      "the .crmdb itself holds every entry");
    for (const e of onFile) {
      if (e.name !== "manifest.json") assert.ok(Buffer.from(e.data).equals(Buffer.from(edited[e.name])), "on the .crmdb: " + e.name);
    }

    third = await relaunch();
    assert.ok(await third.stored(), "a commit made after a relaunch survives the next one");
    assert.strictEqual(third.lastOpenError(), null);
    await assertIntact(third, edited, "second relaunch");
  }

  /* 4. The journal. Staged edits can hold slices: moveSlot re-keys an entry the container handed out,
   *    which is what this stages (moveSlot itself also schedules a commit, and a crash test needs
   *    one that never happens). A crash and a relaunch must replay them intact. */
  {
    const moved = `patients/${DATE}/0930_SAMPLEBRAVO/report.pdf`;
    const slice = third._bundle.get(`patients/${DATE}/${BRAVO}/report.pdf`);
    await third.writeFile({ prefix: `patients/${DATE}/0930_SAMPLEBRAVO/` }, "report.pdf", slice, { defer: true });
    await third.writeFile({ prefix: `patients/${DATE}/${BRAVO}/` }, "report.txt", "staged, never committed", { defer: true });
    await paused();
    assert.ok(shared.get("journal"), "the staged edits were journalled");
    assert.ok(shared.get("journal").blob[PARTS].every(isWhole), "the journal row is whole parts too");

    const next = await relaunch();                  // `third` never commits: that is the crash
    assert.ok(await next.stored());
    assert.strictEqual(next.lastOpenError(), null);
    const replayed = Object.assign({}, edited, {
      [moved]: FILES[`patients/${DATE}/${BRAVO}/report.pdf`],
      [`patients/${DATE}/${BRAVO}/report.txt`]: te.encode("staged, never committed")
    });
    await assertIntact(next, replayed, "journal replay after a relaunch");

    // The next pause rewrites the journal row the replay came from, and the commit after it deletes
    // the row. The replayed edits must outlive both.
    await next.writeFile({ prefix: `patients/${DATE}/${ALPHA}/` }, "report.txt", "one more", { defer: true });
    await paused();
    const later = Object.assign({}, replayed, { [`patients/${DATE}/${ALPHA}/report.txt`]: te.encode("one more") });
    await assertIntact(next, later, "replayed edits after the journal row is rewritten");
    await next.flush();
    await assertIntact(next, later, "replayed edits after they are committed");
    assert.ok(await (await relaunch()).stored(), "and the result reopens");
  }

  /* 5. A protected database. Its container and journal are sealed envelopes built from whole
   *    buffers, so copying them again would buy nothing, and a relaunch must still open it. */
  {
    const password = "synthetic test password";
    const tab = await fresh(WEBKIT);
    tab.onPasswordRequest = () => password;
    pickedHandle = appFileHandle(bytes);
    await tab.connect();
    streamed = [];
    await tab.enableProtection(password);
    await tab._fileIdle();
    for (const b of streamed) {
      const head = Buffer.from(await realArrayBuffer.call(b.slice(0, 8))).toString("latin1");
      assert.notStrictEqual(head, "CRMDBENC", "a sealed container is not copied a second time");
    }
    assert.ok(shared.get("bundle")[PARTS].every(isWhole));

    const next = await relaunch();
    next.onPasswordRequest = () => password;
    assert.ok(await next.stored(), "a protected working copy reopens after a relaunch");
    assert.strictEqual(next.lastOpenError(), null);
    assert.ok(next.isEncrypted());
    await assertIntact(next, FILES, "protected, after a relaunch");
  }

  while (tabs.length) { const t = tabs.pop(); try { await t.forget(); } catch (e) {} }
  console.log("crmdb-webkit-idb-slices: all assertions passed");
}

run().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
