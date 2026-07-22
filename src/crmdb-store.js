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
  var conflictCb = null;      // pages set CRMWorkspace.onConflict = fn(details) -> "file"|"local"|"backup"
  var protection = null;      // { key: CryptoKey, salt: Uint8Array, iterations: number }
  var lastOpenError = null;   // retained so pages can explain a cancelled/failed quiet reopen

  // ---- cross-STATION freshness guard (the OneDrive stale-cache problem) ---------------------
  // The IndexedDB working copy is per-machine and lingers between visits. When the SAME .crmdb
  // lives on OneDrive and is edited from another station, the browser here can reopen holding a
  // cache that is OLDER than the file — and, left unchecked, flush that stale cache straight over
  // the newer file (silently reverting a day's work; this actually happened moving MP → Arcadia).
  //
  // The revision CAS above only orders two TABS on one machine; it says nothing about how this
  // machine's cache compares to a file touched elsewhere. So we additionally pin the cache to the
  // real file's last-modified time:
  //   • baseFileMod       — file.lastModified the cache is based on (persisted with the bundle);
  //   • cacheMatchesFile  — the cache equals what is on the bound file right now (no unsaved edits);
  //   • freshnessVerified — this session has compared the bound file to the cache. Until it is true
  //                         (desktop, file bound) NOTHING is written to the file, so a stale cache
  //                         can never overwrite a newer OneDrive copy before we've looked.
  // On reconnect: file newer than base + clean cache → the file wins; file newer + unsaved edits →
  // a real conflict handed to the page's onConflict.
  var META_KEY = "fileMeta";
  var baseFileMod = null;         // file.lastModified our cache is based on, or null when unknown
  var cacheMatchesFile = false;   // cache byte-for-byte equals the bound file (no unsaved edits)
  var freshnessVerified = false;  // desktop only: bound file compared to the cache this session

  // ---- cross-tab safety ------------------------------------------------------
  // Two same-origin tabs (typically Schedule + Report Generator) each hold their OWN in-memory
  // `bundle`, and a save serializes the WHOLE bundle. A plain write therefore replaces whatever
  // the other tab committed — silently reverting schedule edits, reverting a report, or outright
  // DELETING a file the other tab attached (serialize only emits paths this tab happens to hold).
  //
  // So every commit is a compare-and-swap against a revision counter stored beside the bundle:
  //   • revision unchanged (the normal case, and always when only one tab is open) → straight
  //     write, costing one extra ~0.3ms read of a tiny key;
  //   • revision moved → another tab wrote, so adopt the shared copy and replay only the paths
  //     THIS tab actually touched (`journal`) on top of it.
  // The journal is what makes the merge safe: replaying only touched paths means we never
  // resurrect a file another tab deleted, nor delete one it added.
  var journal = new Map();     // path -> Blob (written) | null (deleted), since the last commit
  var myRev = 0;               // the shared revision this tab's bundle is based on
  var authoritative = false;   // our bundle is a whole new database (opened/created) — overwrite
  var REV_KEY = "rev", BUNDLE_KEY = "bundle";
  // Record a mutation as well as applying it, so a later rebase can replay it. Any edit means the
  // cache no longer matches the bound file until the next successful write-through.
  function bset(path, blob) { bundle.set(path, blob); journal.set(path, blob); cacheMatchesFile = false; }
  function bdel(path) { var had = bundle.delete(path); journal.set(path, null); cacheMatchesFile = false; return had; }
  function applyJournal() {
    journal.forEach(function (blob, path) {
      if (blob === null) bundle.delete(path); else bundle.set(path, blob);
    });
  }
  // Our bundle is a whole database we just opened / created / re-encrypted, so it supersedes the
  // shared copy wholesale instead of merging into it. (Without this, opening a .crmdb would
  // rebase onto — and therefore keep — the working copy it was meant to replace.)
  function markAuthoritative() { journal.clear(); authoritative = true; }

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

  // Re-encryption rewrites the whole database, so these three adopt any other tab's work first
  // and then publish authoritatively. Order matters: ingest() resets `protection` from the
  // envelope it reads, so the new key can only be installed AFTER adopting.
  function enableProtection(password) {
    if (!opened) return Promise.reject(new Error("Open a database first"));
    if (!password) return Promise.reject(new Error("Password cannot be empty"));
    var c = cryptoApi(), salt = new Uint8Array(16); c.getRandomValues(salt);
    return adoptShared()
      .then(function () { return deriveMaterial(password, salt, ENC_ITERATIONS); })
      .then(function (material) {
        protection = { key: material.key, salt: salt, iterations: ENC_ITERATIONS };
        rememberSessionKey(material.raw, salt, ENC_ITERATIONS);
        markAuthoritative();
        return flush();
      }).then(function () { status("Password protection enabled · save the database", "ok"); return true; });
  }
  function changePassword(currentPassword, newPassword) {
    if (!protection) return Promise.reject(new Error("This database is not password protected"));
    if (!newPassword) return Promise.reject(new Error("New password cannot be empty"));
    return verifyPassword(currentPassword).then(function () {
      var c = cryptoApi(), salt = new Uint8Array(16); c.getRandomValues(salt);
      return adoptShared()
        .then(function () { return deriveMaterial(newPassword, salt, ENC_ITERATIONS); })
        .then(function (material) {
          protection = { key: material.key, salt: salt, iterations: ENC_ITERATIONS };
          rememberSessionKey(material.raw, salt, ENC_ITERATIONS);
          markAuthoritative();
          return flush();
        });
    }).then(function () { status("Database password changed · save the database", "ok"); return true; });
  }
  function disableProtection(password) {
    if (!protection) return Promise.resolve(false);
    return verifyPassword(password).then(function () {
      return adoptShared().then(function () {
        protection = null;
        clearSessionKey();
        markAuthoritative();
        return flush();
      });
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
  // Persist the freshness metadata beside the bundle so a later session (a reopen at this station)
  // can tell whether its cache is stale relative to the file.
  function persistMeta() { return idbSet(META_KEY, { baseFileMod: baseFileMod, cacheMatchesFile: cacheMatchesFile }); }
  function loadMeta() {
    return idbGet(META_KEY).then(function (m) {
      if (m && typeof m === "object") { baseFileMod = (m.baseFileMod == null ? null : m.baseFileMod); cacheMatchesFile = !!m.cacheMatchesFile; }
      else { baseFileMod = null; cacheMatchesFile = false; }
    });
  }

  // Publish the bundle only if the shared revision is still what we based our work on. The
  // re-read and both puts ride in ONE readwrite transaction, so a tab that commits while we were
  // busy serializing loses the race here rather than silently clobbering.
  //   → { ok:true, rev }        committed
  //   → { ok:false }            another tab moved the revision; caller rebases and retries
  //   → { ok:true, noIdb:true } no IndexedDB (Node / private mode) — nothing to race with
  function idbCas(expectedRev, blob) {
    return idb().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction("kv", "readwrite"), st = tx.objectStore("kv");
        var rq = st.get(REV_KEY), wrote = false;
        rq.onsuccess = function () {
          if ((Number(rq.result) || 0) !== expectedRev) return;   // conflict: complete without writing
          st.put(blob, BUNDLE_KEY);
          st.put(expectedRev + 1, REV_KEY);
          wrote = true;
        };
        tx.oncomplete = function () { res(wrote ? { ok: true, rev: expectedRev + 1 } : { ok: false }); };
        tx.onerror = function () { rej(tx.error); };
      });
    }).catch(function () { return { ok: true, noIdb: true }; });
  }

  /* ------------------------------------------------------------- persistence */
  // Replace our bundle with the shared working copy, then replay this tab's un-committed edits
  // on top so adopting another tab's work never drops our own.
  function adoptShared() {
    return idbGet(REV_KEY).then(function (r) {
      return idbGet(BUNDLE_KEY).then(function (blob) {
        if (!blob) return ROOT;
        return blob.arrayBuffer().then(ingest).then(function () {
          applyJournal();
          myRev = Number(r) || 0;
          opened = true;
          return ROOT;
        });
      });
    });
  }

  // The one write path. Rebases onto the shared copy when another tab has committed, then
  // compare-and-swaps. Returns the committed blob (or null when there was nothing to write).
  var COMMIT_RETRIES = 3;
  function commit() {
    // Nothing of ours to publish: don't touch the shared copy at all. This is what stops an
    // idle tab's flush (e.g. on navigation) from re-publishing its stale bundle over newer work.
    if (!opened) return Promise.resolve(null);
    if (!journal.size && !authoritative) return Promise.resolve(null);
    var tries = 0;
    function attempt() {
      return idbGet(REV_KEY).then(function (r) {
        var shared = Number(r) || 0;
        // authoritative = we just opened/created a whole database; ours is the truth by intent.
        var stale = !authoritative && journal.size && shared !== myRev;
        return (stale ? adoptShared() : Promise.resolve()).then(function () {
          return serialize().then(function (blob) {
            return idbCas(shared, blob).then(function (res) {
              if (!res.ok) {                       // another tab committed mid-serialize
                if (++tries >= COMMIT_RETRIES) return null;
                return attempt();
              }
              if (!res.noIdb) myRev = res.rev;
              journal.clear();
              authoritative = false;
              // Persist the freshness flags alongside the committed bundle so a later reopen knows
              // whether this cache carries edits the bound file doesn't have yet.
              return persistMeta().then(function () { return blob; });
            });
          });
        });
      });
    }
    return attempt();
  }

  // Write the committed bytes out to the bound .crmdb (desktop autosave only).
  function writeThroughToFile(blob, loud) {
    if (!blob || !fileHandle || !canAutosave) return Promise.resolve();
    // Never write to the file until this session has confirmed our cache isn't an older copy than
    // what's on disk. This is the guard that stops a stale station cache clobbering newer OneDrive
    // data before the reconnect freshness check has had a chance to run.
    if (!freshnessVerified) { if (loud) status("Reconnect the database before saving — it hasn't been verified against the file yet", "warn"); return Promise.resolve(); }
    return fileHandle.createWritable()
      .then(function (w) { return w.write(blob).then(function () { return w.close(); }); })
      .then(function () { return fileHandle.getFile(); })
      // We are now the file's contents, so pin the base to the file's fresh mtime.
      .then(function (f) { baseFileMod = f.lastModified; cacheMatchesFile = true; return persistMeta(); })
      .then(function () { if (loud) status("Saved ✓", "ok"); })
      .catch(function (e) { if (loud) status("Save failed: " + e.message, "warn"); });
  }

  // Every write goes here: commit to the shared IndexedDB copy and, on desktop, autosave to the
  // bound .crmdb file — both debounced so bursts of edits coalesce.
  function persist() {
    if (!opened) return;
    clearTimeout(persistTimer);
    persistTimer = setTimeout(function () {
      commit().then(function (blob) {
        if (!blob) return;
        if (fileHandle && canAutosave) return writeThroughToFile(blob, true);
        status("Unsaved — tap Save database updates", "warn");
      });
    }, 1200);
  }

  // Flush the working copy to IndexedDB (and the desktop file) immediately — NO download.
  // Used before navigating between the two pages so the handoff carries the latest edits.
  function flush() {
    clearTimeout(persistTimer);
    if (!opened) return Promise.resolve();
    return commit().then(function (blob) { return writeThroughToFile(blob, false); });
  }

  // Refresh this tab's in-memory bundle from the latest IndexedDB working copy. Schedule uses
  // this after another open tab commits a newer revision, preventing stale-tab overwrites.
  function reloadWorkingCopy() { return adoptShared(); }

  /* -------------------------------------------------- cross-station freshness check */
  function backupStamp() {
    var d = new Date(), p = function (n) { return (n < 10 ? "0" : "") + n; };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }
  // Serialize the CURRENT cache (before we discard it) and hand it to the user as a separate file,
  // so a conflicting local copy is never simply thrown away.
  function backupCurrentCache() {
    return serialize().then(function (blob) {
      var base = (suggestedName || DEFAULT_NAME).replace(/\.crmdb$/i, "");
      return shareOrDownload(blob, base + ".conflict-" + backupStamp() + ".crmdb");
    });
  }
  // Replace our cache with the file's bytes and publish it as the authoritative working copy.
  function adoptFile(f) {
    return f.arrayBuffer().then(ingest).then(function () {
      markAuthoritative();
      baseFileMod = f.lastModified; cacheMatchesFile = true; freshnessVerified = true;
      return persistMeta().then(function () { return commit(); });
    });
  }
  // A true conflict: the file moved AND our cache has unsaved edits. Ask the page which wins.
  function resolveConflict(f) {
    var details = { fileName: suggestedName, fileModified: f.lastModified };
    var ask = conflictCb ? Promise.resolve().then(function () { return conflictCb(details); })
                         : Promise.resolve("file");   // no handler wired → safest default is the file
    return ask.then(function (choice) {
      if (choice === "local") {
        // Keep our cache and let it overwrite the file on the next save. Reconcile the base so we
        // don't re-prompt, and leave it marked dirty-vs-file so a save is actually written out.
        baseFileMod = f.lastModified; cacheMatchesFile = false; freshnessVerified = true;
        markAuthoritative();
        return persistMeta().then(function () { return { decision: "local" }; });
      }
      if (choice === "backup") {
        return backupCurrentCache().then(function () { return adoptFile(f); }).then(function () { return { decision: "backup" }; });
      }
      return adoptFile(f).then(function () { return { decision: "file" }; });   // "file" / anything else
    });
  }
  // Compare the bound file to our cache and settle who is authoritative. Desktop-only; everything
  // without a real file handle (iPad, Node) is trivially "fresh" — the cache IS the database there.
  // Rejects if the file can't be read yet (permission not granted), leaving freshnessVerified false
  // so autosave stays blocked until a real reconnect.
  function verifyFreshness() {
    if (!fileHandle || !canAutosave) { freshnessVerified = true; return Promise.resolve({ decision: "cache" }); }
    return fileHandle.getFile().then(function (f) {
      // File unchanged since our cache was based on it → the cache is at least as new. Trust it.
      if (baseFileMod != null && f.lastModified <= baseFileMod) { freshnessVerified = true; return { decision: "cache" }; }
      // File is newer than the state our cache was based on (edited from another station, or a
      // OneDrive sync brought a newer copy down). No unsaved edits here → the file simply wins.
      if (cacheMatchesFile) return adoptFile(f).then(function () { return { decision: "file" }; });
      // Newer file AND unsaved local edits → real conflict.
      return resolveConflict(f);
    });
  }

  // Explicit save (the separate button). Desktop: flush to file now. iPad: download.
  function saveNow() {
    if (!opened) return Promise.resolve();
    clearTimeout(persistTimer);
    // Goes through the same rebase + compare-and-swap as any other save. When we have nothing of
    // our own to publish, adopt the shared copy first so Save writes the NEWEST bytes to the
    // USB/file rather than this tab's possibly-stale ones.
    return commit().then(function (blob) {
      return blob || adoptShared().then(serialize);
    }).then(function (blob) {
      if (fileHandle && canAutosave) {
        // Same guard as the autosave path: an unverified session must not write to the file.
        if (!freshnessVerified) { status("Reconnect the database before saving — it hasn't been verified against the file yet", "warn"); return; }
        return fileHandle.createWritable().then(function (w) { return w.write(blob).then(function () { return w.close(); }); })
          .then(function () { return fileHandle.getFile(); })
          .then(function (f) { baseFileMod = f.lastModified; cacheMatchesFile = true; return persistMeta(); })
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
          close: function () { bset(path, new Blob(chunks)); persist(); return Promise.resolve(); }
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
    if (!bundle.has("schedule.json")) bset("schedule.json", new Blob([JSON.stringify({ type: "patient-schedule", version: 1, dates: {} }, null, 2)]));
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
          // BUT only when this session is verified — an unverified cache may be an old station copy,
          // and writing it back here is exactly how a stale reconnect overwrote OneDrive before.
          var prev = fileHandle, prevName = suggestedName, prevProtection = protection;
          var next = hs[0];
          var saveOld = (opened && prev && canAutosave && freshnessVerified)
            ? serialize().then(function (blob) {
                return prev.createWritable().then(function (w) { return w.write(blob).then(function () { return w.close(); }); });
              }).catch(function () {})
            : Promise.resolve();
          return saveOld.then(function () {
            clearTimeout(persistTimer);
            suggestedName = next.name;
            return next.getFile();
          }).then(function (f) {
            var mod = f.lastModified;
            return f.arrayBuffer().then(ingest).then(function () {
              fileHandle = next;
              // We just read the file, so the cache equals it exactly and this session is verified.
              baseFileMod = mod; cacheMatchesFile = true; freshnessVerified = true;
            }).catch(function (e) { fileHandle = prev; suggestedName = prevName; protection = prevProtection; throw e; });
          })
            .then(function () { return idbSet("fileHandle", fileHandle); })
            // Keep an immediately reopenable working copy. Waiting for the next edit used to
            // leave refresh/page handoff with only a permission-gated file handle and no data.
            .then(function () { opened = true; markAuthoritative(); return persistMeta().then(commit); })
            .then(function () { return ROOT; });
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
          freshnessVerified = true; baseFileMod = null; cacheMatchesFile = true;  // iPad: the cache IS the database
          markAuthoritative();
          return commit();
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
          opened = true; fileHandle = h; suggestedName = h.name;
          // Brand-new file we are about to author: verified by construction, so saveNow may write it.
          freshnessVerified = true; baseFileMod = null; cacheMatchesFile = false;
          markAuthoritative();                  // a brand-new database replaces the working copy
          return idbSet("fileHandle", h);
        })
        .then(function () { return saveNow(); })
        .then(function () { return ROOT; });
    }
    protection = null;
    bundle.clear();
    bundle.set("schedule.json", new Blob([JSON.stringify({ type: "patient-schedule", version: 1, dates: {} }, null, 2)]));
    fileHandle = null; suggestedName = DEFAULT_NAME;
    opened = true;
    freshnessVerified = true; baseFileMod = null; cacheMatchesFile = true;
    markAuthoritative();
    return commit().then(function () { return ROOT; });
  }

  // Auto-reconnect on page load: pull the working copy out of IndexedDB (both platforms),
  // and re-bind the desktop file handle if one was remembered. Returns ROOT or null.
  function stored() {
    lastOpenError = null;
    return idbGet("fileHandle").then(function (h) {
      if (h && canAutosave) fileHandle = h;
      return loadMeta().then(function () {
        // Desktop with a bound file must prove its cache isn't stale (verifyFreshness) before any
        // save; iPad/no-handle has no file to compare against, so its copy is trivially current.
        freshnessVerified = !(fileHandle && canAutosave);
        return idbGet(BUNDLE_KEY).then(function (blob) {
          if (blob) {
            // Adopting the shared copy: record which revision we're based on, so the first save
            // knows whether anyone else has moved since.
            return idbGet(REV_KEY).then(function (r) {
              return blob.arrayBuffer().then(ingest).then(function () {
                opened = true; myRev = Number(r) || 0; journal.clear(); authoritative = false;
                return ROOT;
              });
            });
          }
          // no working copy yet, but a desktop handle may still let us open the file later
          return (h && canAutosave) ? ROOT : null;
        });
      });
    }).catch(function (e) { lastOpenError = e; return null; });
  }

  // Load the bound file as the working copy (used when permission is (re)granted and we had no
  // cache). Reading the file is itself a verification, so this pins the base and clears the gate.
  function readFromFile() { return fileHandle.getFile().then(function (f) { return adoptFile(f); }); }

  function permission(root, ask) {
    if (fileHandle && canAutosave && fileHandle.queryPermission) {
      return fileHandle.queryPermission({ mode: "readwrite" }).then(function (p) {
        if (p !== "granted" && ask && fileHandle.requestPermission) {
          return fileHandle.requestPermission({ mode: "readwrite" }).then(function (p2) {
            if (p2 === "granted" && !opened) return readFromFile().then(function () { return "granted"; });
            return p2;
          });
        }
        if (p === "granted" && !opened) return readFromFile().then(function () { return "granted"; });
        return p;
      });
    }
    return Promise.resolve(opened ? "granted" : "granted");   // iPad: the in-memory bundle is the copy
  }

  function forget() {
    clearTimeout(persistTimer);
    fileHandle = null; opened = false; protection = null; clearSessionKey(); bundle.clear();
    // Drop any pending edits with the database — nothing may be replayed into the next one.
    journal.clear(); authoritative = false; myRev = 0;
    baseFileMod = null; cacheMatchesFile = false; freshnessVerified = false;
    return Promise.all([idbDel("fileHandle"), idbDel(BUNDLE_KEY), idbDel(REV_KEY), idbDel(META_KEY)]).then(function () {});
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
    bset(dir.prefix + name, toBlob(data));
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
    var had = bdel(slotPrefix(date, slot) + name);
    if (had) persist();
    return Promise.resolve(had);
  }
  // Remove every file in one patient's slot (used when a patient is deleted from the schedule).
  function removeSlotFiles(root, date, slot) {
    var pre = slotPrefix(date, slot), removed = 0;
    Array.from(bundle.keys()).forEach(function (k) { if (k.indexOf(pre) === 0) { bdel(k); removed++; } });
    if (removed) persist();
    return Promise.resolve(removed);
  }
  // Retention: drop every patient file whose date is strictly before cutISO (YYYY-MM-DD).
  // Catches orphaned files too (dates no longer in the schedule), so the database stays bounded.
  function pruneFilesBefore(cutISO) {
    var removed = 0, bytes = 0;
    Array.from(bundle.keys()).forEach(function (path) {
      var m = /^patients\/(\d{4}-\d{2}-\d{2})\//.exec(path);
      if (m && m[1] < cutISO) { var b = bundle.get(path); bytes += (b && b.size) || 0; bdel(path); removed++; }
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
      if (k.indexOf(op) === 0) { bset(np + k.slice(op.length), bundle.get(k)); bdel(k); moved = true; }
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
      bset(target, bundle.get(k));
      bdel(k);
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
    verifyFreshness: verifyFreshness,
    isVerified: function () { return freshnessVerified; },
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
    // Pages set this to resolve a true reconnect conflict (newer file AND unsaved local edits).
    // fn(details) -> "file" (take OneDrive), "local" (keep this station), "backup" (save local
    // copy aside, then take the file). Returning nothing defaults to "file".
    set onConflict(fn) { conflictCb = fn; },
    get onConflict() { return conflictCb; },
    // test hooks (used by the Node unit test; harmless in the browser)
    _bundle: bundle, _serialize: serialize, _serializeZip: serializeZip, _ingest: ingest,
    _markAuthoritativeForTest: markAuthoritative, _journal: journal,
    _setFileHandleForTest: function (h) { fileHandle = h; }, _metaForTest: function () { return { baseFileMod: baseFileMod, cacheMatchesFile: cacheMatchesFile, freshnessVerified: freshnessVerified }; }
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.CRMWorkspace = api;
})();
