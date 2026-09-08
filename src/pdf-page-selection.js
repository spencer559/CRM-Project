/* Small metadata only. Page numbers are physical, one-based PDF pages. */
(function (root) {
  'use strict';
  // Validate and de-duplicate without reordering: a Set keeps first insertion, so a page claimed by
  // two shortcuts prints once, at the position of the earlier one.
  function sequence(pages, max) {
    max = max || 10000;
    if (!Array.isArray(pages) || !pages.length || pages.length > max ||
        pages.some(function (p) { return !Number.isInteger(p) || p < 1 || p > max; })) return null;
    return Array.from(new Set(pages));
  }
  function normalize(pages, max) {
    var seq = sequence(pages, max);
    return seq && seq.sort(function (a, b) { return a - b; });
  }
  function parse(text, max) {
    var pages = [], parts = String(text).trim().split(',');
    if (!parts.length || parts.length > max) return null;
    for (var i = 0; i < parts.length; i++) {
      var m = /^\s*(\d+)\s*(?:[-–]\s*(\d+)\s*)?$/.exec(parts[i]);
      if (!m) return null;
      var a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
      if (a < 1 || b < a || b > max) return null;
      for (var p = a; p <= b; p++) pages.push(p);
      if (pages.length > max * 2) return null;
    }
    return normalize(Array.from(new Set(pages)), max);
  }
  function format(pages) {
    var out = [];
    for (var i = 0; i < pages.length; i++) {
      var start = pages[i], end = start;
      while (pages[i + 1] === end + 1) end = pages[++i];
      out.push(start === end ? String(start) : start + '–' + end);
    }
    return out.join(', ');
  }
  function pagesOf(item, max) { return normalize(item.pages || [item.page], max); }
  function compare(a, b) {
    var ao = Number.isInteger(a.order) ? a.order : 1000000;
    var bo = Number.isInteger(b.order) ? b.order : 1000000;
    return ao - bo || a.page - b.page;
  }
  var api = { sequence: sequence, normalize: normalize, parse: parse, format: format, pagesOf: pagesOf, compare: compare };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CRMPageSelection = api;
})(typeof window !== 'undefined' ? window : null);
