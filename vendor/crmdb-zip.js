/* crmdb-zip.js — tiny, dependency-free ZIP reader/writer for the .crmdb container.
 *
 * Why hand-rolled instead of JSZip: the schedule/report pages run under a strict CSP
 * (script-src 'self'; connect-src 'none'), so no CDN and no network. This file is
 * self-hosted and does everything the container model needs and nothing else.
 *
 *   CRMDB.write(entries)      -> Blob        (STORE / no compression; universally readable)
 *   CRMDB.read(arrayBuffer)   -> Promise<entries>
 *
 * where entries is [{ name: "patients/2026-07-13/0800_JS/notes.txt", data: Uint8Array|string }, ...]
 *
 * The output is a standard .zip: a .crmdb can be renamed to .zip and opened in Finder or
 * Windows Explorer for recovery. On read we handle STORE directly and DEFLATE via the
 * browser's built-in DecompressionStream when a bundle was produced elsewhere.
 */
(function () {
  "use strict";

  var te = new TextEncoder();
  var td = new TextDecoder();

  /* ---- CRC-32 (IEEE 802.3), table-driven ---- */
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(u8) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function toU8(data) {
    if (data == null) return new Uint8Array(0);
    if (typeof data === "string") return te.encode(data);
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    throw new Error("crmdb: unsupported entry data type");
  }

  /* DOS date/time from a JS Date (local). Times before 1980 clamp to 1980-01-01. */
  function dosDateTime(d) {
    d = d || new Date();
    var y = d.getFullYear();
    if (y < 1980) return { time: 0, date: 0x21 };
    var time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    var date = ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time: time & 0xFFFF, date: date & 0xFFFF };
  }

  /* ------------------------------------------------------------------ WRITE */
  function write(entries, opts) {
    opts = opts || {};
    var dt = dosDateTime(opts.date);
    var chunks = [];         // Uint8Array pieces, concatenated at the end
    var central = [];        // central-directory records
    var offset = 0;          // running offset of the next local header

    function push(u8) { chunks.push(u8); offset += u8.length; }

    entries.forEach(function (e) {
      var nameBytes = te.encode(e.name);
      var body = toU8(e.data);
      var crc = crc32(body);

      // ---- local file header (30 bytes + name) ----
      var lh = new Uint8Array(30 + nameBytes.length);
      var v = new DataView(lh.buffer);
      v.setUint32(0, 0x04034b50, true);   // signature
      v.setUint16(4, 20, true);           // version needed
      v.setUint16(6, 0x0800, true);       // flags: UTF-8 filename
      v.setUint16(8, 0, true);            // method: STORE
      v.setUint16(10, dt.time, true);
      v.setUint16(12, dt.date, true);
      v.setUint32(14, crc, true);
      v.setUint32(18, body.length, true); // compressed size (== raw for STORE)
      v.setUint32(22, body.length, true); // uncompressed size
      v.setUint16(26, nameBytes.length, true);
      v.setUint16(28, 0, true);           // extra length
      lh.set(nameBytes, 30);

      var localOffset = offset;
      push(lh);
      push(body);

      // ---- central directory record (46 bytes + name) ----
      var cd = new Uint8Array(46 + nameBytes.length);
      var cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);  // signature
      cv.setUint16(4, 20, true);          // version made by
      cv.setUint16(6, 20, true);          // version needed
      cv.setUint16(8, 0x0800, true);      // flags: UTF-8
      cv.setUint16(10, 0, true);          // method: STORE
      cv.setUint16(12, dt.time, true);
      cv.setUint16(14, dt.date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, body.length, true);
      cv.setUint32(24, body.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);          // extra length
      cv.setUint16(32, 0, true);          // comment length
      cv.setUint16(34, 0, true);          // disk number start
      cv.setUint16(36, 0, true);          // internal attrs
      cv.setUint32(38, 0, true);          // external attrs
      cv.setUint32(42, localOffset, true);
      cd.set(nameBytes, 46);
      central.push(cd);
    });

    // ---- central directory + EOCD ----
    var cdStart = offset;
    central.forEach(push);
    var cdSize = offset - cdStart;

    var eocd = new Uint8Array(22);
    var ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);                    // disk number
    ev.setUint16(6, 0, true);                    // disk with CD
    ev.setUint16(8, entries.length, true);       // entries on this disk
    ev.setUint16(10, entries.length, true);      // total entries
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, cdStart, true);
    ev.setUint16(20, 0, true);                   // comment length
    push(eocd);

    return new Blob(chunks, { type: "application/octet-stream" });
  }

  /* ------------------------------------------------------------------- READ */
  function inflateRaw(u8) {
    if (typeof DecompressionStream === "undefined")
      return Promise.reject(new Error("crmdb: this bundle uses compression this browser can't read"));
    var ds = new DecompressionStream("deflate-raw");
    var stream = new Blob([u8]).stream().pipeThrough(ds);
    return new Response(stream).arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
  }

  function read(arrayBuffer, opts) {
    opts = opts || {};
    var buf = arrayBuffer instanceof Uint8Array
      ? arrayBuffer
      : new Uint8Array(arrayBuffer);
    var dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

    // locate End Of Central Directory by scanning backwards for its signature
    var eocd = -1;
    for (var i = buf.length - 22; i >= 0; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return Promise.reject(new Error("crmdb: not a valid bundle (no EOCD)"));

    var total = dv.getUint16(eocd + 10, true);
    var cdOffset = dv.getUint32(eocd + 16, true);

    var records = [];
    var p = cdOffset;
    for (var n = 0; n < total; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) return Promise.reject(new Error("crmdb: corrupt central directory"));
      var method = dv.getUint16(p + 10, true);
      var compSize = dv.getUint32(p + 20, true);
      var nameLen = dv.getUint16(p + 28, true);
      var extraLen = dv.getUint16(p + 30, true);
      var commentLen = dv.getUint16(p + 32, true);
      var localOff = dv.getUint32(p + 42, true);
      var name = td.decode(buf.subarray(p + 46, p + 46 + nameLen));
      records.push({ name: name, method: method, compSize: compSize, localOff: localOff });
      p += 46 + nameLen + extraLen + commentLen;
    }

    return Promise.all(records.map(function (r) {
      // jump to the local header to find where the data actually starts
      var lhNameLen = dv.getUint16(r.localOff + 26, true);
      var lhExtraLen = dv.getUint16(r.localOff + 28, true);
      var dataStart = r.localOff + 30 + lhNameLen + lhExtraLen;
      var raw = buf.subarray(dataStart, dataStart + r.compSize);
      var isDir = /\/$/.test(r.name);
      if (isDir) return Promise.resolve(null);
      if (r.method === 0) return Promise.resolve({ name: r.name, data: raw.slice() });
      if (r.method === 8) return inflateRaw(raw).then(function (d) { return { name: r.name, data: d }; });
      return Promise.reject(new Error("crmdb: unsupported compression method " + r.method + " in " + r.name));
    })).then(function (list) { return list.filter(Boolean); });
  }

  /* small convenience: text <-> bytes */
  function encodeText(s) { return te.encode(s); }
  function decodeText(u8) { return td.decode(u8); }

  var api = { write: write, read: read, crc32: crc32, encodeText: encodeText, decodeText: decodeText };
  if (typeof module !== "undefined" && module.exports) module.exports = api;   // Node tests
  if (typeof window !== "undefined") window.CRMDB = api;                        // browser
})();
