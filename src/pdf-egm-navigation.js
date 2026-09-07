/* Local, document-scoped EGM page shortcuts.
   Every destination here is an explicit save by the technician. Nothing in this file infers that
   a page holds a recording, and none of it reaches the generated report content.

   The controls live in one toolbar button and a popover, never a second toolbar row: the whole
   point of the split view is vertical space for the document. */
(function (root) {
  'use strict';
  var ENTRY = /^(?:ep|lep)-[1-9]\d*$/;
  function mount(options) {
    var doc = options.doc, slot = options.toolbar, disposed = false;
    var episodes = [], marks = [], returnPosition = null;
    function valid(page) { return Number.isInteger(page) && page > 0 && page <= doc.numPages; }
    function make(tag, className, parent) {
      var el = document.createElement(tag);
      if (className) el.className = className;
      if (parent) parent.appendChild(el);
      return el;
    }
    function button(label, className, parent, action) {
      var b = make('button', className, parent);
      b.type = 'button'; b.textContent = label;
      b.addEventListener('click', action);
      return b;
    }
    function option(value, label) {
      var o = document.createElement('option'); o.value = value; o.textContent = label; return o;
    }

    // Hidden until the report says which logbook entries exist: a PDF opened on its own has
    // nowhere to save a page to.
    var trigger = button('EGM', 'egm-trigger', slot, function () { menu.hidden ? open() : close(true); });
    trigger.hidden = true;
    var back = button('Back', 'egm-back', slot, function () {
      if (!returnPosition) return;
      options.restore(returnPosition); returnPosition = null; back.hidden = true;
    });
    back.hidden = true; back.title = 'Restore the page and zoom from before your last jump';

    var menu = make('div', 'egm-menu', document.body);
    menu.hidden = true; menu.id = 'egm-menu';
    menu.setAttribute('role', 'region'); menu.setAttribute('aria-label', 'EGM page shortcuts');
    trigger.setAttribute('aria-controls', menu.id); trigger.setAttribute('aria-expanded', 'false');
    var saveRow = make('div', 'egm-save-row', menu);
    var target = make('select', 'egm-target', saveRow);
    target.setAttribute('aria-label', 'Where to save the current page');
    var save = button('Save page', 'egm-save', saveRow, function () {
      var page = options.position().page;
      if (!valid(page) || !options.onAssign) return;
      options.onAssign(ENTRY.test(target.value) ? target.value : null, page);
      close(true);
    });
    var list = make('div', 'egm-list', menu);
    var empty = make('p', 'egm-empty', menu);

    // An episode's own page wins the label; a page saved without an entry stands on its own.
    function destinations() {
      var found = [];
      episodes.forEach(function (e) { if (valid(e.page)) found.push({ page: e.page, label: e.label }); });
      marks.forEach(function (p) {
        if (valid(p) && !found.some(function (d) { return d.page === p; })) found.push({ page: p, label: 'Unassigned' });
      });
      return found.sort(function (a, b) { return a.page - b.page; });
    }
    function jump(page) {
      if (!valid(page)) return;
      if (options.position().page !== page) {
        if (!returnPosition) returnPosition = options.position();
        back.textContent = 'Back to p. ' + returnPosition.page; back.hidden = false;
      }
      options.goTo(page);
      close(false);
    }
    // Runs on every scroll, so it touches only the two labels that follow the page.
    function updatePosition() {
      var page = options.position().page, count = destinations().length;
      var chosen = ENTRY.test(target.value) && episodes.filter(function (e) { return e.id === target.value; })[0];
      save.textContent = 'Save page ' + page;
      save.title = chosen ? 'Assign PDF page ' + page + ' to ' + chosen.label
        : 'Save PDF page ' + page + ' without assigning it to a logbook entry';
      trigger.textContent = count ? 'EGM · ' + count : 'EGM';
      trigger.title = 'Save this page to a logbook entry, or jump to a saved page' +
        (count ? ' (' + count + ' saved)' : '');
    }
    function refresh() {
      // A report edit republishes its entries at any time; never yank the list out from under
      // someone who is choosing in the dropdown.
      if (!(document.activeElement === target && !menu.hidden)) {
        var keep = target.value;
        target.replaceChildren(option('', 'Unassigned page'));
        episodes.forEach(function (e) { target.appendChild(option(e.id, e.label + (valid(e.page) ? ' · p. ' + e.page : ''))); });
        target.value = episodes.some(function (e) { return e.id === keep; }) ? keep : '';
      }
      var found = destinations();
      // Keep the focused destination reachable when the list is rebuilt under a keyboard user.
      var focused = document.activeElement, focusedPage = focused && focused.dataset && focused.dataset.egmPage;
      list.replaceChildren();
      found.forEach(function (d) {
        var row = make('div', 'egm-dest', list);
        var go = button(d.label + ' · p. ' + d.page, 'egm-go', row, function () { jump(d.page); });
        go.dataset.egmPage = String(d.page);
        go.title = 'Go to PDF page ' + d.page;
        if (focusedPage === String(d.page)) go.focus();
        var drop = button('×', 'egm-remove', row, function () {
          if (options.onRemove) options.onRemove(d.page);
          target.focus();
        });
        drop.setAttribute('aria-label', 'Remove page ' + d.page + ' and any episode links to it');
        drop.title = drop.getAttribute('aria-label');
      });
      empty.hidden = !!found.length;
      empty.textContent = 'No saved pages yet. Choose an entry above and save the page you are on.';
      updatePosition();
    }
    target.addEventListener('change', function () { if (!disposed) updatePosition(); });
    function open() {
      refresh(); menu.hidden = false; trigger.setAttribute('aria-expanded', 'true'); target.focus();
    }
    function close(focus) {
      if (menu.hidden) return;
      menu.hidden = true; trigger.setAttribute('aria-expanded', 'false');
      if (focus) trigger.focus();
    }
    function outside(ev) { if (!menu.hidden && !menu.contains(ev.target) && ev.target !== trigger) close(false); }
    function key(ev) {
      if (menu.hidden) return;
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopImmediatePropagation(); close(true); }
      // The viewer's page shortcuts must not consume native button, select or Tab behavior here.
      else if (menu.contains(ev.target)) ev.stopPropagation();
    }
    document.addEventListener('click', outside);
    document.addEventListener('keydown', key, true);
    refresh();
    return {
      jump: jump, updatePosition: updatePosition, refresh: refresh,
      setEpisodes: function (values) {
        var next = (Array.isArray(values) ? values : []).filter(function (e) { return e && ENTRY.test(e.id); }).map(function (e) {
          return { id: e.id, page: valid(e.page) ? e.page : null,
            label: typeof e.label === 'string' && e.label.trim() ? e.label.trim().slice(0, 80) : 'Entry ' + e.id.split('-')[1] };
        });
        trigger.hidden = false;
        if (JSON.stringify(next) === JSON.stringify(episodes)) return;
        episodes = next; refresh();
      },
      setMarks: function (values) {
        var next = (Array.isArray(values) ? values : []).filter(valid).sort(function (a, b) { return a - b; });
        if (JSON.stringify(next) === JSON.stringify(marks)) return;
        marks = next; refresh();
      },
      dispose: function () {
        disposed = true;
        document.removeEventListener('click', outside);
        document.removeEventListener('keydown', key, true);
        trigger.remove(); back.remove(); menu.remove();
      }
    };
  }
  var api = { mount: mount };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CRMEgmNavigation = api;
})(typeof window !== 'undefined' ? window : null);
