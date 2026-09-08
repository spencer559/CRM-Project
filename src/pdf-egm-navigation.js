/* Document-scoped page shortcuts. Only small selections cross the host bridge. */
(function (root) {
  'use strict';
  var ENTRY = /^(?:ep|lep)-[1-9]\d*$/;
  var P = root.CRMPageSelection;
  function mount(options) {
    var doc = options.doc, slot = options.toolbar, disposed = false;
    var episodes = [], marks = [], returnPosition = null, editing = null, dragging = null;
    var excluded = new Set(), printing = false;
    function valid(page) { return Number.isInteger(page) && page > 0 && page <= doc.numPages; }
    function make(tag, cls, parent) {
      var el = document.createElement(tag); if (cls) el.className = cls;
      if (parent) parent.appendChild(el); return el;
    }
    function button(label, cls, parent, action) {
      var el = make('button', cls, parent); el.type = 'button'; el.textContent = label;
      el.addEventListener('click', action); return el;
    }
    function option(value, label) { var el = make('option'); el.value = value; el.textContent = label; return el; }
    function field(label, cls, parent) {
      var wrap = make('label', 'egm-field', parent); make('span', '', wrap).textContent = label;
      return make('input', cls, wrap);
    }
    var trigger = button('EGM', 'egm-trigger', slot, function () { menu.hidden ? open() : close(true); });
    trigger.hidden = true;
    var back = button('Back', 'egm-back', slot, function () {
      if (!returnPosition) return;
      options.restore(returnPosition); returnPosition = null; back.hidden = true;
    });
    back.hidden = true; back.title = 'Restore page and zoom';
    var menu = make('div', 'egm-menu', document.body);
    menu.hidden = true; menu.id = 'egm-menu';
    menu.setAttribute('role', 'region'); menu.setAttribute('aria-label', 'EGM page shortcuts');
    trigger.setAttribute('aria-controls', menu.id); trigger.setAttribute('aria-expanded', 'false');
    var saveRow = make('div', 'egm-save-row', menu);
    var target = make('select', 'egm-target', saveRow);
    target.setAttribute('aria-label', 'Save to');
    var save = button('Save', 'egm-save', saveRow, saveSelection);
    var name = field('Name', 'egm-name', menu); name.maxLength = 80; name.placeholder = 'Name this shortcut';
    var rangeRow = make('div', 'egm-range-row', menu);
    var range = field('Pages', 'egm-range', rangeRow); range.placeholder = 'e.g. 3–5, 8'; range.maxLength = 1000;
    var addPage = button('+ Current', 'egm-add-page', rangeRow, function () {
      var pages = range.value.trim() ? P.parse(range.value, doc.numPages) : [];
      if (!pages) { showError('Enter pages from 1 to ' + doc.numPages + ', e.g. 3–5, 8.'); return; }
      range.value = P.format(P.normalize(pages.concat([options.position().page]), doc.numPages));
      clearError(); updatePosition();
    });
    addPage.title = 'Add the current page to this selection';
    var cancel = button('Cancel edit', 'egm-cancel', rangeRow, function () { resetEditor(); }); cancel.hidden = true;
    var error = make('p', 'egm-error', menu); error.hidden = true; error.setAttribute('role', 'alert');
    var list = make('div', 'egm-list', menu);
    var empty = make('p', 'egm-empty', menu); empty.textContent = 'No saved pages';
    var printRow = make('div', 'egm-print-row', menu);
    var printSummary = make('span', 'egm-print-summary', printRow);
    var print = button('Print selected', 'egm-print', printRow, function () {
      var pages = selectedPages();
      if (!pages.length || printing || !options.onPrint) return;
      printing = true; clearError(); updatePrint();
      Promise.resolve().then(function () { return options.onPrint(pages); }).catch(function (e) {
        if (!disposed) showError(e.message || 'Could not prepare selected pages.');
      }).then(function () { printing = false; if (!disposed) updatePrint(); });
    });
    function clearError() { error.hidden = true; range.removeAttribute('aria-invalid'); }
    function showError(text) { error.textContent = text; error.hidden = false; }
    function destinations() {
      var found = episodes.filter(function (e) { return e.pages; }).concat(marks);
      return found.slice().sort(P.compare);
    }
    // Print in the order the list shows, not in page order: the technician's arrangement is the
    // point of the drag handles.
    function selectedPages() {
      var pages = [];
      destinations().forEach(function (d) { if (!excluded.has(d.id)) pages = pages.concat(d.pages); });
      return pages.length ? P.sequence(pages, doc.numPages) || [] : [];
    }
    function updatePrint() {
      var pages = selectedPages();
      printRow.hidden = !destinations().length || !options.onPrint;
      print.disabled = printing || !pages.length;
      print.textContent = printing ? 'Preparing…' : 'Print selected';
      printSummary.textContent = pages.length + ' / ' + doc.numPages + ' pages';
      printSummary.title = P.format(pages);
    }
    function jump(page) {
      if (!valid(page)) return;
      if (options.position().page !== page && !returnPosition) {
        returnPosition = options.position(); back.textContent = 'Back to p. ' + returnPosition.page; back.hidden = false;
      }
      options.goTo(page); close(false);
    }
    function resetEditor() {
      editing = null; target.value = ''; name.value = ''; range.value = '';
      name.placeholder = 'Name this shortcut';
      cancel.hidden = true; clearError(); updatePosition();
    }
    function editorChoices() { return marks.slice().sort(P.compare).concat(episodes); }
    function refreshPicker(force) {
      // Leave an open native picker alone when the report republishes in the background.
      if (!force && document.activeElement === target && !menu.hidden) return;
      var keep = target.value, choices = editorChoices();
      target.replaceChildren(option('', 'New shortcut…'));
      choices.forEach(function (d) { target.appendChild(option(d.id, d.label + (d.pages ? ' · p. ' + P.format(d.pages) : ''))); });
      target.value = choices.some(function (d) { return d.id === keep; }) ? keep : '';
    }
    function selectEditor(id, focusName) {
      var d = editorChoices().find(function (item) { return item.id === id; });
      if (!d) { resetEditor(); return; }
      refreshPicker(true);
      editing = d.id; target.value = d.id;
      name.value = d.label;
      name.placeholder = d.defaultLabel || 'Name this shortcut';
      range.value = d.pages ? P.format(d.pages) : ''; cancel.hidden = false;
      clearError(); updatePosition(); if (focusName) name.focus();
    }
    function saveSelection() {
      var pages = P.parse(range.value.trim() || String(options.position().page), doc.numPages);
      if (!pages) { showError('Enter pages from 1 to ' + doc.numPages + ', e.g. 3–5, 8.'); range.setAttribute('aria-invalid', 'true'); range.focus(); return; }
      if (!options.onAssign) return;
      var chosen = editorChoices().find(function (d) { return d.id === target.value; });
      if (target.value && !chosen) { resetEditor(); refreshPicker(true); return; }
      var label = name.value.trim();
      // Display an episode's name in the editor without freezing its date/type label when the
      // user only changes pages. An explicitly different name remains a custom label.
      if (chosen && ENTRY.test(chosen.id) && label === chosen.defaultLabel) label = '';
      options.onAssign(ENTRY.test(target.value) ? target.value : null, pages[0], {
        pages: pages, label: label, savedId: editing
      });
      resetEditor(); close(true);
    }
    function updatePosition() {
      var page = options.position().page, count = destinations().length;
      save.textContent = editing ? 'Update' : 'Save';
      range.placeholder = 'Current: ' + page + ' · e.g. 3–5, 8';
      trigger.textContent = count ? 'EGM · ' + count : 'EGM';
      trigger.title = 'Saved pages and episodes';
    }
    function reorder(from, to) {
      var found = destinations(), ids = found.map(function (d) { return d.id; });
      var a = ids.indexOf(from), b = ids.indexOf(to);
      if (a < 0 || b < 0 || a === b) return;
      ids.splice(a, 1); ids.splice(b, 0, from);
      found.forEach(function (d) { d.order = ids.indexOf(d.id); });
      if (options.onReorder) options.onReorder(ids);
      refresh();
    }
    function refresh() {
      if (dragging) return;
      refreshPicker(false);
      var found = destinations();
      if (editing && !editorChoices().some(function (d) { return d.id === editing; })) resetEditor();
      var focused = document.activeElement, focusedId = focused && focused.dataset && focused.dataset.egmId;
      list.replaceChildren();
      found.forEach(function (d) {
        var row = make('div', 'egm-dest', list); row.dataset.egmId = d.id;
        var handle = button('⠿', 'egm-drag', row, function () {});
        handle.draggable = true; handle.title = 'Drag to reorder · Alt + ↑ / ↓';
        handle.setAttribute('aria-label', 'Reorder ' + d.label);
        // Pointer capture supports mouse and touch without moving DOM under a live drag.
        var startY = null, dropId = null;
        handle.addEventListener('pointerdown', function (ev) {
          if (ev.button !== 0) return;
          ev.preventDefault(); startY = ev.clientY; dropId = null;
          handle.setPointerCapture(ev.pointerId); handle.focus();
        });
        handle.addEventListener('pointermove', function (ev) {
          if (startY === null || Math.abs(ev.clientY - startY) < 4 && !dragging) return;
          dragging = d.id; row.classList.add('egm-dragging');
          list.querySelectorAll('.egm-drop-target').forEach(function (el) { el.classList.remove('egm-drop-target'); });
          var hit = document.elementFromPoint(ev.clientX, ev.clientY);
          var destination = hit && hit.closest('.egm-dest');
          dropId = destination && list.contains(destination) ? destination.dataset.egmId : null;
          if (dropId && dropId !== d.id) destination.classList.add('egm-drop-target');
          var bounds = menu.getBoundingClientRect();
          if (ev.clientY > bounds.bottom - 24) menu.scrollTop += 12;
          else if (ev.clientY < bounds.top + 24) menu.scrollTop -= 12;
        });
        function releasePointer(ev) {
          if (startY === null) return;
          startY = null; dragging = null;
          if (handle.hasPointerCapture(ev.pointerId)) handle.releasePointerCapture(ev.pointerId);
          if (ev.type === 'pointerup' && dropId) reorder(d.id, dropId);
          dropId = null; refresh();
        }
        handle.addEventListener('pointerup', releasePointer);
        handle.addEventListener('pointercancel', releasePointer);
        handle.addEventListener('dragstart', function (ev) {
          dragging = d.id; row.classList.add('egm-dragging');
          if (ev.dataTransfer) { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', d.id); }
        });
        handle.addEventListener('dragend', function () { dragging = null; row.classList.remove('egm-dragging'); refresh(); });
        handle.addEventListener('keydown', function (ev) {
          if (!ev.altKey || (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown')) return;
          ev.preventDefault(); ev.stopPropagation(); var i = found.indexOf(d), other = found[i + (ev.key === 'ArrowUp' ? -1 : 1)];
          if (other) { reorder(d.id, other.id); var h = list.querySelector('[data-egm-id="' + d.id + '"] .egm-drag'); if (h) h.focus(); }
        });
        row.addEventListener('dragover', function (ev) { if (dragging) { ev.preventDefault(); row.classList.add('egm-drop-target'); } });
        row.addEventListener('dragleave', function () { row.classList.remove('egm-drop-target'); });
        row.addEventListener('drop', function (ev) {
          if (dragging) { ev.preventDefault(); var from = dragging; dragging = null; reorder(from, d.id); }
        });
        var check = make('input', 'egm-check', row); check.type = 'checkbox'; check.checked = !excluded.has(d.id);
        check.setAttribute('aria-label', 'Print ' + d.label);
        check.addEventListener('change', function () { check.checked ? excluded.delete(d.id) : excluded.add(d.id); updatePrint(); });
        var go = button(d.label + ' · p. ' + P.format(d.pages), 'egm-go', row, function () { jump(d.page); });
        go.dataset.egmId = d.id; go.title = 'Go to PDF page ' + d.page;
        if (focusedId === d.id) go.focus();
        var editBtn = button('✎', 'egm-edit', row, function () { selectEditor(d.id, true); });
        editBtn.setAttribute('aria-label', 'Edit ' + d.label); editBtn.title = 'Edit name and pages';
        var drop = button('×', 'egm-remove', row, function () {
          excluded.delete(d.id);
          if (options.onRemove) options.onRemove(d.page, d.id);
          if (editing === d.id) resetEditor();
        });
        drop.setAttribute('aria-label', 'Remove ' + d.label); drop.title = 'Remove shortcut';
      });
      empty.hidden = !!found.length; updatePosition(); updatePrint();
    }
    target.addEventListener('change', function () { selectEditor(target.value, false); });
    target.addEventListener('blur', function () { refreshPicker(true); });
    range.addEventListener('input', function () { clearError(); updatePosition(); });
    function open() { refreshPicker(true); refresh(); menu.hidden = false; trigger.setAttribute('aria-expanded', 'true'); target.focus(); }
    function close(focus) { menu.hidden = true; trigger.setAttribute('aria-expanded', 'false'); if (focus) trigger.focus(); }
    function outside(ev) { if (!menu.hidden && !menu.contains(ev.target) && ev.target !== trigger) close(false); }
    function key(ev) {
      if (menu.hidden) return;
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopImmediatePropagation(); close(true); }
      else if (menu.contains(ev.target)) {
        // Capture shields the viewer's global shortcuts; target handlers still need Alt+arrows.
        if (ev.altKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) return;
        if (ev.key === 'Enter' && (ev.target === name || ev.target === range)) { ev.preventDefault(); saveSelection(); }
        ev.stopPropagation();
      }
    }
    document.addEventListener('click', outside); document.addEventListener('keydown', key, true);
    refresh();
    return {
      jump: jump, updatePosition: updatePosition, refresh: refresh,
      setEpisodes: function (values) {
        var next = (Array.isArray(values) ? values : []).filter(function (e) { return e && ENTRY.test(e.id); }).map(function (e) {
          var pages = P.pagesOf(e, doc.numPages);
          return { id: e.id, page: pages ? pages[0] : null, pages: pages, order: e.order,
            defaultLabel: e.defaultLabel || e.label, customLabel: e.customLabel || '',
            label: typeof e.label === 'string' && e.label.trim() ? e.label.trim().slice(0, 80) : 'Entry ' + e.id.split('-')[1] };
        });
        trigger.hidden = false;
        if (JSON.stringify(next) !== JSON.stringify(episodes)) { episodes = next; refresh(); }
      },
      setMarks: function (values) {
        var next = (Array.isArray(values) ? values : []).map(function (v) {
          var m = typeof v === 'number' ? { page: v } : v;
          var pages = m && P.pagesOf(m, doc.numPages);
          return pages ? { id: m.id || 'mark-' + pages[0], page: pages[0], pages: pages, order: m.order,
            label: m.label || 'Saved pages' } : null;
        }).filter(Boolean);
        if (JSON.stringify(next) !== JSON.stringify(marks)) { marks = next; refresh(); }
      },
      dispose: function () {
        disposed = true; document.removeEventListener('click', outside); document.removeEventListener('keydown', key, true);
        trigger.remove(); back.remove(); menu.remove();
      }
    };
  }
  var api = { mount: mount };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CRMEgmNavigation = api;
})(typeof window !== 'undefined' ? window : null);
