/* =====================================================================
   BIOTRONIK -> CRM field map
   ---------------------------------------------------------------------
   BIOTRONIK.runMap(LINES) -> { RESULT, LEADS, ROUTE, ORDER, GOTCHAS }.

   Biotronik exports come in (at least) TWO very different templates, and
   this parser handles both:

   (A) Home-Monitoring report — text fragmented into per-character tokens
       ("R"+"ecent"="Recent"), bold headers drawn 2-4x, values in fixed
       columns far right (A ~x407, V ~x485), device on a "... S/N: ..." line.

   (B) Standard / BIOSTD report — whole-word tokens, a clean first line
       "PDF: BIOTRONIK - <model> - <serial> - <Last, First> - p/N", values
       closer in (single ~x315-456, A/V ~x315/x406 or x334/x378/x400),
       leads as an A|V table (no per-lead serials), and slightly different
       labels (Atrial burden, P/R wave amplitude, fixed AV delay, ...).

   Unifying tricks:
     - VSPLIT (~305) separates LABEL (left) from VALUE (right) tokens; labels
       are matched by joining the left tokens with NO separator + de-spacing,
       so both fragmentation styles normalize the same.
     - A value row's FIRST value token = Atrial, SECOND = Ventricular
       (avField), independent of the exact x. "-----" means "not measured".
     - Multiple interrogations / test runs appear, so values are taken from
       the LAST (or last non-empty) matching row.
   ===================================================================== */
