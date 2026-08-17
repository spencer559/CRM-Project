/* Vendor-neutral CIED PDF redaction helpers.
 *
 * This module contains no PDF or DOM dependency. The browser tool supplies positioned text
 * items from pdf.js; these helpers identify likely identifiers and return normalized boxes.
 */
(function (global) {
  "use strict";

  var LABELS = [
    { kind: "name", re: /\b(?:patient\s+name|full\s*name)\b|^(?:patient|name|first\s*name|last\s*name|surname):?$/i, replacement: "DOE, TEST" },
    { kind: "dob", re: /\b(?:date\s*of\s*birth|birth\s*date|d\.?o\.?b\.?)\b/i, replacement: "01/01/2000" },
    { kind: "id", re: /\b(?:patient\s*(?:id|number|no\.?|#)|medical\s*record(?:\s*number)?|mrn|account\s*(?:number|no\.?|#))\b|^id:?$/i, replacement: "00000000" },
    { kind: "provider", re: /\b(?:physician|provider|doctor|ordering\s*provider|referring\s*provider)\b/i, replacement: "TEST PROVIDER" },
    { kind: "facility", re: /\b(?:hospital|clinic|facility|practice|facility\s*location|clinic\s*location)\b/i, replacement: "TEST FACILITY" },
    { kind: "address", re: /\baddress\b/i, replacement: "100 TEST STREET" },
    { kind: "phone", re: /\b(?:phone|telephone|mobile)\b/i, replacement: "000-000-0000" },
    { kind: "email", re: /\be-?mail\b/i, replacement: "test@example.invalid" },
    { kind: "serial", re: /\b(?:(?:device|generator|lead|module)\s*)?(?:serial(?:\s*(?:number|no\.?|#))?|s\/?n)\b/i, replacement: "XXXXXXXX" }
  ];

  var DATE_LABEL = /\b(?:interrogation|session|report|transmission|implant|visit|check|last\s+(?:office|follow[- ]?up)|episode)\s*(?:date|created|time)?\b|\bdate\s*(?:of\s*)?(?:service|implant|interrogation|transmission|visit|completion|completed)\b/i;
  var DATE_VALUE = /\b(?:\d{1,2}[\/-]\d{1,2}[\/-](?:\d{2}|\d{4})|\d{4}[\/-]\d{1,2}[\/-]\d{1,2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s\/-]+\d{1,2}(?:,|[\s\/.-])+(?:19|20)\d{2}|\d{1,2}[\s\/-]+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s\/-]+(?:19|20)\d{2})\b/i;
  var EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
  var PHONE = /(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]\d{4}/;
  var MONTH_NAME = /^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)$/i;

  function clean(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }

  function maskAlphaNum(value) {
    return String(value == null ? "" : value).replace(/[A-Za-z]/g, "X").replace(/\d/g, "0");
  }

  function fakeMonth(sample) {
    var word = String(sample || ""), fake = word.length > 3 ? "January" : "Jan";
    if (word === word.toUpperCase()) return fake.toUpperCase();
    if (word === word.toLowerCase()) return fake.toLowerCase();
    return fake;
  }

  function fakeNumber(sample, year) {
    var n = String(sample || "").length;
    if (year) return n <= 2 ? "00" : "2000";
    return n <= 1 ? "1" : "01";
  }

  function dateReplacement(value, fallback) {
    var text = clean(value), m, replacement;
    m = text.match(/\b(\d{1,4})([\/.-])(\d{1,2})([\/.-])(\d{2,4})\b/);
    if (m) {
      replacement = m[1].length === 4
        ? fakeNumber(m[1], true) + m[2] + fakeNumber(m[3], false) + m[4] + fakeNumber(m[5], false)
        : fakeNumber(m[1], false) + m[2] + fakeNumber(m[3], false) + m[4] + fakeNumber(m[5], true);
    } else {
      // Try day-first before month-first: otherwise "16 Aug 2026" contains a misleading
      // month-first substring ("Aug 2026") that consumes part of the year as the day.
      m = text.match(/\b(\d{1,2})(\s*[\/.-]\s*|\s+)([A-Za-z]{3,9})(\s*,?\s*[\/.-]?\s*)(\d{2,4})\b/);
      if (m && MONTH_NAME.test(m[3])) replacement = fakeNumber(m[1], false) + m[2] + fakeMonth(m[3]) + m[4] + fakeNumber(m[5], true);
      else {
        m = text.match(/\b([A-Za-z]{3,9})(\s*[\/.-]\s*|\s+)(\d{1,2})(\s*,?\s*[\/.-]?\s*)(\d{2,4})\b/);
        if (m && MONTH_NAME.test(m[1])) replacement = fakeMonth(m[1]) + m[2] + fakeNumber(m[3], false) + m[4] + fakeNumber(m[5], true);
      }
    }
    if (!m || !replacement) return fallback || "01/01/2000";
    // Preserve a following time/time-zone shape, but zero every digit it carried.
    return replacement + text.slice(m.index + m[0].length).replace(/\d/g, "0");
  }

  function nameReplacement(value, fallback) {
    var text = clean(value);
    if (!text) return fallback || "DOE, TEST";
    if (text.indexOf(",") >= 0) return "DOE, TEST";
    if (text.indexOf("/") >= 0) return "TEST/PATIENT";
    if (text.indexOf(";") >= 0) return "DOE; TEST";
    return /\s/.test(text) ? "TEST PATIENT" : "TEST";
  }

  function structuredReplacement(kind, value, fallback) {
    value = clean(value);
    if (!value) return fallback || "";
    if (kind === "date" || kind === "dob") return dateReplacement(value, fallback);
    if (kind === "serial" || kind === "id") return maskAlphaNum(value) || fallback;
    if (kind === "phone") return value.replace(/\d/g, "0");
    if (kind === "name") return nameReplacement(value, fallback);
    return fallback || "";
  }

  function classifyLabel(text, strictDates) {
    var value = clean(text), hit = null;
    LABELS.some(function (rule) {
      if (rule.re.test(value)) { hit = { kind: rule.kind, replacement: rule.replacement, match: value.match(rule.re)[0] }; return true; }
      return false;
    });
    if (!hit && strictDates && DATE_LABEL.test(value)) hit = { kind: "date", replacement: "01/01/2000", match: value.match(DATE_LABEL)[0] };
    return hit;
  }

  function isStandaloneIdentifier(text) {
    text = clean(text);
    if (EMAIL.test(text)) return { kind: "email", replacement: "test@example.invalid", shape: false };
    if (PHONE.test(text)) return { kind: "phone", replacement: "000-000-0000", shape: true };
    // Biotronik's compact header can put model, serial, and patient name in one text item
    // without labels. Redacting the whole header is safer than leaving the trailing name.
    if (/\bBIOTRONIK\s*-\s*.+\s*-\s*[A-Z0-9]+\s*-\s*.+\s*-\s*\d+\s*\/\s*\d+/i.test(text)) return { kind: "name", replacement: "DOE, TEST", shape: false };
    return null;
  }

  function normalizedRect(item, pageWidth, pageHeight) {
    var pad = Math.max(1.5, Math.min(4, Number(item.height || 10) * 0.16));
    var x = Math.max(0, Number(item.x || 0) - pad);
    var y = Math.max(0, Number(item.y || 0) - pad);
    var right = Math.min(pageWidth, Number(item.x || 0) + Math.max(2, Number(item.width || 0)) + pad);
    var bottom = Math.min(pageHeight, Number(item.y || 0) + Math.max(2, Number(item.height || 0)) + pad);
    return { x: x / pageWidth, y: y / pageHeight, w: (right - x) / pageWidth, h: (bottom - y) / pageHeight };
  }

  function lineGroups(items) {
    var rows = [];
    items.filter(function (it) { return clean(it.text); }).sort(function (a, b) {
      return (a.y - b.y) || (a.x - b.x);
    }).forEach(function (it) {
      var center = Number(it.y || 0) + Number(it.height || 0) / 2;
      var row = rows.find(function (r) { return Math.abs(r.center - center) <= Math.max(4, Number(it.height || 0) * 0.45); });
      if (!row) { row = { center: center, items: [] }; rows.push(row); }
      row.items.push(it);
      row.center = row.items.reduce(function (sum, x) { return sum + Number(x.y || 0) + Number(x.height || 0) / 2; }, 0) / row.items.length;
    });
    rows.forEach(function (r) { r.items.sort(function (a, b) { return a.x - b.x; }); });
    return rows;
  }

  function hasInlineValue(text, match) {
    var at = text.toLowerCase().indexOf(String(match || "").toLowerCase());
    if (at < 0) return false;
    var tail = text.slice(at + String(match).length).replace(/^[\s:#-]+/, "");
    return tail.length > 0;
  }

  function valueAfterLabel(text, match) {
    var at = text.toLowerCase().indexOf(String(match || "").toLowerCase());
    return at < 0 ? "" : text.slice(at + String(match).length).replace(/^[\s:#-]+/, "");
  }

  function inlineSelectableReplacement(text, label, replacement) {
    var at = text.toLowerCase().indexOf(String(label.match || "").toLowerCase());
    var tail = at < 0 ? "" : text.slice(at + String(label.match).length);
    var separator = (tail.match(/^\s*([:#-])/) || [])[1] || ":";
    return String(label.match || "").trim() + separator + " " + (replacement || label.replacement);
  }

  function detect(items, pageWidth, pageHeight, options) {
    options = options || {};
    var strictDates = options.strictDates !== false, found = [];
    lineGroups(items).forEach(function (row) {
      row.items.forEach(function (item, index) {
        var text = clean(item.text), direct = isStandaloneIdentifier(text), label = classifyLabel(text, strictDates);
        if (direct) {
          var directReplacement = direct.shape === false ? direct.replacement : structuredReplacement(direct.kind, text, direct.replacement);
          found.push({ rect: normalizedRect(item, pageWidth, pageHeight), kind: direct.kind, replacement: directReplacement, source: text, automatic: true });
        }
        if (!label) return;

        if (hasInlineValue(text, label.match)) {
          var inlineReplacement = structuredReplacement(label.kind, valueAfterLabel(text, label.match), label.replacement);
          found.push({ rect: normalizedRect(item, pageWidth, pageHeight), kind: label.kind, replacement: inlineReplacement, selectableReplacement: inlineSelectableReplacement(text, label, inlineReplacement), source: text, automatic: true });
          return;
        }

        var candidates = [];
        for (var j = index + 1; j < row.items.length; j++) {
          var next = row.items[j], nextText = clean(next.text);
          if (classifyLabel(nextText, strictDates)) break;
          if (/^[A-Za-z][A-Za-z /()-]{2,}:$/.test(nextText)) break;
          candidates.push(next);
        }
        if (!candidates.length && index + 1 < row.items.length) candidates.push(row.items[index + 1]);
        candidates.slice(0, 3).forEach(function (valueItem) {
          found.push({ rect: normalizedRect(valueItem, pageWidth, pageHeight), kind: label.kind, replacement: structuredReplacement(label.kind, clean(valueItem.text), label.replacement), source: text, automatic: true });
        });
      });
    });

    if (strictDates) {
      lineGroups(items).forEach(function (row) {
        var joined = row.items.map(function (it) { return clean(it.text); }).join(" ");
        if (!DATE_LABEL.test(joined)) return;
        row.items.forEach(function (item) {
          if (DATE_VALUE.test(clean(item.text))) found.push({ rect: normalizedRect(item, pageWidth, pageHeight), kind: "date", replacement: dateReplacement(clean(item.text), "01/01/2000"), source: clean(item.text), automatic: true });
        });
      });
    }

    var unique = [];
    found.forEach(function (box) {
      var r = box.rect;
      var duplicate = unique.some(function (x) {
        var q = x.rect;
        return Math.abs(r.x - q.x) < 0.003 && Math.abs(r.y - q.y) < 0.003 && Math.abs(r.w - q.w) < 0.006 && Math.abs(r.h - q.h) < 0.006;
      });
      if (!duplicate) unique.push(box);
    });
    return unique;
  }

  function manualBox(x1, y1, x2, y2, width, height) {
    var left = Math.max(0, Math.min(x1, x2)), top = Math.max(0, Math.min(y1, y2));
    var right = Math.min(width, Math.max(x1, x2)), bottom = Math.min(height, Math.max(y1, y2));
    if (right - left < 3 || bottom - top < 3) return null;
    return { rect: { x: left / width, y: top / height, w: (right - left) / width, h: (bottom - top) / height }, kind: "manual", replacement: "", source: "Manual selection", automatic: false };
  }

  function itemIntersectsBox(item, box, pageWidth, pageHeight) {
    var r = box.rect || box;
    var ix1 = Number(item.x || 0) / pageWidth, iy1 = Number(item.y || 0) / pageHeight;
    var ix2 = (Number(item.x || 0) + Math.max(1, Number(item.width || 0))) / pageWidth;
    var iy2 = (Number(item.y || 0) + Math.max(1, Number(item.height || 0))) / pageHeight;
    return ix1 < r.x + r.w && ix2 > r.x && iy1 < r.y + r.h && iy2 > r.y;
  }

  /* Rebuild a safe text layer rather than copying the source PDF's content streams. Text items
   * under any redaction are omitted. Automatic boxes contribute only their synthetic replacement
   * once, which keeps dates/serial placeholders useful to the parser without retaining PHI. */
  function selectableText(items, boxes, pageWidth, pageHeight) {
    var kept = items.filter(function (item) {
      return clean(item.text) && !boxes.some(function (box) { return itemIntersectsBox(item, box, pageWidth, pageHeight); });
    }).map(function (item) {
      return { text: item.text, x: item.x, y: item.y, width: item.width, height: item.height, replacement: false };
    });
    boxes.forEach(function (box) {
      var replacement = clean(box.selectableReplacement || box.replacement);
      if (!box.automatic || !replacement) return;
      var r = box.rect;
      kept.push({
        text: replacement, x: r.x * pageWidth, y: r.y * pageHeight,
        width: r.w * pageWidth, height: r.h * pageHeight, replacement: true
      });
    });
    return kept;
  }

  function safeOutputName(index) { return "redacted-cied-report" + (index > 0 ? "-" + (index + 1) : "") + ".pdf"; }

  global.CIEDPdfRedactor = {
    classifyLabel: classifyLabel,
    isStandaloneIdentifier: isStandaloneIdentifier,
    normalizedRect: normalizedRect,
    lineGroups: lineGroups,
    detect: detect,
    manualBox: manualBox,
    itemIntersectsBox: itemIntersectsBox,
    selectableText: selectableText,
    inlineSelectableReplacement: inlineSelectableReplacement,
    valueAfterLabel: valueAfterLabel,
    structuredReplacement: structuredReplacement,
    dateReplacement: dateReplacement,
    maskAlphaNum: maskAlphaNum,
    safeOutputName: safeOutputName
  };
})(typeof window !== "undefined" ? window : globalThis);
