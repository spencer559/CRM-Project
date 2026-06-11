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
  var ORDER_DUAL = ['pt-name', 'pt-dob', 'pt-mrn', 'pt-date', 'dev-implant', 'pt-provider', 'mfr', 'dtype', 'dev-model', 'dev-serial', 'bat-lon-cur', 'bat-lon-unit', 'bat-cc-cur', 'pct-a', 'pct-v', 'p-mode', 'p-lrl', 'p-utr', 'p-usr', 'p-sav', 'p-pav', 'p-ms', 'p-msrate', 'lead-ra-imp', 'lead-ra-sens', 'lead-ra-thr', 'lead-ra-pw', 'lead-rv-imp', 'lead-rv-sens', 'lead-rv-thr', 'lead-rv-pw', 'lead-lv-imp', 'lead-lv-sens', 'lead-lv-thr', 'lead-lv-pw', 'lead-rv-coil-imp', 'lead-svc-coil-imp', 'ep-af-burden', 'ep-hvr', 'obs-yn', 'obs-text', 'rp-chg', 'sig-date'];

  /* ---------- device routing ---------- */
  function detectDevice(model) {
    if (/Micra/i.test(model)) return { family: 'leadless', dtype: 'Leadless', label: 'Leadless (Micra)' };
    if (/Aveir/i.test(model)) return { family: 'leadless', dtype: 'Aveir', label: 'Leadless (Aveir)' };
    var icd = /Cobalt|Crome|Claria|Evera|Visia|Primo|Viva|Amplia|Compia/i.test(model);
    // CRT / biventricular: model carries CRT, CRTD or CRTP (often with "Quad" for a
    // quadripolar LV lead). Must be checked BEFORE the dual test — a CRT model has no
    // "DR"/"DDDR" token, so it would otherwise fall through to single-chamber.
    // Signals: explicit CRT/CRTD/CRTP/BiV, plus Medtronic CRT naming cues "HF" (heart
    // failure) and "Quad" (quadripolar LV lead). e.g. "Cobalt XT HF Quad" carries no CRT token.
    if (/CRT-?[DP]?\b|\bBiV\b|\bHF\b|\bQuad\b/i.test(model)) {
      var crtP = /CRT-?P\b/i.test(model);
      return { family: 'crt', dtype: crtP ? 'CRT-P' : 'CRT-D', label: crtP ? 'CRT-P (BiV pacemaker)' : 'CRT-D (BiV ICD)' };
    }
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
    var text = E.text, toISO = E.toISO, num = E.num, cmpNum = E.cmpNum, MODES = E.MODES;

    var RESULT = {}, LEADS = [], GOTCHAS = [], ROUTE = {};

    function set(field, label, val, src, status, note) {
      RESULT[field] = { label: label, field: field, v: (val == null ? '' : String(val)), src: src || '', status: val ? (status || 'auto') : 'empty', note: note || '' };
    }

    /* ---------- generator implant date resolver ----------
       The report carries the generator (device) implant date in several places, all
       distinct from the per-lead implant dates. In priority order:
         1. Device row in Session Summary / Parameters: item[0]="Device" + "Implanted:" <date>.
         2. "Device Status (Implanted: <date>)" on Quick Look / Session Summary.
         3. The "Implant Date" row under the Patient Information "Implant" block — i.e. an
            "Implant Date" whose nearest preceding section label is NOT "Lead N".
       Each step is device-scoped, so a lead's "Implant Date" can never win. */
    function deviceImplantDate() {
      // 1) "Device" row with an "Implanted:" date cell.
      var row = LINES.find(function (l) {
        var c0 = l.items[0];
        return c0 && /^Device$/.test(c0.str) && l.items.some(function (i) { return /^Implanted:?$/i.test(i.str); });
      });
      if (row) {
        var di = row.items.findIndex(function (i) { return /^Implanted:?$/i.test(i.str); });
        var iso = toISO(((row.items[di + 1] || {}).str) || '') || toISO(text(row));
        if (iso) return { iso: iso, src: 'p' + row.page + ' · ' + row.section.replace(/:.*/, '') };
      }
      // 2) "Device Status (Implanted: <date>)" — label and value may be one item or two.
      var ds = lineWith(/Device Status/);
      if (ds) { var iso2 = toISO(text(ds)); if (iso2) return { iso: iso2, src: 'p' + ds.page + ' · ' + ds.section.replace(/:.*/, '') }; }
      // 3) The device-section "Implant Date" (not a lead's). Walk lines; track the most recent
      //    section sub-header; only accept an "Implant Date" when that header isn't "Lead N".
      var lastHdr = '';
      for (var k = 0; k < LINES.length; k++) {
        var its = LINES[k].items;
        // Section sub-headers ("Implant", "Lead 1", "Leads"...) are value-less — a single item
        // on the line — while data rows carry a value cell. Tracking headers this way keeps a
        // Lead's "Implant Date  Aug/08/2005" row from masking its own "Lead N" header, so the
        // lead guard below still fires. (Exclude "Implant Date" itself: it is a label, not a header.)
        if (its.length === 1 && !/^Implant Date$/.test(its[0].str)) lastHdr = its[0].str;
        var li = its.findIndex(function (i) { return /^Implant Date$/.test(i.str); });
        if (li >= 0 && !/^Lead\s*\d+/i.test(lastHdr)) {
          var rv = its.slice(li + 1).find(function (n) { return n.x > its[li].x + 2; });
          var iso3 = rv ? toISO(rv.str) : '';
          if (iso3) return { iso: iso3, src: 'p' + LINES[k].page + ' · ' + LINES[k].section.replace(/:.*/, '') };
        }
      }
      return { iso: '', src: '' };
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
      // Generator (device) implant date — NOT a lead implant date. The Patient Information
      // page lists each lead's own "Implant Date" (e.g. Aug/08/2005) BEFORE the device's, so a
      // bare findRight(/^Implant Date$/) grabs the first lead's date. Prefer device-scoped
      // anchors that carry the generator implant date, and only fall back to a device-section
      // "Implant Date" — never a "Lead N" one.
      var imp = deviceImplantDate();
      set('dev-implant', 'Implant Date', imp.iso, imp.src);
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

    /* ---------- lead inventory (verbatim) ----------
       The "Device Information" rows (Session Summary + Parameters pages) list each lead as
       <chamber> | Medtronic | <model> | <serial> | Implanted: | <date>. Capture them exactly
       as printed: location = the chamber label as shown ("Atrial" / "RV" / "CS"), with model,
       serial and implant date verbatim. These rows REPEAT across report sections, so de-dup by
       SERIAL (a physical lead) rather than by chamber — that collapses page-to-page repeats
       while still keeping two distinct leads that happen to share a chamber. */
    function mapLeadInventory() {
      LEADS = [];
      var seen = {};
      LINES.forEach(function (l) {
        var c = l.items[0]; if (!c) return;
        if (!/^(Atrial|RV(\/SVC)?|LV|CS)$/.test(c.str)) return;            // a lead row, not "Device"
        var mi = l.items.findIndex(function (i) { return /^Medtronic$/.test(i.str); }); if (mi < 0) return;
        var model = (l.items[mi + 1] || {}).str || '';
        var serial = (l.items[mi + 2] || {}).str || '';
        var date = (l.items[l.items.length - 1] || {}).str || '';          // raw, e.g. "Aug/08/2005"
        if (serial && seen[serial]) return;                                 // collapse repeated rows
        if (serial) seen[serial] = 1;
        LEADS.push({ location: c.str, model: model, serial: serial, date: date,
          chamber: /^Atrial$/.test(c.str) ? 'Atrial' : /^RV/.test(c.str) ? 'RV' : 'LV' });
      });
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
      (function () { var h = findRight(/^Paced$/); var c = h ? cmpNum(h.v) : null; set('pct-v', 'V Paced %', c ? c.v : '', 'p (V histogram)', c && c.cmp ? 'review' : 'auto', c && c.cmp ? ('Reported "' + c.raw + '".') : ''); })();
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
      var isCRT = ROUTE.family === 'crt';
      var LV_SPLIT = 385;  // x boundary: RV column < LV_SPLIT <= LV column
      var h;
      // Pacing percentages. Two Quick Look layouts exist:
      //  (a) simple MVP report: standalone "AP <x%>" and "VP <x%>" rows.
      //  (b) AdaptivCRT report: a four-state breakdown (AS-VS / AS-VP / AP-VS / AP-VP)
      //      plus "Total VP*". There is no standalone "AP"/"VP", so pct-a came back blank
      //      and /^VP$/ grabbed the stray "VP" on the AT/AF histogram page (% of AT/AF paced).
      // Simple Quick Look format has standalone "AP <x%>" and "VP <x%>" rows (the
      // since-last-session summary). Prefer these. Only the AdaptivCRT breakdown layout
      // lacks them; there we sum the four pacing states instead. Requiring BOTH a standalone
      // AP and VP avoids the stray "VP" (% of AT/AF) on the histogram pages.
      var hAP = findRight(/^AP$/, { match: /%/ }), hVP = findRight(/^VP$/, { match: /%/ });
      if (hAP && hVP) {
        // pacing % may be a comparator ("<0.1 %"); cmpNum keeps it for the text field.
        var ca = cmpNum(hAP.v), cv = cmpNum(hVP.v);
        set('pct-a', 'A Paced %', ca.v, 'p' + hAP.page, ca.cmp ? 'review' : 'auto', ca.cmp ? ('Reported "' + ca.raw + '".') : '');
        set('pct-v', 'V Paced %', cv.v, 'p' + hVP.page, cv.cmp ? 'review' : 'auto', cv.cmp ? ('Reported "' + cv.raw + '".') : '');
      } else {
        var pH = function (re) { return findRight(re, { match: /%/ }); };
        var hApvp = pH(/^AP-VP$/), hApvs = pH(/^AP-VS$/), hAsvp = pH(/^AS-VP$/), hTotVP = pH(/^Total VP\*?$/);
        if (hApvp) {
          var pv = function (x) { return x ? (parseFloat(num(x.v)) || 0) : 0; };
          var aPaced = pv(hApvs) + pv(hApvp);                        // atrium paced in any state
          var vPaced = hTotVP ? pv(hTotVP) : pv(hAsvp) + pv(hApvp);  // ventricle paced (device Total VP preferred)
          var pSrc = 'p' + hApvp.page;
          set('pct-a', 'A Paced %', aPaced.toFixed(1), pSrc, 'auto', 'Summed pacing states: AP-VS + AP-VP.');
          set('pct-v', 'V Paced %', vPaced.toFixed(1), pSrc, 'auto', hTotVP ? 'Device Total VP from the pacing-state breakdown.' : 'Summed pacing states: AS-VP + AP-VP.');
        } else {
          set('pct-a', 'A Paced %', '', '', 'review', '');
          set('pct-v', 'V Paced %', '', '', 'review', '');
        }
      }

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
      // Label varies by report: "Pacing Impedance" (Quick Look / Session Summary, two-col row)
      // or "Lead Impedance" (header on the Battery & Lead Measurements page). Match either; the
      // hardened colsRightOf skips the value-less header so RV no longer comes back empty.
      var imp = twoCol(/^(?:Lead|Pacing) Impedance$/, { prefer: 'final', valRe: /^\d/, split: COL_SPLIT, lvSplit: isCRT ? LV_SPLIT : undefined });
      set('lead-ra-imp', 'RA Impedance (Ω)', num(imp.a), imp.src, 'review', 'Atrial column. Verify.');
      set('lead-rv-imp', 'RV Impedance (Ω)', num(imp.v), imp.src, 'review', 'RV column. Verify.');
      if (isCRT) set('lead-lv-imp', 'LV Impedance (Ω)', num(imp.lv), imp.src, 'review', 'LV column. Verify.');
      // Prefer the clinician's in-office reading; fall back per-column to the device's
      // auto value ("Measured P/R Wave" / "Capture Threshold") only where no in-office value exists.
      function preferIO(ioRe, autoRe, valRe) {
        var o = { prefer: 'final', valRe: valRe, split: COL_SPLIT, lvSplit: isCRT ? LV_SPLIT : undefined };
        var io = twoCol(ioRe, o);
        var au = twoCol(autoRe, o);
        var any = io.a || io.v || io.lv;
        return { a: io.a || au.a, v: io.v || au.v, lv: io.lv || au.lv, src: any ? io.src : au.src, io: !!any };
      }
      function ioNote(x) { return x.io ? 'In-office (clinician) reading — preferred over the device auto value. Verify.' : 'Device-measured value (no in-office reading). Verify.'; }

      var sns = preferIO(/^In-Office P\/R Wave$/, /Measured P\/R Wave/, /mV/);
      set('lead-ra-sens', 'RA Sensing P-wave (mV)', num(sns.a), sns.src, 'review', ioNote(sns));
      set('lead-rv-sens', 'RV Sensing R-wave (mV)', num(sns.v), sns.src, 'review', ioNote(sns));
      if (isCRT && sns.lv) set('lead-lv-sens', 'LV Sensing (mV)', num(sns.lv), sns.src, 'review', ioNote(sns));
      var thr = preferIO(/^In-Office Threshold$/, /Capture Threshold/, /V @/);
      set('lead-ra-thr', 'RA Threshold (V)', num(thr.a), thr.src, 'review', ioNote(thr));
      set('lead-rv-thr', 'RV Threshold (V)', num(thr.v), thr.src, 'review', ioNote(thr));
      RESULT['lead-ra-pw'] = { label: 'RA Pulse Width (ms)', field: 'lead-ra-pw', v: (thr.a.match(/@\s*([\d.]+)\s*ms/) || [])[1] || '', src: thr.src, status: thr.a ? 'auto' : 'empty', note: '' };
      RESULT['lead-rv-pw'] = { label: 'RV Pulse Width (ms)', field: 'lead-rv-pw', v: (thr.v.match(/@\s*([\d.]+)\s*ms/) || [])[1] || '', src: thr.src, status: thr.v ? 'auto' : 'empty', note: '' };
      if (isCRT) {
        set('lead-lv-thr', 'LV Threshold (V)', num(thr.lv), thr.src, 'review', ioNote(thr));
        RESULT['lead-lv-pw'] = { label: 'LV Pulse Width (ms)', field: 'lead-lv-pw', v: (thr.lv.match(/@\s*([\d.]+)\s*ms/) || [])[1] || '', src: thr.src, status: thr.lv ? 'auto' : 'empty', note: '' };
      }

      // ICD-only high-voltage measurements: defib-coil impedances + capacitor charge time.
      // These live on the Battery & Lead Measurements page as single-value rows
      // ("RV Defib 41 Ω", "SVC Defib 57 Ω", "Charge Time 3.5 s"), not in the two-col block.
      if (/ICD|CRT-D/.test(ROUTE.dtype || '')) {
        var rvd = findRight(/^RV Defib$/, { prefer: 'final', match: /^\d/ });
        set('lead-rv-coil-imp', 'RV Defib Impedance (Ω)', rvd && num(rvd.v), rvd ? 'p' + rvd.page : '', 'review', 'RV shock-coil impedance. Verify against PDF.');
        var svcd = findRight(/^SVC Defib$/, { prefer: 'final', match: /^\d/ });
        set('lead-svc-coil-imp', 'SVC Defib Impedance (Ω)', svcd && num(svcd.v), svcd ? 'p' + svcd.page : '', 'review', 'SVC/Can-coil impedance. Verify against PDF.');
        var chg = findRight(/^Charge Time$/, { prefer: 'final', match: /\d/ });
        set('bat-cc-cur', 'Cap. Charge Time (s)', chg && num(chg.v), chg ? 'p' + chg.page : '', 'review', 'Last capacitor charge — confirm charge date in the report.');
      }

      // episodes (the clean ones only; counts left for review)
      var af = LINES.find(function (l) { return /Time in AT\/AF/.test(text(l)); });
      var afItem = af ? (af.items.find(function (i) { return /%/.test(i.str); }) || { str: '' }).str : '';
      var afc = cmpNum(afItem);   // keep "<0.1" style values verbatim
      set('ep-af-burden', 'AF Burden (%)', afc.v, af ? 'p' + af.page : '', afc.cmp ? 'review' : 'auto', afc.cmp ? ('Reported "' + afItem.trim() + '".') : '');
      h = findRight(/VT-NS/); set('ep-hvr', 'HVR (VT/VF/NS-VT)', h && num(h.v), h ? 'p' + h.page : '', 'review', 'Non-sustained VT count this session. Confirm episode counts in the device log.');

      mapLeadInventory();
      flagMode();
      GOTCHAS = [
        { tag: '2-COL', body: '<b>Two-column lead data.</b> "Capture Threshold 0.875 (atrial) | 0.750 (RV)" — right-of-label alone takes the first cell. A column split at x' + COL_SPLIT + ' separates atrial from RV so RV no longer inherits the atrial value.' },
        { tag: 'LABEL', body: '<b>The pacing-impedance row is labeled "Pacing Impedance" (Quick Look / Session Summary), while "Lead Impedance" is only a value-less header on the Battery &amp; Lead Measurements page.</b> The map matches either label and skips the header, so RV impedance no longer comes back empty.' },
        { tag: 'CAPS', body: '<b>"OBSERVATIONS" vs "Observations."</b> The match is now case-insensitive, so observations are caught either way.' },
        { tag: 'MVP', body: '<b>AAI⇔DDD (MVP)</b> is two mode tokens. The dual map collects both and records DDD with a note, instead of grabbing just "AAI."' }
      ];
    }

    /* ---------- router ---------- */
    var model = (findRight(/^Device:$/) || { v: '' }).v;
    ROUTE = detectDevice(model);
    // Safety net: some CRT-D model names lack any obvious CRT token. If the report shows
    // CRT evidence (AdaptivCRT / Bi-V / CRT Pacing text, or an LV/CS lead row), upgrade to CRT.
    if (ROUTE.family !== 'crt' && ROUTE.family !== 'leadless') {
      var crtEvidence = lineWith(/AdaptivCRT|Bi-V|CRT Pacing/) || LINES.some(function (l) {
        var c0 = l.items[0]; return c0 && /^(LV|CS)$/.test(c0.str) && l.items.some(function (i) { return /Medtronic/.test(i.str); });
      });
      if (crtEvidence) {
        var hasDefib = /ICD|CRT-D/.test(ROUTE.dtype) || /Cobalt|Crome|Claria|Evera|Visia|Primo|Viva|Amplia|Compia/i.test(model);
        ROUTE = { family: 'crt', dtype: hasDefib ? 'CRT-D' : 'CRT-P', label: hasDefib ? 'CRT-D (BiV ICD)' : 'CRT-P (BiV pacemaker)' };
      }
    }
    mapHeader();
    if (ROUTE.family === 'leadless') mapLeadless();
    else if (ROUTE.family === 'dual' || ROUTE.family === 'crt') mapDual();
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
