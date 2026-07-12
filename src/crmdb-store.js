/* crmdb-store.js — shared persistence engine for the .crmdb container model.
 *
 * Drop-in replacement for src/workspace.js: it exposes the SAME window.CRMWorkspace API
 * both the Patient Schedule and CRM Report Generator already call (connect, slotDir,
 * writeFile, readText, listFiles, moveSlot, slotName, stored, permission, forget,
 * usbOnly …) — but instead of driving a live folder tree through the File System Access
 * directory API, everything reads and writes an in-memory bundle:
 *
 *     bundle : Map<path, Blob>     e.g. "schedule.json", "patients/2026-07-13/0800_JS/report.pdf"
 *
 * The bundle is the one database. It is:
 *   • serialized to a single .crmdb file (a standard zip — see vendor/crmdb-zip.js);
 *   • mirrored to IndexedDB on every change, so navigating between the two pages carries
 *     the working copy across (this is what makes the two-page handoff work on iPad, which
 *     has no File System Access API);
 *   • on desktop (Chrome/Edge) additionally bound to a real .crmdb file handle and
 *     autosaved in place — no button required. On iPad the explicit "Save database
 *     updates" button writes the bundle out through the Files sheet.
 *
 * Requires vendor/crmdb-zip.js to be loaded first (window.CRMDB).
 */
