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
    var entries = new Map(), marks = new Set(), suppressed = new Set(), episodes = [], returnPosition = null;
    var bar = document.createElement('div'); bar.className = 'egm-bar';
    var menu = document.createElement('div'); menu.className = 'egm-menu'; menu.hidden = true;
    menu.id = 'egm-navigation'; menu.setAttribute('role', 'region'); menu.setAttribute('aria-label', 'EGM page navigation');
    function button(parent, label, action) {
      var b = document.createElement('button'); b.type = 'button'; b.textContent = label;
      b.addEventListener('click', action); parent.appendChild(b); return b;
    }
    var trigger = button(bar, 'EGMs ▾', function () { menu.hidden ? show(false) : close(true); });
    trigger.setAttribute('aria-controls', menu.id); trigger.setAttribute('aria-expanded', 'false');
    var back = button(bar, 'Back', function () {
      if (!returnPosition) return;
      options.restore(returnPosition); returnPosition = null; back.hidden = true;
    });
    back.hidden = true; back.title = 'Restore the page and zoom from before your EGM jump';
    var status = document.createElement('span'); status.className = 'egm-status'; bar.appendChild(status);
    var info = document.createElement('p'); menu.appendChild(info);
    var list = document.createElement('div'); menu.appendChild(list);
    var assignmentLabel = document.createElement('label'); menu.appendChild(assignmentLabel);
    var picker = document.createElement('select'); assignmentLabel.appendChild(picker);
    picker.setAttribute('aria-label', 'Assign current PDF page to logbook entry');
    var mark = button(menu, 'Save current page', function () {
      var p = options.position().page;
      suppressed.delete(p);
      if (picker.value && options.onAssign) options.onAssign(picker.value, p);
      else marks.add(p);
      refresh();
    });
    var note = document.createElement('p'); note.textContent = 'Entry links save with the report. Page-only shortcuts last while this viewer is open. × removes the page shortcut and its entry links.'; menu.appendChild(note);
    button(menu, 'Close', function () { close(true); });
    document.body.appendChild(bar); document.body.appendChild(menu);
    document.documentElement.classList.add('egm-ready');
    function destinations() {
      var result = new Map(entries);
      marks.forEach(function (p) { result.set(p, { kind: 'manual', label: 'Marked EGM page' }); });
      episodes.forEach(function (e) { if (e.page && !result.has(e.page)) result.set(e.page, { kind: 'manual', label: 'Linked EGM page' }); });
      suppressed.forEach(function (p) { result.delete(p); });
      return Array.from(result, function (pair) { return { page: pair[0], kind: pair[1].kind, label: pair[1].label }; })
        .sort(function (a, b) { return a.page - b.page; });
    }
    function close(focus) {
      menu.hidden = true; trigger.setAttribute('aria-expanded', 'false');
      if (focus) trigger.focus();
    }
    function jump(page) {
      if (!Number.isInteger(page) || page < 1 || page > doc.numPages) return;
      if (options.position().page !== page) {
        if (!returnPosition) returnPosition = options.position();
        back.textContent = 'Back to p. ' + returnPosition.page; back.hidden = false;
      }
      options.goTo(page); close(false);
    }
    function fillPicker(select, first) {
      var value = select.value; select.replaceChildren();
      var option = document.createElement('option'); option.value = ''; option.textContent = first; select.appendChild(option);
      episodes.forEach(function (e) {
        var o = document.createElement('option'); o.value = e.id; o.textContent = e.label + (e.page ? ' · p. ' + e.page : ''); select.appendChild(o);
      });
      if (episodes.some(function (e) { return e.id === value; })) select.value = value;
    }
    function updatePosition() { mark.textContent = 'Save page ' + options.position().page + (picker.value ? ' to ' + picker.selectedOptions[0].textContent.split(' · ')[0] : ' shortcut'); }
    picker.addEventListener('change', updatePosition);
    picker.addEventListener('blur', function () { setTimeout(function () { if (!disposed) refresh(); }, 0); });
    function refresh() {
      var found = destinations();
      status.textContent = scanning ? 'Finding pages…' : found.length ? found.length + ' page links' : 'No EGM pages detected';
      info.textContent = 'Headings suggest possible recordings; verify each page.' +
        (scanning ? ' Still checking the document.' : '') +
        (failed ? ' Some pages could not be checked.' : '') +
        (!found.length ? ' You can mark a page manually, including scanned pages.' : '');
      // Background indexing must not remove a keyboard user's focused destination.
      // Keep a native dropdown stable while someone is choosing an entry during indexing.
      if (menu.contains(document.activeElement) && document.activeElement.tagName === 'SELECT') return;
      var focused = document.activeElement, focusedPage = focused && focused.dataset && focused.dataset.egmPage;
      list.replaceChildren();
      found.forEach(function (e) {
        var card = document.createElement('div'); card.className = 'egm-destination'; list.appendChild(card);
        var header = document.createElement('div'); header.className = 'egm-destination-header'; card.appendChild(header);
        var linked = episodes.filter(function (row) { return row.page === e.page; }).map(function (row) { return row.label; });
        var b = button(header, (linked.length ? linked.join(', ') : e.kind === 'summary' ? 'Episode summary' : e.kind === 'manual' ? 'Marked EGM' : 'Possible recording') + ' · p. ' + e.page + ' — ' + e.label,
          function () { jump(e.page); });
        b.dataset.egmPage = String(e.page);
        if (focusedPage === String(e.page)) b.focus();
        var remove = button(header, '×', function () {
          suppressed.add(e.page); marks.delete(e.page);
          episodes.forEach(function (row) { if (row.page === e.page) row.page = null; });
          if (options.onRemove) options.onRemove(e.page);
          refresh(); trigger.focus();
        });
        remove.className = 'egm-remove'; remove.setAttribute('aria-label', 'Remove page ' + e.page + ' shortcut and entry links');
        if (episodes.length) {
          var assign = document.createElement('select'); card.appendChild(assign);
          assign.setAttribute('aria-label', 'Assign PDF page ' + e.page + ' to logbook entry');
          fillPicker(assign, 'Assign page ' + e.page + ' to entry…');
          assign.addEventListener('change', function () { if (assign.value && options.onAssign) options.onAssign(assign.value, e.page); assign.blur(); refresh(); });
          assign.addEventListener('blur', function () { setTimeout(function () { if (!disposed) refresh(); }, 0); });
        }
      });
      fillPicker(picker, 'Page shortcut only'); updatePosition();
    }
    function show() {
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
    return { show: show, jump: jump, updatePosition: updatePosition, add: add, refresh: refresh, ready: ready,
      setEpisodes: function (values) {
        var next = (Array.isArray(values) ? values : []).filter(function (e) { return e && /^(?:ep|lep)-[1-9]\d*$/.test(e.id); }).map(function (e) {
          return { id: e.id, label: 'Entry ' + e.id.split('-')[1], page: Number.isInteger(e.page) && e.page > 0 && e.page <= doc.numPages ? e.page : null };
        });
        if (JSON.stringify(next) === JSON.stringify(episodes)) return;
        episodes = next; episodes.forEach(function (e) { if (e.page) suppressed.delete(e.page); }); refresh();
      },
      dispose: function () { disposed = true; document.removeEventListener('click', outside); document.removeEventListener('keydown', key, true); bar.remove(); menu.remove(); } };
  }
  var api = { classifyHeading: classifyHeading, classifyPage: classifyPage, pageHeadings: pageHeadings, mount: mount };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CRMEgmNavigation = api;
})(typeof window !== 'undefined' ? window : null);
