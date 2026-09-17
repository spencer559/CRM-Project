/* Saving when iOS puts the app in the background.
 *
 * Leaving the app is how most edits end on a phone — locking it, a call, switching apps — and iOS
 * suspends a backgrounded app within seconds. The page's own tab-hide save was getting frozen
 * part-way: the edits survived in the app's storage and replayed on the next launch, but the .crmdb
 * on the stick or in OneDrive didn't have them until then (iPad_APP/README.md, known gap 1).
 *
 * WebViewController asks iOS for time and calls CRMNative.flushForBackground(). What's pinned here
 * is the JavaScript half:
 *   • the page's own pending work runs BEFORE the database is written out, and is awaited
 *   • the store's persistNow waits for the file itself, not just for the commit
 *   • with no bound file it reports nothing written, and never reaches for the share sheet —
 *     nothing can answer a dialog in the background
 *   • it never rejects, whatever fails: the app would hold its background assertion until iOS
 *     killed it
 *
 * Run with:  node tests/crmdb-background-flush.test.js
 */
"use strict";

const assert = require("assert");
const path = require("path");
if (!global.crypto) global.crypto = require("crypto").webcrypto;
global.window = global;
Object.defineProperty(global, "navigator", { value: {}, configurable: true, writable: true });
global.URL = { createObjectURL: () => "blob:x", revokeObjectURL() {} };
global.document = {
  body: { appendChild() {}, removeChild() {} },
  createElement: () => ({ style: {}, click() {}, remove() {}, set href(v) {}, get href() { return ""; } }),
  addEventListener() {}
};
// The pickers exist, so the store takes its desktop path: a bound handle, autosaved in place. This
// is the path the app runs, with the shim's native handles standing in for real ones.
global.showOpenFilePicker = function () {};
global.showSaveFilePicker = function () {};

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
  return { set: (k, v) => data.get("kv").set(k, v), wipe: () => data.get("kv").clear() };
}
const shared = installIndexedDB();

require("../site/vendor/crmdb-zip.js");
const STORE = path.resolve(__dirname, "../site/src/crmdb-store.js");
function newTab() { delete require.cache[STORE]; delete global.CRMWorkspace; return require(STORE); }

// The .crmdb on the stick. `slowWrite` models OneDrive taking its time, which is the case the
// background save exists for: the write must still be awaited.
function makeHandle() {
  const h = {
    writes: 0, slowWrite: 0, failWrite: false, _bytes: new Uint8Array(0), _mtime: 1000,
    getFile() {
      return Promise.resolve({
        lastModified: h._mtime,
        arrayBuffer: () => Promise.resolve(h._bytes.buffer.slice(h._bytes.byteOffset, h._bytes.byteOffset + h._bytes.byteLength))
      });
    },
    createWritable() {
      if (h.failWrite) return Promise.reject(new Error("the file is busy"));
      const chunks = [];
      return Promise.resolve({
        write(d) { chunks.push(d); return Promise.resolve(); },
        async close() {
          if (h.slowWrite) await new Promise((r) => setTimeout(r, h.slowWrite));
          h._bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
          h._mtime += 1000; h.writes++;
        }
      });
    },
    queryPermission: () => Promise.resolve("granted"),
    requestPermission: () => Promise.resolve("granted")
  };
  return h;
}

const ROOT = { prefix: "" };

// A station with the database open and its metadata pinned to the real file, the way a working
// one's is (same shape as tests/crmdb-selfwrite.test.js).
async function openStation(handle) {
  shared.wipe();
  const s = newTab();
  s._bundle.clear();
  s._bundle.set("schedule.json", new Blob([JSON.stringify({ dates: {} })]));
  handle._bytes = new Uint8Array(await (await s._serialize()).arrayBuffer());
  shared.set("fileHandle", handle);
  s._setFileHandleForTest(handle);
  s._markAuthoritativeForTest();
  await s.verifyFreshness();
  return s;
}

/* ---- persistNow: awaited all the way to the file ---- */

