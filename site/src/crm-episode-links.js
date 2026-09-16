/* Episode navigation metadata rides in the existing report JSON, never in clinical exports. */
(function (root) {
  'use strict';
  var P = root ? root.CRMPageSelection : require('./pdf-page-selection');
  function checkLink(v) {
    if (!v || !/^sha256:[a-f0-9]{64}$/.test(v.documentKey) || typeof v.file !== 'string' || !v.file.length ||
        v.file.length > 255 || /[\\/]/.test(v.file)) return null;
    var pages = P.pagesOf(v);
    if (!pages) return null;
    var link = { documentKey: v.documentKey, file: v.file, page: pages[0] };
    if (v.pages) link.pages = pages;
    if (typeof v.label === 'string' && v.label.trim()) link.label = v.label.trim().slice(0, 80);
    if (Number.isInteger(v.order) && v.order >= 0 && v.order < 10000) link.order = v.order;
    if (typeof v.id === 'string' && /^mark-[a-z0-9-]{1,80}$/i.test(v.id)) link.id = v.id;
    return link;
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
      var value = list.length ? JSON.stringify(list) : '';
      if (el && el.value !== value) { el.value = value; dirty(el); }
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
    function markId(item) { return item.id || 'mark-' + item.page; }
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
        marks: readMarks().filter(ofSource).map(function (m) {
          return { id: markId(m), page: m.page, pages: P.pagesOf(m), label: m.label || '', order: m.order };
        }),
        entries: active.map(function (row) {
          var link = readLink(input(row).value);
          var current = link && ofSource(link);
          return { id: row.id, label: current && link.label || entryLabel(row), page: current ? link.page : null,
            defaultLabel: entryLabel(row), customLabel: current && link.label || '',
            pages: current ? P.pagesOf(link) : null, order: current ? link.order : undefined };
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
        var pages = P.pagesOf(m, context.numPages);
        if (!pages) return;
        var link = checkLink({ documentKey: context.documentKey, file: context.file, page: pages[0],
          pages: m.pages ? pages : undefined, label: m.label });
        if (!link) return;
        if (m.entryId) {
          var row = rows().filter(function (r) { return r.id === m.entryId; })[0];
          if (!row) return;
          var previous = readLink(input(row).value);
          if (previous && ofSource(previous) && previous.order !== undefined) link.order = previous.order;
          save(row, link);
          // Preserve named shortcuts, even if they overlap an episode. Legacy anonymous single
          // pages retain their old assignment behavior.
          saveMarks(readMarks().filter(function (k) { return !(ofSource(k) && !k.label && !k.id && k.page === link.page); }));
        } else {
          var all = readMarks(), index = all.findIndex(function (k) {
            return ofSource(k) && (m.savedId ? markId(k) === m.savedId : !k.id && !k.label && k.page === link.page);
          });
          if (m.savedId && index < 0) return; // an obsolete editor cannot resurrect a removed shortcut
          if (index >= 0) {
            link.id = all[index].id || (m.savedId ? markId(all[index]) : undefined);
            link.order = all[index].order;
            if (JSON.stringify(all[index]) === JSON.stringify(link)) return;
            all[index] = link;
          } else {
            if (m.pages || m.label) link.id = 'mark-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
            all.push(link);
          }
          saveMarks(all);
        }
        publish();
      } else if (m.type === 'crm:egm-remove') {
        // Include the other device-mode table too; links never silently reappear after a mode switch.
        document.querySelectorAll('[data-egm-link-value]').forEach(function (el) {
          var link = readLink(el.value);
          if (link && ofSource(link) && (m.savedId ? el.closest('tr').id === m.savedId : link.page === m.page)) save(el.closest('tr'), null);
        });
        if (m.savedId) saveMarks(readMarks().filter(function (k) { return !(ofSource(k) && markId(k) === m.savedId); }));
        else dropMark(m.page);
        publish();
      } else if (m.type === 'crm:egm-reorder' && Array.isArray(m.ids) && m.ids.length <= 10000) {
        var ids = Array.from(new Set(m.ids.filter(function (id) { return typeof id === 'string'; })));
        rows().forEach(function (row) {
          var link = readLink(input(row).value), order = ids.indexOf(row.id);
          if (link && ofSource(link) && order >= 0 && link.order !== order) { link.order = order; save(row, link); }
        });
        var all = readMarks(), changed = false;
        all.forEach(function (link) {
          var order = ids.indexOf(markId(link));
          if (ofSource(link) && order >= 0 && link.order !== order) { link.order = order; changed = true; }
        });
        if (changed) saveMarks(all);
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
