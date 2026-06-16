/* =====================================================================
   BOSTON SCIENTIFIC LATITUDE -> CRM field map
   ---------------------------------------------------------------------
   One vendor = one file, same shape as medtronic.js. Depends on the
   shared Engine (engine.js) for findRight / lineWith / num / MODES and
   adds Boston-specific helpers the LATITUDE report layout needs:

     - bToISO()      "8 Apr 2026" / "13 Jun 1947"  ->  ISO yyyy-mm-dd
                     (Boston prints "D Mon YYYY"; Engine.toISO only knows
                      Medtronic's "Mon/DD/YYYY", so we parse dates here.)
     - valueBelow()  some header fields print the LABEL on one line and the
                     VALUE on the line directly beneath it at the same x
                     ("Last Office Interrogation" / "Implant Date"), so a
                     right-of-label search finds nothing. valueBelow walks
                     one line down and takes the cell under the label.
     - leadCols()    the Leads Data block is a 3-column table
                     (Implant | Previous Session | Most Recent). We read the
                     Most-Recent column (x >= MR_X) for the current chamber.

   runMap(LINES, META) routes by the device model and returns the same
   bundle the preview/auto-fill expects:
       { RESULT, GOTCHAS, LEADS, ROUTE, ORDER }

   FIELD KEYS match medtronic.js exactly (the form input names):
     dual-chamber -> lead-ra-* / lead-rv-*  (lowercase chamber)
   so prefillForm() in CRM_Report_Generator_Test.html fills them with no
   vendor-specific code. The manufacturer radio value is "BSc".
   ===================================================================== */
