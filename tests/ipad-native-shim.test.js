/* The iPad app's native file bridge (iPad_APP/CRMiPad/crm-native-shim.js) driving crmdb-store.js.
 *
 * WKWebView has no File System Access API; the app injects showOpenFilePicker/showSaveFilePicker
 * and handles whose bytes are fetched from Swift as binary (writes still cross as base64). With the shim present crmdb-store must take its
 * DESKTOP path — a bound .crmdb autosaved in place — and survive a reload. That last part is the
 * subtle one: a real FileSystemFileHandle structured-clones into IndexedDB, but the shim's handle
 * comes back as plain data and has to be rehydrated, or autosave silently stops after a reload.
 *
 * The native side is faked here as an in-memory disk keyed by bookmark token; its reads are
 * deliberately short so the shim's chunk loop runs, and the database is big enough (> 3 MB) that
 * a save spans several write chunks. It also holds picked folders, so "Download patients" can be run
 * through the page's own writeExportTree and checked to produce real folders instead of a .zip.
 *
 * Run with:  node tests/ipad-native-shim.test.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const nodeCrypto = require("crypto");
if (!global.crypto) global.crypto = nodeCrypto.webcrypto;
if (typeof File === "undefined") global.File = require("buffer").File;
global.window = global;
Object.defineProperty(global, "navigator", { value: {}, configurable: true, writable: true });
global.document = {
  body: { appendChild() {}, removeChild() {} },
  createElement() { return { style: {}, click() {}, remove() {} }; },
  addEventListener() {}
};

/* ---- fake native side (NativeBridge.swift) ---- */
const disk = new Map();      // token -> { name, bytes, mtime, reachable }        (a picked file)
const folders = new Map();   // token -> Map(relative path -> { kind, bytes, mtime, reachable })
function target(token, p) {
  const tree = folders.get(token);
  if (!tree) return disk.get(token);
  const node = tree.get(p || "");
  return node && { ...node, name: (p || "").split("/").pop(), set bytes(b) { node.bytes = b; }, get bytes() { return node.bytes; }, set mtime(t) { node.mtime = t; }, get mtime() { return node.mtime; } };
}
const ops = [];
const sessions = new Map();
let nextPick = null;
let clock = 1_780_000_000_000;
const gone = { error: "Can't reach the database file.", name: "NotFoundError" };
// The read route (BundleSchemeHandler). Reads no longer come back through the message bridge as
// base64: the shim fetches them as binary from the app's own origin, in one streamed response.
let fetchBlocked = false;   // a page CSP without connect-src, or a WebKit that declines the scheme
global.fetch = function (url) {
  ops.push("fetch");
  if (fetchBlocked) return Promise.reject(new TypeError("Load failed"));
  const q = new URL(url).searchParams;
  const f = target(q.get("token"), q.get("path") || "");
  if (!f || !f.reachable) return Promise.resolve({ ok: false, status: 404 });
  return Promise.resolve({ ok: true, status: 200, blob: () => Promise.resolve(new Blob([f.bytes])) });
};
global.webkit = { messageHandlers: { crmNative: { postMessage(msg) {
  ops.push(msg.op);
  const f = target(msg.token, msg.path);
  const r = (() => {
    switch (msg.op) {
      case "pickOpen": return { files: [{ token: nextPick, name: disk.get(nextPick).name }] };
      case "pickSave": {
        const token = "tok-new-" + disk.size;
        disk.set(token, { name: msg.suggestedName, bytes: new Uint8Array(0), mtime: clock, reachable: true });
        return { token, name: msg.suggestedName };
      }
      case "stat": return f && f.reachable ? { name: f.name, size: f.bytes.length, lastModified: f.mtime } : gone;
      case "read":
        if (!f || !f.reachable) return gone;
        return { data: Buffer.from(f.bytes.subarray(msg.offset, msg.offset + Math.min(msg.length, 64 * 1024))).toString("base64") };
      case "pickFolder": return { token: "tok-folder", name: "Exports" };
      case "dirEntry": {
        const tree = folders.get(msg.token);
        const key = msg.path ? msg.path + "/" + msg.name : msg.name;
        const node = tree.get(key);
        if (node) return node.kind === msg.kind ? { name: msg.name } : { error: "Wrong kind.", name: "TypeMismatchError" };
        if (!msg.create) return { error: msg.name + " was not found.", name: "NotFoundError" };
        tree.set(key, { kind: msg.kind, bytes: new Uint8Array(0), mtime: clock, reachable: true });
        return { name: msg.name };
      }
      case "permission": return { state: f && f.reachable ? "granted" : "prompt" };
      case "writeBegin": { const s = "s" + ops.length; sessions.set(s, { token: msg.token, path: msg.path, chunks: [] }); return { session: s }; }
      case "writeChunk": sessions.get(msg.session).chunks.push(Buffer.from(msg.data, "base64")); return {};
      case "writeCommit": {
        const s = sessions.get(msg.session); sessions.delete(msg.session);
        const dest = target(s.token, s.path);
        if (!dest.reachable) return gone;
        dest.bytes = new Uint8Array(Buffer.concat(s.chunks)); dest.mtime = (clock += 2000);
        return { size: dest.bytes.length, lastModified: dest.mtime };
      }
      case "writeAbort": sessions.delete(msg.session); return {};
      case "printPage": case "printPdf": return { completed: true };
      default: return { error: "Unsupported operation.", name: "NotSupportedError" };
    }
  })();
  return Promise.resolve(r);
} } } };