(function (global) {
  'use strict';
  var E = global.Engine;
  var VSPLIT = 305;

  function bToISO(s) {
    var m = String(s).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    return m ? (m[3] + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0')) : '';
  }
  function clean(s) { s = String(s == null ? '' : s).trim(); return /^[-–—\s]+$/.test(s) ? '' : s; }

  function detectDevice(hasRA, hasRV, hasLV, hasShock) {
    if (hasShock) return hasLV ? { dtype: 'CRT-D', label: 'CRT-D (BiV ICD)', family: 'crt' }
                               : { dtype: (hasRA ? 'ICD-DC' : 'ICD-SC'), label: 'ICD', family: 'icd' };
    if (hasLV) return { dtype: 'CRT-P', label: 'CRT-P (BiV pacemaker)', family: 'crt' };
    if (hasRA && hasRV) return { dtype: 'PPM-DC', label: 'Dual-chamber pacemaker', family: 'ppm' };
    return { dtype: 'PPM-SC', label: 'Single-chamber pacemaker', family: 'ppm' };
  }

  function runMap(LINES, META) {
    var RESULT = {}, LEADS = [], EPISODES = [], GOTCHAS = [], ROUTE;
    var num = E.num;
    function set(field, label, v, src, status, note) {
      v = (v == null ? '' : String(v));
      RESULT[field] = { label: label, field: field, v: v, src: src || '', status: status || (v ? 'auto' : 'empty'), note: note || '' };
    }

    function leftStr(l) { return l.items.filter(function (it) { return it.x < VSPLIT; }).map(function (it) { return it.str; }).join('').replace(/\s+/g, '').toLowerCase(); }
    function vtoks(l) { return l.items.filter(function (it) { return it.x >= VSPLIT; }).map(function (it) { return it.str; }); }
    function joinV(l) { return vtoks(l).join(' ').trim(); }
    function one(l) { return clean(vtoks(l)[0] || ''); }
    function av(l) { var t = vtoks(l); return { a: clean(t[0] || ''), v: clean(t[1] || '') }; }
    function findLbl(re, last) { var hit = null; LINES.forEach(function (l) { if (re.test(leftStr(l))) { if (last || !hit) hit = l; } }); return hit; }
    function modelText(items) {
      return items.map(function (it) { return it.str; }).join(' ')
        .replace(/\b([A-Z][a-z]{2,})\s+([a-z])\b/g, '$1$2') // "Edor" + "a" -> "Edora"
        .replace(/\s*-\s*/g, '-').replace(/\s+/g, ' ').trim();
    }
    // scan all 2-value rows matching re; keep the LAST non-empty A and V (so blanks don't clobber)
    function avField(re) {
      var a = '', v = '';
      LINES.forEach(function (l) { if (re.test(leftStr(l))) { var t = vtoks(l); if (t.length >= 2) { var ca = clean(t[0]), cv = clean(t[1]); if (ca) a = ca; if (cv) v = cv; } } });
      return { a: a, v: v };
    }

    /* ---------- manufacturer ---------- */
    set('mfr', 'Manufacturer', 'Biotronik', 'signature', 'auto');

    /* ---------- device header (model / serial / name) ---------- */
    var bhdr = null;
    LINES.forEach(function (l) { l.items.forEach(function (it) { var m = it.str.match(/BIOTRONIK\s*-\s*(.+?)\s*-\s*([A-Za-z0-9]+)\s*-\s*(.+?)\s*-\s*\d+\s*\/\s*\d+/i); if (m && !bhdr) bhdr = m; }); });
    var implantRaw = '';
    if (bhdr) {                                   // Layout B: clean header line
      set('dev-model', 'Device Model', bhdr[1].trim(), 'header', 'auto');
      set('dev-serial', 'Serial #', bhdr[2].trim(), 'header', 'auto');
      set('pt-name', 'Patient Name', bhdr[3].trim(), 'header', 'auto');
    } else {                                      // Layout A: "... S/N: <serial> ..." header
      var hdr = LINES.find(function (l) { return /S\/N:/i.test(l.items.map(function (it) { return it.str; }).join('')); });
      if (hdr) {
        var hs = hdr.items.map(function (it) { return it.str; }).join('');
        var sn = hs.match(/S\/N:?(\d+)/i);
        set('dev-serial', 'Serial #', sn ? sn[1] : '', 'header', sn ? 'auto' : 'empty');
        var modelToks = hdr.items.filter(function (it) { return it.x >= 245 && it.x <= 302; });
        var model = modelText(modelToks);
        set('dev-model', 'Device Model', model, 'header', model ? 'review' : 'empty', model ? 'Verify model — reconstructed from fragmented header text.' : '');
        var dtok = hdr.items.find(function (it) { return /^\d{2}\/\d{2}\/\d{4}$/.test(it.str); });
        if (dtok) set('pt-date', 'Interrogation Date', bToISO(dtok.str), 'header', 'auto');
      }
    }

    /* ---------- patient ---------- */
    var ln;
    if (!RESULT['pt-name'] || !RESULT['pt-name'].v) {
      ln = findLbl(/^name$/); if (ln) set('pt-name', 'Patient Name', joinV(ln), 'patient', 'auto');
      if (!RESULT['pt-name'] || !RESULT['pt-name'].v) {
        var lln = findLbl(/^lastname$/), fln = findLbl(/^firstname$/);
        var L = lln ? joinV(lln) : '', F = fln ? joinV(fln) : '';
        if (L || F) set('pt-name', 'Patient Name', (L + (F ? ', ' + F : '')).trim(), 'patient', 'auto');
      }
    }
    ln = findLbl(/^dateofbirth/); if (ln) set('pt-dob', 'Date of Birth', bToISO(one(ln)), 'patient', 'auto');
    ln = findLbl(/^dateofimplant/); if (ln) { implantRaw = one(ln); set('dev-implant', 'Implant Date', bToISO(implantRaw), 'patient', 'auto'); }
    ln = findLbl(/^physician/); if (ln) set('pt-provider', 'Provider / Physician', joinV(ln), 'patient', 'review', 'Verify physician name.');

    /* ---------- leads ----------
       Layout A: per-lead blocks (Lead model / Manufacturer / Serial number / Type / Implantation / Channels).
       Layout B: an A|V table (Type / Manufacturer / Lead position) — no serials. */
    var cur = null, seen = {};
    LINES.forEach(function (l) {
      var k = leftStr(l);
      if (/^leadmodel$/.test(k)) { cur = { model: joinV(l) }; }
      else if (!cur) return;
      else if (/^manufacturer$/.test(k)) cur.manufacturer = joinV(l);
      else if (/^serialnumber$/.test(k)) cur.serial = joinV(l);
      else if (/^implantation$/.test(k)) cur.date = joinV(l);
      else if (/^channels$/.test(k)) {
        cur.location = joinV(l);
        var key = cur.serial || cur.model;
        if (cur.model && !seen[key]) { seen[key] = 1; LEADS.push({ location: cur.location || '', manufacturer: cur.manufacturer || '', model: cur.model, serial: cur.serial || '', date: cur.date || '' }); }
        cur = null;
      }
    });
    if (!LEADS.length) {  // Home-Monitoring horizontal inventory table
      var leadHead = -1;
      for (var li = 0; li < LINES.length; li++) {
        var hi = LINES[li].items.map(function (it) { return it.str; }).join(' ');
        if (/manufacturer/i.test(hi) && /serial/i.test(hi) && /implantation/i.test(hi) && /channels/i.test(hi)) { leadHead = li; break; }
      }
      if (leadHead >= 0) {
        var leadPage = LINES[leadHead].page;
        for (var lr = leadHead + 1; lr < LINES.length && LINES[lr].page === leadPage; lr++) {
          var row = LINES[lr];
          function col(lo, hi) {
            return row.items.filter(function (it) { return it.x >= lo && it.x < hi; }).map(function (it) { return it.str; }).join(' ').replace(/\s+/g, ' ').trim();
          }
          var lm = col(130, 235);
          if (!lm) continue;
          var lead = { location: col(475, 540), manufacturer: col(235, 305), model: lm, serial: col(305, 370), date: col(405, 475) };
          var lk = lead.serial || [lead.location, lead.model].join('|');
          if (!seen[lk]) { seen[lk] = 1; LEADS.push(lead); }
        }
      }
    }
    if (!LEADS.length) {  // table style
      var typeL = findLbl(/^type$/), posL = findLbl(/^leadposition$/), mfrL = findLbl(/^manufacturer$/);
      if (typeL && posL) {
        var ty = av(typeL), po = av(posL), mf = mfrL ? av(mfrL) : { a: '', v: '' };
        if (ty.a) LEADS.push({ location: po.a || 'RA', manufacturer: mf.a || 'Biotronik', model: ty.a, serial: '', date: implantRaw });
        if (ty.v) LEADS.push({ location: po.v || 'RV', manufacturer: mf.v || 'Biotronik', model: ty.v, serial: '', date: implantRaw });
      }
    }

    /* ---------- routing ---------- */
    var posJoin = LEADS.map(function (d) { return (d.location || '').toUpperCase(); }).join(' ');
    var hasRA = /\bRA\b|ATRI|APPEND/.test(posJoin) || LEADS.length >= 1;
    var hasRV = /\bRV\b|VENTRIC|APEX/.test(posJoin) || LEADS.length >= 2;
    var hasLV = /\bLV\b|LEFT/.test(posJoin);
    var hasShock = LINES.some(function (l) { return /shock|defibrillation|\bVT\s*zone|\bVF\s*zone/i.test(l.items.map(function (it) { return it.str; }).join('')); });
    ROUTE = detectDevice(hasRA, hasRV, hasLV, hasShock);
    RESULT['dtype'] = { label: 'Device Type', field: 'dtype', v: ROUTE.dtype, src: 'leads', status: 'auto', note: '' };

    /* ---------- mode + bradycardia rates ---------- */
    ln = findLbl(/^mode$/, true); if (ln) set('p-mode', 'Mode', one(ln), 'params', 'auto');
    ln = findLbl(/^basicrate\//, true); if (ln) set('p-lrl', 'Lower Rate (LRL)', num(one(ln)), 'params', 'auto');
    ln = findLbl(/^upperrateresponse/, true); var utr = ln ? num(one(ln)) : '';
    if (!utr) { var bru = findLbl(/^basicrate\/utr/, true); if (bru) { var p = one(bru).split('/'); if (p[1] && num(p[1])) utr = num(p[1]); } }
    if (utr) set('p-utr', 'Upper Track (UTR)', utr, 'params', 'auto');
    ln = findLbl(/^sensor\/ratefading/, true); if (ln) set('p-usr', 'Upper Sensor (USR)', num(one(ln)), 'params', 'auto');
    ln = findLbl(/^modeswitching$/, true);
    if (ln) set('p-ms', 'Mode Switch', /^on$/i.test(one(ln)) ? 'On' : (/^off$/i.test(one(ln)) ? 'Off' : ''), 'params', 'auto');
    ln = findLbl(/^interventionrate/, true);
    if (!ln) ln = findLbl(/^modeswitching\[bpm\]$/, true);
    if (ln) set('p-msrate', 'Mode Switch Rate', num(one(ln)), 'params', 'auto');

    /* ---------- AV delay: dynamic ("300/260") or fixed ("240") ---------- */
    ln = findLbl(/^dynamicavdelay/, true);
    if (ln) {
      var avm = one(ln).match(/(\d+)\s*\/\s*(\d+)/);
      if (avm) {
        var hi = Math.max(+avm[1], +avm[2]), lo = Math.min(+avm[1], +avm[2]);
        RESULT['dyn-av'] = { label: 'Dynamic AV', field: 'dyn-av', v: 'Yes', src: 'params', status: 'auto', note: '' };
        set('p-sav', 'Sensed AV min', lo, 'params', 'review', 'Dynamic AV ' + lo + '-' + hi + ' ms.');
        set('p-sav-hi', 'Sensed AV max', hi, 'params', 'review', '');
        set('p-pav', 'Paced AV min', lo, 'params', 'review', '');
        set('p-pav-hi', 'Paced AV max', hi, 'params', 'review', '');
      }
    } else {
      ln = findLbl(/^avdelay\[ms\]$/);  // first occurrence = programmed (test programs come later)
      if (ln) { var avv = num(one(ln)); if (avv) { set('p-pav', 'Paced AV', avv, 'params', 'review', 'Verify sensed vs paced AV.'); set('p-sav', 'Sensed AV', avv, 'params', 'review', ''); } }
    }

    /* ---------- pacing % + AF burden ---------- */
    ln = findLbl(/^pacingina\/v/, true);
    if (ln) { var pv = one(ln).split('/'); if (pv[0] != null && clean(pv[0])) set('pct-a', 'A Paced %', clean(pv[0]), 'diag', 'auto'); if (pv[1] != null && clean(pv[1])) set('pct-v', 'V Paced %', clean(pv[1]), 'diag', 'auto'); }
    ln = findLbl(/atrial(arrhythmia)?burden/, true);
    if (ln) { var b = E.cmpNum(one(ln)); set('ep-af-burden', 'AF Burden (%)', b.v, 'diag', b.cmp ? 'review' : 'auto', b.cmp ? ('Reported "' + b.raw + '".') : ''); }

    /* ---------- longevity (Calculated/Expected ERI "N Y. M Mo.") ---------- */
    ln = findLbl(/^(calculated|expected)eri/, true);
    if (ln) {
      var eri = joinV(ln).match(/(\d+)\s*Y.*?(\d+)\s*Mo/i);
      if (eri) { var yrs = (+eri[1] + (+eri[2]) / 12).toFixed(1); set('bat-lon-cur', 'Longevity', yrs, 'status', 'review', 'Calculated ERI ' + eri[1] + ' Y ' + eri[2] + ' Mo — verify.'); set('bat-lon-unit', 'Longevity unit', 'years', 'status', 'auto'); }
    }
    ln = findLbl(/^batterystatus$/, true);
    if (ln) {
      var bs = one(ln).toUpperCase();
      if (/^(OK|ERI|EOL)$/.test(bs)) set('bat-status', 'Battery Status', bs, 'status', 'auto');
    }

    /* ---------- episode counters + Home-Monitoring recording table ---------- */
    ln = findLbl(/^totalnumberofepisodes$/, true);
    if (ln) set('ep-ahr', 'AHR (AT/AF/AFl)', num(one(ln)), 'diag', 'review', 'Total atrial episodes reported since the first interrogation; confirm the desired reporting interval.');
    ln = findLbl(/^highventricularrateepisodes\[count\]$/, true);
    if (ln) set('ep-hvr', 'HVR (VT/VF/NS-VT)', num(one(ln)), 'diag', 'review', 'BIOTRONIK high-ventricular-rate episode count; confirm rhythm classification.');
    ln = findLbl(/^pmtepisodes\[count\]$/, true);
    if (ln) set('ep-pmt', 'PMT', num(one(ln)), 'diag', 'auto');

    function bDateTime(date, time) {
      var m = String(date).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      return m ? (m[3] + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0') + 'T' + time) : '';
    }
    LINES.forEach(function (l) {
      var dateIt = l.items.find(function (it) { return it.x >= 145 && it.x < 185 && /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(it.str); });
      var timeIt = l.items.find(function (it) { return it.x >= 185 && it.x < 240 && /^\d{1,2}:\d{2}$/.test(it.str); });
      var durIt = l.items.find(function (it) { return it.x >= 260 && it.x < 360 && /^\d{2}:\d{2}:\d{2}$/.test(it.str); });
      var trig = l.items.filter(function (it) { return it.x >= 380 && it.x < 440; }).map(function (it) { return it.str; }).join('').trim();
      var rateIt = l.items.find(function (it) { return it.x >= 450 && it.x < 505 && /^\d+$/.test(it.str); });
      if (!dateIt || !timeIt || !durIt || !/^(AT|HVR)$/i.test(trig)) return;
      EPISODES.push({
        dt: bDateTime(dateIt.str, timeIt.str),
        dur: durIt.str,
        rate: rateIt ? rateIt.str : '',
        types: /^AT$/i.test(trig) ? ['AT'] : ['Other'],
        flags: [],
        notes: /^HVR$/i.test(trig) ? 'BIOTRONIK HVR trigger — verify rhythm classification.' : ''
      });
    });
    if (EPISODES.length) {
      function durSeconds(s) { var p = s.split(':').map(Number); return p[0] * 3600 + p[1] * 60 + p[2]; }
      var allEpisodes = EPISODES, ahrs = [], nonAhrs = [];
      allEpisodes.forEach(function (ep) { (ep.types.indexOf('AT') >= 0 ? ahrs : nonAhrs).push(ep); });
      var recentAhr = null, longestAhr = null, fastestNonAhr = null;
      ahrs.forEach(function (ep) {
        if (!recentAhr || ep.dt > recentAhr.dt) recentAhr = ep;
        if (!longestAhr || durSeconds(ep.dur) > durSeconds(longestAhr.dur)) longestAhr = ep;
      });
      nonAhrs.forEach(function (ep) { if (!fastestNonAhr || +ep.rate > +fastestNonAhr.rate) fastestNonAhr = ep; });
      EPISODES = [];
      function select(ep, flag) {
        if (!ep) return;
        if (ep.flags.indexOf(flag) < 0) ep.flags.push(flag);
        if (EPISODES.indexOf(ep) < 0) EPISODES.push(ep);
      }
      select(recentAhr, 'Recent');
      select(longestAhr, 'Longest');
      select(fastestNonAhr, 'Fastest');
    }

    /* ---------- lead measurements (Atrial value -> RA, Ventricular -> RV) ----------
       Prefer the LAST "Test results" block so a chamber shown as "-----" stays blank — the
       programmed/test-program pulse width elsewhere must NOT leak in. Fall back to a whole-doc
       search only when that field's row is absent from the block (e.g. threshold lives in a
       different section on the Home-Monitoring report). */
    var trIdx = -1;
    for (var ti = 0; ti < LINES.length; ti++) if (/^testresults/.test(leftStr(LINES[ti]))) trIdx = ti;
    var trBlock = [];
    if (trIdx >= 0) {
      for (var tj = trIdx; tj < LINES.length; tj++) {
        if (tj > trIdx && /^(diagnostics|patient|status|alertsandepisodes|bradycardia|follow-?up|measuredvalues|testprogram|leads|recordingtriggers|trendview)/.test(leftStr(LINES[tj]))) break;
        trBlock.push(LINES[tj]);
      }
    }
    function avScoped(re) {
      var present = false, a = '', v = '';
      trBlock.forEach(function (l) { if (re.test(leftStr(l))) { var t = vtoks(l); if (t.length) { present = true; var ca = clean(t[0]), cv = clean(t[1]); if (ca) a = ca; if (cv) v = cv; } } });
      return present ? { a: a, v: v } : avField(re);
    }
    var imp = avScoped(/^leadimpedance/);                        if (imp.a) set('lead-ra-imp', 'RA Impedance', num(imp.a), 'test', 'auto'); if (imp.v) set('lead-rv-imp', 'RV Impedance', num(imp.v), 'test', 'auto');
    var sen = avScoped(/sensingamplitude|p\/rwaveamplitude/);    if (sen.a) set('lead-ra-sens', 'RA Sensing', num(sen.a), 'test', 'auto'); if (sen.v) set('lead-rv-sens', 'RV Sensing', num(sen.v), 'test', 'auto');
    var thr = avScoped(/(?:lastmeasured)?threshold\[v\]$/);      if (thr.a) set('lead-ra-thr', 'RA Threshold', num(thr.a), 'test', 'auto'); if (thr.v) set('lead-rv-thr', 'RV Threshold', num(thr.v), 'test', 'auto');
    var pw = avScoped(/^pulsewidth\[ms\]$/);                     if (pw.a) set('lead-ra-pw', 'RA Pulse Width', num(pw.a), 'params', 'auto'); if (pw.v) set('lead-rv-pw', 'RV Pulse Width', num(pw.v), 'params', 'auto');

    GOTCHAS = [
      { tag: 'TWO LAYOUTS', body: '<b>Two report templates.</b> The Home-Monitoring report is per-character fragmented with far-right value columns; the Standard/BIOSTD report uses whole words and a clean <code>PDF: BIOTRONIK - model - serial - name</code> header. Both are handled.' },
      { tag: 'LABEL/VALUE', body: '<b>Dynamic split.</b> Tokens left of x=' + VSPLIT + ' are the (de-spaced, joined) label; tokens right of it are values. The first value token is Atrial, the second Ventricular (<code>avField</code>); "-----" = not measured.' },
      { tag: 'LEADS', body: '<b>Three lead styles.</b> Home-Monitoring uses either per-lead blocks or a horizontal inventory table (both include serials); Standard lists an A|V table (Type/Manufacturer/Position, no serials → uses the device implant date).' },
      { tag: 'EPISODES', body: '<b>Focused Home-Monitoring episode summary.</b> The logbook receives the most recent AHR, longest AHR, and fastest non-AHR recording (deduplicated when one AHR is both recent and longest). HVR rhythm type remains flagged for clinical classification.' },
      { tag: 'VALIDATED', body: '<b>Validated on a dual-chamber PPM in each layout.</b> ICD/CRT and single-chamber Biotronik are still unverified.' }
    ];

    return { RESULT: RESULT, LEADS: LEADS, ROUTE: ROUTE, ORDER: null, GOTCHAS: GOTCHAS, EPISODES: EPISODES };
  }

  global.BIOTRONIK = {
    name: 'Biotronik',
    // no `sig` here — vendor detection lives in engine.js (Engine.VENDORS) so the lists can't drift.
    detectDevice: detectDevice,
    runMap: runMap
  };
})(window);