(function () {
  "use strict";

  var FOLDER = "CRM Toolkit";                 // kept for message continuity
  var DEFAULT_NAME = "schedule.crmdb";
  var hasFSopen = typeof window !== "undefined" && !!window.showOpenFilePicker;
  var hasFSsave = typeof window !== "undefined" && !!window.showSaveFilePicker;
  var canAutosave = hasFSopen && hasFSsave;   // desktop Chrome/Edge

  /* ------------------------------------------------------------------ state */
  var bundle = new Map();     // path -> Blob
  var fileHandle = null;      // desktop FSA handle to the .crmdb, or null (iPad)
  var opened = false;
  var suggestedName = DEFAULT_NAME;
  var persistTimer = null;
  var statusCb = null;        // pages set CRMWorkspace.onStatus = fn(msg, cls)

  function status(msg, cls) { try { if (statusCb) statusCb(msg, cls); } catch (e) {} }

  /* ---------------------------------------------------------- small helpers */
  function toBlob(data) {
    if (data instanceof Blob) return data;
    if (typeof data === "string") return new Blob([data]);
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return new Blob([data]);
    return new Blob([String(data)]);
  }
  function baseName(p) { var i = p.lastIndexOf("/"); return i < 0 ? p : p.slice(i + 1); }
  function mimeFor(name) {
    var e = (String(name).split(".").pop() || "").toLowerCase();
    return ({ pdf: "application/pdf", txt: "text/plain", log: "text/plain", csv: "text/csv",
      json: "application/json", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", html: "text/html" })[e] || "";
  }

  function slotName(time, pt) {
    var t = String(time || "").replace(/[^0-9]/g, "").slice(0, 4) || "0000";
    if (t.length === 3) t = "0" + t;
    while (t.length < 4) t = t + "0";
    var p = String(pt || "").toUpperCase().replace(/[^A-Z0-9]/g, "") || "XX";
    return t + "_" + p;
  }
  function slotPrefix(date, slot) { return "patients/" + date + "/" + slot + "/"; }

  /* --------------------------------------------------- bundle <-> .crmdb bytes */
  function serialize() {
    var entries = [
      { name: "manifest.json", data: JSON.stringify({ type: "crm-workspace-bundle", version: 1, modified: new Date().toISOString(), fileCount: bundle.size }, null, 2) }
    ];
    if (!bundle.has("schedule.json")) entries.push({ name: "schedule.json", data: JSON.stringify({ type: "patient-schedule", version: 1, dates: {} }, null, 2) });
    var paths = Array.from(bundle.keys());
    return paths.reduce(function (p, path) {
      return p.then(function () { return bundle.get(path).arrayBuffer(); })
        .then(function (ab) { entries.push({ name: path, data: new Uint8Array(ab) }); });
    }, Promise.resolve()).then(function () { return window.CRMDB.write(entries); });
  }
  function ingest(arrayBuffer) {
    return window.CRMDB.read(arrayBuffer).then(function (entries) {
      bundle.clear();
      entries.forEach(function (e) {
        if (e.name === "manifest.json") return;
        bundle.set(e.name, new Blob([e.data]));
      });
      if (!bundle.has("schedule.json")) bundle.set("schedule.json", new Blob([JSON.stringify({ type: "patient-schedule", version: 1, dates: {} }, null, 2)]));
      opened = true;
    });
  }

  /* -------------------------------------------------------------- IndexedDB */
  function idb() {
    return new Promise(function (res, rej) {
      if (typeof indexedDB === "undefined") return rej(new Error("no idb"));
      var r = indexedDB.open("crmdbStore", 1);
      r.onupgradeneeded = function () { r.result.createObjectStore("kv"); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function idbSet(k, v) {
    return idb().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction("kv", "readwrite"); tx.objectStore("kv").put(v, k);
        tx.oncomplete = function () { res(); }; tx.onerror = function () { rej(tx.error); };
      });
    }).catch(function () {});
  }
  function idbGet(k) {
    return idb().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction("kv", "readonly"); var rq = tx.objectStore("kv").get(k);
        rq.onsuccess = function () { res(rq.result); }; rq.onerror = function () { rej(rq.error); };
      });
    }).catch(function () { return undefined; });
  }
  function idbDel(k) {
    return idb().then(function (db) {
      return new Promise(function (res) {
        var tx = db.transaction("kv", "readwrite"); tx.objectStore("kv").delete(k);
        tx.oncomplete = function () { res(); }; tx.onerror = function () { res(); };
      });
    }).catch(function () {});
  }

  /* ------------------------------------------------------------- persistence */
  // Every write goes here: mirror to IndexedDB (cross-page copy) and, on desktop,
  // autosave to the bound .crmdb file — both debounced so bursts of edits coalesce.
  function persist() {
    if (!opened) return;
    clearTimeout(persistTimer);
    persistTimer = setTimeout(function () {
      serialize().then(function (blob) {
        idbSet("bundle", blob);
        if (fileHandle && canAutosave) {
          return fileHandle.createWritable().then(function (w) { return w.write(blob).then(function () { return w.close(); }); })
            .then(function () { status("Saved ✓", "ok"); })
            .catch(function (e) { status("Save failed: " + e.message, "warn"); });
        }
        status("Unsaved — tap Save database updates", "warn");
      });
    }, 1200);
  }

  // Flush the working copy to IndexedDB (and the desktop file) immediately — NO download.
  // Used before navigating between the two pages so the handoff carries the latest edits.
  function flush() {
    clearTimeout(persistTimer);
    if (!opened) return Promise.resolve();
    return serialize().then(function (blob) {
      return idbSet("bundle", blob).then(function () {
        if (fileHandle && canAutosave) {
          return fileHandle.createWritable().then(function (w) { return w.write(blob).then(function () { return w.close(); }); }).catch(function () {});
        }
      });
    });
  }

  // Explicit save (the separate button). Desktop: flush to file now. iPad: download.
  function saveNow() {
    if (!opened) return Promise.resolve();
    return serialize().then(function (blob) {
      idbSet("bundle", blob);
      if (fileHandle && canAutosave) {
        return fileHandle.createWritable().then(function (w) { return w.write(blob).then(function () { return w.close(); }); })
          .then(function () { status("Saved to " + (suggestedName) + " ✓", "ok"); });
      }
      return shareOrDownload(blob, suggestedName || DEFAULT_NAME);
    });
  }
  // iPad has no showSaveFilePicker; the ONLY way a web page can write to an external USB is the
  // native share sheet ("Save to Files → <USB>"). Fall back to a plain download if unavailable.
  // Must be called from a user gesture (the Save button) so the share sheet is allowed.
  function shareOrDownload(blob, name) {
    try {
      if (navigator.canShare) {
        var file = new File([blob], name, { type: "application/octet-stream" });
        if (navigator.canShare({ files: [file] })) {
          return navigator.share({ files: [file] })
            .then(function () { status("Saved — pick your USB in the Files sheet ✓", "ok"); })
            .catch(function (e) {
              if (e && e.name === "AbortError") { status("Save cancelled", "warn"); return; }
              download(blob, name); status("Exported to Downloads — move it to the USB", "ok");
            });
        }
      }
    } catch (e) { /* fall through to download */ }
    download(blob, name);
    status("Exported to Downloads — move it to the USB", "ok");
    return Promise.resolve();
  }
  function download(blob, name) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  /* -------------------------------------------------- hidden input for iPad open */
  var openInput = null;
  function ensureInput() {
    if (openInput || typeof document === "undefined") return openInput;
    openInput = document.createElement("input");
    openInput.type = "file"; openInput.accept = ".crmdb,.zip,application/octet-stream";
    openInput.style.display = "none";
    document.body.appendChild(openInput);
    return openInput;
  }

  /* ------------------------------------------------------- virtual FS handles */
  function fileHandleFor(path) {
    return {
      kind: "file",
      name: baseName(path),
      getFile: function () { var b = bundle.get(path) || new Blob([]); return Promise.resolve(new File([b], baseName(path), { type: mimeFor(path) })); },
      createWritable: function () {
        var chunks = [];
        return Promise.resolve({
          write: function (d) { chunks.push(d); return Promise.resolve(); },
          truncate: function () { return Promise.resolve(); },
          close: function () { bundle.set(path, new Blob(chunks)); persist(); return Promise.resolve(); }
        });
      }
    };
  }
  function dirHandleFor(prefix) {
    return {
      kind: "directory",
      prefix: prefix,
      getFileHandle: function (name) { return Promise.resolve(fileHandleFor(prefix + name)); }
    };
  }
  // the "root": the only bit the pages call on it is getFileHandle('schedule.json')
  var ROOT = {
    kind: "directory",
    name: FOLDER,
    getFileHandle: function (name) { return Promise.resolve(fileHandleFor(name)); },
    getDirectoryHandle: function (name) { return Promise.resolve(dirHandleFor(name.replace(/\/?$/, "/"))); }
  };

  /* --------------------------------------------------------- CRMWorkspace API */
  function initScaffold(root) {
    if (!bundle.has("schedule.json")) bundle.set("schedule.json", new Blob([JSON.stringify({ type: "patient-schedule", version: 1, dates: {} }, null, 2)]));
    return Promise.resolve(root || ROOT);
  }

  // Open an EXISTING database. Desktop: file picker (handle kept for autosave).
  // iPad: hidden file input. Either way the bytes populate the bundle.
  function connect() {
    if (canAutosave) {
      return window.showOpenFilePicker({ types: [{ description: "CRM database", accept: { "application/octet-stream": [".crmdb", ".zip"] } }] })
        .then(function (hs) {
          fileHandle = hs[0]; suggestedName = hs[0].name;
          return hs[0].getFile().then(function (f) { return f.arrayBuffer(); }).then(ingest)
            .then(function () { return idbSet("fileHandle", fileHandle); })
            .then(function () { return idbSet("bundle", null); })   // refreshed on next persist
            .then(function () { opened = true; return ROOT; });
        });
    }
    // iPad
    var inp = ensureInput();
    return new Promise(function (res, rej) {
      inp.value = "";
      inp.onchange = function () {
        var f = inp.files && inp.files[0];
        if (!f) { rej(Object.assign(new Error("cancelled"), { name: "AbortError" })); return; }
        fileHandle = null; suggestedName = f.name;
        f.arrayBuffer().then(ingest).then(function () { opened = true; res(ROOT); }).catch(rej);
      };
      inp.click();
    });
  }

  // Create a NEW empty database.
  function newDatabase() {
    bundle.clear();
    bundle.set("schedule.json", new Blob([JSON.stringify({ type: "patient-schedule", version: 1, dates: {} }, null, 2)]));
    opened = true;
    if (canAutosave) {
      return window.showSaveFilePicker({ suggestedName: DEFAULT_NAME, types: [{ description: "CRM database", accept: { "application/octet-stream": [".crmdb"] } }] })
        .then(function (h) { fileHandle = h; suggestedName = h.name; return idbSet("fileHandle", h); })
        .then(function () { return saveNow(); })
        .then(function () { return ROOT; });
    }
    fileHandle = null; suggestedName = DEFAULT_NAME;
    return idbSet("bundle", null).then(function () { return ROOT; });
  }

  // Auto-reconnect on page load: pull the working copy out of IndexedDB (both platforms),
  // and re-bind the desktop file handle if one was remembered. Returns ROOT or null.
  function stored() {
    return idbGet("fileHandle").then(function (h) {
      if (h && canAutosave) fileHandle = h;
      return idbGet("bundle").then(function (blob) {
        if (blob) {
          return blob.arrayBuffer().then(ingest).then(function () { opened = true; return ROOT; });
        }
        // no working copy yet, but a desktop handle may still let us open the file later
        return (h && canAutosave) ? ROOT : null;
      });
    }).catch(function () { return null; });
  }

  function permission(root, ask) {
    if (fileHandle && canAutosave && fileHandle.queryPermission) {
      return fileHandle.queryPermission({ mode: "readwrite" }).then(function (p) {
        if (p !== "granted" && ask && fileHandle.requestPermission) {
          return fileHandle.requestPermission({ mode: "readwrite" }).then(function (p2) {
            if (p2 === "granted" && !opened) {
              return fileHandle.getFile().then(function (f) { return f.arrayBuffer(); }).then(ingest).then(function () { return "granted"; });
            }
            return p2;
          });
        }
        if (p === "granted" && !opened) {
          return fileHandle.getFile().then(function (f) { return f.arrayBuffer(); }).then(ingest).then(function () { return "granted"; });
        }
        return p;
      });
    }
    return Promise.resolve(opened ? "granted" : "granted");   // iPad: the in-memory bundle is the copy
  }

  function forget() {
    fileHandle = null; opened = false; bundle.clear();
    return Promise.all([idbDel("fileHandle"), idbDel("bundle")]).then(function () {});
  }

  /* USB-only preference (unchanged semantics: whether pages keep a localStorage mirror) */
  function usbOnly() { try { return localStorage.getItem("usbOnlyMode") === "1"; } catch (e) { return false; } }
  function setUsbOnly(v) { try { v ? localStorage.setItem("usbOnlyMode", "1") : localStorage.removeItem("usbOnlyMode"); } catch (e) {} }

  /* slot / file operations over the bundle */
  function slotDir(root, date, slot, create) { return Promise.resolve(dirHandleFor(slotPrefix(date, slot))); }
  function readText(dir, name) {
    var path = dir.prefix + name;
    if (!bundle.has(path)) return Promise.reject(new Error("not found: " + name));
    return bundle.get(path).text();
  }
  function writeFile(dir, name, data) {
    bundle.set(dir.prefix + name, toBlob(data));
    persist();
    return Promise.resolve();
  }
  function listFiles(dir) {
    var pre = dir.prefix, out = [];
    bundle.forEach(function (blob, path) {
      if (path.indexOf(pre) === 0 && path.indexOf("/", pre.length) === -1) {
        out.push(fileHandleFor(path));
      }
    });
    out.sort(function (a, b) { return a.name.localeCompare(b.name); });
    return Promise.resolve(out);
  }
  function removeFile(root, date, slot, name) {
    var had = bundle.delete(slotPrefix(date, slot) + name);
    if (had) persist();
    return Promise.resolve(had);
  }
  // Remove every file in one patient's slot (used when a patient is deleted from the schedule).
  function removeSlotFiles(root, date, slot) {
    var pre = slotPrefix(date, slot), removed = 0;
    Array.from(bundle.keys()).forEach(function (k) { if (k.indexOf(pre) === 0) { bundle.delete(k); removed++; } });
    if (removed) persist();
    return Promise.resolve(removed);
  }
  // Retention: drop every patient file whose date is strictly before cutISO (YYYY-MM-DD).
  // Catches orphaned files too (dates no longer in the schedule), so the database stays bounded.
  function pruneFilesBefore(cutISO) {
    var removed = 0, bytes = 0;
    Array.from(bundle.keys()).forEach(function (path) {
      var m = /^patients\/(\d{4}-\d{2}-\d{2})\//.exec(path);
      if (m && m[1] < cutISO) { var b = bundle.get(path); bytes += (b && b.size) || 0; bundle.delete(path); removed++; }
    });
    if (removed) persist();
    return Promise.resolve({ files: removed, bytes: bytes });
  }
  // Map of "<date>/<slot>" -> number of files, for the All-patients overview.
  function slotFileCounts() {
    var counts = {};
    bundle.forEach(function (_b, path) {
      var m = /^patients\/(\d{4}-\d{2}-\d{2})\/([^/]+)\//.exec(path);
      if (m) { var k = m[1] + "/" + m[2]; counts[k] = (counts[k] || 0) + 1; }
    });
    return counts;
  }
  // Current size of the open database (patient files + schedule), for the Memory readout.
  function stats() {
    var files = 0, bytes = 0;
    bundle.forEach(function (b, path) {
      bytes += (b && b.size) || 0;
      if (path.indexOf("patients/") === 0) files++;
    });
    return { files: files, bytes: bytes };
  }
  function moveSlot(root, date, oldSlot, newSlot) {
    if (!oldSlot || !newSlot || oldSlot === newSlot) return Promise.resolve(false);
    var op = slotPrefix(date, oldSlot), np = slotPrefix(date, newSlot), moved = false;
    Array.from(bundle.keys()).forEach(function (k) {
      if (k.indexOf(op) === 0) { bundle.set(np + k.slice(op.length), bundle.get(k)); bundle.delete(k); moved = true; }
    });
    if (moved) persist();
    return Promise.resolve(moved);
  }

  var api = {
    supported: true,           // open(file input)+save(download) work everywhere; autosave is desktop-only
    canAutosave: canAutosave,
    FOLDER: FOLDER,
    slotName: slotName,
    connect: connect,
    newDatabase: newDatabase,
    initScaffold: initScaffold,
    stored: stored,
    permission: permission,
    forget: forget,
    usbOnly: usbOnly,
    setUsbOnly: setUsbOnly,
    slotDir: slotDir,
    moveSlot: moveSlot,
    listFiles: listFiles,
    readText: readText,
    writeFile: writeFile,
    removeFile: removeFile,
    removeSlotFiles: removeSlotFiles,
    pruneFilesBefore: pruneFilesBefore,
    slotFileCounts: slotFileCounts,
    stats: stats,
    saveNow: saveNow,
    flush: flush,
    isOpen: function () { return opened; },
    set onStatus(fn) { statusCb = fn; },
    get onStatus() { return statusCb; },
    // test hooks (used by the Node unit test; harmless in the browser)
    _bundle: bundle, _serialize: serialize, _ingest: ingest
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.CRMWorkspace = api;
})();
