/* Local, document-scoped navigation hints. Headings identify candidates, not clinical findings. */
(function (root) {
  'use strict';
  function classifyHeading(value) {
    var s = String(value || '').replace(/\s+/g, ' ').trim();
    if (!s || s.length > 110) return null;
    if (/^(?:table of )?contents\b/i.test(s) || /\.{3,}\s*\d+\s*$/.test(s)) return null;
    if (/^(?:arrhythmia )?episode (?:list|summary|log|logbook|directory)\b/i.test(s)) return 'summary';
    if (/^(?:(?:stored|recorded|real[- ]time|episode)\s+)?(?:[iv]?egms?|electrograms?)(?:\s+(?:recordings?|strips?|details?|traces?|episode|printout))?(?:\s*[:#-].*|\s*\(.*\)|\s*\d+(?:\s+of\s+\d+)?)?$/i.test(s) ||
        /^(?:stored )?episode (?:details?|recordings?|electrograms?|[iv]?egms?|strips?)(?:\s*[:#-].*|\s*\d+.*)?$/i.test(s)) return 'recording';
    return null;
  }
  function pageHeadings(items) {
    // Reassemble fragmented PDF text by baseline, including per-character exports.
    var rows = [];
    (items || []).forEach(function (item) {
      if (!item || !item.str || !item.transform) return;
      var y = item.transform[5], row = rows.find(function (r) { return Math.abs(r.y - y) < 2; });
      if (!row) { row = { y: y, items: [] }; rows.push(row); }
      row.items.push(item);
    });
    return rows.sort(function (a, b) { return b.y - a.y; }).map(function (row) {
      var end = null;
      return row.items.sort(function (a, b) { return a.transform[4] - b.transform[4]; }).map(function (item) {
        var x = item.transform[4], gap = end !== null && x - end > 2 ? ' ' : '';
        end = x + (item.width || 0);
        return gap + item.str;
      }).join('').trim();
    });
  }
  function classifyPage(items) {
    var lines = pageHeadings(items);
    if (lines.some(function (s) { return /^(?:table of )?contents\s*$/i.test(s); })) return [];
    return lines.map(function (s) { return { kind: classifyHeading(s), label: s }; }).filter(function (h) { return h.kind; });
  }
  function mount(options) {
    var doc = options.doc, disposed = false, scanning = true, failed = 0;
    var entries = new Map(), marks = new Set(), returnPosition = null;
    var bar = document.createElement('div'); bar.className = 'egm-bar';
    var menu = document.createElement('div'); menu.className = 'egm-menu'; menu.hidden = true;
    menu.id = 'egm-navigation'; menu.setAttribute('role', 'region'); menu.setAttribute('aria-label', 'EGM page navigation');
    function button(parent, label, action) {
      var b = document.createElement('button'); b.type = 'button'; b.textContent = label;
      b.addEventListener('click', action); parent.appendChild(b); return b;
    }
    var trigger = button(bar, 'EGMs ▾', function () { menu.hidden ? show(false) : close(true); });
    trigger.setAttribute('aria-controls', menu.id); trigger.setAttribute('aria-expanded', 'false');
    var back = button(bar, 'Return', function () {
      if (!returnPosition) return;
      options.restore(returnPosition); returnPosition = null; back.disabled = true;
    });
    back.disabled = true; back.title = 'Return to the position before your first EGM jump';
    var status = document.createElement('span'); status.className = 'egm-status'; bar.appendChild(status);
    var info = document.createElement('p'); menu.appendChild(info);
    var list = document.createElement('div'); menu.appendChild(list);
    var mark = button(menu, 'Mark current page as EGM', function () {
      var p = options.position().page;
      marks.has(p) ? marks.delete(p) : marks.add(p); refresh();
    });
    var note = document.createElement('p'); note.textContent = 'Manual marks last while this viewer is open.'; menu.appendChild(note);
    button(menu, 'Close', function () { close(true); });
    document.body.appendChild(bar); document.body.appendChild(menu);
    document.documentElement.classList.add('egm-ready');
    function destinations() {
      var result = new Map(entries);
      marks.forEach(function (p) { result.set(p, { kind: 'manual', label: 'Marked EGM page' }); });
      return Array.from(result, function (pair) { return { page: pair[0], kind: pair[1].kind, label: pair[1].label }; })
        .sort(function (a, b) { return a.page - b.page; });
    }
    function close(focus) {
      menu.hidden = true; trigger.setAttribute('aria-expanded', 'false');
      if (focus) trigger.focus();
    }
    function jump(page) {
      if (!returnPosition) returnPosition = options.position();
      back.disabled = false; options.goTo(page); close(false);
    }
    function refresh() {
      var found = destinations();
      status.textContent = scanning ? 'Finding pages…' : found.length ? found.length + ' page links' : 'No EGM pages detected';
      info.textContent = 'Headings suggest possible recordings; verify each page.' +
        (scanning ? ' Still checking the document.' : '') +
        (failed ? ' Some pages could not be checked.' : '') +
        (!found.length ? ' You can mark a page manually, including scanned pages.' : '');
      // Background indexing must not remove a keyboard user's focused destination.
      var focused = document.activeElement, focusedPage = focused && focused.dataset && focused.dataset.egmPage;
      list.replaceChildren();
      found.forEach(function (e) {
        var b = button(list, (e.kind === 'summary' ? 'Episode summary' : e.kind === 'manual' ? 'Marked EGM' : 'Possible recording') + ' · p. ' + e.page + ' — ' + e.label,
          function () { jump(e.page); });
        b.dataset.egmPage = String(e.page);
        if (focusedPage === String(e.page)) b.focus();
      });
      mark.textContent = marks.has(options.position().page) ? 'Unmark current EGM page' : 'Mark current page as EGM';
    }
    function show(jumpSingle) {
      var recordings = destinations().filter(function (e) { return e.kind !== 'summary'; });
      if (jumpSingle && !scanning && recordings.length === 1) { jump(recordings[0].page); return; }
      refresh(); menu.hidden = false; trigger.setAttribute('aria-expanded', 'true');
      (list.querySelector('button') || mark).focus();
    }
    function add(page, label) {
      var kind = classifyHeading(label);
      if (!kind || !Number.isInteger(page) || page < 1 || page > doc.numPages || disposed) return;
      var existing = entries.get(page);
      if (!existing || existing.kind === 'summary') entries.set(page, { kind: kind, label: label });
    }
    function outside(ev) { if (!menu.hidden && !menu.contains(ev.target) && !bar.contains(ev.target)) close(false); }
    function key(ev) {
      if (menu.hidden) return;
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopImmediatePropagation(); close(true); }
      // The viewer's page shortcuts must not consume native button or Tab behavior in the list.
      else if (menu.contains(ev.target)) ev.stopPropagation();
    }
    document.addEventListener('click', outside);
    document.addEventListener('keydown', key, true);
    refresh();
    // One page at a time, yielding between pages. Keep only page labels, never document text/canvases.
    var ready = (async function () {
      for (var p = 1; p <= doc.numPages && !disposed; p++) {
        try {
          var page = await doc.getPage(p);
          if (disposed) break;
          var content = await page.getTextContent();
          if (disposed) break;
          classifyPage(content.items).forEach(function (h) { add(p, h.label); });
        } catch (e) { failed++; }
        if (!disposed) refresh();
        await new Promise(function (resolve) { setTimeout(resolve, 0); });
      }
      scanning = false; if (!disposed) refresh();
    })();
    return { show: show, add: add, refresh: refresh, ready: ready,
      dispose: function () { disposed = true; document.removeEventListener('click', outside); document.removeEventListener('keydown', key, true); bar.remove(); menu.remove(); } };
  }
  var api = { classifyHeading: classifyHeading, classifyPage: classifyPage, pageHeadings: pageHeadings, mount: mount };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CRMEgmNavigation = api;
})(typeof window !== 'undefined' ? window : null);