/* In-memory IndexedDB that structured-clones what it stores, as the real one does — this is what
   strips the shim handle's methods. (Node can't clone Blobs; those are kept by reference.) */
function installIndexedDB() {
  const data = new Map([["kv", new Map()]]);
  const clone = (v) => { try { return structuredClone(v); } catch (e) { return v; } };
  function makeTx(storeName) {
    const queue = [];
    const tx = { oncomplete: null, onerror: null, error: null, objectStore: () => store };
    const store = {
      get(k) { const rq = {}; queue.push(() => { rq.result = data.get(storeName).get(k); if (rq.onsuccess) rq.onsuccess(); }); return rq; },
      put(v, k) { const rq = {}; queue.push(() => { data.get(storeName).set(k, clone(v)); if (rq.onsuccess) rq.onsuccess(); }); return rq; },
      delete(k) { const rq = {}; queue.push(() => { data.get(storeName).delete(k); if (rq.onsuccess) rq.onsuccess(); }); return rq; }
    };
    queueMicrotask(() => {
      try { while (queue.length) queue.shift()(); } catch (e) { tx.error = e; if (tx.onerror) tx.onerror(); return; }
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
  return { get: (k) => data.get("kv").get(k) };
}
const idb = installIndexedDB();

require("../iPad_APP/CRMiPad/crm-native-shim.js");
require("../site/vendor/crmdb-zip.js");
const STORE = path.resolve(__dirname, "../site/src/crmdb-store.js");
function newTab() { delete require.cache[STORE]; delete global.CRMWorkspace; return require(STORE); }

const ROOT = { prefix: "" };
const schedOf = async (tab) => JSON.parse(await tab.readText(ROOT, "schedule.json"));
async function scheduleOnDisk(token) {
  const t = newTab();
  await t._ingest(new Blob([disk.get(token).bytes]));
  return JSON.parse(await t.readText(ROOT, "schedule.json"));
}
const count = (op) => ops.filter((o) => o === op).length;

function functionSource(source, name) {
  const start = source.indexOf("function " + name + "(");
  assert.notStrictEqual(start, -1, name + " must exist");
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  assert.fail("Could not find the end of " + name);
}

async function run() {
  assert.strictEqual(newTab().canAutosave, true, "with the shim installed crmdb-store must take the desktop autosave path");

  // A database on "the USB stick": a schedule plus a 3.5 MB patient PDF, so saves span write chunks.
  {
    const t = newTab();
    t._bundle.clear();
    t._bundle.set("schedule.json", new Blob([JSON.stringify({ type: "patient-schedule", version: 1, dates: { "2026-09-10": [{ time: "08:00", pt: "SEED" }] } })]));
    t._bundle.set("patients/2026-09-10/0800_SEED/report.pdf", new Blob([nodeCrypto.randomBytes(3.5 * 1024 * 1024)]));
    disk.set("tok-usb", { name: "schedule.crmdb", bytes: new Uint8Array(await (await t._serialize()).arrayBuffer()), mtime: clock, reachable: true });
  }

  /* 1. Open: the native picker's file is read through the bridge in chunks and ingested. */
  const tab = newTab();
  nextPick = "tok-usb";
  await tab.connect();
  assert.strictEqual((await schedOf(tab)).dates["2026-09-10"][0].pt, "SEED");
  assert.strictEqual(count("fetch"), 1, "the database is read as binary in one streamed response");
  assert.strictEqual(count("read"), 0, "no part of a read crosses the message bridge as base64");

  /* 2. Edit + save: written back to the SAME file in place, across several chunks. */
  ops.length = 0;
  const edited = await schedOf(tab);
  edited.dates["2026-09-10"].push({ time: "09:00", pt: "EDIT-1" });
  await tab.writeFile(ROOT, "schedule.json", new Blob([JSON.stringify(edited)]));
  await tab.saveNow();
  assert.ok(count("writeChunk") >= 2, "a > 3 MB save is sent in several chunks");
  assert.strictEqual(count("writeCommit"), 1);
  assert.strictEqual(count("read") + count("fetch"), 0, "re-reading the file we just wrote is served from the shim's cache");
  assert.deepStrictEqual((await scheduleOnDisk("tok-usb")).dates["2026-09-10"].map((e) => e.pt), ["SEED", "EDIT-1"]);

  /* 3. Reload: IndexedDB hands back plain data; the store must rehydrate it and keep autosaving. */
  const stored = idb.get("fileHandle");
  assert.strictEqual(stored.crmNativeToken, "tok-usb");
  assert.strictEqual(typeof stored.getFile, "undefined", "the fake IndexedDB really does strip methods");
  const reloaded = newTab();
  assert.ok(await reloaded.stored(), "the working copy reopens after a reload");
  await reloaded.reconnect();
  const again = await schedOf(reloaded);
  again.dates["2026-09-10"].push({ time: "10:00", pt: "EDIT-2" });
  await reloaded.writeFile(ROOT, "schedule.json", new Blob([JSON.stringify(again)]));
  await reloaded.saveNow();
  assert.deepStrictEqual((await scheduleOnDisk("tok-usb")).dates["2026-09-10"].map((e) => e.pt), ["SEED", "EDIT-1", "EDIT-2"]);

  /* 4. USB unplugged: reconnect is refused (not a crash), and works again once it's back. */
  disk.get("tok-usb").reachable = false;
  const unplugged = newTab();
  await unplugged.stored();
  await assert.rejects(unplugged.reconnect(), (e) => e.name === "NotAllowedError");
  await assert.rejects(window.CRMNative.rehydrate(stored).getFile(), (e) => e.name === "NotFoundError");
  disk.get("tok-usb").reachable = true;
  await unplugged.reconnect();
  assert.deepStrictEqual((await schedOf(unplugged)).dates["2026-09-10"].map((e) => e.pt), ["SEED", "EDIT-1", "EDIT-2"]);

  /* 5. New database: the save picker creates the file and it's written immediately. */
  const fresh = newTab();
  await fresh.newDatabase();
  const created = [...disk.keys()].find((k) => k.startsWith("tok-new-"));
  assert.ok(created && disk.get(created).bytes.length > 0, "newDatabase writes the new .crmdb straight away");
  assert.strictEqual(disk.get(created).name, "schedule.crmdb");
  assert.deepStrictEqual((await scheduleOnDisk(created)).dates, {});

  /* 6. Printing goes to the native print sheet. */
  ops.length = 0;
  window.print();
  await window.CRMNative.printPdf(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
  assert.deepStrictEqual(ops, ["printPage", "printPdf"]);

  /* 7. Download patients: with showDirectoryPicker present the page takes its folder path, and its own
        writeExportTree builds <date>/<patient>/<file> in the picked folder — no .zip. */
  const html = fs.readFileSync(path.join(__dirname, "..", "site", "protected", "Patient_Schedule.html"), "utf8");
  assert.match(functionSource(html, "pickExportDestination"), /if \(window\.showDirectoryPicker\)[\s\S]*kind: 'dir'/,
    "the page must prefer real folders whenever a directory picker exists");
  const writeExportTree = new Function(functionSource(html, "writeExportTree") + "\nreturn writeExportTree;")();
  folders.set("tok-folder", new Map([["", { kind: "directory", bytes: new Uint8Array(0), mtime: clock, reachable: true }]]));
  const picked = await window.showDirectoryPicker({ id: "crmPatientExport", mode: "readwrite" });
  const where = await writeExportTree(picked, { date: "2026-09-11" }, [
    { folder: "01 - Doe, John 0800", name: "Doe_2026-09-11_CRM_Report.pdf", file: new Blob(["%PDF-1.7 doe report"]) },
    { folder: "01 - Doe, John 0800", name: "MDT_export.pdf", file: new Blob(["%PDF-1.4 doe export"]) },
    { folder: "02 - Roe, Jane 0900", name: "Roe_2026-09-11_CRM_Report.pdf", file: new Blob(["%PDF-1.7 roe report"]) }
  ]);
  assert.strictEqual(where, "Exports/2026-09-11");
  const tree = folders.get("tok-folder");
  assert.deepStrictEqual([...tree.keys()].filter(Boolean).sort(), [
    "2026-09-11",
    "2026-09-11/01 - Doe, John 0800",
    "2026-09-11/01 - Doe, John 0800/Doe_2026-09-11_CRM_Report.pdf",
    "2026-09-11/01 - Doe, John 0800/MDT_export.pdf",
    "2026-09-11/02 - Roe, Jane 0900",
    "2026-09-11/02 - Roe, Jane 0900/Roe_2026-09-11_CRM_Report.pdf"
  ]);
  assert.strictEqual(Buffer.from(tree.get("2026-09-11/01 - Doe, John 0800/MDT_export.pdf").bytes).toString(), "%PDF-1.4 doe export");

  // Two files under one picked folder share a token; the shim's cache must still keep them apart.
  const doeDir = await (await picked.getDirectoryHandle("2026-09-11")).getDirectoryHandle("01 - Doe, John 0800");
  assert.strictEqual(await (await (await doeDir.getFileHandle("MDT_export.pdf")).getFile()).text(), "%PDF-1.4 doe export");
  assert.strictEqual(await (await (await doeDir.getFileHandle("Doe_2026-09-11_CRM_Report.pdf")).getFile()).text(), "%PDF-1.7 doe report");

  // Same rules as the real API: no creating by accident, no climbing out, no kind confusion.
  await assert.rejects(picked.getFileHandle("missing.pdf"), (e) => e.name === "NotFoundError");
  await assert.rejects(picked.getDirectoryHandle("..", { create: true }), (e) => e.name === "TypeError");
  await assert.rejects(picked.getFileHandle("a/b.pdf", { create: true }), (e) => e.name === "TypeError");
  await assert.rejects(picked.getFileHandle("2026-09-11"), (e) => e.name === "TypeMismatchError");

  /* The binary read route is not always available — a page whose Content-Security-Policy has no
     connect-src blocks it outright, which is exactly how it failed on device. The open must still
     succeed over the base64 bridge rather than failing. */
  {
    ops.length = 0;
    fetchBlocked = true;
    disk.get("tok-usb").mtime = ++clock;   // past the shim's cache, so the bytes really are re-read
    const blocked = newTab();
    nextPick = "tok-usb";
    await blocked.connect();
    assert.ok((await schedOf(blocked)).dates["2026-09-10"].length >= 1,
      "with the fast path blocked the database must still open");
    assert.strictEqual(count("fetch"), 1, "the fast path is tried first");
    assert.ok(count("read") > 1, "and the bytes then come over the base64 bridge instead");
    fetchBlocked = false;
  }

  console.log("ipad-native-shim: all assertions passed");
}

run().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