(async () => {
  const handle = makeHandle();
  const s = await openStation(handle);
  await s.saveNow();                       // a first save, so the file holds a real container
  const writesAfterOpen = handle.writes;

  // A staged edit, exactly as the report generator's live sync leaves one: in the bundle, not yet
  // published, and with a slow file behind it.
  handle.slowWrite = 30;
  await s.writeFile(ROOT, "patients/2026-09-17/0830_X/report.json", '{"pt":"staged"}', { defer: true });
  assert.strictEqual(handle.writes, writesAfterOpen, "a staged write costs no file write of its own");

  const written = await s.persistNow();
  assert.strictEqual(written, true, "persistNow reports the file was written");
  assert.ok(handle.writes > writesAfterOpen, "the staged edit reached the file");
  // The file, not just the working copy, must contain it: this is the whole point on a phone.
  const onDisk = await CRMDB.read(handle._bytes.buffer.slice(handle._bytes.byteOffset, handle._bytes.byteOffset + handle._bytes.byteLength));
  const names = onDisk.map((e) => e.name);
  assert.ok(names.some((n) => n.indexOf("report.json") !== -1),
    "the staged patient file is in the container on disk: " + names.join(", "));

  // Nothing staged: it still resolves rather than hanging, and doesn't rewrite the file.
  const before = handle.writes;
  assert.strictEqual(await s.persistNow(), false, "with nothing staged there is nothing to write");
  assert.strictEqual(handle.writes, before, "and the file is left alone");

  /* ---- no bound file: report it, don't reach for the share sheet ---- */

  const shares = [];
  global.navigator.canShare = () => { shares.push("canShare"); return true; };
  global.navigator.share = () => { shares.push("share"); return Promise.resolve(); };
  // No pickers at module load is what makes canAutosave false — iPad Safari, or any browser
  // without the File System Access API. The database then lives in the browser copy alone.
  delete global.showOpenFilePicker;
  delete global.showSaveFilePicker;
  const browserOnly = newTab();
  await browserOnly.newDatabase();
  await browserOnly.writeFile(ROOT, "schedule.json", JSON.stringify({ dates: { x: [] } }), { defer: true });
  assert.strictEqual(await browserOnly.persistNow(), false, "nothing was written to a file, and it says so");
  assert.deepStrictEqual(shares, [], "the share sheet needs a gesture — never from the background");
  assert.strictEqual(browserOnly.saveState.state, "browser", "the indicator says the work is in the browser copy");

  /* ---- a failing file write is reported, not thrown ---- */

  // Pickers back, or the next station would have no bound file and pass for the wrong reason.
  global.showOpenFilePicker = function () {};
  global.showSaveFilePicker = function () {};
  const failing = makeHandle();
  const s2 = await openStation(failing);
  await s2.saveNow();
  failing.failWrite = true;
  await s2.writeFile(ROOT, "schedule.json", JSON.stringify({ dates: { y: [] } }), { defer: true });
  assert.strictEqual(await s2.persistNow(), false, "a file that won't open is reported as not written");

  /* ---- the shim's hook: page work first, then the database, and never a rejection ---- */

  const order = [];
  global.webkit = { messageHandlers: { crmNative: { postMessage: () => Promise.resolve({}) } } };
  delete global.CRMNative;
  delete require.cache[path.resolve(__dirname, "../iPad_APP/CRMiPad/crm-native-shim.js")];
  require("../iPad_APP/CRMiPad/crm-native-shim.js");
  const shim = global.CRMNative;
  assert.strictEqual(typeof shim.flushForBackground, "function", "the app has something to call");

  global.CRMWorkspace = {
    persistNow() { order.push("persistNow"); return Promise.resolve(true); }
  };
  global.CRMFlushPending = function () {
    order.push("pending:start");
    return new Promise((res) => setTimeout(() => { order.push("pending:done"); res(); }, 10));
  };
  assert.strictEqual(await shim.flushForBackground(), "wrote the database");
  assert.deepStrictEqual(order, ["pending:start", "pending:done", "persistNow"],
    "the page's own work finishes before the database is written out");

  // The ordinary case on a real exit: the page's own tab-hide handler has already taken the commit,
  // so persistNow only waits for that write to land and reports nothing of its own.
  global.CRMWorkspace = { persistNow: () => Promise.resolve(false) };
  assert.strictEqual(await shim.flushForBackground(), "already current");

  // A page with nothing registered (the PDF viewer) is not an error.
  delete global.CRMFlushPending;
  global.CRMWorkspace = {};
  assert.strictEqual(await shim.flushForBackground(), "already current");

  // Whatever throws, the app gets a string back: a rejection would leave it holding the background
  // assertion until iOS killed it.
  global.CRMFlushPending = function () { throw new Error("form blew up"); };
  assert.match(await shim.flushForBackground(), /^failed: form blew up$/);
  global.CRMFlushPending = () => Promise.reject(new Error("staging failed"));
  assert.match(await shim.flushForBackground(), /^failed: staging failed$/);
  global.CRMFlushPending = null;
  global.CRMWorkspace = { persistNow: () => Promise.reject(new Error("file gone")) };
  assert.match(await shim.flushForBackground(), /^failed: file gone$/);

  console.log("crmdb-background-flush: all assertions passed");
})().catch((e) => { console.error(e); process.exit(1); });
