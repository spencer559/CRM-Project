/* Abbott Merlin .log byte-preserving redaction helpers.
 *
 * The format is code <FS> name <FS> value <FS> unit <FS>, where FS is 0x1C.
 * Only selected VALUE byte ranges are replaced. Every other byte — BOM, line endings,
 * delimiters, encoding, and unknown/control bytes — is copied from the original verbatim.
 */
(function (global) {
  'use strict';

  var FS = 0x1c;

  function asBytes(input) { return input instanceof Uint8Array ? input : new Uint8Array(input); }

  function detectEncoding(input) {
    var b = asBytes(input);
    if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return 'utf-8';
    if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return 'utf-16le';
    if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return 'utf-16be';
    var evenZero = 0, oddZero = 0, n = Math.min(b.length, 512);
    for (var i = 0; i < n; i++) { if (b[i] === 0) { if (i % 2) oddZero++; else evenZero++; } }
    if (oddZero > Math.max(3, evenZero * 3)) return 'utf-16le';
    if (evenZero > Math.max(3, oddZero * 3)) return 'utf-16be';
    return 'utf-8';
  }

  function seq(code, enc) {
    if (enc === 'utf-16le') return [code, 0];
    if (enc === 'utf-16be') return [0, code];
    return [code];
  }

  function findSeq(bytes, needle, start, end, aligned) {
    for (var i = start; i + needle.length <= end; i += aligned) {
      var ok = true;
      for (var j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) { ok = false; break; }
      if (ok) return i;
    }
    return -1;
  }

  function decodeRange(bytes, start, end, enc) {
    var view = bytes.slice(start, end);
    try { return new TextDecoder(enc).decode(view).replace(/^\uFEFF/, ''); }
    catch (e) { return new TextDecoder('utf-8').decode(view).replace(/^\uFEFF/, ''); }
  }

  function encodeText(text, enc) {
    text = String(text == null ? '' : text);
    if (enc === 'utf-8') return new TextEncoder().encode(text);
    var out = new Uint8Array(text.length * 2), le = enc === 'utf-16le';
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      out[i * 2] = le ? (c & 255) : (c >> 8);
      out[i * 2 + 1] = le ? (c >> 8) : (c & 255);
    }
    return out;
  }

  var SENSITIVE_CODES = {
    '202': true,  // device serial number
    '204': true,  // patient ID
    '2430': true, // patient name
    '2431': true, // date of birth
    '2432': true, // physician
    '2468': true, // atrial lead serial number
    '2469': true, // RV lead serial number (format variant)
    '2470': true, // RV lead serial number
    '2471': true  // LV lead serial number
  };

  function isSensitive(name, code) {
    return !!SENSITIVE_CODES[String(code)] || /patient.*(?:name|id|birth|number)|(?:name|id|birth|number).*patient|medical\s*record|\bmrn\b|physician|doctor|provider|hospital|clinic|facility|address|phone|e-?mail|serial\s*(?:number|#)/i.test(String(name));
  }

  function maskAlphaNum(value) {
    return String(value).replace(/[A-Za-z]/g, 'X').replace(/\d/g, '0');
  }

  function defaultReplacement(row) {
    var name = String(row.name || ''), value = String(row.value || '');
    if (/birth/i.test(name)) {
      if (/\d{1,2}\/\d{1,2}\/\d{4}/.test(value)) return value.replace(/\d{1,2}\/\d{1,2}\/\d{4}/, '01/01/1900');
      return '01/01/1900';
    }
    if (/serial|patient.*id|medical\s*record|\bmrn\b/i.test(name)) return maskAlphaNum(value) || 'REDACTED';
    return 'REDACTED';
  }

  function parse(input, filename) {
    var bytes = asBytes(input), enc = detectEncoding(bytes), stride = enc === 'utf-8' ? 1 : 2;
    var fs = seq(FS, enc), lf = seq(0x0a, enc), cr = seq(0x0d, enc), rows = [];
    var lineStart = 0, lineNo = 0;
    while (lineStart <= bytes.length) {
      var lfAt = findSeq(bytes, lf, lineStart, bytes.length, stride);
      var lineEnd = lfAt < 0 ? bytes.length : lfAt;
      if (lineEnd >= cr.length) {
        var hasCr = true;
        for (var ci = 0; ci < cr.length; ci++) if (bytes[lineEnd - cr.length + ci] !== cr[ci]) hasCr = false;
        if (hasCr) lineEnd -= cr.length;
      }
      lineNo++;
      var f0 = findSeq(bytes, fs, lineStart, lineEnd, stride);
      var f1 = f0 < 0 ? -1 : findSeq(bytes, fs, f0 + fs.length, lineEnd, stride);
      var f2 = f1 < 0 ? -1 : findSeq(bytes, fs, f1 + fs.length, lineEnd, stride);
      if (f0 >= 0 && f1 >= 0 && f2 >= 0) {
        var code = decodeRange(bytes, lineStart, f0, enc).trim();
        if (/^\d+$/.test(code)) {
          var row = {
            line: lineNo,
            code: code,
            name: decodeRange(bytes, f0 + fs.length, f1, enc).trim(),
            value: decodeRange(bytes, f1 + fs.length, f2, enc),
            valueStart: f1 + fs.length,
            valueEnd: f2,
            sensitive: false,
            redact: false,
            replacement: ''
          };
          row.sensitive = isSensitive(row.name, row.code);
          row.redact = row.sensitive && row.value.trim() !== '';
          row.replacement = row.redact ? defaultReplacement(row) : row.value;
          rows.push(row);
        }
      }
      if (lfAt < 0) break;
      lineStart = lfAt + lf.length;
    }
    return { filename: filename || 'Abbott.log', bytes: bytes, encoding: enc, rows: rows };
  }

  function redact(parsed) {
    var selected = parsed.rows.filter(function (r) { return r.redact; }).sort(function (a, b) { return a.valueStart - b.valueStart; });
    var parts = [], cursor = 0, total = 0;
    selected.forEach(function (row) {
      var before = parsed.bytes.slice(cursor, row.valueStart), replacement = encodeText(row.replacement, parsed.encoding);
      parts.push(before, replacement); total += before.length + replacement.length; cursor = row.valueEnd;
    });
    var tail = parsed.bytes.slice(cursor); parts.push(tail); total += tail.length;
    var out = new Uint8Array(total), at = 0;
    parts.forEach(function (p) { out.set(p, at); at += p.length; });
    return out;
  }

  global.AbbottLogRedactor = {
    detectEncoding: detectEncoding,
    encodeText: encodeText,
    isSensitive: isSensitive,
    defaultReplacement: defaultReplacement,
    parse: parse,
    redact: redact
  };
})(typeof window !== 'undefined' ? window : globalThis);
