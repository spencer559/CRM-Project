/* =====================================================================
   CIED EXTRACTION ENGINE  (shared, vendor-agnostic)
   ---------------------------------------------------------------------
   One copy of the pieces both the Harness and the Preview rely on:
     - pdf.js worker loader (survives file:// and sandbox iframes)
     - extractItems()  pdf  -> [{page,x,y,w,str}]
     - normalize()     items -> reading-order LINES
     - tagSections()   tags each line Initial / Final / other
     - findRight()     the anchor engine (value to the right of a label)
     - findAllRight()  every label->right match (harness probe)
     - cleaners        toISO / num / MODES
     - vendor sigs     VENDORS / guessVendor()
     - small UI utils  esc / toast / wireDrop

   Loaded as a plain <script src="engine.js"> (classic, not a module) so
   it works whether the page is double-clicked (file://) or served.
   Everything hangs off a single global: Engine.
   ===================================================================== */
(function (global) {
  'use strict';

  var TOL = 3; // y-tolerance (pt) for grouping items into one line

  /* ---------- pdf.js worker: blob-from-CDN so it also survives a
       sandbox iframe; falls back to direct workerSrc (file:// / https). ---------- */
  function initWorker() {
    if (typeof pdfjsLib === 'undefined') return;
    var url = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    fetch(url).then(function (r) { return r.text(); }).then(function (code) {
      pdfjsLib.GlobalWorkerOptions.workerSrc =
        URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
    }).catch(function () {
      pdfjsLib.GlobalWorkerOptions.workerSrc = url; // direct works for file:// and https
    });
  }

  /* ---------- pdf -> flat text items ---------- */
  async function extractItems(pdf) {
    var items = [];
    for (var p = 1; p <= pdf.numPages; p++) {
      var page = await pdf.getPage(p);
      var tc = await page.getTextContent();
      tc.items.forEach(function (it) {
        var s = it.str || '';
        if (!s.trim()) return;                 // skip whitespace-only items
        items.push({ page: p, x: it.transform[4], y: it.transform[5], w: it.width || 0, str: s });
      });
    }
    return items;
  }

  /* ---------- group items into reading-order lines ----------
       top -> bottom (y descending), then left -> right within each line. */
  function normalize(items) {
    var LINES = [];
    var byPage = {};
    items.forEach(function (it) { (byPage[it.page] = byPage[it.page] || []).push(it); });
    Object.keys(byPage).map(Number).sort(function (a, b) { return a - b; }).forEach(function (pg) {
      var arr = byPage[pg].slice().sort(function (a, b) { return b.y - a.y; }); // top -> bottom
      var cur = null;
      arr.forEach(function (it) {
        if (!cur || Math.abs(it.y - cur.y) > TOL) {
          cur = { page: pg, y: it.y, items: [it] };
          LINES.push(cur);
        } else {
          cur.items.push(it);
        }
      });
    });
    LINES.forEach(function (l) { l.items.sort(function (a, b) { return a.x - b.x; }); }); // left -> right
    return LINES;
  }

  function text(l) { return l.items.map(function (i) { return i.str; }).join(' '); }

  /* ---------- section tagging ----------
       each page's topmost line is its section title ("Initial: ..." / "Final: ..."). */
  function tagSections(LINES) {
    var titleByPage = {};
    LINES.forEach(function (l) { if (titleByPage[l.page] === undefined) titleByPage[l.page] = text(l); });
    LINES.forEach(function (l) {
      l.section = titleByPage[l.page] || '';
      l.secType = /^Final/i.test(l.section) ? 'final' : /^Initial/i.test(l.section) ? 'initial' : 'other';
    });
    return LINES;
  }

  /* ---------- the anchor engine ----------
       find the value to the RIGHT of a label, with three guards:
         prefer  : keep candidates from 'final' (or 'initial') section pages
         match   : value must match this pattern (rejects header words / axis labels)
         notLabel: blank a captured value that is itself a label (empty-field guard) */
  function findRight(LINES, labelRe, opts) {
    opts = opts || {};
    var c = [];
    LINES.forEach(function (l) {
      l.items.forEach(function (it, i) {
        if (!labelRe.test(it.str)) return;
        var r = l.items.slice(i + 1).find(function (n) { return n.x > it.x + 2; });
        var v = r ? r.str : '';
        if (opts.notLabel && r && opts.notLabel.test(r.str)) v = '';
        c.push({ v: v, page: l.page, secType: l.secType, section: l.section });
      });
    });
    if (opts.match) c = c.filter(function (x) { return opts.match.test(x.v); });
    if (opts.prefer) { var f = c.filter(function (x) { return x.secType === opts.prefer; }); if (f.length) c = f; }
    return c.find(function (x) { return x.v !== ''; }) || null;
  }

  /* every label match with the nearest item to its right (harness label probe). */
  function findAllRight(LINES, re) {
    var out = [];
    LINES.forEach(function (l) {
      l.items.forEach(function (it, idx) {
        if (!re.test(it.str)) return;
        var right = l.items.slice(idx + 1).find(function (n) { return n.x > it.x; });
        out.push({ label: it.str, val: right ? right.str : null, page: l.page, lx: Math.round(it.x), ly: Math.round(l.y) });
      });
    });
    return out;
  }

  function lineWith(LINES, re) { return LINES.find(function (l) { return re.test(text(l)); }); }

  /* ---------- column-aware anchors ----------
       colsRightOf: every value cell to the right of a label on its line
       (the first matching line, honoring opts.prefer). Used for layouts
       where one label heads several columns (e.g. atrial | ventricular). */
  function colsRightOf(LINES, re, opts) {
    opts = opts || {};
    var cand = [];
    LINES.forEach(function (l) {
      var idx = l.items.findIndex(function (it) { return re.test(it.str); });
      if (idx < 0) return;
      var lab = l.items[idx];
      var rights = l.items.slice(idx + 1).filter(function (n) { return n.x > lab.x + 2; });
      cand.push({ l: l, rights: rights });
    });
    if (opts.prefer) { var f = cand.filter(function (c) { return c.l.secType === opts.prefer; }); if (f.length) cand = f; }
    return cand.length ? { rights: cand[0].rights, page: cand[0].l.page, section: cand[0].l.section } : null;
  }

  /* twoCol: split a two-column row into {a:left/atrial, v:right/ventricular}.
       opts.split = x midpoint (default 310). opts.valRe filters cells. */
  var COL_SPLIT = 310;
  function twoCol(LINES, re, opts) {
    opts = opts || {};
    var split = opts.split == null ? COL_SPLIT : opts.split;
    var r = colsRightOf(LINES, re, opts);
    if (!r) return { a: '', v: '', src: '' };
    var pick = function (cells) {
      if (opts.valRe) { var m = cells.find(function (c) { return opts.valRe.test(c.str); }); return m ? m.str : ''; }
      return cells.length ? cells[0].str : '';
    };
    return {
      a: pick(r.rights.filter(function (c) { return c.x < split; })),
      v: pick(r.rights.filter(function (c) { return c.x >= split; })),
      src: 'p' + r.page
    };
  }

  /* ---------- cleaners ---------- */
  var MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  function toISO(s) {
    var m = String(s).match(/([A-Za-z]{3})\/(\d{1,2})\/(\d{4})/);
    if (!m) return '';
    var mo = MONTHS[m[1].toLowerCase()];
    return mo ? (m[3] + '-' + mo + '-' + m[2].padStart(2, '0')) : '';
  }
  function num(s) { var m = String(s).match(/-?\d+\.?\d*/); return m ? m[0] : ''; }
  var MODES = /^(AAI|AAIR|VVI|VVIR|DDD|DDDR|DDI|DDIR|VDI|VDIR|VDD|VDDR|AOO|VOO|DOO|OOO)$/i;

  /* ---------- vendor signatures (substring match, case-insensitive) ---------- */
  var VENDORS = [
    { name: 'Medtronic',         sig: /medtronic|carelink|azure|micra|cobalt|crome|claria|percepta/i },
    { name: 'Abbott / St. Jude', sig: /abbott|st\.?\s*jude|merlin|assurity|ellipse|gallant|aveir|fortify/i },
    { name: 'Boston Scientific', sig: /boston scientific|latitude|accolade|resonate|emblem|vigilant|altrua/i },
    { name: 'Biotronik',         sig: /biotronik|home monitoring|edora|enitra|rivacor|acticor|intica/i }
  ];
  function guessVendor(items) {
    var all = items.map(function (i) { return i.str; }).join(' ');
    var hit = VENDORS.find(function (v) { return v.sig.test(all); });
    return hit ? hit.name : 'Unknown';
  }

  /* ---------- small UI utils ---------- */
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  var toastT;
  function toast(msg) {
    var el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(function () { el.classList.remove('show'); }, 2200);
  }

  /* wire a drop zone + hidden file input to an onFile(file) callback. */
  function wireDrop(dropEl, fileInputEl, onFile) {
    dropEl.addEventListener('click', function () { fileInputEl.click(); });
    fileInputEl.addEventListener('change', function (e) { if (e.target.files[0]) onFile(e.target.files[0]); });
    ['dragenter', 'dragover'].forEach(function (ev) { dropEl.addEventListener(ev, function (e) { e.preventDefault(); dropEl.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { dropEl.addEventListener(ev, function (e) { e.preventDefault(); dropEl.classList.remove('over'); }); });
    dropEl.addEventListener('drop', function (e) { var f = e.dataTransfer.files[0]; if (f) onFile(f); });
  }

  initWorker();

  global.Engine = {
    TOL: TOL,
    extractItems: extractItems,
    normalize: normalize,
    tagSections: tagSections,
    text: text,
    findRight: findRight,
    findAllRight: findAllRight,
    lineWith: lineWith,
    colsRightOf: colsRightOf,
    twoCol: twoCol,
    COL_SPLIT: COL_SPLIT,
    MONTHS: MONTHS,
    toISO: toISO,
    num: num,
    MODES: MODES,
    VENDORS: VENDORS,
    guessVendor: guessVendor,
    esc: esc,
    toast: toast,
    wireDrop: wireDrop
  };
})(window);
/* engine.js — shared CIED extraction engine */
