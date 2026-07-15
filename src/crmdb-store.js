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
 *   • serialized to a single .crmdb file (a standard zip when password protection is
 *     off; an authenticated, locally-encrypted envelope when it is on);
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
  var passwordCb = null;      // pages set CRMWorkspace.onPasswordRequest = fn(details)
  var protection = null;      // { key: CryptoKey, salt: Uint8Array, iterations: number }
  var lastOpenError = null;   // retained so pages can explain a cancelled/failed quiet reopen

  // Encrypted .crmdb envelope (all fixed-width fields are authenticated as AES-GCM AAD):
  // magic[8] + version[1] + PBKDF2 iterations[4] + salt[16] + iv[12] + ciphertext/tag.
  var ENC_MAGIC = new Uint8Array([67, 82, 77, 68, 66, 69, 78, 67]); // "CRMDBENC"
  var ENC_VERSION = 1;
  var ENC_ITERATIONS = 600000;
  var ENC_HEADER_SIZE = 41;
  var SESSION_UNLOCK_KEY = "crmdbSessionUnlockV1";

  function status(msg, cls) { try { if (statusCb) statusCb(msg, cls); } catch (e) {} }

  function abortError(message) {
    var e = new Error(message || "Password entry cancelled"); e.name = "AbortError"; return e;
  }
  function cryptoApi() {
    var c = (typeof globalThis !== "undefined" && globalThis.crypto) || (typeof window !== "undefined" && window.crypto);
    if (!c || !c.subtle || !c.getRandomValues) throw new Error("Password protection is not supported by this browser");
    return c;
  }
  function isEncryptedBytes(bytes) {
    if (!bytes || bytes.byteLength < ENC_MAGIC.length) return false;
    var u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (var i = 0; i < ENC_MAGIC.length; i++) if (u[i] !== ENC_MAGIC[i]) return false;
    return true;
  }
  function deriveMaterial(password, salt, iterations) {
    var c = cryptoApi();
    var encoded = new TextEncoder().encode(String(password));
    return c.subtle.importKey("raw", encoded, "PBKDF2", false, ["deriveBits"]).then(function (baseKey) {
      return c.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt, iterations: iterations }, baseKey, 256);
    }).then(function (raw) {
      return c.subtle.importKey("raw", raw, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"])
        .then(function (key) { return { key: key, raw: new Uint8Array(raw) }; });
    });
  }
  function deriveKey(password, salt, iterations) {
    return deriveMaterial(password, salt, iterations).then(function (m) { return m.key; });
  }
  function b64(bytes) {
    var s = ""; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function fromB64(value) {
    var s = atob(value), out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  function rememberSessionKey(raw, salt, iterations) {
    try { sessionStorage.setItem(SESSION_UNLOCK_KEY, JSON.stringify({ key: b64(raw), salt: b64(salt), iterations: iterations })); } catch (e) {}
  }
  function clearSessionKey() { try { sessionStorage.removeItem(SESSION_UNLOCK_KEY); } catch (e) {} }
  function sessionKey(salt, iterations) {
    try {
      var saved = JSON.parse(sessionStorage.getItem(SESSION_UNLOCK_KEY) || "null");
      if (!saved || saved.salt !== b64(salt) || saved.iterations !== iterations) return Promise.resolve(null);
      return cryptoApi().subtle.importKey("raw", fromB64(saved.key), { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    } catch (e) { clearSessionKey(); return Promise.resolve(null); }
  }
  function requestPassword(details) {
    if (passwordCb) return Promise.resolve().then(function () { return passwordCb(details); });
    if (typeof window !== "undefined" && window.prompt) return Promise.resolve(window.prompt(details.message || "Database password:"));
    return Promise.reject(new Error("A password is required to open this database"));
  }

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
    // Patient names remain human-readable in schedule.json. Only the internal folder key is
    // normalized so punctuation, spaces and very long names cannot create unsafe ZIP paths.
    var p = String(pt || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
      .toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 48) || "XX";
    return t + "_" + p;
  }
  function slotPrefix(date, slot) { return "patients/" + date + "/" + slot + "/"; }

  /* --------------------------------------------------- bundle <-> .crmdb bytes */
  function serializeZip() {
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
  function encryptZip(blob) {
    if (!protection) return Promise.resolve(blob);
    var c = cryptoApi(), iv = new Uint8Array(12); c.getRandomValues(iv);
    var header = new Uint8Array(ENC_HEADER_SIZE);
    header.set(ENC_MAGIC, 0); header[8] = ENC_VERSION;
    new DataView(header.buffer).setUint32(9, protection.iterations, false);
    header.set(protection.salt, 13); header.set(iv, 29);
    return blob.arrayBuffer().then(function (plain) {
      return c.subtle.encrypt({ name: "AES-GCM", iv: iv, additionalData: header, tagLength: 128 }, protection.key, plain);
    }).then(function (ciphertext) { return new Blob([header, ciphertext], { type: "application/octet-stream" }); });
  }
  function serialize() { return serializeZip().then(encryptZip); }

  function decryptEnvelope(arrayBuffer) {
    var bytes = new Uint8Array(arrayBuffer);
    if (bytes.length <= ENC_HEADER_SIZE || bytes[8] !== ENC_VERSION) return Promise.reject(new Error("Unsupported encrypted database format"));
    var iterations = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(9, false);
    if (iterations < 10000 || iterations > 10000000) return Promise.reject(new Error("Invalid encrypted database header"));
    var salt = bytes.slice(13, 29), iv = bytes.slice(29, 41), header = bytes.slice(0, ENC_HEADER_SIZE);
    var ciphertext = bytes.slice(ENC_HEADER_SIZE), retry = false;
    function decryptWith(key) {
      return cryptoApi().subtle.decrypt({ name: "AES-GCM", iv: iv, additionalData: header, tagLength: 128 }, key, ciphertext)
        .then(function (plain) { protection = { key: key, salt: salt, iterations: iterations }; return plain; });
    }
    function attempt() {
      return requestPassword({ action: "unlock", retry: retry, fileName: suggestedName,
        message: retry ? "Incorrect password. Try again:" : "Enter the password for " + (suggestedName || "this database") + ":" })
        .then(function (password) {
          if (password === null || password === undefined) throw abortError();
          return deriveMaterial(password, salt, iterations).then(function (material) {
            return decryptWith(material.key).then(function (plain) {
              rememberSessionKey(material.raw, salt, iterations);
              return plain;
            });
          });
        }).catch(function (e) {
          if (e && e.name === "AbortError") throw e;
          if (e && (e.name === "OperationError" || e.name === "DataError")) { retry = true; return attempt(); }
          throw e;
        });
    }
    return sessionKey(salt, iterations).then(function (key) {
      if (!key) return attempt();
      return decryptWith(key).catch(function () { clearSessionKey(); return attempt(); });
    });
  }
  function ingestZip(arrayBuffer) {
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
  function ingest(arrayBuffer) {
    var bytes = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
    if (isEncryptedBytes(bytes)) return decryptEnvelope(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)).then(ingestZip);
    protection = null;
    return ingestZip(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  }

  function verifyPassword(password) {
    if (!protection) return Promise.resolve(true);
    return deriveKey(password, protection.salt, protection.iterations).then(function (candidate) {
      var c = cryptoApi(), iv = new Uint8Array(12), sample = new Uint8Array([67, 82, 77, 68, 66]); c.getRandomValues(iv);
      return c.subtle.encrypt({ name: "AES-GCM", iv: iv }, candidate, sample)
        .then(function (cipher) { return c.subtle.decrypt({ name: "AES-GCM", iv: iv }, protection.key, cipher); })
        .then(function () { return true; }, function () { throw new Error("Incorrect password"); });
    });
  }

  function enableProtection(password) {
    if (!opened) return Promise.reject(new Error("Open a database first"));
    if (!password) return Promise.reject(new Error("Password cannot be empty"));
    var c = cryptoApi(), salt = new Uint8Array(16); c.getRandomValues(salt);
    return deriveMaterial(password, salt, ENC_ITERATIONS).then(function (material) {
      protection = { key: material.key, salt: salt, iterations: ENC_ITERATIONS };
      rememberSessionKey(material.raw, salt, ENC_ITERATIONS);
      return flush();
    }).then(function () { status("Password protection enabled · save the database", "ok"); return true; });
  }
  function changePassword(currentPassword, newPassword) {
    if (!protection) return Promise.reject(new Error("This database is not password protected"));
    if (!newPassword) return Promise.reject(new Error("New password cannot be empty"));
    return verifyPassword(currentPassword).then(function () {
      var c = cryptoApi(), salt = new Uint8Array(16); c.getRandomValues(salt);
      return deriveMaterial(newPassword, salt, ENC_ITERATIONS).then(function (material) {
        protection = { key: material.key, salt: salt, iterations: ENC_ITERATIONS };
        rememberSessionKey(material.raw, salt, ENC_ITERATIONS);
        return flush();
      });
    }).then(function () { status("Database password changed · save the database", "ok"); return true; });
  }
  function disableProtection(password) {
    if (!protection) return Promise.resolve(false);
    return verifyPassword(password).then(function () {
      protection = null;
      clearSessionKey();
      return flush();
    }).then(function () { status("Password protection removed · save the database", "ok"); return true; });
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

  // Refresh this tab's in-memory bundle from the latest IndexedDB working copy. Schedule uses
  // this after another open tab commits a newer revision, preventing stale-tab overwrites.
  function reloadWorkingCopy() {
    return idbGet("bundle").then(function (blob) {
      if (!blob) return ROOT;
      return blob.arrayBuffer().then(ingest).then(function () { opened = true; return ROOT; });
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
          // Switching from an already-open database: write its latest edits back to its own
          // file BEFORE we clear the bundle to load the newly-picked one, so nothing is lost.
          var prev = fileHandle, prevName = suggestedName, prevProtection = protection;
          var next = hs[0];
          var saveOld = (opened && prev && canAutosave)
            ? serialize().then(function (blob) {
                return prev.createWritable().then(function (w) { return w.write(blob).then(function () { return w.close(); }); });
              }).catch(function () {})
            : Promise.resolve();
          return saveOld.then(function () {
            clearTimeout(persistTimer);
            suggestedName = next.name;
            return next.getFile().then(function (f) { return f.arrayBuffer(); }).then(ingest)
              .catch(function (e) { fileHandle = prev; suggestedName = prevName; protection = prevProtection; throw e; }); })
            .then(function () { fileHandle = next; })
            .then(function () { return idbSet("fileHandle", fileHandle); })
            // Keep an immediately reopenable working copy. Waiting for the next edit used to
            // leave refresh/page handoff with only a permission-gated file handle and no data.
            .then(function () { return serialize(); })
            .then(function (blob) { return idbSet("bundle", blob); })
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
        var prev = fileHandle, prevName = suggestedName, prevProtection = protection;
        suggestedName = f.name;
        f.arrayBuffer().then(ingest).then(function () {
          fileHandle = null; opened = true;
          return serialize().then(function (blob) { return idbSet("bundle", blob); });
        }).then(function () { res(ROOT); })
          .catch(function (e) { fileHandle = prev; suggestedName = prevName; protection = prevProtection; rej(e); });
      };
      inp.click();
    });
  }

  // Create a NEW empty database.
  function newDatabase() {
    if (canAutosave) {
      return window.showSaveFilePicker({ suggestedName: DEFAULT_NAME, types: [{ description: "CRM database", accept: { "application/octet-stream": [".crmdb"] } }] })
        .then(function (h) {
          protection = null; bundle.clear();
          bundle.set("schedule.json", new Blob([JSON.stringify({ type: "patient-schedule", version: 1, dates: {} }, null, 2)]));
          opened = true; fileHandle = h; suggestedName = h.name; return idbSet("fileHandle", h);
        })
        .then(function () { return saveNow(); })
        .then(function () { return ROOT; });
    }
    protection = null;
    bundle.clear();
    bundle.set("schedule.json", new Blob([JSON.stringify({ type: "patient-schedule", version: 1, dates: {} }, null, 2)]));
    fileHandle = null; suggestedName = DEFAULT_NAME;
    opened = true;
    return serialize().then(function (blob) { return idbSet("bundle", blob); }).then(function () { return ROOT; });
  }

  // Auto-reconnect on page load: pull the working copy out of IndexedDB (both platforms),
  // and re-bind the desktop file handle if one was remembered. Returns ROOT or null.
  function stored() {
    lastOpenError = null;
    return idbGet("fileHandle").then(function (h) {
      if (h && canAutosave) fileHandle = h;
      return idbGet("bundle").then(function (blob) {
        if (blob) {
          return blob.arrayBuffer().then(ingest).then(function () { opened = true; return ROOT; });
        }
        // no working copy yet, but a desktop handle may still let us open the file later
        return (h && canAutosave) ? ROOT : null;
      });
    }).catch(function (e) { lastOpenError = e; return null; });
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
    fileHandle = null; opened = false; protection = null; clearSessionKey(); bundle.clear();
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
  // Move every patient folder for one schedule date to another date. This is deliberately a
  // bundle-prefix move (rather than looping over the visible rows) so orphaned/manual attachments
  // follow too. When merging into an existing day, the moving day's same-path file wins.
  function moveDate(root, oldDate, newDate) {
    if (!oldDate || !newDate || oldDate === newDate) return Promise.resolve({ files: 0, overwritten: 0 });
    var op = "patients/" + oldDate + "/", np = "patients/" + newDate + "/";
    var files = 0, overwritten = 0;
    Array.from(bundle.keys()).forEach(function (k) {
      if (k.indexOf(op) !== 0) return;
      var target = np + k.slice(op.length);
      if (bundle.has(target)) overwritten++;
      bundle.set(target, bundle.get(k));
      bundle.delete(k);
      files++;
    });
    if (files) persist();
    return Promise.resolve({ files: files, overwritten: overwritten });
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
    moveDate: moveDate,
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
    reloadWorkingCopy: reloadWorkingCopy,
    lastOpenError: function () { return lastOpenError; },
    enableProtection: enableProtection,
    changePassword: changePassword,
    disableProtection: disableProtection,
    lockSession: function () { clearSessionKey(); return true; },
    isEncrypted: function () { return !!protection; },
    isOpen: function () { return opened; },
    // Filename of the bound database, or null when nothing is open. Browsers do NOT
    // expose the parent folder path through the File System Access API, so this is the
    // filename only (e.g. "schedule.crmdb") — the most a web page is allowed to know.
    fileName: function () { return opened ? suggestedName : null; },
    set onStatus(fn) { statusCb = fn; },
    get onStatus() { return statusCb; },
    set onPasswordRequest(fn) { passwordCb = fn; },
    get onPasswordRequest() { return passwordCb; },
    // test hooks (used by the Node unit test; harmless in the browser)
    _bundle: bundle, _serialize: serialize, _serializeZip: serializeZip, _ingest: ingest
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.CRMWorkspace = api;
})();
