/* Episode navigation metadata rides in the existing report JSON, never in clinical exports. */
(function (root) {
  'use strict';
  function checkLink(v) {
    return v && /^sha256:[a-f0-9]{64}$/.test(v.documentKey) && typeof v.file === 'string' && v.file.length > 0 && v.file.length <= 255 &&
      !/[\\/]/.test(v.file) && Number.isInteger(v.page) && v.page > 0 ? { documentKey: v.documentKey, file: v.file, page: v.page } : null;
  }
  function readLink(value) {
    try { return checkLink(JSON.parse(value || 'null')); } catch (e) { return null; }
  }
  // "08/22/2026 09:18PM" — read straight off the datetime-local string so no time zone is applied.
  function formatWhen(value) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(value || ''));
    if (!m) return '';
    var h = Number(m[4]), suffix = h < 12 ? 'AM' : 'PM', hour = h % 12 || 12;
    return m[2] + '/' + m[3] + '/' + m[1] + ' ' + String(hour).padStart(2, '0') + ':' + m[5] + suffix;
  }
  // The label a technician recognizes in the viewer: the logbook entry as they wrote it.
  function entryLabel(row) {
    var id = String(row.id || ''), n = id.split('-')[1] || '', prefix = id.split('-')[0] + n;
    var dt = row.querySelector('[name="' + prefix + '-dt"]');
    var types = Array.from(row.querySelectorAll('[name="' + prefix + '-type"]'))
      .filter(function (el) { return el.checked; }).map(function (el) { return el.value; }).join('/');
    // The "#" column leads, so a destination reads the way the row does: "#1 08/22/2026 09:18PM NS-VT".
    return ('#' + n + ' ' + [formatWhen(dt && dt.value), types].filter(Boolean).join(' ')).trim();
  }
  function mount() {
    var context = null, embedded = root.CRM_EMBED === true;
    function post(message) { if (embedded) root.parent.postMessage(message, location.origin === 'null' ? '*' : location.origin); }
    function rows() { return Array.from(document.querySelectorAll((root.isLoopMode() ? '#lep-tbody' : '#ep-tbody') + ' tr')); }
    function input(row) { return row.querySelector('[data-egm-link-value]'); }
    // Pages saved without an episode. One hidden field for the whole report, scoped to its source
    // document exactly like the per-entry links.
    function marksInput() { return document.getElementById('egm-marks'); }
    function readMarks() {
      try {
        var v = JSON.parse((marksInput() || {}).value || '[]');
        return Array.isArray(v) ? v.map(checkLink).filter(Boolean) : [];
      } catch (e) { return []; }
    }
    function saveMarks(list) {
      var el = marksInput();
      if (el) { el.value = list.length ? JSON.stringify(list) : ''; dirty(el); }
    }
    function dirty(el) {
      // The same input event as manual editing marks the slot dirty and schedules its draft save.
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    function dropMark(page) {
      var all = readMarks(), kept = all.filter(function (k) { return !(ofSource(k) && k.page === page); });
      if (kept.length !== all.length) saveMarks(kept);
    }
    function ofSource(item) { return context && item.documentKey === context.documentKey && item.file === context.file; }
    function publish() {
      var active = rows();
      // The row number is the jump control, so it stays visible whether or not a page is linked.
      document.querySelectorAll('[data-episode-link]').forEach(function (b) {
        var row = b.closest('tr'), link = readLink(input(row).value), n = row.id.split('-')[1];
        b.textContent = n;
        b.disabled = !link || !embedded;
        if (link && embedded) b.setAttribute('data-linked', ''); else b.removeAttribute('data-linked');
        b.title = link ? 'Open the EGM page for episode ' + n + ' — ' + link.file + ', PDF page ' + link.page : '';
        b.setAttribute('aria-label', link ? 'Episode ' + n + ', open EGM page ' + link.page : 'Episode ' + n);
      });
      if (context && context.available && context.documentKey) post({ type: 'crm:egm-entries', id: context.id, documentKey: context.documentKey,
        marks: readMarks().filter(ofSource).map(function (m) { return m.page; }),
        entries: active.map(function (row) {
          var link = readLink(input(row).value);
          return { id: row.id, label: entryLabel(row), page: link && ofSource(link) ? link.page : null };
        }) });
    }
    function save(row, value) {
      var el = input(row); el.value = value ? JSON.stringify(value) : '';
      dirty(el);
    }
    document.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-episode-link]');
      if (!b || b.disabled) return;
      var link = readLink(input(b.closest('tr')).value);
      if (link) post({ type: 'crm:egm-open-link', link: link });
    });
    root.addEventListener('message', function (ev) {
      if (!embedded || ev.source !== root.parent || ev.origin !== location.origin) return;
      var m = ev.data || {};
      if (m.type === 'crm:egm-available') { context = m; publish(); return; }
      if (!context || !context.available || m.id !== context.id || m.documentKey !== context.documentKey) return;
      if (m.type === 'crm:egm-assign') {
        var link = checkLink({ documentKey: context.documentKey, file: context.file, page: m.page });
        if (!link) return;
        if (m.entryId) {
          var row = rows().filter(function (r) { return r.id === m.entryId; })[0];
          if (!row) return;
          save(row, link);
          // An assigned page is now named by its episode; drop the anonymous copy of it.
          dropMark(link.page);
        } else if (!readMarks().some(function (k) { return ofSource(k) && k.page === link.page; })) {
          saveMarks(readMarks().concat([link]));
        } else return;
        publish();
      } else if (m.type === 'crm:egm-remove') {
        // Include the other device-mode table too; links never silently reappear after a mode switch.
        document.querySelectorAll('[data-egm-link-value]').forEach(function (el) {
          var link = readLink(el.value);
          if (link && ofSource(link) && link.page === m.page) save(el.closest('tr'), null);
        });
        dropMark(m.page);
        publish();
      }
    });
    var observer = new MutationObserver(publish);
    ['ep-tbody', 'lep-tbody'].forEach(function (id) { observer.observe(document.getElementById(id), { childList: true }); });
    // Date, episode type and device mode all change the labels the viewer shows.
    document.addEventListener('change', publish);
    document.addEventListener('input', function (ev) { if (ev.target.type === 'datetime-local') publish(); });
    // Stored links may already have been restored before this script loads.
    publish();
    if (embedded) post({ type: 'crm:egm-context-request' });
  }
  var api = { readLink: readLink, formatWhen: formatWhen, entryLabel: entryLabel, mount: mount };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) { root.CRMEpisodeLinks = api; mount(); }
})(typeof window !== 'undefined' ? window : null);
