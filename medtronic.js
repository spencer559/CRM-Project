/* =====================================================================
   MEDTRONIC SmartSync -> CRM field map   (v2: device-class routing)
   ---------------------------------------------------------------------
   One vendor = one file. Depends on the shared Engine (engine.js) for
   the anchor primitives: findRight (single value), colsRightOf / twoCol
   (column-aware), lineWith, and the cleaners.

   runMap(LINES, META) routes by the device model string and applies the
   matching map (leadless / dual / single), then returns everything the
   preview needs:
       { RESULT, GOTCHAS, LEADS, ROUTE, ORDER }

   FIELD KEYS match the input names index.html's rebuildLeads() builds:
     - Leadless (Micra):  lead-leadless-{imp,sens,thr,pw}
     - Dual-chamber:      lead-ra-* and lead-rv-*   (lowercase chamber)
   (Earlier drafts wrote lead-RV-* / lead-RA-*, which the form never
   builds, so applyToForm() silently missed every lead value.)
   To add a vendor, copy this shape into e.g. abbott.js.
   ===================================================================== */
(function (global) {
  'use strict';

  var COL_SPLIT = 310;  // x midpoint: atrial column < SPLIT <= RV column
  var DROPDOWN_MODES = ['AAI', 'AAIR', 'VVI', 'VVIR', 'DDD', 'DDDR', 'DDI', 'DDIR', 'VDI', 'VDIR', 'AOO', 'VOO', 'DOO', 'OOO'];

  var ORDER_LEADLESS = ['pt-name', 'pt-dob', 'pt-mrn', 'pt-date', 'dev-implant', 'pt-provider', 'mfr', 'dtype', 'dev-model', 'dev-serial', 'bat-lon-cur', 'bat-lon-unit', 'pct-v', 'p-mode', 'p-lrl', 'p-utr', 'p-usr', 'p-sav', 'p-ms', 'lead-leadless-imp', 'lead-leadless-sens', 'lead-leadless-thr', 'lead-leadless-pw', 'obs-yn', 'obs-text', 'rp-chg', 'sig-date'];
  var ORDER_DUAL = ['pt-name', 'pt-dob', 'pt-mrn', 'pt-date', 'dev-implant', 'pt-provider', 'mfr', 'dtype', 'dev-model', 'dev-serial', 'bat-lon-cur', 'bat-lon-unit', 'pct-a', 'pct-v', 'p-mode', 'p-lrl', 'p-utr', 'p-usr', 'p-sav', 'p-pav', 'p-ms', 'p-msrate', 'lead-ra-imp', 'lead-ra-sens', 'lead-ra-thr', 'lead-ra-pw', 'lead-rv-imp', 'lead-rv-sens', 'lead-rv-thr', 'lead-rv-pw', 'ep-af-burden', 'ep-hvr', 'obs-yn', 'obs-text', 'rp-chg', 'sig-date'];

  /* ---------- device routing ---------- */
  function detectDevice(model) {
    if (/Micra/i.test(model)) return { family: 'leadless', dtype: 'Leadless', label: 'Leadless (Micra)' };
    if (/Aveir/i.test(model)) return { family: 'leadless', dtype: 'Aveir', label: 'Leadless (Aveir)' };
    var icd = /Cobalt|Crome|Claria|Evera|Visia|Primo|Viva|Amplia|Compia/i.test(model);
    var dual = /\bDR\b|XT DR|DR MRI|DDDR?/i.test(model);
    if (dual) return { family: 'dual', dtype: icd ? 'ICD-DC' : 'PPM-DC', label: icd ? 'Dual-chamber ICD' : 'Dual-chamber PPM' };
    return { family: 'single', dtype: icd ? 'ICD-SC' : 'PPM-SC', label: icd ? 'Single-chamber ICD' : 'Single-chamber PPM' };
  }

  function runMap(LINES, META) {
    var E = global.Engine;
    var findRight = function (re, opts) { return E.findRight(LINES, re, opts); };
    var colsRightOf = function (re, opts) { return E.colsRightOf(LINES, re, opts); };
    var twoCol = function (re, opts) { return E.twoCol(LINES, re, opts); };
    var lineWith = function (re) { return E.lineWith(LINES, re); };
    var text = E.text, toISO = E.toISO, num = E.num, MODES = E.MODES;

    var RESULT = {}, LEADS = [], GOTCHAS = [], ROUTE = {};

    function set(field, label, val, src, status, note) {
      RESULT[field] = { label: label, field: field, v: (val == null ? '' : String(val)), src: src || '', status: val ? (status || 'auto') : 'empty', note: note || '' };
    }

    /* ---------- shared identity block ---------- */
    function mapHeader() {
      var s = function (h) { return h ? ('p' + h.page + ' · ' + h.section.replace(/:.*/, '')) : ''; };
      var h;
      h = findRight(/^Patient:?$/);            set('pt-name', 'Patient Name', h && h.v, s(h));
      h = findRight(/^Device:$/);              set('dev-model', 'Model', h && h.v, s(h));
      h = findRight(/Serial Number:?/);        set('dev-serial', 'Serial #', h && h.v, s(h));
      h = findRight(/Date of Visit:?/);        set('pt-date', 'Interrogation Date', h && toISO(h.v), s(h));
      h = findRight(/^Physician:?$/);          set('pt-provider', 'Provider / Physician', h && h.v, s(h));
      h = findRight(/^ID:?$/, { notLabel: /:$|^(Physician|Serial|Date|Device|Patient)/i });
                                               set('pt-mrn', 'MRN / ID', h && h.v, s(h), null, 'Blank in export — pull from EHR.');
      h = findRight(/^Date of Birth$/);        set('pt-dob', 'Date of Birth', h && toISO(h.v), s(h));
      h = findRight(/^Implant Date$/);         set('dev-implant', 'Implant Date', h && toISO(h.v), s(h));
      RESULT['mfr'] = { label: 'Manufacturer', field: 'mfr', v: 'Medtronic', src: 'vendor', status: 'auto', note: '' };
      RESULT['dtype'] = { label: 'Device Type', field: 'dtype', v: ROUTE.dtype, src: 'from model', status: ROUTE.dtype ? 'auto' : 'review', note: ROUTE.dtype ? '' : 'Set device type manually.' };
      h = findRight(/Remaining Longevity/);    set('bat-lon-cur', 'Battery Longevity', h && num(h.v), s(h));
      RESULT['bat-lon-unit'] = { label: 'Longevity Unit', field: 'bat-lon-unit', v: h && /month/i.test(h.v) ? 'months' : 'years', src: s(h), status: h ? 'auto' : 'empty', note: '' };
    }

    /* ---------- observations + session-changes (shared) ---------- */
    function mapObsAndChanges() {
      var oi = LINES.findIndex(function (l) { return /Observations\s*\(\d+\)/i.test(text(l)); }); // case-insensitive: catches OBSERVATIONS
      if (oi >= 0) {
        var pg = LINES[oi].page, b = [], cur = '';
        for (var i = oi + 1; i < LINES.length && LINES[i].page === pg; i++) {
          var t = text(LINES[i]).trim();
          if (/Medtronic Software|Confidential|©|Initial:|Final:/.test(t)) break;
          if (/^-/.test(t)) { if (cur) b.push(cur); cur = t; } else if (cur) cur += ' ' + t;
        }
        if (cur) b.push(cur);
        RESULT['obs-yn'] = { label: 'Observations?', field: 'obs-yn', v: 'Yes', src: 'p' + pg, status: 'auto', note: '' };
        RESULT['obs-text'] = { label: 'Observations text', field: 'obs-text', v: b.join('\n'), src: 'p' + pg, status: 'auto', note: '' };
      } else RESULT['obs-yn'] = { label: 'Observations?', field: 'obs-yn', v: 'N/A', src: '', status: 'auto', note: '' };
      var n = lineWith(/No parameters have been changed/);
      RESULT['rp-chg'] = { label: 'Parameter changes?', field: 'rp-chg', v: n ? 'No' : '', src: n ? 'p' + n.page : '', status: n ? 'auto' : 'review', note: n ? '' : 'Changes table present — review.' };
      RESULT['sig-date'] = { label: 'Date Completed', field: 'sig-date', v: RESULT['pt-date'].v, src: 'visit date', status: RESULT['pt-date'].v ? 'auto' : 'empty', note: '' };
    }

    /* ---------- lead inventory (dual/single transvenous) ---------- */
    function mapLeadInventory() {
      LEADS = [];
      LINES.forEach(function (l) {
        var c = l.items[0]; if (!c || !/^(Atrial|RV|LV)$/.test(c.str)) return;
        var mi = l.items.findIndex(function (i) { return /Medtronic/.test(i.str); }); if (mi < 0) return;
        LEADS.push({ chamber: c.str, model: (l.items[mi + 1] || {}).str || '', serial: (l.items[mi + 2] || {}).str || '', date: toISO((l.items[l.items.length - 1] || {}).str || '') });
      });
      // de-dup by chamber (device-info rows repeat on summary + parameters pages)
      var seen = {}; LEADS = LEADS.filter(function (x) { if (seen[x.chamber]) return false; seen[x.chamber] = 1; return true; });
    }

    function flagMode() {
      var m = RESULT['p-mode']; if (!m || !m.v) return;
      if (DROPDOWN_MODES.indexOf(m.v.toUpperCase()) < 0) {
        m.status = 'review';
        m.note = (m.note ? m.note + ' ' : '') + '"' + m.v + '" is not in the form’s Mode <select> — add it or it won’t display.';
      }
    }

    /* ---------- MAP: leadless (Micra) ----------
       Keys target the form's 'leadless' lead row: lead-leadless-{imp,sens,thr,pw}. */
    function mapLeadless() {
      set('pct-v', 'V Paced %', (function () { var h = findRight(/^Paced$/); return h && num(h.v); })(), 'p (V histogram)', 'auto');
      var h;
      h = findRight(/^Mode$/, { prefer: 'final', match: MODES }); set('p-mode', 'Mode', h && h.v, h ? 'p' + h.page : '');
      h = findRight(/^Lower Rate$|^Lower$/, { prefer: 'final', match: /\d/ }); set('p-lrl', 'Lower Rate (LRL)', h && num(h.v), h ? 'p' + h.page : '');
      h = findRight(/Upper Track/, { prefer: 'final', match: /\d/ }); set('p-utr', 'Upper Track (UTR)', h && num(h.v), h ? 'p' + h.page : '');
      h = findRight(/Upper Sensor/, { prefer: 'final', match: /\d/ }); set('p-usr', 'Upper Sensor (USR)', h && num(h.v), h ? 'p' + h.page : '');
      h = findRight(/Sensed AV/, { prefer: 'final', match: /\d/ }); set('p-sav', 'Sensed AV', h && num(h.v), h ? 'p' + h.page : '');
      h = findRight(/Activity Mode Switch/, { prefer: 'final' }); set('p-ms', 'Mode Switch', h && h.v, h ? 'p' + h.page : '');
      h = findRight(/Electrode Impedance/, { prefer: 'final', match: /\d/ }); set('lead-leadless-imp', 'Leadless Impedance (Ω)', h && num(h.v), h ? 'p' + h.page : '', 'review', 'Verify against PDF.');
      h = findRight(/Measured R Wave|R-Wave Amplitude/, { prefer: 'final', match: /\d/ }); set('lead-leadless-sens', 'Leadless Sensing (mV)', h && num(h.v), h ? 'p' + h.page : '', 'review', 'Final value, not implant baseline. Verify.');
      var thr = findRight(/Capture Threshold/, { prefer: 'final', match: /\d/ });
      set('lead-leadless-thr', 'Leadless Threshold (V)', thr && num(thr.v), thr ? 'p' + thr.page : '', 'review', 'Verify against PDF.');
      RESULT['lead-leadless-pw'] = { label: 'Leadless Pulse Width (ms)', field: 'lead-leadless-pw', v: thr ? ((thr.v.match(/@\s*([\d.]+)\s*ms/) || [])[1] || '') : '', src: thr ? 'p' + thr.page : '', status: thr ? 'auto' : 'empty', note: '' };
      flagMode();
      GOTCHAS = [
        { tag: 'FINAL', body: '<b>Same label across sections.</b> Measurements appear under <i>Initial</i> and <i>Final</i>; the engine prefers <b>Final:</b> pages.' },
        { tag: 'MATCH', body: '<b>"Mode" can resolve to "Rates"</b> (a header). A mode-pattern check keeps the real value.' },
        { tag: 'GUARD', body: '<b>Empty ID</b> would grab "Physician:"; the label guard blanks it.' }
      ];
    }

    /* ---------- MAP: dual-chamber (Azure / Adapta-class) ----------
       Two-column lead data -> lead-ra-* (atrial) and lead-rv-* (RV). */
    function mapDual() {
      var h;
      h = findRight(/^AP$/, { match: /%/ }); set('pct-a', 'A Paced %', h && num(h.v), h ? 'p' + h.page : '');
      h = findRight(/^VP$/, { match: /%/ }); set('pct-v', 'V Paced %', h && num(h.v), h ? 'p' + h.page : '');

      // mode: collect all mode-tokens right of "Mode" -> MVP shows AAI + DDD
      var mr = colsRightOf(/^Mode$/, { prefer: 'final' });
      var toks = mr ? mr.rights.filter(function (c) { return MODES.test(c.str); }).map(function (c) { return c.str; }) : [];
      var mvp = toks.length > 1;
      set('p-mode', 'Mode', mvp ? 'DDD' : (toks[0] || ''), mr ? 'p' + mr.page : '', mvp ? 'review' : 'auto', mvp ? ('Programmed ' + toks.join('⇔') + ' (MVP) — recorded as DDD.') : '');

      h = findRight(/^Lower Rate$|^Lower$/, { prefer: 'final', match: /\d/ }); set('p-lrl', 'Lower Rate (LRL)', h && num(h.v), h ? 'p' + h.page : '');
      h = findRight(/Upper Track/, { prefer: 'final', match: /\d/ }); set('p-utr', 'Upper Track (UTR)', h && num(h.v), h ? 'p' + h.page : '');
      h = findRight(/Upper Sensor/, { prefer: 'final', match: /\d/ }); set('p-usr', 'Upper Sensor (USR)', h && num(h.v), h ? 'p' + h.page : '');
      h = findRight(/Sensed AV/, { prefer: 'final', match: /\d/ }); set('p-sav', 'Sensed AV', h && num(h.v), h ? 'p' + h.page : '');
      h = findRight(/^Paced AV$/, { prefer: 'final', match: /ms/ }); set('p-pav', 'Paced AV', h && num(h.v), h ? 'p' + h.page : '');
      h = findRight(/^Mode Switch$/, { prefer: 'final', match: /\d/ });
      RESULT['p-ms'] = { label: 'Mode Switch', field: 'p-ms', v: h ? 'On' : '', src: h ? 'p' + h.page : '', status: h ? 'auto' : 'empty', note: '' };
      set('p-msrate', 'Mode Switch Rate', h && num(h.v), h ? 'p' + h.page : '');

      // two-column lead measurements (atrial | RV)
      var imp = twoCol(/^Lead Impedance$/, { prefer: 'final', valRe: /^\d/, split: COL_SPLIT });
      set('lead-ra-imp', 'RA Impedance (Ω)', num(imp.a), imp.src, 'review', 'Atrial column. Verify.');
      set('lead-rv-imp', 'RV Impedance (Ω)', num(imp.v), imp.src, 'review', 'RV column. Verify.');
      var sns = twoCol(/Measured P\/R Wave/, { prefer: 'final', valRe: /mV/, split: COL_SPLIT });
      set('lead-ra-sens', 'RA Sensing P-wave (mV)', num(sns.a), sns.src, 'review', 'Atrial column. Verify.');
      set('lead-rv-sens', 'RV Sensing R-wave (mV)', num(sns.v), sns.src, 'review', 'RV column. Verify.');
      var thr = twoCol(/Capture Threshold/, { prefer: 'final', valRe: /V @/, split: COL_SPLIT });
      set('lead-ra-thr', 'RA Threshold (V)', num(thr.a), thr.src, 'review', 'Atrial column. Verify.');
      set('lead-rv-thr', 'RV Threshold (V)', num(thr.v), thr.src, 'review', 'RV column. Verify.');
      RESULT['lead-ra-pw'] = { label: 'RA Pulse Width (ms)', field: 'lead-ra-pw', v: (thr.a.match(/@\s*([\d.]+)\s*ms/) || [])[1] || '', src: thr.src, status: thr.a ? 'auto' : 'empty', note: '' };
      RESULT['lead-rv-pw'] = { label: 'RV Pulse Width (ms)', field: 'lead-rv-pw', v: (thr.v.match(/@\s*([\d.]+)\s*ms/) || [])[1] || '', src: thr.src, status: thr.v ? 'auto' : 'empty', note: '' };

      // episodes (the clean ones only; counts left for review)
      var af = LINES.find(function (l) { return /Time in AT\/AF/.test(text(l)); });
      set('ep-af-burden', 'AF Burden (%)', af ? num((af.items.find(function (i) { return /%/.test(i.str); }) || { str: '' }).str) : '', af ? 'p' + af.page : '', 'auto');
      h = findRight(/VT-NS/); set('ep-hvr', 'HVR (VT/VF/NS-VT)', h && num(h.v), h ? 'p' + h.page : '', 'review', 'Non-sustained VT count this session. Confirm episode counts in the device log.');

      mapLeadInventory();
      flagMode();
      GOTCHAS = [
        { tag: '2-COL', body: '<b>Two-column lead data.</b> "Capture Threshold 0.875 (atrial) | 0.750 (RV)" — right-of-label alone takes the first cell. A column split at x' + COL_SPLIT + ' separates atrial from RV so RV no longer inherits the atrial value.' },
        { tag: 'LABEL', body: '<b>Dual reports say "Lead Impedance," not "Electrode Impedance."</b> The dual map keys on the right label.' },
        { tag: 'CAPS', body: '<b>"OBSERVATIONS" vs "Observations."</b> The match is now case-insensitive, so observations are caught either way.' },
        { tag: 'MVP', body: '<b>AAI⇔DDD (MVP)</b> is two mode tokens. The dual map collects both and records DDD with a note, instead of grabbing just "AAI."' }
      ];
    }

    /* ---------- router ---------- */
    var model = (findRight(/^Device:$/) || { v: '' }).v;
    ROUTE = detectDevice(model);
    mapHeader();
    if (ROUTE.family === 'leadless') mapLeadless();
    else if (ROUTE.family === 'dual') mapDual();
    else { mapDual(); ROUTE.note = 'Single-chamber spec not yet validated — atrial fields may be empty or misassigned. Send a single-chamber export to tune it.'; }
    mapObsAndChanges();

    var ORDER = ROUTE.family === 'leadless' ? ORDER_LEADLESS : ORDER_DUAL;
    return { RESULT: RESULT, GOTCHAS: GOTCHAS, LEADS: LEADS, ROUTE: ROUTE, ORDER: ORDER };
  }

  global.MEDTRONIC = {
    name: 'Medtronic',
    sig: /medtronic|carelink|azure|micra|cobalt|crome|claria|percepta/i,
    dropdownModes: DROPDOWN_MODES,
    detectDevice: detectDevice,
    runMap: runMap
  };
})(window);
