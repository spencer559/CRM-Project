/* Import-problem cases: turn a programmer export that imported badly into a de-identified,
 * replayable test case (docs/import-cases.md).
 *
 * The workflow this serves: a report fails to import, or imports wrong, and the tech finishes the
 * form by hand anyway. That finished form is the answer the parser should have produced. The Report
 * Generator's "Report import problem" hands the case builder (the PDF or Abbott .log redactor,
 * opened with #case=<id>) the export, the form as the tech left it, and with it the patient's own
 * identifiers: the name, DOB, MRN and serials the form holds. Knowing exactly what the PHI is lets
 * this module remove it wherever it appears (split across text items, in a footer, in a table the
 * label rules never reach) and then check that it is gone (residual()), instead of relying on
 * someone to eyeball every page.
 *
 * Everything is transformed CONSISTENTLY: the text items a parser reads, the parser's output and
 * the form's expected values all go through one scrubber holding one date shift. Replaying the
 * de-identified items through a parser therefore reproduces the de-identified expected values,
 * which is what lets a case become a regression test (tests/import-cases/).
 *
 * No DOM and no pdf.js: the pages feed it text items and form snapshots, and Node (tests,
 * scripts/import-case.js) loads it directly.
 */
(function (global) {
  'use strict';

  var SCHEMA = 1;
  var ITEMS_FORMAT = 'crm-import-items-1';
  var FILL = '\uE000';   // private-use char that stands in for text an earlier detector claimed

  function str(v) { return v == null ? '' : String(v); }
  function clean(s) { return str(s).replace(/\s+/g, ' ').trim(); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function escapeRe(s) { return str(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function maskAlphaNum(v) { return str(v).replace(/[A-Za-z]/g, 'X').replace(/\d/g, '0'); }
  function repeat(ch, n) { return new Array(n + 1).join(ch); }
  function caseLike(sample, word) {
    if (sample === sample.toUpperCase() && sample !== sample.toLowerCase()) return word.toUpperCase();
    if (sample === sample.toLowerCase()) return word.toLowerCase();
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }
  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  /* ============================================================ form fields */

  // Every field a parser can fill (docs/report-import.md, "Field keys used by RESULT").
  var FIELD_KEYS = ['pt-name', 'pt-dob', 'pt-mrn', 'pt-date', 'dev-implant', 'pt-provider', 'mfr', 'dtype',
    'dev-model', 'dev-serial', 'bat-lon-cur', 'bat-lon-unit', 'bat-cc-cur', 'bat-status', 'pct-a', 'pct-v',
    'pct-lv', 'pct-biv', 'p-mode', 'p-lrl', 'p-utr', 'p-usr', 'dyn-av', 'p-sav', 'p-sav-hi', 'p-pav', 'p-pav-hi',
    'p-ms', 'p-msrate', 'lead-ra-imp', 'lead-ra-sens', 'lead-ra-thr', 'lead-ra-pw', 'lead-rv-imp', 'lead-rv-sens',
    'lead-rv-thr', 'lead-rv-pw', 'lead-lv-imp', 'lead-lv-sens', 'lead-lv-thr', 'lead-lv-pw', 'lead-leadless-imp',
    'lead-leadless-sens', 'lead-leadless-thr', 'lead-leadless-pw', 'lead-rv-coil-imp', 'lead-svc-coil-imp',
    'ep-since-date', 'ep-af-burden', 'ep-ahr', 'ep-hvr', 'ep-pmt', 'obs-yn', 'obs-text', 'rp-chg', 'sig-date'];
  var NAME_FIELDS = { 'pt-name': 1 };
  var MASK_FIELDS = { 'pt-mrn': 1, 'dev-serial': 1 };
  var DATE_FIELDS = { 'pt-dob': 1, 'pt-date': 1, 'dev-implant': 1, 'sig-date': 1, 'ep-since-date': 1 };
  // Never taken from the form: a clinician's name, and a box the tech may have typed anything into.
  var NOT_EXPORTED = { 'pt-provider': 'clinician name', 'obs-text': 'free text' };
  // Filled or changed by clinical judgment, not read from the report, so a difference is no bug.
  var JUDGMENT_FIELDS = { 'obs-yn': 1, 'obs-text': 1, 'rp-chg': 1, 'sig-date': 1, 'pt-provider': 1 };
  // The generator's measurement cleaner (CLEAN_FIELDS in CRM_Report_Generator.html) touches these;
  // comparing them as numbers keeps "0.750 V" and "0.75" equal.
  var NUMERIC_FIELD = /^(lead-(ra|rv|lv|leadless)-(imp|sens|thr|pw)|lead-rv-coil-imp|lead-svc-coil-imp|bat-lon-cur|bat-cc-cur|pct-(a|v|lv|biv)|ep-af-burden|ep-(ahr|hvr|pmt)|p-lrl|p-utr|p-usr|p-sav|p-sav-hi|p-pav|p-pav-hi|p-msrate)$/;

  var PARSER_GLOBALS = { 'Medtronic': 'MEDTRONIC', 'Boston Scientific': 'BOSTON', 'Biotronik': 'BIOTRONIK' };
  var MFR_VENDOR = { Medtronic: 'Medtronic', BSci: 'Boston Scientific', BSc: 'Boston Scientific', Biotronik: 'Biotronik', Abbott: 'Abbott / St. Jude' };

  /* ================================================================== dates
     Every date on every page is shifted by one per-case offset instead of being blanked. Blanking
     (the standalone redactor's 01/01/2000) destroys the order a parser relies on to pick the most
     recent episode or the final session; one shared offset keeps order and intervals. The offset
     is a whole number of weeks so weekday names stay true, it is held only in page memory, and it
     is never written to the case. Output keeps each date's own format — separators, zero padding,
     month-name case and length, two- or four-digit year — so vendor anchors still match. */

  var MON3 = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  var MONFULL = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  var MONTH = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(\\.?)(?![A-Za-z])';

  function monthIndex(word) { return MON3.indexOf(str(word).slice(0, 3).toLowerCase()) + 1; }
  function monthWord(m, sample) {
    var s = sample.toLowerCase(), w;
    if (s.length > 3 && s === MONFULL[monthIndex(s) - 1]) w = MONFULL[m - 1];
    else if (s === 'sept' && m === 9) w = 'sept';
    else w = MON3[m - 1];
    return caseLike(sample, w);
  }
  function numLike(sample, n) { return sample.length >= 2 ? pad2(n) : String(n); }
  function yearLike(sample, y) { return sample.length <= 2 ? pad2(y % 100) : String(y); }
  function ordinal(d) { var t = d % 100; if (t >= 11 && t <= 13) return 'th'; return ['th', 'st', 'nd', 'rd'][d % 10] || 'th'; }
  function fullYear(ys, pivot) { var y = +ys; if (ys.length > 2) return y; return y <= pivot ? 2000 + y : 1900 + y; }
  function validYMD(y, m, d) {
    if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1800 && y <= 2200)) return false;
    var t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  }
  function addDays(p, days) {
    var t = new Date(Date.UTC(p.y, p.m - 1, p.d) + days * 86400000);
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
  }

  /* A two-digit year needs the same separator on both sides of the month ("16-Aug-26",
     "16 Aug 26"). Without that, an episode row "12  Aug/10/2026" read as 12 Aug 2010: the episode
     number became the day and the real day became the year. */
  function sameSep(a, b) { return str(a).replace(/[\s,]/g, '') === str(b).replace(/[\s,]/g, ''); }

  /* Each pattern's group 1 is the boundary character in front of the date, so the date itself
     starts at m.index + m[1].length (no lookbehind: older iPad WebKit lacks it). parse() returns
     {y,m,d} or null; format() writes a shifted date back in the matched date's own style. Order
     matters: day-first runs before month-first, or "16 Aug 2026" would be read as "Aug 20, 26". */
  var DATE_PATTERNS = [
    { // 16 Aug 2026 · 16-Aug-26 · 16AUG2026 · 3rd March, 2026
      re: new RegExp('(^|[^\\dA-Za-z])(\\d{1,2})(st|nd|rd|th)?(\\s*[-\\/.]?\\s*)' + MONTH + '(,?\\s*[-\\/.,]?\\s*)(\\d{4}|\\d{2})(?![\\d:]|[-\\/.]\\d)', 'gi'),
      parse: function (m, pv) { return m[8].length === 2 && !sameSep(m[4], m[7]) ? null : { y: fullYear(m[8], pv), m: monthIndex(m[5]), d: +m[2] }; },
      format: function (m, p) { return numLike(m[2], p.d) + (m[3] ? caseLike(m[3], ordinal(p.d)) : '') + m[4] + monthWord(p.m, m[5]) + m[6] + m[7] + yearLike(m[8], p.y); }
    },
    { // Aug/16/2026 · Aug 16, 2026 · August 16th 2026 · Aug-16-26 (needs a separator before the year)
      re: new RegExp('(^|[^A-Za-z])' + MONTH + '(\\s*[-\\/.,]?\\s*)(\\d{1,2})(st|nd|rd|th)?(,\\s*|\\s*[-\\/.]\\s*|\\s+)(\\d{4}|\\d{2})(?![\\d:]|[-\\/.]\\d)', 'gi'),
      parse: function (m, pv) { return m[8].length === 2 && !sameSep(m[4], m[7]) ? null : { y: fullYear(m[8], pv), m: monthIndex(m[2]), d: +m[5] }; },
      format: function (m, p) { return monthWord(p.m, m[2]) + m[3] + m[4] + numLike(m[5], p.d) + (m[6] ? caseLike(m[6], ordinal(p.d)) : '') + m[7] + yearLike(m[8], p.y); }
    },
    { // 2026-08-16 · 2026/8/16
      re: /(^|[^\dA-Za-z])(\d{4})([-\/.])(\d{1,2})\3(\d{1,2})(?!\d|[-\/.]\d)/g,
      parse: function (m) { return { y: +m[2], m: +m[4], d: +m[5] }; },
      format: function (m, p) { return String(p.y) + m[3] + numLike(m[4], p.m) + m[3] + numLike(m[5], p.d); }
    },
    { // 08/16/2026 · 8-16-26 · 16/08/2026 (day-first only when the first number can't be a month)
      re: /(^|[^\dA-Za-z.\/-])(\d{1,2})([-\/.])(\d{1,2})\3(\d{4}|\d{2})(?![\d:]|[-\/.]\d)/g,
      parse: function (m, pv) {
        if (m[3] === '.' && m[5].length !== 4) return null;   // "1.2.60" is more likely a version than a date
        var a = +m[2], b = +m[4], y = fullYear(m[5], pv);
        if (a <= 12) return { y: y, m: a, d: b, dmy: false };
        if (b <= 12) return { y: y, m: b, d: a, dmy: true };
        return null;
      },
      format: function (m, p, parsed) {
        var first = parsed.dmy ? p.d : p.m, second = parsed.dmy ? p.m : p.d;
        return numLike(m[2], first) + m[3] + numLike(m[4], second) + m[3] + yearLike(m[5], p.y);
      }
    },
    { // Aug 2026 · August, 2026 (no day: shifted from mid-month so the month moves with the offset)
      re: new RegExp('(^|[^A-Za-z])' + MONTH + '(\\s*[-\\/.,]?\\s*)(\\d{4})(?![\\d:]|[-\\/.]\\d)', 'gi'),
      parse: function (m) { return { y: +m[5], m: monthIndex(m[2]), d: 15 }; },
      format: function (m, p) { return monthWord(p.m, m[2]) + m[3] + m[4] + String(p.y); }
    },
    { // 08/2026
      re: /(^|[^\d.\/-])(0?[1-9]|1[0-2])(\/)((?:19|20)\d{2})(?![\d\/])/g,
      parse: function (m) { return { y: +m[4], m: +m[2], d: 15 }; },
      format: function (m, p) { return numLike(m[2], p.m) + m[3] + String(p.y); }
    },
    { // 08/16 14:35 (a yearless episode stamp; only next to a time, where it can't be a ratio)
      re: /(^|[^\d.\/-])(\d{1,2})(\/)(\d{1,2})(?=\s+\d{1,2}:\d{2})/g,
      parse: function (m) { return { y: 2000, m: +m[2], d: +m[4] }; },
      format: function (m, p) { return numLike(m[2], p.m) + m[3] + numLike(m[4], p.d); }
    },
    { // Aug 16 14:35
      re: new RegExp('(^|[^A-Za-z])' + MONTH + '(\\s+)(\\d{1,2})(?=\\s+\\d{1,2}:\\d{2})', 'gi'),
      parse: function (m) { return { y: 2000, m: monthIndex(m[2]), d: +m[5] }; },
      format: function (m, p) { return monthWord(p.m, m[2]) + m[3] + m[4] + numLike(m[5], p.d); }
    }
  ];

  function defaultPivot() { return new Date().getFullYear() % 100; }

  // Visit every date in `text` (skipping claimed regions) and hand its span and parse to `each`.
  function scanDates(work, pivot, each) {
    DATE_PATTERNS.forEach(function (p) {
      p.re.lastIndex = 0;
      var m;
      while ((m = p.re.exec(work))) {
        var start = m.index + m[1].length, core = m[0].slice(m[1].length);
        // A number that is the tail of a clock time or a decimal ("00:12:30", "1.30") never starts
        // a date: "00:12:30   Aug 16 14:40" is a duration and then Aug 16, not 30 Aug 2016.
        var lead = /^\d/.test(core) && /\d[:.]$/.test(work.slice(Math.max(0, start - 2), start));
        var parsed = lead ? null : p.parse(m, pivot);
        if (parsed && validYMD(parsed.y, parsed.m, parsed.d)) {
          var claimed = each(start, start + core.length, parsed, p, m);
          if (claimed) work = claimed;
        }
        if (!m[0].length) p.re.lastIndex++;
      }
    });
    return work;
  }

  /* The first date in a string, as yyyy-mm-dd (or ''). Used to compare values and to recognize a
     known date however the report prints it. */
  function toISODate(v, pivot) {
    var found = null;
    scanDates(str(v), pivot == null ? defaultPivot() : pivot, function (s, e, p) {
      if (!found || s < found.s) found = { s: s, p: p };
      return null;
    });
    return found ? found.p.y + '-' + pad2(found.p.m) + '-' + pad2(found.p.d) : '';
  }

  // A shift in whole weeks, one to three years back.
  function randomShiftDays() {
    var weeks = 52 + Math.floor(Math.random() * 105);
    return -7 * weeks;
  }

  // Seven random base-36 characters. Names the bundle and the fixture folder; carries no date.
  function newCaseId() {
    var id = '', b = null;
    try { b = new Uint8Array(7); global.crypto.getRandomValues(b); } catch (e) { b = null; }
    for (var i = 0; i < 7; i++) id += ((b ? b[i] : Math.floor(Math.random() * 256)) % 36).toString(36);
    return id;
  }

  /* ================================================================== names */

  var TITLE = /^(?:dr|md|do|np|pa|pac|rn|mr|mrs|ms|miss|mx|jr|sr|ii|iii|iv|phd|facc|fhrs|cepc|cces)$/i;
  // Words vendor reports print as labels or values (plus months and weekdays). A patient named one
  // of these ("Page", "Day", "Ring", "May") is only replaced next to another part of their name:
  // replacing "Page" everywhere would rewrite "Page 3 of 20" and break the anchors being tested.
  var COMMON_WORDS = {};
  ('patient name first last full surname birth date dob device lead leads mode modes rate rates lower upper ' +
   'tracking sensor pace paced pacing sense sensed sensing amplitude impedance threshold thresholds pulse width capture ' +
   'test tests result results battery voltage longevity charge time times episode episodes event events therapy ' +
   'therapies shock shocks detection zone zones histogram histograms trend trends summary report reports session ' +
   'final initial parameter parameters programmed program programming settings setting brady tachy normal temporary ' +
   'permanent auto automatic manual on off yes no none not measured available unknown total max min mean average ' +
   'since reset cleared serial model number implant implanted implantation manufacturer position polarity bipolar ' +
   'unipolar tip ring coil can atrial atrium ventricle ventricular right left status page of notes note comments ' +
   'comment observations observation alert alerts clinician physician provider doctor clinic hospital follow up ' +
   'interrogation interrogated printed print and or the in at for with from to high low long short burden count ' +
   'counts counter counters percent heart failure sinus rhythm delay dynamic fixed hysteresis rest sleep activity ' +
   'day night week month year days hours minutes seconds quick look remote monitoring home transmission diagnostics ' +
   'data counter safety margin mri conditional sure scan active passive fast slow rapid rise ' +
   'january february march april may june july august september october november december ' +
   'jan feb mar apr jun jul aug sep sept oct nov dec monday tuesday wednesday thursday friday saturday sunday')
    .split(' ').forEach(function (w) { if (w) COMMON_WORDS[w] = 1; });
  // Company words: a "Word, Word" pair made of these is vendor furniture, not a patient.
  var VENDOR_WORDS = {};
  'medtronic boston scientific abbott biotronik jude st inc corporation corp llc ltd gmbh co kg ag se sa plc medical'
    .split(' ').forEach(function (w) { VENDOR_WORDS[w] = 1; });

  var PSEUDO = { family: 'DOE', given: 'TEST', middle: 'SAMPLE', provider: 'PROVIDER' };
  var PSEUDO_ALT = { family: 'ROE', given: 'CASE', middle: 'EXAMPLE', provider: 'CLINICIAN' };
  var PSEUDO_SET = { DOE: 1, ROE: 1, TEST: 1, CASE: 1, SAMPLE: 1, EXAMPLE: 1, PROVIDER: 1, CLINICIAN: 1, PATIENT: 1, REDACTED: 1 };

  function nameWords(s) { return (str(s).match(/[A-Za-z][A-Za-z'\u2019-]*/g) || []).filter(function (w) { return !TITLE.test(w.replace(/\./g, '')); }); }

  // "SMITH, JOHN Q" / "John Q Smith" -> roles. Hyphenated names also contribute their parts.
  function nameRoles(raw, provider) {
    var s = clean(raw), out = [];
    if (!s) return out;
    function add(words, role) {
      words.forEach(function (w) {
        out.push({ word: w, role: role });
        if (w.indexOf('-') > 0) w.split('-').forEach(function (part) { if (part) out.push({ word: part, role: role }); });
      });
    }
    if (provider) { add(nameWords(s), 'provider'); return out; }
    if (s.indexOf(',') >= 0) {
      var parts = s.split(','), rest = nameWords(parts.slice(1).join(' '));
      add(nameWords(parts[0]), 'family'); add(rest.slice(0, 1), 'given'); add(rest.slice(1), 'middle');
    } else {
      var w = nameWords(s);
      if (w.length === 1) add(w, 'family');
      else { add(w.slice(0, 1), 'given'); add(w.slice(-1), 'family'); add(w.slice(1, -1), 'middle'); }
    }
    return out;
  }

  /* A name value that still carries a word that is not a pseudonym, title or label word is
     replaced whole, in the shape of the original. This catches a middle name the form didn't have. */
  var NAME_LABEL_WORDS = { patient: 1, name: 1, first: 1, last: 1, full: 1, surname: 1, physician: 1, provider: 1, doctor: 1, referring: 1, ordering: 1 };
  function nameShape(text) {
    if (text.indexOf(',') >= 0) return 'DOE, TEST';
    if (text.indexOf('/') >= 0) return 'TEST/PATIENT';
    if (text.indexOf(';') >= 0) return 'DOE; TEST';
    return /\s/.test(clean(text)) ? 'TEST PATIENT' : 'TEST';
  }
  // knownWords: the patient's own name words. One of those is never accepted as a pseudonym, even
  // when the patient's real surname happens to be "Case" or "Test".
  function nameLeftovers(text, knownWords) {
    return (str(text).match(/[A-Za-z][A-Za-z'\u2019-]+/g) || []).filter(function (w) {
      var u = w.toUpperCase().replace(/\u2019/g, "'");
      if (knownWords && knownWords[u]) return true;
      return !PSEUDO_SET[u] && !TITLE.test(w.replace(/\./g, '')) && !NAME_LABEL_WORDS[w.toLowerCase()];
    });
  }
  function nameGuard(text, knownWords) {
    text = str(text);
    if (!clean(text)) return text;
    return nameLeftovers(text, knownWords).length ? nameShape(text) : text;
  }

  /* ================================================================ known identifiers */

  function fieldV(result, key) { var f = result && result[key]; return f && f.v != null ? str(f.v) : ''; }

  /* What the case builder knows is PHI: the form the tech left (what they confirmed), the parser's
     own read of the export (what the report prints), and any names the host adds (the Schedule's
     patient label). Raw strings; createScrubber() expands them into matchers. */
  function knownFromSources(src) {
    src = src || {};
    var snap = src.snapshot || {}, result = src.result || {}, k = { names: [], providers: [], serials: [], ids: [], dates: [] };
    function push(list, v) { v = clean(v); if (v && list.indexOf(v) < 0) list.push(v); }
    push(k.names, snapValue(snap, 'pt-name')); push(k.names, fieldV(result, 'pt-name'));
    (src.extraNames || []).forEach(function (n) { push(k.names, n); });
    push(k.providers, snapValue(snap, 'pt-provider')); push(k.providers, fieldV(result, 'pt-provider'));
    push(k.serials, snapValue(snap, 'dev-serial')); push(k.serials, fieldV(result, 'dev-serial'));
    push(k.ids, snapValue(snap, 'pt-mrn')); push(k.ids, fieldV(result, 'pt-mrn'));
    ['pt-dob', 'pt-date', 'dev-implant'].forEach(function (key) { push(k.dates, snapValue(snap, key)); push(k.dates, fieldV(result, key)); });
    (Array.isArray(snap.__leadinfo) ? snap.__leadinfo : []).concat(src.leads || []).forEach(function (L) {
      if (!L) return;
      push(k.serials, L.serial); push(k.dates, L.date);
    });
    return k;
  }

  /* ================================================================ the scrubber */

  /* Detectors never see text an earlier one claimed (it is overwritten with FILL, keeping every
     offset valid), so two rules can't both rewrite the same characters. */
  function EditSet(text) { this.text = str(text); this.work = this.text; this.edits = []; }
  EditSet.prototype.claim = function (start, end, text, kind) {
    for (var i = 0; i < this.edits.length; i++) { var e = this.edits[i]; if (start < e.end && end > e.start) return false; }
    this.edits.push({ start: start, end: end, text: text, kind: kind });
    this.work = this.work.slice(0, start) + repeat(FILL, end - start) + this.work.slice(end);
    return true;
  };
  EditSet.prototype.apply = function () {
    var s = this.text;
    this.edits.slice().sort(function (a, b) { return b.start - a.start; }).forEach(function (e) {
      s = s.slice(0, e.start) + e.text + s.slice(e.end);
    });
    return s;
  };

  // A token as a regex that tolerates a separator between its characters: a serial printed
  // "PJN 123456" or "PJN-123456" is the same identifier as "PJN123456".
  function flexibleToken(t) {
    return t.replace(/[^A-Za-z0-9]/g, '').split('').map(escapeRe).join('[-\\s]?');
  }

  function createScrubber(opts) {
    opts = opts || {};
    var known = opts.known || {}, days = opts.shiftDays == null ? randomShiftDays() : opts.shiftDays;
    var pivot = opts.pivot == null ? defaultPivot() : opts.pivot;
    var custom = [];

    /* ---- names ---- */
    var roleOf = {};   // UPPER word (curly apostrophe folded) -> role; first wins, patient before provider
    function addRole(r) { var u = r.word.toUpperCase().replace(/\u2019/g, "'"); if (!roleOf[u]) roleOf[u] = r.role; }
    (known.names || []).forEach(function (n) { nameRoles(n, false).forEach(addRole); });
    (known.providers || []).forEach(function (n) { nameRoles(n, true).forEach(addRole); });
    var globalWords = [], contextWords = [];
    Object.keys(roleOf).forEach(function (u) {
      var plain = u.replace(/['-]/g, '');
      if (plain.length < 2) return;
      if (plain.length === 2 || COMMON_WORDS[u.toLowerCase()]) contextWords.push(u); else globalWords.push(u);
    });
    function wordPattern(u) { return escapeRe(u).replace(/'|\u2019/g, "['\u2019]"); }
    function wordsRe(list) {
      if (!list.length) return null;
      list = list.slice().sort(function (a, b) { return b.length - a.length; });
      return new RegExp('(^|[^A-Za-z])(' + list.map(wordPattern).join('|') + ')(?![A-Za-z])', 'gi');
    }
    var globalRe = wordsRe(globalWords), contextRe = wordsRe(contextWords);
    // Two name words side by side, separated by at most a comma and a space.
    function pairOf(list) {
      if (!list.length) return null;
      var alt = list.slice().sort(function (a, b) { return b.length - a.length; }).map(wordPattern).join('|');
      return new RegExp('(^|[^A-Za-z])(' + alt + ')([\\s,.;]{1,3})(' + alt + ')(?![A-Za-z])', 'gi');
    }
    var contextPairRe = pairOf(contextWords);
    function pseudonymFor(matched) {
      var role = roleOf[matched.toUpperCase().replace(/\u2019/g, "'")] || 'family';
      var word = PSEUDO[role];
      if (roleOf[word]) word = PSEUDO_ALT[role];        // a patient actually named Doe or Test
      if (roleOf[word]) word = 'REDACTED';
      return caseLike(matched, word);
    }

    /* ---- serials and IDs ---- */
    /* Too short to match safely is skipped: a four-digit MRN would also rewrite "1234 ms". The
       label rules (MRN, ID, Serial) still cover those, and nothing already masked is re-matched. */
    function idTokens(list) {
      var out = [];
      (list || []).forEach(function (v) {
        var compact = clean(v).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
        var min = /^\d+$/.test(compact) ? 5 : 4;
        if (compact.length < min || !/\d/.test(compact) || /^[X0]+$/.test(compact)) return;
        if (out.indexOf(compact) < 0) out.push(compact);
      });
      return out.sort(function (a, b) { return b.length - a.length; });
    }
    var serialTokens = idTokens(known.serials), idTokenList = idTokens(known.ids);
    function idRe(tokens) {
      if (!tokens.length) return null;
      return new RegExp('(^|[^A-Za-z0-9])(' + tokens.map(flexibleToken).join('|') + ')(?![A-Za-z0-9])', 'gi');
    }
    var serialRe = idRe(serialTokens), idsRe = idRe(idTokenList);

    /* Each distinct serial or ID gets its own stable pseudonym of the same shape: letters become
       X and the digits carry a per-case counter (PJN1234567 -> XXX0000001, PJN7654321 ->
       XXX0000002). Masking every one to XXX0000000 made two leads identical, and the Medtronic
       inventory de-duplicates by serial, so the RV lead vanished from the replayed case. */
    var pseudoIds = {}, pseudoCount = { serial: 0, id: 0 };
    function pseudoFor(text, kind) {
      var key = kind + ':' + str(text).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      if (!pseudoIds[key]) pseudoIds[key] = ++pseudoCount[kind];
      var n = String(pseudoIds[key]), count = (str(text).match(/\d/g) || []).length;
      var digits = (repeat('0', count) + n).slice(-Math.max(count, 1)), di = 0;
      return str(text).replace(/[A-Za-z0-9]/g, function (c) { return /\d/.test(c) ? digits.charAt(di++) : 'X'; });
    }
    serialTokens.forEach(function (t) { pseudoFor(t, 'serial'); });   // numbered in known-list order
    idTokenList.forEach(function (t) { pseudoFor(t, 'id'); });

    /* ---- known dates (for residual()) ---- */
    var knownDates = [];
    (known.dates || []).forEach(function (v) {
      var iso = toISODate(v, pivot);
      if (iso && knownDates.indexOf(iso) < 0) knownDates.push(iso);
    });

    function regexClaims(es, re, kind, replace) {
      if (!re) return;
      re.lastIndex = 0;
      var m;
      while ((m = re.exec(es.work))) {
        var start = m.index + m[1].length, word = m[2];
        es.claim(start, start + word.length, replace(word), kind);
        if (!m[0].length) re.lastIndex++;
      }
    }

    function detectAll(es) {
      // user decisions from the review list come first: they are exact strings
      custom.forEach(function (c) {
        var re = new RegExp('(^|[^A-Za-z0-9])(' + escapeRe(c).replace(/\s+/g, '\\s+') + ')(?![A-Za-z0-9])', 'gi');
        regexClaims(es, re, 'custom', maskAlphaNum);
      });
      regexClaims(es, serialRe, 'serial', function (w) { return pseudoFor(w, 'serial'); });
      regexClaims(es, idsRe, 'id', function (w) { return pseudoFor(w, 'id'); });
      // dates before names: a first name "June" must not eat the month of "June 5, 2026"
      scanDates(es.work, pivot, function (start, end, parsed, p, m) {
        return es.claim(start, end, p.format(m, addDays(parsed, days), parsed), 'date') ? es.work : null;
      });
      regexClaims(es, globalRe, 'name', pseudonymFor);
      // two context words side by side are a name on their own ("MAY DAY"), with no edit to anchor them
      if (contextPairRe) {
        contextPairRe.lastIndex = 0;
        var pm;
        while ((pm = contextPairRe.exec(es.work))) {
          var s1 = pm.index + pm[1].length, e1 = s1 + pm[2].length, s2 = e1 + pm[3].length, e2 = s2 + pm[4].length;
          es.claim(s1, e1, pseudonymFor(pm[2]), 'name');
          es.claim(s2, e2, pseudonymFor(pm[4]), 'name');
        }
      }
      // context words: only right beside a name edit ("PAGE, TEST" after SMITH -> DOE, etc.)
      if (contextRe) {
        var grew = true;
        while (grew) {
          grew = false;
          contextRe.lastIndex = 0;
          var m;
          while ((m = contextRe.exec(es.work))) {
            var s = m.index + m[1].length, e = s + m[2].length;
            var near = es.edits.some(function (ed) {
              if (ed.kind !== 'name') return false;
              var gap = ed.end <= s ? es.text.slice(ed.end, s) : (ed.start >= e ? es.text.slice(e, ed.start) : null);
              return gap != null && /^[\s,.;\/]{0,3}$/.test(gap);
            });
            if (near && es.claim(s, e, pseudonymFor(m[2]), 'name')) grew = true;
            if (!m[0].length) contextRe.lastIndex++;
          }
        }
      }
    }

    function scrubText(text) {
      var es = new EditSet(text);
      detectAll(es);
      var hits = {};
      es.edits.forEach(function (e) { hits[e.kind] = (hits[e.kind] || 0) + 1; });
      return { text: es.apply(), hits: hits, edits: es.edits };
    }

    /* Items -> lines exactly as Engine.normalize groups them (page, then y within 3pt of the line's
       first item, then x), joined into one string per line. Adjacent fragments with no visible gap
       are joined without a space, so a name Biotronik draws as "S" + "MITH" is still "SMITH"; a
       bold header drawn twice at the same x is NOT a fragment (its gap is minus its width). */
    function lines(items) {
      var byPage = {}, out = [];
      items.forEach(function (it, i) {
        if (!clean(it.str)) return;
        (byPage[it.page] = byPage[it.page] || []).push({ i: i, it: it });
      });
      Object.keys(byPage).map(Number).sort(function (a, b) { return a - b; }).forEach(function (pg) {
        var arr = byPage[pg].slice().sort(function (a, b) { return b.it.y - a.it.y; }), cur = null;
        arr.forEach(function (e) {
          if (!cur || Math.abs(e.it.y - cur.y) > 3) { cur = { page: pg, y: e.it.y, members: [e] }; out.push(cur); }
          else cur.members.push(e);
        });
      });
      out.forEach(function (l) {
        l.members.sort(function (a, b) { return a.it.x - b.it.x; });
        var text = '', map = [];
        l.members.forEach(function (e, k) {
          if (k) {
            var prev = l.members[k - 1].it, gap = e.it.x - (prev.x + (+prev.w || 0));
            var h = +e.it.h || +prev.h || 10;
            var tight = +prev.w > 0 && gap > -1 && gap < Math.max(0.6, 0.12 * h);
            if (!tight) text += ' ';
          }
          map.push({ i: e.i, start: text.length, end: text.length + str(e.it.str).length });
          text += str(e.it.str);
        });
        l.text = text; l.map = map;
      });
      return out;
    }

    /* Spread a line's edits back over its items. A replacement as long as what it replaces (a
       shifted date, a masked serial) is split character for character, so a date drawn as
       "01/02/" + "1950" stays two tokens and the parser sees the same token boundaries. Otherwise
       (a name becomes "DOE") it all goes into the first item and the others lose their share. */
    function distribute(line, edits, out, changed) {
      var cuts = {};
      edits.forEach(function (e) {
        var first = true, aligned = e.text.length === e.end - e.start;
        line.map.forEach(function (seg) {
          if (e.end <= seg.start || e.start >= seg.end) return;
          var a = Math.max(e.start, seg.start), b = Math.min(e.end, seg.end);
          var text = aligned ? e.text.slice(a - e.start, b - e.start) : (first ? e.text : '');
          (cuts[seg.i] = cuts[seg.i] || []).push({ from: a - seg.start, to: b - seg.start, text: text, kind: e.kind });
          first = false;
        });
      });
      Object.keys(cuts).forEach(function (i) {
        var s = str(out[i].str);
        cuts[i].sort(function (a, b) { return b.from - a.from; }).forEach(function (c) { s = s.slice(0, c.from) + c.text + s.slice(c.to); });
        if (s === out[i].str) return;
        out[i].str = s;
        var kinds = changed[i] || (changed[i] = []);
        cuts[i].forEach(function (c) { if (kinds.indexOf(c.kind) < 0) kinds.push(c.kind); });
      });
    }

    /* items: [{page,x,y,w,str,h?}] (Engine coordinates). Returns copies with de-identified text,
       plus which items changed and why. Items whose text is emptied stay in place (str '') so
       indexes keep lining up with the page geometry; exportItems() drops them. */
    function scrubItems(items) {
      var out = items.map(function (it) { var c = {}; for (var k in it) if (own(it, k)) c[k] = it[k]; c.str = str(it.str); return c; });
      var changed = {}, hits = {};
      lines(items).forEach(function (line) {
        var es = new EditSet(line.text);
        detectAll(es);
        if (!es.edits.length) return;
        es.edits.forEach(function (e) { hits[e.kind] = (hits[e.kind] || 0) + 1; });
        distribute(line, es.edits, out, changed);
      });
      out.forEach(function (it, i) {
        var g = biotronikHeaderGuard(it.str, roleOf);
        if (g !== it.str) { it.str = g; (changed[i] = changed[i] || []).push('name'); hits.name = (hits.name || 0) + 1; }
      });
      return { items: out, changed: changed, hits: hits };
    }

    /* ---- residual: is any known identifier still present? ---- */
    var residualWordRe = wordsRe(globalWords.filter(function (u) { return u.replace(/['\u2019-]/g, '').length >= 3; }));
    // Context words are only residue as part of a pair: "Page 3" is not the patient.
    var pairRe = contextWords.length ? pairOf(globalWords.concat(contextWords)) : null;
    var dateVariants = [];
    knownDates.forEach(function (iso) {
      var y = +iso.slice(0, 4), mo = +iso.slice(5, 7), d = +iso.slice(8, 10);
      var M = [pad2(mo), String(mo)], D = [pad2(d), String(d)], Y = [String(y), pad2(y % 100)];
      var mon = [MON3[mo - 1], MONFULL[mo - 1]];
      ['/', '-', '.'].forEach(function (sep) {
        M.forEach(function (a) { D.forEach(function (b) { Y.forEach(function (c) { dateVariants.push(a + sep + b + sep + c, b + sep + a + sep + c); }); }); });
        dateVariants.push(y + sep + pad2(mo) + sep + pad2(d), y + sep + mo + sep + d);
      });
      dateVariants.push(y + pad2(mo) + pad2(d), pad2(mo) + pad2(d) + y, pad2(d) + pad2(mo) + y);
      mon.forEach(function (mn) {
        D.forEach(function (b) {
          dateVariants.push(mn + ' ' + b + ', ' + y, mn + ' ' + b + ' ' + y, mn + '/' + b + '/' + y, mn + '-' + b + '-' + y,
            b + ' ' + mn + ' ' + y, b + '-' + mn + '-' + y, b + mn + y, b + '-' + mn + '-' + pad2(y % 100));
        });
      });
    });
    dateVariants = dateVariants.map(function (v) { return v.toLowerCase(); }).filter(function (v, i, a) { return a.indexOf(v) === i; });

    function residualText(text) {
      text = str(text);
      var found = [];
      function run(re, kind, pick) {
        if (!re) return;
        re.lastIndex = 0;
        var m;
        while ((m = re.exec(text))) {
          found.push({ kind: kind, start: m.index + m[1].length, end: m.index + m[0].length, match: pick ? pick(m) : m[2] });
          if (!m[0].length) re.lastIndex++;
        }
      }
      run(serialRe, 'serial'); run(idsRe, 'id'); run(residualWordRe, 'name');
      run(pairRe, 'name', function (m) { return m[0].slice(m[1].length); });
      var low = text.toLowerCase();
      dateVariants.forEach(function (v) {
        var at = low.indexOf(v);
        while (at >= 0) {
          var before = low.charAt(at - 1), after = low.charAt(at + v.length);
          if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) found.push({ kind: 'date', start: at, end: at + v.length, match: text.slice(at, at + v.length) });
          at = low.indexOf(v, at + 1);
        }
      });
      return found;
    }

    // Residual hits per output line, with the item indexes they touch (so a page can box them).
    function residualItems(items) {
      var hits = [];
      lines(items).forEach(function (line) {
        residualText(line.text).forEach(function (h) {
          var touched = line.map.filter(function (seg) { return h.start < seg.end && h.end > seg.start; }).map(function (seg) { return seg.i; });
          hits.push({ page: line.page, kind: h.kind, match: h.match, items: touched });
        });
      });
      return hits;
    }

    /* ---- values (form fields, parser output) ---- */
    function deidentifyValue(key, v) {
      v = str(v);
      if (!v) return v;
      var r = scrubText(v), out = r.text;
      if (NAME_FIELDS[key]) out = nameGuard(out, roleOf);
      if (MASK_FIELDS[key] && !looksPseudo(out)) out = maskAlphaNum(out);
      // a date field the shifter could not read is dropped rather than exported as-is
      if (DATE_FIELDS[key] && !r.edits.some(function (e) { return e.kind === 'date'; })) out = clean(out) ? '[date]' : out;
      return out;
    }
    // Output of a parser run on already de-identified items: the dates are shifted already, so
    // only the idempotent guards run.
    function guardValue(key, v) {
      v = str(v);
      if (NAME_FIELDS[key]) v = nameGuard(v, roleOf);
      if (MASK_FIELDS[key] && !looksPseudo(v)) v = maskAlphaNum(v);
      return v;
    }

    // Every string anywhere in a JSON-able value (the manifest, notes included) checked at once.
    function residualObject(value) {
      var hits = [];
      (function walk(v, path) {
        if (v == null) return;
        if (typeof v === 'string') { residualText(v).forEach(function (h) { hits.push({ path: path, kind: h.kind, match: h.match }); }); return; }
        if (typeof v !== 'object') return;
        Object.keys(v).forEach(function (k) { walk(v[k], path ? path + '.' + k : k); });
      })(value, '');
      return hits;
    }

    return {
      scrubText: scrubText,
      scrubItems: scrubItems,
      residualObject: residualObject,
      lines: lines,
      residualText: residualText,
      residualItems: residualItems,
      deidentifyValue: deidentifyValue,
      guardValue: guardValue,
      addCustom: function (s) { s = clean(s); if (s && custom.indexOf(s) < 0) custom.push(s); },
      custom: function () { return custom.slice(); },
      nameWords: function () { return globalWords.slice(); },
      loneWords: function () { return contextWords.slice(); },
      nameGuard: function (t) { return nameGuard(t, roleOf); },
      pseudonym: pseudoFor,
      counts: function () {
        return { names: globalWords.length + contextWords.length, serials: serialTokens.length, ids: idTokenList.length, dates: knownDates.length };
      },
      hasKnown: function () { return !!(globalWords.length || contextWords.length || serialTokens.length || idTokenList.length || knownDates.length); }
    };
  }

  /* Biotronik's standard layout prints "PDF: BIOTRONIK - <model> - <serial> - <Last, First> - p/N"
     as one text item. The parser reads model and serial from it, so it is repaired segment by
     segment rather than replaced whole; the name and serial segments must end up synthetic. */
  function biotronikHeaderGuard(text, knownWords) {
    var s = str(text);
    if (!/BIOTRONIK\s*-/i.test(s)) return s;
    var seg = s.split(/\s+-\s+/);
    if (seg.length < 5 || !/^\d+\s*\/\s*\d+$/.test(clean(seg[seg.length - 1]))) return s;
    var name = seg.length - 2, serial = seg.length - 3;
    if (nameLeftovers(seg[name], knownWords).length) seg[name] = nameShape(seg[name]);
    if (/\d/.test(seg[serial]) && !/^[X0\s-]+$/i.test(seg[serial]) && serial > 1) seg[serial] = maskAlphaNum(seg[serial]);
    var out = seg.join(' - ');
    return out === s.replace(/\s+-\s+/g, ' - ') ? s : out;
  }

  // A pseudonym from pseudoFor() or a plain mask: only X for letters, and digits that are zeros
  // with at most a short counter at the end. A real serial has other letters or more digits.
  function looksPseudo(v) {
    var c = str(v).replace(/[^A-Za-z0-9]/g, '');
    if (!/^[X0-9]+$/.test(c) || !/^0*\d{0,3}$/.test(c.replace(/X/g, ''))) return false;
    // a pure-number pseudonym only ever comes from a 5+ digit ID, and starts with its zero padding
    return /X/.test(c) ? c.length >= 4 : (c.length >= 5 && c.charAt(0) === '0');
  }

  /* ============================================================= review list
     What the known-identifier pass can't vouch for: strings shaped like a person, a clinician, an
     account number or a serial that no rule replaced. Distinct strings, so the reviewer makes one
     decision per string (keep or redact everywhere) instead of reading every page. */
  var SUSPECT_RULES = [
    { kind: 'name', re: /(^|[^A-Za-z])([A-Z][A-Za-z'\u2019-]+,\s*[A-Z][A-Za-z'\u2019-]+)(?![A-Za-z])/g,
      keep: function (t) {
        var w = t.split(/,\s*/);
        var vendor = w.some(function (x) { return VENDOR_WORDS[x.toLowerCase()]; });
        var synthetic = w.every(function (x) { return PSEUDO_SET[x.toUpperCase()]; });
        var common = w.every(function (x) { return COMMON_WORDS[x.toLowerCase()]; });
        return vendor || synthetic || common;
      } },
    { kind: 'clinician', re: /(^|[^A-Za-z])(Dr\.?\s+[A-Z][A-Za-z'\u2019-]+(?: [A-Z][A-Za-z'\u2019-]+)?)/g,
      keep: function (t) { return nameLeftovers(t.split(' ').filter(function (w) { return !VENDOR_WORDS[w.toLowerCase()]; }).join(' ')).length === 0; } },
    { kind: 'number', re: /(^|[^\dA-Za-z.,:\/-])(\d{7,})(?![\dA-Za-z.,:\/-])/g, keep: function (t) { return /^0+$/.test(t) || looksPseudo(t); } },
    { kind: 'serial', re: /(^|[^A-Za-z0-9])([A-Z]{2,4}\d{5,}[A-Z]?)(?![A-Za-z0-9])/g, keep: looksPseudo },
    { kind: 'email', re: /(^|[^A-Za-z0-9._%+-])([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, keep: function (t) { return /example\.invalid$/i.test(t); } },
    { kind: 'phone', re: /(^|[^\d])((?:\(\d{3}\)\s*|\d{3}[\s.-])\d{3}[\s.-]\d{4})(?!\d)/g, keep: function (t) { return !/[1-9]/.test(t); } }
  ];

  /* lines: [{ page, text }]. decided: { string: 'keep'|'redact' }. Two lists from the scrubber
     (scrubber.nameWords() / .loneWords()) catch what no whole-word rule replaces:
       nameWords: the patient's longer name words, buried in a longer token ("jheartwell", a login
         printed in a footer);
       loneWords: the patient's name words that are also report words ("Page", "Day", "Long"),
         standing alone, which the scrubber only replaces next to the rest of the name. */
  function suspects(lineList, decided, nameWords, loneWords) {
    decided = decided || {};
    var byText = {}, out = [], rules = SUSPECT_RULES;
    var words = (nameWords || []).filter(function (w) { return w.replace(/[^A-Za-z]/g, '').length >= 4; });
    if (words.length) {
      rules = rules.concat([{ kind: 'name', re: new RegExp('(^|[^A-Za-z0-9._@-])([A-Za-z0-9._@-]*(?:' + words.map(escapeRe).join('|') + ')[A-Za-z0-9._@-]*)', 'gi'),
        keep: function (t) { return words.some(function (w) { return t.toUpperCase() === w.toUpperCase(); }); } }]);
    }
    if (loneWords && loneWords.length) {
      rules = rules.concat([{ kind: 'name', re: new RegExp('(^|[^A-Za-z])(' + loneWords.map(escapeRe).join('|') + ')(?![A-Za-z])', 'gi'),
        keep: function () { return false; } }]);
    }
    lineList.forEach(function (l) {
      rules.forEach(function (rule) {
        rule.re.lastIndex = 0;
        var m;
        while ((m = rule.re.exec(l.text))) {
          var t = clean(m[2]);
          if (!rule.keep(t) && !own(decided, t)) {
            var c = byText[t];
            if (!c) { c = byText[t] = { text: t, kind: rule.kind, count: 0, pages: [] }; out.push(c); }
            c.count++;
            if (c.pages.indexOf(l.page) < 0) c.pages.push(l.page);
          }
          if (!m[0].length) rule.re.lastIndex++;
        }
      });
    });
    return out;
  }

  /* ================================================================ expected values */

  function snapValue(snap, key) {
    if (!snap) return '';
    if (own(snap, 'r:' + key)) return str(snap['r:' + key]);
    if (own(snap, key)) return str(snap[key]);
    if (own(snap, 'n:' + key)) return str(snap['n:' + key]);
    return '';
  }
  function snapChecked(snap, name) {
    var prefix = 'cx:' + name + ':';
    return Object.keys(snap || {}).filter(function (k) { return k.indexOf(prefix) === 0 && snap[k] === true; })
      .map(function (k) { return k.slice(prefix.length); });
  }

  /* The form as the tech left it (collectFormData() in the Report Generator), reduced to what a
     parser could have produced. Raw: still PHI until deidentifyExpected(). */
  function expectedFromSnapshot(snap, extraKeys) {
    var fields = {};
    FIELD_KEYS.concat(extraKeys || []).forEach(function (k) { if (!own(fields, k)) fields[k] = snapValue(snap, k); });
    var leads = (snap && Array.isArray(snap.__leadinfo) ? snap.__leadinfo : []).map(function (L) {
      return { location: str(L.location), manufacturer: str(L.manufacturer), model: str(L.model), serial: str(L.serial), date: str(L.date) };
    });
    var episodes = [], n = +(snap && snap.__ep) || 0;
    for (var i = 1; i <= n; i++) {
      var e = { dt: snapValue(snap, 'ep' + i + '-dt'), dur: snapValue(snap, 'ep' + i + '-dur'), rate: snapValue(snap, 'ep' + i + '-rate'),
        types: snapChecked(snap, 'ep' + i + '-type'), flags: snapChecked(snap, 'ep' + i + '-flag') };
      if (e.dt || e.dur || e.rate || e.types.length) episodes.push(e);
    }
    return { fields: fields, leads: leads, episodes: episodes };
  }

  function deidentifyLeads(leads, scrub, guard) {
    return (leads || []).map(function (L) {
      var f = guard ? function (v) { return str(v); } : function (v) { return scrub.scrubText(v).text; };
      return { location: f(L.location), manufacturer: f(L.manufacturer), model: f(L.model),
        serial: looksPseudo(f(L.serial)) ? f(L.serial) : maskAlphaNum(f(L.serial)), date: f(L.date) };
    });
  }

  function deidentifyExpected(expected, scrub) {
    var fields = {}, omitted = [];
    Object.keys(expected.fields || {}).forEach(function (k) {
      if (NOT_EXPORTED[k]) { if (expected.fields[k]) omitted.push(k); return; }
      fields[k] = scrub.deidentifyValue(k, expected.fields[k]);
    });
    return {
      fields: fields,
      omitted: omitted,
      leads: deidentifyLeads(expected.leads, scrub, false),
      episodes: (expected.episodes || []).map(function (e) {
        return { dt: scrub.scrubText(e.dt).text, dur: str(e.dur), rate: str(e.rate), types: (e.types || []).slice(), flags: (e.flags || []).slice() };
      })
    };
  }

  /* A parser bundle ({RESULT, LEADS, EPISODES, ROUTE}) reduced to plain de-identified data.
     mode 'original': the parse of the untouched export, fully de-identified here.
     mode 'redacted': the parse of already de-identified items, so only the idempotent guards run. */
  function sanitizeParse(bundle, scrub, mode) {
    if (!bundle) return null;
    var redacted = mode === 'redacted';
    var val = redacted ? scrub.guardValue : scrub.deidentifyValue;
    var text = redacted ? function (v) { return str(v); } : function (v) { return scrub.scrubText(v).text; };
    var fields = {};
    Object.keys(bundle.RESULT || {}).forEach(function (k) {
      var f = bundle.RESULT[k] || {};
      fields[k] = { label: str(f.label), v: val(k, f.v), status: str(f.status), note: text(f.note), src: text(f.src) };
    });
    var R = bundle.ROUTE || {};
    return {
      route: { family: str(R.family), dtype: str(R.dtype), label: str(R.label), note: text(R.note) },
      fields: fields,
      leads: deidentifyLeads(bundle.LEADS, scrub, redacted),
      episodes: (bundle.EPISODES || []).map(function (e) {
        return { dt: text(e.dt), dur: str(e.dur), rate: str(e.rate), types: (e.types || []).slice(), flags: (e.flags || []).slice(), notes: text(e.notes) };
      })
    };
  }

  /* ================================================================ comparing */

  function normalizeValue(key, v, pivot) {
    v = clean(v);
    if (!v) return '';
    if (key === 'mfr' && v === 'BSc') return 'bsci';
    if (key === 'ep-dt') {   // an episode stamp: the time of day matters as much as the date
      var t = v.match(/(\d{1,2}):(\d{2})/);
      return toISODate(v, pivot) + (t ? 'T' + pad2(+t[1]) + ':' + t[2] : '');
    }
    if (DATE_FIELDS[key] || /(^|-)(date|dt)$/.test(key)) { var iso = toISODate(v, pivot); if (iso) return iso; }
    if (NUMERIC_FIELD.test(key)) {
      var m = v.replace(/(\d),(\d{3})\b/g, '$1$2').match(/([<>]=?)?\s*(-?\d+(?:[.,]\d+)?)/);
      if (m) return (m[1] || '') + String(parseFloat(m[2].replace(',', '.')));
    }
    return v.toLowerCase();
  }
  function sameValue(key, a, b, pivot) { return normalizeValue(key, a, pivot) === normalizeValue(key, b, pivot); }

  /* parsed: sanitizeParse(...).fields; expected: deidentifyExpected(...).fields.
     Judgment fields (observations, "parameters changed?", the completion date) are left out. */
  function compare(parsed, expected, pivot) {
    var diff = [];
    Object.keys(expected || {}).forEach(function (k) {
      if (JUDGMENT_FIELDS[k]) return;
      var p = parsed && parsed[k] ? str(parsed[k].v) : '', e = str(expected[k]);
      if (sameValue(k, p, e, pivot)) return;
      diff.push({ field: k, label: parsed && parsed[k] ? str(parsed[k].label) : '', parsed: p, expected: e,
        kind: !clean(p) ? 'missing' : (!clean(e) ? 'extra' : 'mismatch') });
    });
    return diff;
  }

  function compareLeads(parsed, expected, pivot) {
    var diff = [], n = Math.max((parsed || []).length, (expected || []).length);
    for (var i = 0; i < n; i++) {
      var p = (parsed || [])[i] || {}, e = (expected || [])[i] || {};
      var cells = ['location', 'manufacturer', 'model', 'serial', 'date'].filter(function (c) {
        return normalizeValue(c === 'date' ? 'lead-date' : c, p[c], pivot) !== normalizeValue(c === 'date' ? 'lead-date' : c, e[c], pivot);
      });
      if (cells.length) diff.push({ row: i + 1, cells: cells, parsed: p, expected: e });
    }
    return diff;
  }

  // Episode rows compared the way the logbook shows them: when, how long, how fast, what, and flags.
  function compareEpisodes(parsed, expected, pivot) {
    var diff = [], n = Math.max((parsed || []).length, (expected || []).length);
    for (var i = 0; i < n; i++) {
      var p = (parsed || [])[i] || {}, e = (expected || [])[i] || {};
      var cells = ['dt', 'dur', 'rate'].filter(function (c) { return normalizeValue(c === 'dt' ? 'ep-dt' : c, p[c], pivot) !== normalizeValue(c === 'dt' ? 'ep-dt' : c, e[c], pivot); });
      ['types', 'flags'].forEach(function (c) { if ((p[c] || []).slice().sort().join('|') !== (e[c] || []).slice().sort().join('|')) cells.push(c); });
      if (cells.length) diff.push({ row: i + 1, cells: cells, parsed: p, expected: e });
    }
    return diff;
  }

  /* Everything a case builder shows and exports about the parse, from the two replays: the
     untouched export (original) and the de-identified input the case will hold (redacted).
     fidelity: fields whose import changed because of de-identification, which the case can't
     vouch for. hasExpected: the tech filled in more than the device type, so there is an answer. */
  function evaluate(original, redacted, snapshot, scrub) {
    var before = original && original.bundle ? sanitizeParse(original.bundle, scrub, 'original') : null;
    var after = redacted && redacted.bundle ? sanitizeParse(redacted.bundle, scrub, 'redacted') : null;
    var expected = deidentifyExpected(expectedFromSnapshot(snapshot || {}, after ? Object.keys(after.fields) : []), scrub);
    var hasExpected = Object.keys(expected.fields).some(function (k) {
      return !JUDGMENT_FIELDS[k] && k !== 'mfr' && k !== 'dtype' && clean(expected.fields[k]);
    });
    var fields = after ? after.fields : {};
    var fidelity = [];
    if (!before || !after) { if (before || after) fidelity.push('the whole import'); }
    else {
      fidelity = Object.keys(before.fields).filter(function (k) { return !after.fields[k] || after.fields[k].v !== before.fields[k].v; });
      if (JSON.stringify(before.leads) !== JSON.stringify(after.leads)) fidelity.push('lead table');
      if (JSON.stringify(before.episodes) !== JSON.stringify(after.episodes)) fidelity.push('episodes');
    }
    return {
      before: before, after: after, expected: expected, hasExpected: hasExpected, fidelity: fidelity,
      diff: hasExpected ? compare(fields, expected.fields) : [],
      leadDiff: hasExpected ? compareLeads(after ? after.leads : [], expected.leads) : [],
      matched: Object.keys(expected.fields).filter(function (k) {
        var pv = fields[k] ? fields[k].v : '', ev = expected.fields[k];
        return !JUDGMENT_FIELDS[k] && (clean(pv) || clean(ev)) && sameValue(k, pv, ev);
      }).length
    };
  }

  /* ================================================================ items + replay */

  function round2(n) { return Math.round((+n || 0) * 100) / 100; }
  function exportItems(items) {
    return {
      format: ITEMS_FORMAT,
      items: items.filter(function (it) { return clean(it.str); }).map(function (it) { return [it.page, round2(it.x), round2(it.y), round2(it.w), str(it.str)]; })
    };
  }
  function importItems(json) {
    if (!json || json.format !== ITEMS_FORMAT || !Array.isArray(json.items)) throw new Error('Not a ' + ITEMS_FORMAT + ' items file');
    return json.items.map(function (r) { return { page: r[0], x: r[1], y: r[2], w: r[3], str: r[4] }; });
  }

  /* Run the production parser on a case's input. env defaults to the globals the pages (and Node,
     after requiring engine.js and the parsers) define. vendor: force a parser, as "Parse as:" does. */
  function replay(kind, input, env) {
    env = env || {};
    var G = env.globals || global;
    if (kind === 'log') {
      var A = G.ABBOTT;
      if (!A) return { vendor: 'Abbott / St. Jude', error: 'abbott.js is not loaded' };
      try { return { vendor: 'Abbott / St. Jude', bundle: A.runLog(input) }; }
      catch (e) { return { vendor: 'Abbott / St. Jude', error: str(e && e.message), stack: str(e && e.stack) }; }
    }
    var E = G.Engine;
    var ranked = E.scoreVendors(input).map(function (r) { return { name: r.name, score: r.score, strongPages: r.strongPages, weakPages: r.weakPages, strongTokens: r.strongTokens }; });
    var detected = ranked[0] && ranked[0].score ? ranked[0].name : 'Unknown';
    var vendor = env.vendor || detected, parser = G[PARSER_GLOBALS[vendor]];
    if (!parser) return { ranked: ranked, detected: detected, vendor: vendor, error: 'No PDF parser for ' + vendor };
    try { return { ranked: ranked, detected: detected, vendor: vendor, bundle: parser.runMap(E.tagSections(E.normalize(input)), {}) }; }
    catch (e) { return { ranked: ranked, detected: detected, vendor: vendor, error: str(e && e.message), stack: str(e && e.stack) }; }
  }

  function vendorForMfr(mfr) { return MFR_VENDOR[str(mfr)] || ''; }

  /* ================================================================ the manifest */

  function slug(s) { return str(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'unknown'; }
  function bundleName(id, vendor) { return 'import-case-' + slug(String(vendor || '').split(/[\s\/]/)[0]) + '-' + id + '.zip'; }

  function buildManifest(o) {
    return {
      schema: SCHEMA,
      id: o.id,
      kind: o.kind,
      source: o.source || {},
      detection: o.detection || null,
      parse: o.parse || null,
      expected: o.expected || null,
      diff: o.diff || [],
      leadDiff: o.leadDiff || [],
      fidelity: o.fidelity || [],
      notes: str(o.notes),
      deid: o.deid || {}
    };
  }

  global.CRMImportCase = {
    SCHEMA: SCHEMA,
    ITEMS_FORMAT: ITEMS_FORMAT,
    FIELD_KEYS: FIELD_KEYS,
    NOT_EXPORTED: NOT_EXPORTED,
    JUDGMENT_FIELDS: JUDGMENT_FIELDS,
    PARSER_GLOBALS: PARSER_GLOBALS,
    newCaseId: newCaseId,
    randomShiftDays: randomShiftDays,
    toISODate: toISODate,
    maskAlphaNum: maskAlphaNum,
    nameGuard: nameGuard,
    biotronikHeaderGuard: biotronikHeaderGuard,
    knownFromSources: knownFromSources,
    createScrubber: createScrubber,
    suspects: suspects,
    snapValue: snapValue,
    expectedFromSnapshot: expectedFromSnapshot,
    deidentifyExpected: deidentifyExpected,
    sanitizeParse: sanitizeParse,
    normalizeValue: normalizeValue,
    sameValue: sameValue,
    compare: compare,
    compareLeads: compareLeads,
    compareEpisodes: compareEpisodes,
    evaluate: evaluate,
    exportItems: exportItems,
    importItems: importItems,
    replay: replay,
    vendorForMfr: vendorForMfr,
    bundleName: bundleName,
    buildManifest: buildManifest
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.CRMImportCase;
})(typeof window !== 'undefined' ? window : globalThis);
