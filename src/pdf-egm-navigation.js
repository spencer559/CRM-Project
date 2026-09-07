/* Local, document-scoped EGM page shortcuts.
   Every destination here is an explicit save by the technician. Nothing in this file infers that
   a page holds a recording, and none of it reaches the generated report content. */
(function (root) {
  'use strict';
  var ENTRY = /^(?:ep|lep)-[1-9]\d*$/;
  function mount(options) {
    var doc = options.doc, disposed = false;
    var episodes = [], marks = [], returnPosition = null;
    function valid(page) { return Number.isInteger(page) && page > 0 && page <= doc.numPages; }

    // Hidden until the report tells us which logbook entries exist: a PDF opened on its own has
    // nowhere to save a page to, and an inert toolbar is just lost reading height.
    var bar = document.createElement('div');
    bar.className = 'egm-bar'; bar.hidden = true;
    bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', 'EGM page shortcuts');
    function add(tag, className) {
      var el = document.createElement(tag);
      if (className) el.className = className;
      bar.appendChild(el); return el;
    }
    function button(label, className, action) {
      var b = add('button', className); b.type = 'button'; b.textContent = label;
      b.addEventListener('click', action); return b;
    }
    function option(value, label) {
      var o = document.createElement('option'); o.value = value; o.textContent = label; return o;
    }
    var target = add('select', 'egm-target');
    target.setAttribute('aria-label', 'Where to save the current page');
    var save = button('Save page', 'egm-save', function () {
      var page = options.position().page;
      if (valid(page) && options.onAssign) options.onAssign(ENTRY.test(target.value) ? target.value : null, page);
    });
    var goto_ = add('select', 'egm-goto');
    goto_.setAttribute('aria-label', 'Go to a saved EGM page');
    goto_.addEventListener('change', function () {
      var page = Number(goto_.value);
      goto_.value = '';
      jump(page);
    });
    var remove = button('Remove', 'egm-remove', function () {
      var page = options.position().page;
      if (valid(page) && options.onRemove) options.onRemove(page);
    });
    var back = button('Back', 'egm-back', function () {
      if (!returnPosition) return;
      options.restore(returnPosition); returnPosition = null; back.hidden = true;
    });
    back.hidden = true; back.title = 'Restore the page and zoom from before your last jump';
    var status = add('span', 'egm-status');
    document.body.appendChild(bar);

    // An episode's own page wins the label; a page saved without an entry stands on its own.
    function destinations() {
      var list = [];
      episodes.forEach(function (e) { if (valid(e.page)) list.push({ page: e.page, label: e.label }); });
      marks.forEach(function (p) {
        if (valid(p) && !list.some(function (d) { return d.page === p; })) list.push({ page: p, label: 'Unassigned' });
      });
      return list.sort(function (a, b) { return a.page - b.page; });
    }
    function jump(page) {
      if (!valid(page)) return;
      if (options.position().page !== page) {
        if (!returnPosition) returnPosition = options.position();
        back.textContent = 'Back to p. ' + returnPosition.page; back.hidden = false;
      }
      options.goTo(page);
    }
    // Runs on every scroll, so it only rewrites labels, never the option lists.
    function updatePosition() {
      var page = options.position().page, found = destinations();
      var chosen = ENTRY.test(target.value) && episodes.filter(function (e) { return e.id === target.value; })[0];
      save.textContent = 'Save page ' + page;
      save.title = chosen ? 'Assign PDF page ' + page + ' to ' + chosen.label
        : 'Save PDF page ' + page + ' without assigning it to a logbook entry';
      remove.hidden = !found.some(function (d) { return d.page === page; });
      remove.textContent = 'Remove p. ' + page;
      remove.title = 'Remove page ' + page + ' and any episode links to it';
      status.textContent = found.length ? found.length + (found.length === 1 ? ' saved page' : ' saved pages') : 'No saved pages yet';
    }
    function fillSelects() {
      var keep = target.value;
      target.replaceChildren(option('', 'Unassigned page'));
      episodes.forEach(function (e) { target.appendChild(option(e.id, e.label + (valid(e.page) ? ' · p. ' + e.page : ''))); });
      target.value = episodes.some(function (e) { return e.id === keep; }) ? keep : '';
      var found = destinations();
      goto_.replaceChildren(option('', found.length ? 'Go to saved page…' : 'No saved pages'));
      found.forEach(function (d) { goto_.appendChild(option(String(d.page), d.label + ' · p. ' + d.page)); });
      goto_.disabled = !found.length;
      goto_.value = '';
    }
    function refresh() {
      // A report edit republishes its entries at any time; never yank the list out from under
      // someone who is choosing in one of these dropdowns.
      var focused = document.activeElement;
      if (!(focused && focused.tagName === 'SELECT' && bar.contains(focused))) fillSelects();
      updatePosition();
    }
    [target, goto_].forEach(function (select) {
      select.addEventListener('change', function () { if (!disposed) refresh(); });
      select.addEventListener('blur', function () { setTimeout(function () { if (!disposed) refresh(); }, 0); });
    });
    function reveal() {
      if (!bar.hidden) return;
      bar.hidden = false;
      document.documentElement.classList.add('egm-ready');
      // The toolbar just took page height; the fit has to be recomputed for it.
      if (options.onReveal) options.onReveal();
    }
    // The viewer's own page shortcuts must not fire while someone is using these controls.
    function key(ev) { if (bar.contains(ev.target)) ev.stopPropagation(); }
    document.addEventListener('keydown', key, true);
    refresh();
    return {
      jump: jump, updatePosition: updatePosition, refresh: refresh,
      setEpisodes: function (values) {
        var next = (Array.isArray(values) ? values : []).filter(function (e) { return e && ENTRY.test(e.id); }).map(function (e) {
          return { id: e.id, page: valid(e.page) ? e.page : null,
            label: typeof e.label === 'string' && e.label.trim() ? e.label.trim().slice(0, 80) : 'Entry ' + e.id.split('-')[1] };
        });
        reveal();
        if (JSON.stringify(next) === JSON.stringify(episodes)) return;
        episodes = next; refresh();
      },
      setMarks: function (values) {
        var next = (Array.isArray(values) ? values : []).filter(valid).sort(function (a, b) { return a - b; });
        if (JSON.stringify(next) === JSON.stringify(marks)) return;
        marks = next; refresh();
      },
      dispose: function () {
        disposed = true; document.removeEventListener('keydown', key, true); bar.remove();
        document.documentElement.classList.remove('egm-ready');
      }
    };
  }
  var api = { mount: mount };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CRMEgmNavigation = api;
})(typeof window !== 'undefined' ? window : null);