(function (global) {
  'use strict';

  // Most-Recent column starts here (x). Implant col ~245-297, Previous ~376-421,
  // Most Recent ~482-545. Anything at x >= MR_X is the latest reading.
  var MR_X = 470;
  var DROPDOWN_MODES = ['AAI', 'AAIR', 'VVI', 'VVIR', 'DDD', 'DDDR', 'DDI', 'DDIR', 'VDI', 'VDIR', 'AOO', 'VOO', 'DOO', 'OOO'];

  var ORDER_DUAL = ['pt-name', 'pt-dob', 'pt-mrn', 'pt-date', 'dev-implant', 'pt-provider', 'mfr', 'dtype', 'dev-model', 'dev-serial', 'bat-lon-cur', 'bat-lon-unit', 'bat-cc-cur', 'pct-a', 'pct-v', 'pct-lv', 'p-mode', 'p-lrl', 'p-utr', 'p-usr', 'dyn-av', 'p-sav', 'p-sav-hi', 'p-pav', 'p-pav-hi', 'p-ms', 'p-msrate', 'lead-ra-imp', 'lead-ra-sens', 'lead-ra-thr', 'lead-ra-pw', 'lead-rv-imp', 'lead-rv-sens', 'lead-rv-thr', 'lead-rv-pw', 'lead-lv-imp', 'lead-lv-sens', 'lead-lv-thr', 'lead-lv-pw', 'lead-rv-coil-imp', 'lead-svc-coil-imp', 'ep-total', 'ep-af-burden', 'ep-ahr', 'ep-hvr', 'obs-yn', 'obs-text', 'rp-chg', 'sig-date'];

  /* ---------- Boston date: "8 Apr 2026" / "13 Jun 1947" -> ISO ---------- */
  var BMONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  function bToISO(s) {
    var m = String(s).match(/(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{4})/); // day month year
    if (!m) return '';
    var mo = BMONTHS[m[2].toLowerCase()];
    return mo ? (m[3] + '-' + mo + '-' + m[1].padStart(2, '0')) : '';
  }

  /* ---------- device routing ----------
     hasShock = the report carries defibrillator evidence (a capacitor Charge Time or a
     shock-coil impedance/vector). A CRT-P pacemaker NEVER has either, so shock evidence is the
     decider for CRT-D vs CRT-P — and for ICD vs PPM — rather than the model family name, which
     is unreliable (e.g. VISIONIST X4 is a CRT-P, not a CRT-D). */
  function detectDevice(model, hasA, hasV, hasLV, hasShock) {
    var m = model || '';
    if (/EMBLEM/i.test(m)) return { family: 'sicd', dtype: 'S-ICD', label: 'Subcutaneous ICD' };
    var icd = /DYNAGEN|INOGEN|ENERGEN|PUNCTUA|TELIGEN|MOMENTUM|RESONATE|PERCIVA|VIGILANT|AUTOGEN|INCEPTA/i.test(m);
    // An explicit CRT-D / CRT-P token in the model is definitive.
    if (/CRT-?P/i.test(m)) return { family: 'crt', dtype: 'CRT-P', label: 'CRT-P (BiV pacemaker)' };
    if (/CRT-?D/i.test(m)) return { family: 'crt', dtype: 'CRT-D', label: 'CRT-D (BiV ICD)' };
    // Otherwise a CRT family name or a present LV lead means CRT; shock evidence decides D vs P.
    var crtName = /VISIONIST|VALITUDE|INTUA|INVIVE|INLIVEN|CHARISMA|COGNIS|RENEWAL|CONTAK/i.test(m);
    if (crtName || hasLV) {
      var crtDefib = hasShock || icd || /ICD/i.test(m);
      return crtDefib ? { family: 'crt', dtype: 'CRT-D', label: 'CRT-D (BiV ICD)' } : { family: 'crt', dtype: 'CRT-P', label: 'CRT-P (BiV pacemaker)' };
    }
    // Non-CRT: shock evidence (or an ICD family name) => ICD, else pacemaker.
    var dual = hasA && hasV;
    if (icd || hasShock) return dual ? { family: 'dual', dtype: 'ICD-DC', label: 'Dual-chamber ICD' } : { family: 'single', dtype: 'ICD-SC', label: 'Single-chamber ICD' };
    return dual ? { family: 'dual', dtype: 'PPM-DC', label: 'Dual-chamber PPM' } : { family: 'single', dtype: 'PPM-SC', label: 'Single-chamber PPM' };
  }

  function runMap(LINES, META) {
    var E = global.Engine;
    var findRight = function (re, opts) { return E.findRight(LINES, re, opts); };
    var lineWith = function (re) { return E.lineWith(LINES, re); };
    var text = E.text, num = E.num, MODES = E.MODES;

    var RESULT = {}, LEADS = [], GOTCHAS = [], ROUTE = {};

    function set(field, label, val, src, status, note) {
      RESULT[field] = { label: label, field: field, v: (val == null ? '' : String(val)), src: src || '', status: val ? (status || 'auto') : 'empty', note: note || '' };
    }

    /* value printed on the line directly below its label, at ~the same x
       (Boston's stacked header: "Implant Date" over "8 Apr 2026"). */
    function valueBelow(labelRe, opts) {
      opts = opts || {};
      var tol = opts.tol == null ? 40 : opts.tol;
      for (var i = 0; i < LINES.length; i++) {
        var li = LINES[i].items.findIndex(function (it) { return labelRe.test(it.str); });
        if (li < 0) continue;
        var lab = LINES[i].items[li];
        // scan the next couple of lines on the same page for a cell under the label
        for (var j = i + 1; j < LINES.length && LINES[j].page === LINES[i].page && j <= i + 2; j++) {
          var cell = LINES[j].items.find(function (it) { return Math.abs(it.x - lab.x) <= tol; });
          if (cell) return { v: cell.str, page: LINES[i].page };
        }
      }
      return null;
    }

    /* ---------- identity / header ---------- */
    function mapHeader() {
      var h;
      // Patient Name: the report header is de-identified ("Lastname, Firstname"); the real
      // name lives on the Patient Data Report.
      h = findRight(/^Patient Name$/);             set('pt-name', 'Patient Name', h && h.v, h ? 'p' + h.page : '');
      if (!RESULT['pt-name'].v) { h = findRight(/^Patient:?$/); set('pt-name', 'Patient Name', h && h.v, h ? 'p' + h.page : '', 'review', 'Header name may be de-identified — verify.'); }
      h = findRight(/^Date of Birth$/);            set('pt-dob', 'Date of Birth', h && bToISO(h.v), h ? 'p' + h.page : '');
      set('pt-mrn', 'MRN / ID', '', '', 'review', 'No MRN in the Boston export — pull from EHR.');
      // Interrogation/visit date = the "Report Created DD Mon YYYY" header stamp. (NOT the
      // "Last Office Interrogation" date below it — that's the PRIOR in-clinic session.) The
      // date is embedded in the same token as the label, so parse it straight out of the string.
      var rc = null, rcPage = '';
      for (var ri = 0; ri < LINES.length && !rc; ri++) {
        var rit = LINES[ri].items.find(function (it) { return /Report Created/i.test(it.str); });
        if (rit) { rc = rit; rcPage = LINES[ri].page; }
      }
      set('pt-date', 'Interrogation Date', rc && bToISO(rc.str), rc ? 'p' + rcPage : '');
      var v;
      // Generator implant date: "PG Implant Date" (Patient Data Report) is the clean same-line
      // source; fall back to the stacked "Implant Date" header value.
      h = findRight(/^PG Implant Date$/);
      if (h && bToISO(h.v)) set('dev-implant', 'Implant Date', bToISO(h.v), 'p' + h.page);
      else { v = valueBelow(/^Implant Date$/); set('dev-implant', 'Implant Date', v && bToISO(v.v), v ? 'p' + v.page : ''); }
      h = findRight(/Implanting Physician Name/);  set('pt-provider', 'Provider / Physician', h && h.v, h ? 'p' + h.page : '');

      RESULT['mfr'] = { label: 'Manufacturer', field: 'mfr', v: 'BSc', src: 'vendor', status: 'auto', note: '' };
      RESULT['dtype'] = { label: 'Device Type', field: 'dtype', v: ROUTE.dtype, src: 'from model', status: ROUTE.dtype ? 'auto' : 'review', note: ROUTE.dtype ? '' : 'Set device type manually.' };

      // Device cell is "MODEL Lxxx/ SERIAL" in one token.
      h = findRight(/^Device$/);
      var devStr = h ? h.v : '';
      var parts = devStr.split('/');
      var model = (parts[0] || '').trim();
      var serial = (parts[1] || '').trim();
      set('dev-model', 'Model', model, h ? 'p' + h.page : '');
      set('dev-serial', 'Serial #', serial, h ? 'p' + h.page : '', 'review', 'Parsed from "' + devStr + '". Verify serial.');

      // Battery: "Approximate time to explant: 12.5 years"
      h = findRight(/Approximate time to explant/); set('bat-lon-cur', 'Battery Longevity', h && num(h.v), h ? 'p' + h.page : '');
      RESULT['bat-lon-unit'] = { label: 'Longevity Unit', field: 'bat-lon-unit', v: h && /month/i.test(h.v) ? 'months' : 'years', src: h ? 'p' + h.page : '', status: h ? 'auto' : 'empty', note: '' };
      // ICD only: last measured capacitor charge time ("Charge Time  11.2 s"). Absent on
      // pacemaker reports — left empty there (and the form hides the row for non-ICD types).
      var ct = findRight(/^Charge Time$/, { match: /\d/ });
      if (ct) set('bat-cc-cur', 'Cap. Charge Time (s)', num(ct.v), 'p' + ct.page, 'review', 'Last measured capacitor charge — confirm the charge/reform date in the report.');
    }

    /* ---------- pacing percentages: "Atrial 65 % Paced" ----------
       The value cell may be a plain number ("14") or a comparator ("<1", ">99"). Return
       the numeric part for the form plus the raw token so the caller can flag "<1"/">x". */
    function pacedPct(chamberRe) {
      var l = LINES.find(function (line) {
        var c0 = line.items[0];
        return c0 && chamberRe.test(c0.str) && /% Paced/.test(text(line));
      });
      if (!l) return null;
      var n = l.items.find(function (it, idx) { return idx > 0 && /\d/.test(it.str) && !/%|Paced/.test(it.str); });
      return n ? { v: num(n.str), raw: n.str, page: l.page } : null;
    }

    /* AV delay: range -> both bounds + dyn-av Yes; single -> one value. dyn-av once set
       to Yes is never downgraded (one dynamic AV is enough to flip the toggle). */
    function avSet(loField, hiField, label, re) {
      var h = findRight(re, { match: /\d/ });
      var raw = h ? h.v : '';
      var rng = raw.match(/(\d+)\s*-\s*(\d+)/);
      if (rng && rng[1] !== rng[2]) {                 // a real dynamic range (e.g. 260 - 300)
        set(loField, label + ' (min)', rng[1], 'p' + h.page, 'auto', 'Dynamic AV delay "' + raw + '".');
        set(hiField, label + ' (max)', rng[2], 'p' + h.page, 'auto', 'Dynamic AV delay "' + raw + '".');
        RESULT['dyn-av'] = { label: 'Dynamic AV?', field: 'dyn-av', v: 'Yes', src: 'p' + h.page, status: 'auto', note: '' };
      } else {                                        // fixed value ("170 - 170 ms" or "120 ms")
        set(loField, label, h && num(h.v), h ? 'p' + h.page : '');
      }
    }

    /* ---------- programmed settings ---------- */
    function mapSettings() {
      var h;
      h = findRight(/^Mode$/, { match: MODES });                 set('p-mode', 'Mode', h && h.v, h ? 'p' + h.page : '');
      h = findRight(/Lower Rate Limit/, { match: /\d/ });        set('p-lrl', 'Lower Rate (LRL)', h && num(h.v), h ? 'p' + h.page : '');
      h = findRight(/Maximum Tracking Rate/, { match: /\d/ });   set('p-utr', 'Upper Track (UTR)', h && num(h.v), h ? 'p' + h.page : '');
      h = findRight(/Maximum Sensor Rate/, { match: /\d/ });     set('p-usr', 'Upper Sensor (USR)', h && num(h.v), h ? 'p' + h.page : '');
      // AV delays may be a dynamic range ("260 - 300 ms"). When so, flip the form's
      // Dynamic AV toggle to Yes and fill BOTH bounds (p-sav/p-sav-hi); otherwise a single value.
      avSet('p-sav', 'p-sav-hi', 'Sensed AV', /Sensed AV Delay/);
      avSet('p-pav', 'p-pav-hi', 'Paced AV', /Paced AV Delay/);
      // default the toggle off if neither AV came back as a range
      if (!RESULT['dyn-av']) RESULT['dyn-av'] = { label: 'Dynamic AV?', field: 'dyn-av', v: 'No', src: '', status: 'auto', note: '' };
      // Mode switch on/off + trigger rate.
      h = findRight(/^ATR Mode Switch$/);
      RESULT['p-ms'] = { label: 'Mode Switch', field: 'p-ms', v: h && /on/i.test(h.v) ? 'On' : (h ? 'Off' : ''), src: h ? 'p' + h.page : '', status: h ? 'auto' : 'empty', note: '' };
      var tr = findRight(/^Trigger Rate$/, { match: /\d/ });     set('p-msrate', 'Mode Switch Rate', tr && num(tr.v), tr ? 'p' + tr.page : '');
    }

    /* ---------- Leads Data: Most-Recent column, per chamber ---------- */
    function mapLeadMeasurements() {
      // Find the "Leads Data" block and walk it, tracking the current chamber.
      var start = LINES.findIndex(function (l) { return /^Leads Data$/.test((l.items[0] || {}).str || ''); });
      if (start < 0) return;
      var chamber = null;
      for (var i = start + 1; i < LINES.length && LINES[i].page === LINES[start].page; i++) {
        var its = LINES[i].items, first = (its[0] || {}).str || '';
        // Chamber sub-headers. CRT reports split the ventricle into "Right Ventricular" and
        // "Left Ventricular"; dual ICD/PPM reports use a single "Ventricular".
        if (/^Atrial$/.test(first)) { chamber = 'ra'; continue; }
        if (/^Right Ventricular$/.test(first)) { chamber = 'rv'; continue; }
        if (/^Left Ventricular$/.test(first)) { chamber = 'lv'; continue; }
        if (/^Ventricular$/.test(first)) { chamber = 'rv'; continue; }
        if (/^Shock Vector$/.test(first)) { chamber = 'shock'; continue; }   // ICD defib-coil block
        if (/^(Brady|Settings|Counters)/.test(first)) break;
        if (!chamber) continue;
        // Most-Recent cell = a value cell at x >= MR_X.
        var mr = its.filter(function (it) { return it.x >= MR_X; });
        var mrVal = mr.length ? mr[0].str : '';
        var src = 'p' + LINES[i].page;
        var CH = chamber.toUpperCase();   // RA / RV / LV
        if (/^Shock Impedance/.test(first) && mrVal) {
          // single-coil (RV→Can) device: the shock impedance is the RV coil impedance.
          set('lead-rv-coil-imp', 'RV Defib / Coil Impedance (Ω)', num(mrVal), src, 'review', 'Shock-coil impedance, Most-Recent. Verify.');
        } else if (/^Intrinsic Amplitude/.test(first) && mrVal) {
          set('lead-' + chamber + '-sens', CH + ' Sensing (mV)', num(mrVal), src, 'review', 'Most-Recent reading. Verify.');
        } else if (/^Pace Impedance/.test(first) && mrVal) {
          // Quadripolar LV leads list two vectors ("Pace Impedance LVa" / "LVb"). LVa is the
          // primary/active vector, so keep the FIRST impedance per chamber and don't let LVb
          // (often Off) overwrite it.
          if (!(RESULT['lead-' + chamber + '-imp'] && RESULT['lead-' + chamber + '-imp'].v)) {
            var vec = (first.match(/\b(LV[ab])\b/) || [])[1];
            set('lead-' + chamber + '-imp', CH + ' Impedance (Ω)', num(mrVal), src, 'review', (vec ? vec + ' vector. ' : '') + 'Most-Recent reading. Verify.');
          }
        } else if (/^Pace Threshold/.test(first) && mrVal) {
          set('lead-' + chamber + '-thr', CH + ' Threshold (V)', num(mrVal), src, 'review', 'Most-Recent reading. Verify.');
          var pw = (mrVal.match(/@\s*([\d.]+)\s*ms/) || [])[1] || '';
          RESULT['lead-' + chamber + '-pw'] = { label: CH + ' Pulse Width (ms)', field: 'lead-' + chamber + '-pw', v: pw, src: src, status: pw ? 'auto' : 'empty', note: '' };
        }
      }
    }

    /* ---------- lead inventory (model / serial / position) from Patient Data ---------- */
    // Classify a Position-column label into a chamber. LV CRT leads come in many flavors —
    // "Left Ventricle", "LV Mid (lateral)", "LV Apical", "Coronary Sinus" — so match on the
    // descriptive text rather than an exact string.
    function chamberOf(posStr) {
      if (/Right Atrium|\bRA\b/i.test(posStr)) return 'RA';
      if (/Right Ventricle|\bRV\b/i.test(posStr)) return 'RV';
      if (/Left Ventric|Coronary Sinus|\bLV\b/i.test(posStr)) return 'LV';
      return null;
    }
    // Verbatim: capture EVERY lead row from the Patient Data "Leads" table exactly as printed —
    // location, model, serial and implant date — with no chamber dedup or re-labeling, so the
    // form's lead table mirrors the report (including quirks like two "Right Ventricle" rows or
    // a mislabeled position). A row is real iff it carries the "Boston Scientific" manufacturer
    // cell; "N/R" filler rows have none and are skipped.
    function mapLeadInventory() {
      LEADS = [];
      LINES.forEach(function (l) {
        // Manufacturer cell is EXACTLY "Boston Scientific". (The page footer says "Boston
        // Scientific Corporation" — substring-matching that pulled the footer in as a lead.)
        var mi = l.items.findIndex(function (it) { return /^Boston Scientific$/.test(it.str); });
        if (mi < 0) return;
        var rest = l.items.slice(mi + 1);                         // [model, serial, polarity, position]
        if (!rest.length) return;                                 // need at least a model after it
        var pos = (l.items[l.items.length - 1] || {}).str || '';  // right-most cell = Position
        LEADS.push({
          location:     pos,                                      // raw, e.g. "Right Ventricle" / "LV Mid (lateral)"
          manufacturer: (l.items[mi] || {}).str || '',            // the matched "Boston Scientific" cell
          model:    (rest[0] || {}).str || '',
          serial:   (rest[1] || {}).str || '',
          date:     (l.items[0] || {}).str || '',                 // raw, e.g. "Mar 2025" (verbatim)
          chamber:  chamberOf(pos)                                // best-effort tag (not used by the table)
        });
      });
    }

    /* ---------- observations (My Alerts) + changes ---------- */
    function mapObsAndChanges() {
      var ai = LINES.findIndex(function (l) { return /^My Alerts$/.test((l.items[0] || {}).str || ''); });
      var alerts = [];
      if (ai >= 0) {
        for (var i = ai + 1; i < LINES.length && LINES[i].page === LINES[ai].page; i++) {
          var first = (LINES[i].items[0] || {}).str || '';
          if (/^(Events Since|Battery|Leads Data|Settings)/.test(first)) break;
          // alert rows look like: <date/time>  <description>; keep the description cell(s).
          var desc = LINES[i].items.filter(function (it) { return it.x >= 150 && !/^\d{2}\s/.test(it.str); }).map(function (it) { return it.str; }).join(' ').trim();
          if (desc) alerts.push(desc);
        }
      }
      if (alerts.length) {
        RESULT['obs-yn'] = { label: 'Observations?', field: 'obs-yn', v: 'Yes', src: 'p' + (LINES[ai].page), status: 'auto', note: '' };
        RESULT['obs-text'] = { label: 'Observations text', field: 'obs-text', v: alerts.join('\n'), src: 'p' + (LINES[ai].page), status: 'auto', note: 'From "My Alerts".' };
      } else {
        RESULT['obs-yn'] = { label: 'Observations?', field: 'obs-yn', v: 'N/A', src: '', status: 'auto', note: '' };
      }
      var n = lineWith(/no changes to display/i);
      RESULT['rp-chg'] = { label: 'Parameter changes?', field: 'rp-chg', v: n ? 'No' : '', src: n ? 'p' + n.page : '', status: n ? 'auto' : 'review', note: n ? '' : 'Changes table present — review.' };
      RESULT['sig-date'] = { label: 'Date Completed', field: 'sig-date', v: RESULT['pt-date'].v, src: 'visit date', status: RESULT['pt-date'].v ? 'auto' : 'empty', note: '' };
    }

    function flagMode() {
      var m = RESULT['p-mode']; if (!m || !m.v) return;
      if (DROPDOWN_MODES.indexOf(m.v.toUpperCase()) < 0) {
        m.status = 'review';
        m.note = (m.note ? m.note + ' ' : '') + '"' + m.v + '" is unusual — verify.';
      }
    }

    /* ---------- router ---------- */
    var model = (findRight(/^Device$/) || { v: '' }).v.split('/')[0].trim();
    var modeTok = (findRight(/^Mode$/, { match: MODES }) || { v: '' }).v;
    var hasA = !!pacedPct(/^Atrial$/) || /^(D|AAI|AOO)/i.test(modeTok) || LINES.some(function (l) { return /Right Atrium/.test(text(l)); });
    var hasV = !!pacedPct(/^Right Ventricular$/) || !!pacedPct(/^Ventricular$/) || /^(D|V)/i.test(modeTok) || LINES.some(function (l) { return /Right Ventricle/.test(text(l)); });
    var hasLV = !!pacedPct(/^Left Ventricular/) || LINES.some(function (l) { return /Left Ventric/.test(text(l)); });
    // Defib evidence: a capacitor Charge Time or a shock-coil impedance/vector. CRT-P / PPM
    // devices have neither.
    var hasShock = LINES.some(function (l) {
      return l.items.some(function (it) { return /^Charge Time$/.test(it.str) || /^Shock (Vector|Impedance)$/.test(it.str); });
    });
    ROUTE = detectDevice(model, hasA, hasV, hasLV, hasShock);

    mapHeader();
    // Pacing % may be a comparator ("<1"); cmpNum keeps it verbatim for the text field.
    function setPct(field, label, p) {
      if (!p) { set(field, label, '', '', 'review', ''); return; }
      var c = E.cmpNum(p.raw);
      set(field, label, c.v, 'p (Brady counters)', c.cmp ? 'review' : 'auto', c.cmp ? ('Reported "' + c.raw + '".') : '');
    }
    setPct('pct-a', 'A Paced %', pacedPct(/^Atrial$/));
    // RV %: CRT splits it under "Right Ventricular"; dual reports use "Ventricular".
    setPct('pct-v', 'V Paced %', pacedPct(/^Right Ventricular$/) || pacedPct(/^Ventricular$/));
    // LV % only present on CRT reports. Quadripolar leads label it "Left Ventricular (LVa)"
    // (with an inactive "(LVb)") — take the LVa/primary value.
    var lvp = pacedPct(/^Left Ventricular \(LVa\)$/) || pacedPct(/^Left Ventricular$/);
    if (lvp) setPct('pct-lv', 'LV Paced %', lvp);
    mapSettings();
    mapLeadMeasurements();
    mapLeadInventory();
    // AF burden + ventricular ectopy summary. Preserve a comparator ("<1") via cmpNum.
    var af = findRight(/^% AT\/AF$/);
    var afc = af ? E.cmpNum(af.v) : null;
    set('ep-af-burden', 'AF Burden (%)', afc ? afc.v : '', af ? 'p' + af.page : '', afc && afc.cmp ? 'review' : 'auto', afc && afc.cmp ? ('Reported "' + afc.raw + '".') : '');
    // HVR field = the "Total Episodes" row, Since Last Reset column (the first value to the right
    // of the label; Device Totals is the second). Per the clinic's workflow this Since-Last-Reset
    // total drives HVR, not the Nonsustained row.
    var te = findRight(/^Total Episodes$/);
    var teVal = te ? num(te.v) : '';
    set('ep-hvr', 'HVR (VT/VF/NS-VT)', teVal, te ? 'p' + te.page : '', 'review', 'Total episodes (Since Last Reset). Confirm in the logbook.');
    // AHR count = sum of the AT/AF "Episodes by Duration" buckets (Since Last Reset column):
    // <1 min + 1m-1h + 1h-24h + 24h-48h + >48h. The Total PACs row that follows is excluded.
    var ahr = sumByDuration();
    if (ahr != null) set('ep-ahr', 'AHR (AT/AF/AFl)', String(ahr), 'p (Episodes by Duration)', 'review', 'Sum of AT/AF Episodes by Duration (Since Last Reset); excludes Total PACs. Confirm in the logbook.');
    // Total Episodes form field = HVR (Since-Last-Reset total) + AHR (Episodes-by-Duration sum).
    if (teVal !== '' || ahr != null) {
      var epSum = (parseFloat(teVal) || 0) + (ahr != null ? ahr : 0);
      set('ep-total', 'Total Episodes', String(epSum), 'computed (HVR + AHR)', 'review', 'HVR total episodes (Since Last Reset) + AHR Episodes-by-Duration sum.');
    }
    mapObsAndChanges();
    flagMode();

    // ---- episode / arrhythmia-log helpers ----
    // "1.2K" / "150" -> number (the duration buckets are small ints, but be K/M tolerant).
    function valK(s) {
      var m = String(s).replace(/,/g, '').match(/([\d.]+)\s*([KkMm]?)/);
      if (!m) return 0;
      var x = parseFloat(m[1]) || 0;
      if (/k/i.test(m[2])) x *= 1000;
      if (/m/i.test(m[2])) x *= 1e6;
      return x;
    }
    // Sum the "Episodes by Duration" rows (Since Last Reset = first value cell on each row),
    // walking from that header to the "Total PACs" row (exclusive). null if the block is absent.
    function sumByDuration() {
      var start = -1;
      for (var i = 0; i < LINES.length; i++) {
        var l0 = LINES[i].items[0];
        if (l0 && /^Episodes by Duration$/.test(l0.str)) { start = i; break; }
      }
      if (start < 0) return null;
      var sum = 0, any = false;
      for (var j = start + 1; j < LINES.length; j++) {
        var lbl = (LINES[j].items[0] || {}).str || '';
        if (/^Total\b/i.test(lbl)) break;                 // "Total PACs" — excluded, stop
        if (/Counters$|Arrhythmia$|^Ventricular\b/i.test(lbl)) break;  // ran past the block
        var cell = LINES[j].items.slice(1).find(function (n) { return /\d/.test(n.str); });
        if (cell) { sum += valK(cell.str); any = true; }
      }
      return any ? Math.round(sum) : null;
    }
    // "17 May 2026 00:12" -> "2026-05-17T00:12" for the datetime-local input.
    function dtToLocal(s) {
      var m = String(s).match(/(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{4})\s+(\d{1,2}):(\d{2})/);
      if (!m) return '';
      var mo = BMONTHS[m[2].toLowerCase()];
      return mo ? (m[3] + '-' + mo + '-' + m[1].padStart(2, '0') + 'T' + m[4].padStart(2, '0') + ':' + m[5]) : '';
    }
    // The "Longest:" episode under "AT/AF Overview: Since Last Reset" (NOT "Reset Before Last").
    function buildEpisodes() {
      var out = [];
      var start = -1;
      for (var i = 0; i < LINES.length; i++) {
        var l0 = LINES[i].items[0];
        if (l0 && /^AT\/AF Overview: Since Last Reset/.test(l0.str)) { start = i; break; }
      }
      if (start < 0) return out;
      for (var j = start + 1; j < LINES.length; j++) {
        var lbl = (LINES[j].items[0] || {}).str || '';
        if (/^AT\/AF Overview:/.test(lbl)) break;          // reached the next overview block
        if (/^Longest:?$/.test(lbl)) {
          var its = LINES[j].items;
          var dtRaw = (its[1] || {}).str || '';
          var rate = '', dur = '';
          its.forEach(function (it) {
            var mr = it.str.match(/Avg V Rate:\s*(\d+)/); if (mr) rate = mr[1];
            var md = it.str.match(/Duration:\s*([\d:]+)/); if (md) dur = md[1];
          });
          out.push({
            dt: dtToLocal(dtRaw),
            dur: dur,
            rate: rate,
            types: ['AF/AHR'],
            notes: 'Longest'
          });
          break;
        }
      }
      return out;
    }

    GOTCHAS = [
      { tag: 'BELOW', body: '<b>Stacked header fields.</b> "Last Office Interrogation" and "Implant Date" print the value on the line <i>below</i> the label, so a right-of-label search misses them. <code>valueBelow()</code> reads the cell underneath.' },
      { tag: 'DATE', body: '<b>Boston dates are "D Mon YYYY"</b> (e.g. 8 Apr 2026), not Medtronic\'s "Mon/DD/YYYY". A vendor-local <code>bToISO()</code> parses them.' },
      { tag: '3-COL', body: '<b>Leads Data is Implant | Previous Session | Most Recent.</b> The map reads the <b>Most Recent</b> column (x ≥ ' + MR_X + ') for the current Atrial/Ventricular row.' },
      { tag: 'RANGE', body: '<b>Dynamic AV delays</b> print as a range ("260 - 300 ms"). The parser flips the form\'s <b>Dynamic AV</b> toggle to Yes and records both bounds (min + max).' },
      { tag: 'DEVICE', body: '<b>Model + serial share one cell</b> ("ACCOLADE MRI EL L331/ 254979"). Split on "/"; serial is flagged to verify.' }
    ];

    return { RESULT: RESULT, GOTCHAS: GOTCHAS, LEADS: LEADS, ROUTE: ROUTE, ORDER: ORDER_DUAL, EPISODES: buildEpisodes() };
  }

  global.BOSTON = {
    name: 'Boston Scientific',
    sig: /boston scientific|latitude|accolade|resonate|emblem|vigilant|altrua|vitalio|formio|proponent|essentio|ingenio|dynagen|inogen|energen|teligen|momentum/i,
    dropdownModes: DROPDOWN_MODES,
    detectDevice: detectDevice,
    runMap: runMap
  };
})(window);
