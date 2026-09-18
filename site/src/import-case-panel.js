/* Case mode UI shared by the two redactors (tools/cied-pdf-redactor.html and
 * tools/abbott-log-redactor.html). The Report Generator's "Report import problem" opens one of
 * them with #case=<id>; this module receives the export from it and draws the panel that turns
 * a failed import into a case: what was removed, what still needs a decision, how the import
 * compares with the tech's finished report, and the export gate. The de-identification itself is
 * in import-case.js; each page owns its own viewer and export. docs/import-cases.md has the
 * workflow.
 */
(function (global) {
  'use strict';

  var CSS =
    '.icp{font:12px/1.4 Arial,Helvetica,sans-serif;color:#171b20}' +
    '.icp h2{margin:0;color:var(--navy,#1e3a5f);font-size:14px;text-transform:uppercase;letter-spacing:.4px}' +
    '.icp .icp-sub{color:#65717d;margin:2px 0 8px}' +
    '.icp h3{margin:12px 0 5px;color:var(--navy,#1e3a5f);font-size:10px;text-transform:uppercase;letter-spacing:.5px;display:flex;gap:6px;align-items:center}' +
    '.icp .icp-n{display:inline-block;min-width:16px;padding:0 5px;border-radius:8px;background:#e7eff7;color:var(--navy,#1e3a5f);font-size:10px;text-align:center}' +
    '.icp .icp-n.bad{background:#f6dcdc;color:#a12f2f}.icp .icp-n.ok{background:#dcefe3;color:#267746}' +
    '.icp ul{margin:0;padding:0;list-style:none}.icp li{padding:4px 0;border-bottom:1px solid #edf0f3}' +
    '.icp .icp-row{display:flex;align-items:center;gap:6px}.icp .icp-row .grow{flex:1;min-width:0;overflow-wrap:anywhere}' +
    '.icp .icp-mono{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:11px}' +
    '.icp .icp-meta{color:#65717d;font-size:10px}' +
    '.icp button{font:inherit;font-size:10px;font-weight:700;padding:3px 8px;border-radius:4px;border:1px solid var(--navy,#1e3a5f);background:#fff;color:var(--navy,#1e3a5f);cursor:pointer}' +
    '.icp button.primary{background:var(--navy,#1e3a5f);color:#fff;padding:7px 12px;font-size:11px}' +
    '.icp button.warn{border-color:#b77;color:#a12f2f}' +
    '.icp button:disabled{opacity:.45;cursor:not-allowed}' +
    '.icp .icp-note{padding:7px 8px;border-radius:5px;background:#fff6e6;border:1px solid #e2c28c;color:#674100;margin:6px 0}' +
    '.icp .icp-err{padding:7px 8px;border-radius:5px;background:#fdf0f0;border:1px solid #e3b8b8;color:#9a2f2f;margin:6px 0}' +
    '.icp table{width:100%;border-collapse:collapse}.icp td,.icp th{padding:3px 4px;border-bottom:1px solid #edf0f3;text-align:left;vertical-align:top}' +
    '.icp th{font-size:9px;text-transform:uppercase;color:#65717d}' +
    '.icp .k-missing{color:#a12f2f}.icp .k-mismatch{color:#9a5b00}.icp .k-extra{color:#65717d}' +
    '.icp textarea{width:100%;min-height:54px;box-sizing:border-box;font:inherit;border:1px solid #c5cfda;border-radius:4px;padding:6px}' +
    '.icp .icp-gate{margin:8px 0;color:#a12f2f;font-size:11px}.icp .icp-gate.ok{color:#267746}' +
    '.icp .icp-done{margin-top:6px;color:#267746;font-weight:700}' +
    '.icp label.icp-check{display:flex;gap:6px;align-items:center;margin:8px 0 0;color:#65717d}';

  function injectCss() {
    if (document.getElementById('icp-css')) return;
    var s = document.createElement('style');
    s.id = 'icp-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  // Every string that reaches the page goes in through textContent: the export's own text is data.
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  /* The Report Generator keeps the export under our id and answers "ready" with its bytes (a
     transferred ArrayBuffer) and the form it came from. Same handshake as the PDF viewer. */
  function receive(onLoad, onFail) {
    var id = (location.hash.match(/[#&]case=([A-Za-z0-9]+)/) || [])[1];
    if (!id) return null;
    // The generator that opened this tab; or, framed, the page hosting the frame (the PDF viewer
    // resolves its host the same way).
    var host = null;
    try { host = window.opener || null; } catch (e) {}
    if (!host && window.parent !== window) host = window.parent;
    var target = location.origin === 'null' ? '*' : location.origin, done = false, timer = null, wait = null;
    window.addEventListener('message', function (ev) {
      if (ev.origin !== location.origin || done) return;
      var m = ev.data || {};
      if (m.id !== id) return;
      if (m.type === 'importcase:error') { done = true; clearInterval(timer); clearTimeout(wait); onFail(m.message || 'The Report Generator could not prepare the case.'); return; }
      if (m.type !== 'importcase:load' || !m.bytes) return;
      done = true; clearInterval(timer); clearTimeout(wait);
      onLoad(m);
    });
    function ping() { try { if (host) host.postMessage({ type: 'importcase:ready', id: id }, target); } catch (e) {} }
    ping();
    timer = setInterval(ping, 500);
    wait = setTimeout(function () {
      clearInterval(timer);
      if (!done) onFail(host ? 'Nothing arrived from the Report Generator. Close this tab and choose Report import problem again.'
        : 'This page builds a case from the Report Generator: Import menu, Report import problem.');
    }, 10000);
    return id;
  }

  var KIND_LABEL = { date: 'dates shifted', name: 'names', serial: 'serial numbers', id: 'patient IDs', custom: 'your redactions', label: 'labelled values', manual: 'hand-drawn boxes' };
  var DIFF_WORD = { missing: 'not imported', mismatch: 'different', extra: 'you cleared it' };

  /* model: built by renderCasePanel() in each page. actions: decide(text, verdict), redactResidual(),
     gotoPage(n), setNotes(text) -> boolean (note is clean), setIncludePdf(on), exportCase(). */
  function render(host, model, actions) {
    injectCss();
    // a .log case locates things by line, a PDF case by page
    var unit = model.unit === 'line' ? { one: 'line ', many: ' lines' } : { one: 'p', many: ' pages' };
    function where(list) { return list.length > 4 ? list.length + unit.many : unit.one + list.join(', '); }
    host.innerHTML = '';
    var root = el('div', 'icp');
    host.appendChild(root);
    root.appendChild(el('h2', null, 'Import problem case'));
    root.appendChild(el('div', 'icp-sub', model.title || ''));
    if (model.parseError) root.appendChild(el('div', 'icp-err', 'The import failed: ' + model.parseError));

    /* ---- what was removed ---- */
    var c = model.counts || {};
    root.appendChild(el('h3', null, 'Removed automatically'));
    if (model.noKnown) {
      root.appendChild(el('div', 'icp-note', 'The form had no patient identifiers to search for (no name, DOB, MRN or serials), so only the generic rules ran. Look over the whole export before sending it.'));
    } else {
      root.appendChild(el('div', 'icp-meta', 'Searched the whole export for ' + [plural(c.names || 0, 'name word'), plural(c.serials || 0, 'serial'), plural(c.ids || 0, 'ID'), plural(c.dates || 0, 'date')].join(', ') + ' taken from your form.'));
    }
    var hits = model.hits || {}, hitList = el('ul');
    Object.keys(KIND_LABEL).forEach(function (k) {
      if (!hits[k]) return;
      var li = el('li', 'icp-row');
      li.appendChild(el('span', 'grow', KIND_LABEL[k]));
      li.appendChild(el('span', 'icp-n', String(hits[k])));
      hitList.appendChild(li);
    });
    if (hitList.children.length) root.appendChild(hitList);
    root.appendChild(el('div', 'icp-meta', 'Every date moves by the same hidden number of weeks, so order and intervals are kept. The shift is never saved.'));

    /* ---- residual: known identifiers still present (blocks export) ---- */
    if (model.residual && model.residual.length) {
      var h = el('h3', null, 'Still present');
      h.appendChild(el('span', 'icp-n bad', String(model.residual.length)));
      root.appendChild(h);
      var rl = el('ul');
      model.residual.slice(0, 30).forEach(function (r) {
        var li = el('li', 'icp-row');
        li.appendChild(el('span', 'grow icp-mono', r.match));
        li.appendChild(el('span', 'icp-meta', r.kind + (r.page ? ' · ' + where([r.page]) : '')));
        rl.appendChild(li);
      });
      root.appendChild(rl);
      var rb = el('button', 'warn', 'Redact all of these');
      rb.type = 'button';
      rb.onclick = function () { actions.redactResidual(); };
      root.appendChild(rb);
    }

    /* ---- review list: one decision per distinct string ---- */
    var sus = model.suspects || [];
    var sh = el('h3', null, 'Needs a decision');
    sh.appendChild(el('span', 'icp-n ' + (sus.length ? 'bad' : 'ok'), String(sus.length)));
    root.appendChild(sh);
    if (!sus.length) root.appendChild(el('div', 'icp-meta', 'Nothing left that looks like a name, ID, serial, phone number or email address.'));
    else {
      root.appendChild(el('div', 'icp-meta', 'Shaped like a person, ID or contact detail, and not something the form knew about. Redact replaces it everywhere; keep leaves it.'));
      var ul = el('ul');
      sus.forEach(function (s) {
        var li = el('li', 'icp-row');
        var t = el('span', 'grow');
        t.appendChild(el('span', 'icp-mono', s.text));
        t.appendChild(el('span', 'icp-meta', '  ' + s.kind + ' · ' + where(s.pages)));
        li.appendChild(t);
        var red = el('button', 'warn', 'Redact'); red.type = 'button';
        red.onclick = function () { actions.decide(s.text, 'redact'); };
        var keep = el('button', null, 'Keep'); keep.type = 'button';
        keep.onclick = function () { actions.decide(s.text, 'keep'); };
        li.appendChild(red); li.appendChild(keep);
        ul.appendChild(li);
      });
      root.appendChild(ul);
    }

    /* ---- pages the text checks can't vouch for ---- */
    if (model.pages) {
      var todo = model.pages.filter(function (p) { return !p.visited; }).length;
      var ph = el('h3', null, 'Pages to look at');
      ph.appendChild(el('span', 'icp-n ' + (todo ? 'bad' : 'ok'), String(todo)));
      root.appendChild(ph);
      if (!model.pages.length) root.appendChild(el('div', 'icp-meta', 'None: every page has a text layer and no large images.'));
      else {
        var pl = el('ul');
        model.pages.forEach(function (p) {
          var li = el('li', 'icp-row');
          li.appendChild(el('span', 'grow', 'Page ' + p.page + ' - ' + p.reasons.join(', ')));
          li.appendChild(el('span', 'icp-meta', p.visited ? 'looked at' : ''));
          var go = el('button', null, 'Show'); go.type = 'button';
          go.onclick = function () { actions.gotoPage(p.page); };
          li.appendChild(go);
          pl.appendChild(li);
        });
        root.appendChild(pl);
      }
    }

    /* ---- the import against the finished report ---- */
    var dh = el('h3', null, 'Import vs. your report');
    var diff = model.diff || [];
    dh.appendChild(el('span', 'icp-n ' + (diff.length ? 'bad' : 'ok'), String(diff.length)));
    root.appendChild(dh);
    if (!model.hasExpected) root.appendChild(el('div', 'icp-meta', 'The form was empty, so there is nothing to compare against. Say in the note what should have been imported.'));
    else if (!diff.length) root.appendChild(el('div', 'icp-meta', 'Every field the import filled matches your report' + (model.matched ? ' (' + model.matched + ' fields)' : '') + '. Describe the problem in the note.'));
    else {
      var table = el('table'), head = el('tr');
      ['Field', 'Import', 'Your report'].forEach(function (x) { head.appendChild(el('th', null, x)); });
      table.appendChild(head);
      diff.forEach(function (d) {
        var tr = el('tr');
        var f = el('td');
        f.appendChild(el('div', null, d.label || d.field));
        f.appendChild(el('div', 'icp-meta k-' + d.kind, DIFF_WORD[d.kind] || d.kind));
        tr.appendChild(f);
        tr.appendChild(el('td', 'icp-mono', d.parsed || '-'));
        tr.appendChild(el('td', 'icp-mono', d.expected || '-'));
        table.appendChild(tr);
      });
      root.appendChild(table);
      if (model.matched) root.appendChild(el('div', 'icp-meta', model.matched + ' other fields match.'));
    }
    if (model.leadDiff && model.leadDiff.length) root.appendChild(el('div', 'icp-meta', 'Lead table: ' + plural(model.leadDiff.length, 'row') + ' differ.'));
    if (model.fidelity && model.fidelity.length) {
      root.appendChild(el('div', 'icp-note', 'De-identifying changed how these fields import, so the case may not reproduce them: ' + model.fidelity.join(', ') + '. Mention it in the note if one of them is the problem.'));
    }

    /* ---- note, options, export ---- */
    root.appendChild(el('h3', null, 'What went wrong? (optional)'));
    var notes = el('textarea');
    notes.placeholder = 'e.g. RV threshold missing, mode imported as DDD. No patient details.';
    notes.value = model.notes || '';
    root.appendChild(notes);
    if (model.includePdf != null) {
      var lab = el('label', 'icp-check'), cb = el('input');
      cb.type = 'checkbox'; cb.checked = !!model.includePdf;
      cb.onchange = function () { actions.setIncludePdf(cb.checked); };
      lab.appendChild(cb);
      lab.appendChild(el('span', null, 'Include the redacted page images (report.pdf)'));
      root.appendChild(lab);
    }
    var gate = el('div', 'icp-gate');
    root.appendChild(gate);
    var btn = el('button', 'primary', 'Export case');
    btn.type = 'button';
    btn.onclick = function () { actions.exportCase(); };
    root.appendChild(btn);
    if (model.done) root.appendChild(el('div', 'icp-done', 'Saved ' + model.done + '. Hand that file to your assistant.'));

    function updateGate(noteClean) {
      var blockers = [];
      if (model.busy) blockers.push(model.busy);
      if (model.residual && model.residual.length) blockers.push(plural(model.residual.length, 'identifier') + ' still present');
      if (sus.length) blockers.push(plural(sus.length, 'string') + (sus.length === 1 ? ' needs' : ' need') + ' a decision');
      var unvisited = (model.pages || []).filter(function (p) { return !p.visited; }).length;
      if (unvisited) blockers.push(plural(unvisited, 'page') + ' to look at');
      if (noteClean === false) blockers.push('the note mentions the patient');
      gate.textContent = blockers.length ? 'Before export: ' + blockers.join('; ') + '.' : 'Ready. The case holds no identifiers the checks know about.';
      gate.className = 'icp-gate' + (blockers.length ? '' : ' ok');
      btn.disabled = !!blockers.length;
    }
    notes.oninput = function () { updateGate(actions.setNotes(notes.value)); };
    updateGate(actions.setNotes(notes.value));
  }

  global.CRMImportCasePanel = { receive: receive, render: render };
})(typeof window !== 'undefined' ? window : globalThis);
