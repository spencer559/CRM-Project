/* crm-native-shim.js — injected by the iPad/iPhone app into every frame at document start.
 *
 * WebKit has no File System Access API, so in iPad Safari crmdb-store.js falls back to a manual
 * Save through the share sheet. This supplies the subset of that API the pages use —
 * showOpenFilePicker / showSaveFilePicker / showDirectoryPicker, file handles with getFile /
 * createWritable / queryPermission / requestPermission, and folder handles with getDirectoryHandle /
 * getFileHandle (so "Download patients" writes real folders, not a .zip) — backed by the app's native
 * document pickers and
 * security-scoped bookmarks (NativeBridge.swift). With it present crmdb-store takes its desktop
 * path unchanged: the .crmdb picked from On My iPad, iCloud Drive or a USB stick is bound and
 * autosaved in place.
 *
 * It also routes printing to the native print sheet, since WKWebView ignores window.print().
 * Writes cross the bridge as base64 in chunks (message bodies can't carry binary); reads come
 * back as binary from crmapp://app/__native/file, which is far cheaper for a database-sized file.
 */
(function (root) {
  "use strict";
  var handlers = root.webkit && root.webkit.messageHandlers;
  if (!handlers || !handlers.crmNative || root.CRMNative) return;
  var bridge = handlers.crmNative;
  var CHUNK = 3 * 1024 * 1024;   // bytes per bridge message, on the write side (base64-encoded)
  // Reads come back over the app's own origin as binary instead. Same origin as the pages, so no
  // CORS; served by BundleSchemeHandler.
  var FILE_URL = "crmapp://app/__native/file";

  function domError(name, message) {
    try { return new DOMException(message || name, name); }
    catch (e) { var err = new Error(message || name); err.name = name; return err; }
  }
  function call(op, args) {
    var msg = args || {};
    msg.op = op;
    return Promise.resolve(bridge.postMessage(msg)).then(function (r) {
      if (r && r.error) throw domError(r.name || "NotReadableError", r.error);
      return r || {};
    });
  }

  function bytesToBase64(bytes) {
    var bin = "";
    for (var i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }
  function base64ToBytes(b64) {
    var bin = atob(b64 || ""), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function concat(chunks, size) {
    if (chunks.length === 1) return chunks[0];
    var out = new Uint8Array(size), at = 0;
    chunks.forEach(function (c) { out.set(c, at); at += c.length; });
    return out;
  }
  // A single entry name, as the File System Access API allows it: nothing that could climb out of
  // the folder the user picked. (The native side checks again.)
  function checkName(name) {
    if (typeof name !== "string" || !name || name === "." || name === ".." || /[\/\\]/.test(name)) {
      throw new TypeError("Name is not allowed.");
    }
    return name;
  }
  function join(path, name) { return path ? path + "/" + name : name; }
  function blobToBase64(blob) {
    return blob.arrayBuffer().then(function (buf) { return bytesToBase64(new Uint8Array(buf)); });
  }

  // "token\npath" -> { blob, size, lastModified }. crmdb-store re-reads the file right after saving it (to
  // pin the modification time); when the file is exactly as we last wrote or read it, hand back
  // those bytes instead of pulling the whole database across the bridge again.
  var cache = Object.create(null);

  // Methods live on the prototype so a handle survives IndexedDB's structured clone as plain data
  // ({kind, name, crmNativeToken, crmNativePath}); CRMNative.rehydrate turns that back into a working
  // handle. The token is a bookmark to what the user picked — a file, or a folder; crmNativePath is
  // where this entry sits inside that folder ("" for the picked item itself).
  function NativeFileHandle(token, name, path) {
    this.kind = "file";
    this.name = name;
    this.crmNativeToken = token;
    this.crmNativePath = path || "";
  }
  // The file's metadata on its own, without materialising a byte of it. crmdb-store's freshness
  // check only ever compares lastModified, and on desktop getFile() is lazy so that costs nothing;
  // here it would have pulled the whole database across for a number it then throws away.
  NativeFileHandle.prototype.crmNativeStat = function () {
    return call("stat", { token: this.crmNativeToken, path: this.crmNativePath });
  };
  // The fast path: one streamed binary response from the app's own origin.
  function fetchBytes(token, path, st) {
    var url = FILE_URL + "?token=" + encodeURIComponent(token) +
              "&path=" + encodeURIComponent(path) +
              "&v=" + encodeURIComponent(st.lastModified + "-" + st.size);
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error("native file route: HTTP " + r.status);
      return r.blob();
    });
  }
  // The fallback: base64 through the message bridge, a CHUNK at a time. This is what the app
  // shipped on for months, and it is kept because the fast path can be unavailable for reasons
  // that have nothing to do with the file — a page whose Content-Security-Policy forbids
  // connect-src, or a WebKit that declines the custom scheme. Slower, but it always works, and a
  // database that will not open is far worse than one that opens slowly. A file that is genuinely
  // unreachable fails here too, with the native side's own wording.
  function readBytes(token, path, st) {
    var parts = [], offset = 0;
    function next() {
      if (offset >= st.size) return new Blob(parts);
      return call("read", { token: token, path: path, offset: offset, length: CHUNK }).then(function (r) {
        var bytes = base64ToBytes(r.data);
        if (!bytes.length) { st.size = offset; return next(); }   // file shrank underneath us
        parts.push(bytes); offset += bytes.length;
        return next();
      });
    }
    return Promise.resolve().then(next);
  }
  NativeFileHandle.prototype.getFile = function () {
    var token = this.crmNativeToken, path = this.crmNativePath, key = token + "\n" + path;
    return call("stat", { token: token, path: path }).then(function (st) {
      var hit = cache[key];
      if (hit && hit.size === st.size && hit.lastModified === st.lastModified) {
        return new File([hit.blob], st.name, { lastModified: st.lastModified });
      }
      // The stat above is what tells the native side which file this token means, so it always
      // runs before either transport.
      return fetchBytes(token, path, st).catch(function () {
        return readBytes(token, path, st);
      }).then(function (blob) {
        var file = new File([blob], st.name, { lastModified: st.lastModified });
        cache[key] = { blob: file, size: file.size, lastModified: st.lastModified };
        return file;
      });
    });
  };
  // Every writer in the pages replaces the whole file, so the stream just collects what it is given
  // and sends it on close(); nothing touches the file until then (as with Chrome's swap file).
  NativeFileHandle.prototype.createWritable = function () {
    var token = this.crmNativeToken, path = this.crmNativePath, key = token + "\n" + path;
    var parts = [], done = false;
    function add(data) {
      if (data && (data.type === "write" || data.type === "seek" || data.type === "truncate") && !(typeof data.size === "number" && typeof data.slice === "function")) {
        if (data.type === "truncate") { if (!data.size) parts = []; return; }
        if (data.type === "seek") return;
        data = data.data;
      }
      parts.push(data);
    }
    return Promise.resolve({
      write: function (data) { add(data); return Promise.resolve(); },
      truncate: function (size) { if (!size) parts = []; return Promise.resolve(); },
      seek: function () { return Promise.resolve(); },
      abort: function () { done = true; parts = []; return Promise.resolve(); },
      close: function () {
        if (done) return Promise.reject(domError("InvalidStateError", "The stream is already closed."));
        done = true;
        var blob = new Blob(parts); parts = [];
        return call("writeBegin", { token: token, path: path }).then(function (w) {
          // Streamed rather than sliced: the store hands over its zero-copy container (a blob of
          // slices of the opened file), and Node 18's Blob returns wrong bytes when such a blob is
          // sliced again. Either way only about one CHUNK of the database is in flight at a time.
          var reader = blob.stream().getReader(), pending = [], pendingSize = 0;
          function send() {
            var bytes = concat(pending, pendingSize); pending = []; pendingSize = 0;
            return call("writeChunk", { session: w.session, data: bytesToBase64(bytes) });
          }
          function pump() {
            return reader.read().then(function (r) {
              if (r.done) {
                return (pendingSize ? send() : Promise.resolve()).then(function () {
                  return call("writeCommit", { session: w.session });
                });
              }
              pending.push(r.value); pendingSize += r.value.length;
              return (pendingSize >= CHUNK ? send() : Promise.resolve()).then(pump);
            });
          }
          return pump().catch(function (e) {
            call("writeAbort", { session: w.session }).catch(function () {});
            throw e;
          });
        }).then(function (st) {
          cache[key] = { blob: blob, size: st.size, lastModified: st.lastModified };
        });
      }
    });
  };
  // "granted" while the bookmarked file is reachable; "prompt" when it isn't (e.g. the USB stick is
  // unplugged) so the page offers Reconnect instead of treating the database as gone.
  NativeFileHandle.prototype.queryPermission = function () {
    return call("permission", { token: this.crmNativeToken }).then(function (r) { return r.state; });
  };
  NativeFileHandle.prototype.requestPermission = NativeFileHandle.prototype.queryPermission;
  NativeFileHandle.prototype.isSameEntry = function (other) {
    return Promise.resolve(!!other && other.kind === this.kind && other.crmNativeToken === this.crmNativeToken &&
      (other.crmNativePath || "") === this.crmNativePath);
  };

  // A folder the user picked, or one inside it. Entries are created or found natively; the handles
  // this returns reach them through the picked folder's bookmark plus a relative path.
  function NativeDirectoryHandle(token, name, path) {
    this.kind = "directory";
    this.name = name;
    this.crmNativeToken = token;
    this.crmNativePath = path || "";
  }
  function dirEntry(dir, name, kind, opts) {
    try { checkName(name); } catch (e) { return Promise.reject(e); }
    return call("dirEntry", {
      token: dir.crmNativeToken, path: dir.crmNativePath, name: name, kind: kind, create: !!(opts && opts.create)
    });
  }
  NativeDirectoryHandle.prototype.getDirectoryHandle = function (name, opts) {
    var dir = this;
    return dirEntry(dir, name, "directory", opts).then(function () {
      return new NativeDirectoryHandle(dir.crmNativeToken, name, join(dir.crmNativePath, name));
    });
  };
  NativeDirectoryHandle.prototype.getFileHandle = function (name, opts) {
    var dir = this;
    return dirEntry(dir, name, "file", opts).then(function () {
      return new NativeFileHandle(dir.crmNativeToken, name, join(dir.crmNativePath, name));
    });
  };
  NativeDirectoryHandle.prototype.queryPermission = NativeFileHandle.prototype.queryPermission;
  NativeDirectoryHandle.prototype.requestPermission = NativeFileHandle.prototype.queryPermission;
  NativeDirectoryHandle.prototype.isSameEntry = NativeFileHandle.prototype.isSameEntry;

  root.showOpenFilePicker = function (opts) {
    return call("pickOpen", { multiple: !!(opts && opts.multiple) }).then(function (r) {
      return r.files.map(function (f) { return new NativeFileHandle(f.token, f.name); });
    });
  };
  root.showSaveFilePicker = function (opts) {
    return call("pickSave", { suggestedName: (opts && opts.suggestedName) || "Untitled" }).then(function (f) {
      return new NativeFileHandle(f.token, f.name);
    });
  };

  root.showDirectoryPicker = function () {
    return call("pickFolder").then(function (f) { return new NativeDirectoryHandle(f.token, f.name, ""); });
  };

  function fire(name) {
    try { root.dispatchEvent(new Event(name)); } catch (e) {}
  }
  root.print = function () {
    fire("beforeprint");
    call("printPage").catch(function () {}).then(function () { fire("afterprint"); });
  };

  root.CRMNative = {
    NativeFileHandle: NativeFileHandle,
    NativeDirectoryHandle: NativeDirectoryHandle,
    rehydrate: function (h) {
      if (!h || !h.crmNativeToken || h instanceof NativeFileHandle || h instanceof NativeDirectoryHandle) return h;
      return h.kind === "directory"
        ? new NativeDirectoryHandle(h.crmNativeToken, h.name, h.crmNativePath)
        : new NativeFileHandle(h.crmNativeToken, h.name, h.crmNativePath);
    },
    // WKWebView can't print a PDF sitting in a frame, so PDF bytes go straight to the print sheet.
    printPdf: function (data) {
      return blobToBase64(new Blob([data], { type: "application/pdf" })).then(function (b64) {
        return call("printPdf", { data: b64 });
      });
    }
  };

  // The Schedule's header links to pages that aren't part of the offline app.
  if (typeof document !== "undefined" && document.addEventListener) {
    document.addEventListener("DOMContentLoaded", function () {
      var style = document.createElement("style");
      style.textContent = 'a[href="../mileage/"],a[href="dashboard.html"],a[href="index.html"]{display:none!important}';
      (document.head || document.documentElement).appendChild(style);
      // On an iPhone, WebKit zooms the whole page into any field whose text is under 16px, and the
      // Report Generator's measurement tables are 10px: every tap on one left the page zoomed in,
      // with the report panel's own controls off screen. maximum-scale=1 stops that zoom, and pinch
      // zoom still works because WebViewController sets ignoresViewportScaleLimits. Only the top
      // page's viewport counts (a frame's is ignored). iPad never zooms to a focused field, and the
      // website keeps its own viewport: this runs only inside the app.
      var viewport = root.top === root && document.querySelector && document.querySelector('meta[name="viewport"]');
      if (viewport && !/maximum-scale/.test(viewport.content)) viewport.content += ", maximum-scale=1";
    });
  }
})(typeof window !== "undefined" ? window : globalThis);
