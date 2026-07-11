/**
 * USB workspace — shared by the Patient Schedule and the CRM Report Generator.
 * ----------------------------------------------------------------------------
 * The workspace is the "CRM Toolkit" folder on the user's USB stick:
 *
 *   CRM Toolkit/
 *     schedule.json                          (the Patient Schedule's data file)
 *     patients/<YYYY-MM-DD>/<HHMM>_<INITIALS>/
 *       report.json  report.txt  report.pdf  (CRM tool exports)
 *       <vendor export>.pdf / .log           (raw programmer files, optional)
 *
 * The directory handle is stored in IndexedDB (db "crmWorkspace") so BOTH pages —
 * same origin — share one connected folder; each page asks for permission with a
 * single click per browser session. Everything is the local File System Access
 * API: nothing here touches the network, and PHI only ever lives on the stick.
 * Chrome/Edge desktop only (iOS has no directory picker).
 */
(function () {
  "use strict";
  var DB = "crmWorkspace", STORE = "kv", KEY = "root";
  var FOLDER = "CRM Toolkit";

  function idb() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open(DB, 1);
      r.onupgradeneeded = function () { r.result.createObjectStore(STORE); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function kvSet(v) {
    return idb().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(v, KEY);
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }
  function kvGet() {
    return idb().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(STORE, "readonly");
        var rq = tx.objectStore(STORE).get(KEY);
        rq.onsuccess = function () { res(rq.result || null); };
        rq.onerror = function () { rej(rq.error); };
      });
    });
  }
  function kvDel() {
    return idb().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).delete(KEY);
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }

  /** Pick the workspace. If the user picks the USB root (or any folder that isn't the
   *  compartment itself), descend into — creating if needed — its "CRM Toolkit" child,
   *  so everything the toolkit does stays inside that one folder. */
  async function connect() {
    if (!window.showDirectoryPicker) throw new Error("This browser cannot open folders (use Chrome or Edge).");
    var dir = await window.showDirectoryPicker({ mode: "readwrite", id: "crm-toolkit" });
    if (dir.name !== FOLDER) {
      dir = await dir.getDirectoryHandle(FOLDER, { create: true });
    }
    await kvSet(dir);
    return dir;
  }

  function stored() { return kvGet().catch(function () { return null; }); }

  /** First-time setup: make sure the workspace has its skeleton — a patients/ folder and a
   *  valid (empty) schedule.json. Never overwrites an existing schedule. */
  async function initScaffold(root) {
    await root.getDirectoryHandle("patients", { create: true });
    var fh = await root.getFileHandle("schedule.json", { create: true });
    var existing = await (await fh.getFile()).text();
    if (!existing.trim()) {
      var w = await fh.createWritable();
      await w.write(JSON.stringify({ type: "patient-schedule", version: 1, dates: {} }, null, 2));
      await w.close();
    }
    return root;
  }

  async function permission(dir, ask) {
    if (!dir) return "none";
    var p = await dir.queryPermission({ mode: "readwrite" });
    if (p !== "granted" && ask) p = await dir.requestPermission({ mode: "readwrite" });
    return p;
  }

  function forget() { return kvDel().catch(function () {}); }

  /** USB-only mode: while a workspace is connected, pages keep NO PHI mirror in the
   *  browser (no localStorage schedule copy; CRM autosave suppressed while a slot is
   *  armed) — the stick is the only copy. Stored as a plain preference (not PHI).
   *  Default is OFF; to make ON the default someday, change the fallback below. */
  function usbOnly() {
    try { return localStorage.getItem("usbOnlyMode") === "1"; } catch (e) { return false; }
  }
  function setUsbOnly(v) {
    try { v ? localStorage.setItem("usbOnlyMode", "1") : localStorage.removeItem("usbOnlyMode"); } catch (e) {}
  }

  /** "08:00" + "JS" -> "0800_JS" (deterministic slot folder name shared by both pages). */
  function slotName(time, pt) {
    var t = String(time || "").replace(/[^0-9]/g, "").slice(0, 4) || "0000";
    if (t.length === 3) t = "0" + t;
    while (t.length < 4) t = t + "0";
    var p = String(pt || "").toUpperCase().replace(/[^A-Z0-9]/g, "") || "XX";
    return t + "_" + p;
  }

  async function slotDir(root, dateISO, slot, create) {
    var patients = await root.getDirectoryHandle("patients", { create: !!create });
    var day = await patients.getDirectoryHandle(dateISO, { create: !!create });
    return day.getDirectoryHandle(slot, { create: !!create });
  }

  async function listFiles(dir) {
    var out = [];
    for await (var entry of dir.values()) {
      if (entry.kind === "file") out.push(entry);
    }
    out.sort(function (a, b) { return a.name.localeCompare(b.name); });
    return out;
  }

  async function readText(dir, name) {
    var fh = await dir.getFileHandle(name);
    return (await fh.getFile()).text();
  }

  async function writeFile(dir, name, data) {
    var fh = await dir.getFileHandle(name, { create: true });
    var w = await fh.createWritable();
    await w.write(data);
    await w.close();
  }

  window.CRMWorkspace = {
    supported: !!window.showDirectoryPicker,
    FOLDER: FOLDER,
    connect: connect,
    initScaffold: initScaffold,
    stored: stored,
    permission: permission,
    forget: forget,
    usbOnly: usbOnly,
    setUsbOnly: setUsbOnly,
    slotName: slotName,
    slotDir: slotDir,
    listFiles: listFiles,
    readText: readText,
    writeFile: writeFile
  };
})();
