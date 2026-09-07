/* Episode navigation metadata rides in the existing report JSON, never in clinical exports. */
(function (root) {
  'use strict';
  function readLink(value) {
    try {
      var v = JSON.parse(value || 'null');
      return v && /^sha256:[a-f0-9]{64}$/.test(v.documentKey) && typeof v.file === 'string' && v.file.length > 0 && v.file.length <= 255 &&
        !/[\\/]/.test(v.file) && Number.isInteger(v.page) && v.page > 0 ? { documentKey: v.documentKey, file: v.file, page: v.page } : null;
    } catch (e) { return null; }
  }
  function mount() {
    var context = null, embedded = root.CRM_EMBED === true;
    function post(message) { if (embedded) root.parent.postMessage(message, location.origin === 'null' ? '*' : location.origin); }
    function rows() { return Array.from(document.querySelectorAll((root.isLoopMode() ? '#lep-tbody' : '#ep-tbody') + ' tr')); }
    function input(row) { return row.querySelector('[data-egm-link-value]'); }
    function publish() {
      var active = rows();
      document.querySelectorAll('[data-episode-link]').forEach(function (b) {
        var row = b.closest('tr'), link = readLink(input(row).value);
        b.hidden = !link; b.disabled = !embedded;
        b.textContent = link ? 'p. ' + link.page : '';
        b.title = link ? 'Open EGM for entry ' + row.id.split('-')[1] + ' — ' + link.file + ', PDF page ' + link.page : '';
        b.setAttribute('aria-label', b.title);
      });
      if (context && context.available && context.documentKey) post({ type: 'crm:egm-entries', id: context.id, documentKey: context.documentKey,
        entries: active.map(function (row) {
          var link = readLink(input(row).value);
          return { id: row.id, label: 'Entry ' + row.id.split('-')[1],
            page: link && link.documentKey === context.documentKey && link.file === context.file ? link.page : null };
        }) });
    }
    function save(row, value) {
      var el = input(row); el.value = value ? JSON.stringify(value) : '';
      // The same input event as manual editing marks the slot dirty and schedules its draft save.
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    document.querySelectorAll('[data-view-egms]').forEach(function (button) {
      button.hidden = !embedded;
      button.textContent = 'EGM pages';
      button.addEventListener('click', function () { publish(); post({ type: 'crm:view-egms' }); });
    });
    document.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-episode-link]');
      if (!b || b.disabled) return;
      var link = readLink(input(b.closest('tr')).value);
      if (link) post({ type: 'crm:egm-open-link', link: link });
    });
    root.addEventListener('message', function (ev) {
      if (!embedded || ev.source !== root.parent || ev.origin !== location.origin) return;
      var m = ev.data || {};
      if (m.type === 'crm:egm-available') {
        context = m;
        document.querySelectorAll('[data-view-egms]').forEach(function (b) {
          b.disabled = !m.available;
          b.title = m.available ? 'Open EGM page shortcuts and assign pages to logbook entries' : 'Select a PDF in split view to open its EGM pages';
        });
        publish(); return;
      }
      if (!context || !context.available || m.id !== context.id || m.documentKey !== context.documentKey) return;
      if (m.type === 'crm:egm-assign') {
        var row = rows().find(function (r) { return r.id === m.entryId; });
        var link = readLink(JSON.stringify({ documentKey: context.documentKey, file: context.file, page: m.page }));
        if (row && link) { save(row, link); publish(); }
      } else if (m.type === 'crm:egm-remove') {
        // Include the other device-mode table too; links never silently reappear after a mode switch.
        document.querySelectorAll('[data-egm-link-value]').forEach(function (el) {
          var link = readLink(el.value);
          if (link && link.documentKey === context.documentKey && link.file === context.file && link.page === m.page) save(el.closest('tr'), null);
        });
        publish();
      }
    });
    var observer = new MutationObserver(publish);
    ['ep-tbody', 'lep-tbody'].forEach(function (id) { observer.observe(document.getElementById(id), { childList: true }); });
    document.addEventListener('change', function (ev) { if (ev.target.name === 'dtype') publish(); });
    // Stored links may already have been restored before this script loads.
    publish();
    if (embedded) post({ type: 'crm:egm-context-request' });
  }
  var api = { readLink: readLink, mount: mount };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) { root.CRMEpisodeLinks = api; mount(); }
})(typeof window !== 'undefined' ? window : null);
