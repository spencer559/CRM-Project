/* Import-problem cases: de-identification and replay (site/src/import-case.js).
 *
 * The property everything else rests on: a synthetic report run through the real Medtronic
 * parser gives the same answers before and after de-identification, once the "before" answers are
 * de-identified too. If that holds, a case built from a failed import replays as a faithful
 * regression test. The rest pins the scrubber's individual rules. All data here is synthetic.
 *
 * Run with: node tests/import-case.test.js
 */
"use strict";

const assert = require("assert");
const path = require("path");

global.window = global;
const site = path.join(__dirname, "..", "site");
require(path.join(site, "src", "engine.js"));
require(path.join(site, "src", "parsers", "medtronic.js"));
require(path.join(site, "src", "parsers", "abbott.js"));
const C = require(path.join(site, "src", "import-case.js"));

const SHIFT = -364;   // 52 weeks
const PIVOT = 26;

/* ---------------------------------------------------------------- dates */
{
  const s = C.createScrubber({ known: {}, shiftDays: SHIFT, pivot: PIVOT });
  const t = (v) => s.scrubText(v).text;
  assert.strictEqual(t("Aug/16/2026"), "Aug/17/2025", "Medtronic Mon/DD/YYYY keeps its shape");
  assert.strictEqual(t("16 Aug 2026"), "17 Aug 2025", "Boston D Mon YYYY is read day-first");
  assert.strictEqual(t("08/16/2026 14:35:22"), "08/17/2025 14:35:22", "the time of day is kept");
  assert.strictEqual(t("8/6/26"), "8/7/25", "unpadded parts and a two-digit year stay that way");
  assert.strictEqual(t("2026-08-16T21:08"), "2025-08-17T21:08", "an ISO datetime shifts its date only");
  assert.strictEqual(t("AUGUST 16TH, 2026"), "AUGUST 17TH, 2025", "month-name case and ordinals are rebuilt");
  assert.strictEqual(t("16-AUG-26"), "17-AUG-25");
  assert.strictEqual(t("Trend Aug 2025 - Sep 2025"), "Trend Aug 2024 - Sep 2024", "month-year labels move too");
  assert.strictEqual(t("Episode 08/16 14:35"), "Episode 08/18 14:35", "a yearless stamp beside a time is a date");
  assert.strictEqual(t("00:12:30   Aug 16 14:40"), "00:12:30   Aug 18 14:40",
    "the seconds of a duration must not be read as the day of a following month");
  assert.strictEqual(t("Mode DDDR 60 ppm 1.2.60 3/4 10/20 mV Page 3 of 20"), "Mode DDDR 60 ppm 1.2.60 3/4 10/20 mV Page 3 of 20",
    "clinical values, ratios and version strings are not dates");
  assert.strictEqual(t("13/45/2026"), "13/45/2026", "an impossible date is left alone");
  // whole weeks: the weekday printed beside a date stays true
  const d0 = new Date(Date.UTC(2026, 7, 16)), d1 = new Date(d0.getTime() + SHIFT * 86400000);
  assert.strictEqual(d0.getUTCDay(), d1.getUTCDay());
  for (let i = 0; i < 50; i++) {
    const days = C.randomShiftDays();
    assert(days % 7 === 0 && days <= -364 && days >= -1092, "random shifts are 1-3 years back, in whole weeks: " + days);
  }
  assert.strictEqual(C.toISODate("Aug/16/2026", PIVOT), "2026-08-16");
  assert.strictEqual(C.toISODate("March 3rd, 2026", PIVOT), "2026-03-03");
  assert.strictEqual(C.toISODate("nothing here", PIVOT), "");
}

/* ---------------------------------------------------------------- names, serials, IDs */
{
  const s = C.createScrubber({
    known: { names: ["SMITH-JONES, JOHN QUINCY", "Page, May"], providers: ["Dr. Jane Heartwell"], serials: ["PJN123456S"], ids: ["00123456", "4321"] },
    shiftDays: SHIFT, pivot: PIVOT
  });
  const t = (v) => s.scrubText(v).text;
  assert.strictEqual(t("Patient: SMITH-JONES, JOHN Q"), "Patient: DOE, TEST Q");
  assert.strictEqual(t("john quincy smith"), "test sample doe", "case follows the source");
  assert.strictEqual(t("Seen by Dr. Jane Heartwell"), "Seen by Dr. Provider Provider");
  assert.strictEqual(t("Page 3 of 20"), "Page 3 of 20", "a common word in the name is left alone on its own...");
  assert.strictEqual(t("PAGE, MAY"), "DOE, TEST", "...and replaced as a pair");
  assert.deepStrictEqual(C.suspects([{ page: 3, text: "Page 3 of 20" }], {}, s.nameWords(), s.loneWords()).map((c) => c.text), ["Page"],
    "...and a lone one goes to the reviewer, since nothing proves it isn't the patient");
  assert.strictEqual(t("SN PJN 123456 S / pjn123456s"), "SN XXX 000001 X / XXX000001X", "separators and case are tolerated");
  assert.strictEqual(t("MRN 0012-3456  4321 ms"), "MRN 0000-0001  4321 ms", "a four-digit number is too short to scrub safely");
  assert.strictEqual(s.deidentifyValue("pt-mrn", "12"), "00", "a short MRN is still masked in the field itself");
  assert.deepStrictEqual(s.residualText("Printed for smith").map((h) => h.kind), ["name"]);
  assert.deepStrictEqual(s.residualText("DOE, TEST").length, 0);

  // a patient actually named Doe, Test gets the alternate pseudonyms, and the guard still sees them
  const odd = C.createScrubber({ known: { names: ["DOE, TEST"] }, shiftDays: SHIFT, pivot: PIVOT });
  assert.strictEqual(odd.scrubText("DOE, TEST").text, "ROE, CASE");
  assert.strictEqual(odd.deidentifyValue("pt-name", "Test Doe"), "Case Roe");
  assert.strictEqual(odd.guardValue("pt-name", "DOE, TEST"), "DOE, TEST", "an already synthetic value passes the guard...");
  assert.strictEqual(odd.residualText("DOE, TEST").length > 0, true, "...but the real name is still residue for this patient");
}

/* ---------------------------------------------------------------- items: fragments and duplicates */
{
  const s = C.createScrubber({ known: { names: ["SMITH, JOHN"], dates: ["1950-01-02"] }, shiftDays: SHIFT, pivot: PIVOT });
  const items = [
    { page: 1, x: 40, y: 700, w: 18, str: "SMI", h: 10 },      // one name drawn as two touching fragments
    { page: 1, x: 58, y: 700, w: 12, str: "TH", h: 10 },
    { page: 1, x: 100, y: 700, w: 30, str: "01/02/", h: 10 },  // and a date split the same way
    { page: 1, x: 130, y: 700, w: 20, str: "1950", h: 10 },
    { page: 1, x: 300, y: 680, w: 30, str: "JOHN", h: 10 },    // a bold word drawn twice in place
    { page: 1, x: 300, y: 680, w: 30, str: "JOHN", h: 10 },
    { page: 1, x: 40, y: 660, w: 30, str: "Mode", h: 10 }
  ];
  const r = s.scrubItems(items);
  assert.deepStrictEqual(r.items.map((i) => i.str), ["DOE", "", "01/03/", "1949", "TEST", "TEST", "Mode"]);
  assert.deepStrictEqual(Object.keys(r.changed).map(Number).sort(), [0, 1, 2, 3, 4, 5]);
  assert.deepStrictEqual(s.residualItems(r.items), []);
  assert.deepStrictEqual(s.residualItems(items).map((h) => h.kind).sort(), ["date", "name", "name", "name"]);
  assert.strictEqual(items[0].str, "SMI", "the input items are not modified");
  const round = C.importItems(JSON.parse(JSON.stringify(C.exportItems(r.items))));
  assert.strictEqual(round.length, 6, "emptied items are dropped on export");
  assert.deepStrictEqual(round[0], { page: 1, x: 40, y: 700, w: 18, str: "DOE" });
}

/* ---------------------------------------------------------------- Biotronik header */
{
  assert.strictEqual(C.biotronikHeaderGuard("PDF: BIOTRONIK - Edora 8 DR-T - 1000363924 - Example, Jane - 1 / 4"),
    "PDF: BIOTRONIK - Edora 8 DR-T - 0000000000 - DOE, TEST - 1 / 4", "model survives; serial and name do not");
  assert.strictEqual(C.biotronikHeaderGuard("PDF: BIOTRONIK - Edora 8 DR-T - 0000000000 - DOE, TEST - 1 / 4"),
    "PDF: BIOTRONIK - Edora 8 DR-T - 0000000000 - DOE, TEST - 1 / 4", "idempotent");
  assert.strictEqual(C.biotronikHeaderGuard("BIOTRONIK - Home Monitoring - Service Center"), "BIOTRONIK - Home Monitoring - Service Center");
}

/* ---------------------------------------------------------------- review list */
{
  const s = C.createScrubber({ known: { names: ["SMITH, JOHN"], providers: ["Dr. Jane Heartwell"] }, shiftDays: SHIFT, pivot: PIVOT });
  const lines = [
    "Printed Aug/17/2025 by jheartwell",
    "Heart, Mary  Dr. Oakes  Medtronic, Inc.  Minneapolis, MN  Dr. Provider  DOE, TEST  Final, Initial",
    "Account 12345678  Lead PJN1234567  XXX0000000  test@example.invalid  a@b.org  (555) 555-1212  000-000-0000"
  ].map((text, i) => ({ page: i + 1, text }));
  const found = C.suspects(lines, {}, s.nameWords()).map((c) => c.kind + ":" + c.text);
  assert.deepStrictEqual(found, ["name:jheartwell", "name:Heart, Mary", "name:Minneapolis, MN", "clinician:Dr. Oakes",
    "number:12345678", "serial:PJN1234567", "email:a@b.org", "phone:(555) 555-1212"]);
  assert.deepStrictEqual(C.suspects(lines, { "Heart, Mary": "keep", "jheartwell": "redact" }, s.nameWords()).length, found.length - 2,
    "a decided string is not asked about again");
  s.addCustom("jheartwell");
  assert.strictEqual(s.scrubText("by jheartwell.").text, "by XXXXXXXXXX.", "a redact decision masks the string everywhere");
}

/* ---------------------------------------------------------------- the consistency property */

function items(page, rows) {
  const out = [];
  rows.forEach(([y, cells]) => cells.forEach(([x, str]) => out.push({ page, x, y, w: str.length * 5, str, h: 10 })));
  return out;
}

const report = [].concat(
  items(1, [
    [760, [[40, "Final: Quick Look II"]]],
    [740, [[40, "Patient:"], [120, "SMITH, JOHN Q"], [330, "Date of Visit:"], [420, "Aug/16/2026"], [480, "2:35 PM"]]],
    [725, [[40, "Device:"], [120, "Azure XT DR MRI W1DR01"], [330, "Serial Number:"], [420, "RNB123456S"]]],
    [710, [[40, "Physician:"], [120, "Dr. Jane Heartwell"], [330, "ID:"], [420, "00123456"]]],
    [695, [[40, "Date of Birth"], [120, "Jan/02/1950"]]],
    [660, [[40, "Remaining Longevity"], [200, "9.5 years"]]],
    [640, [[230, "Atrial(5076)"], [360, "RV(5076)"]]],
    [625, [[40, "Pacing Impedance"], [230, "456"], [260, "ohms"], [360, "589"], [390, "ohms"]]],
    [610, [[40, "Capture Threshold"], [230, "0.625 V @ 0.40 ms"], [360, "0.750 V @ 0.40 ms"]]],
    [595, [[40, "Measured P/R Wave"], [230, "2.8 mV"], [360, "11.2 mV"]]],
    [570, [[40, "Mode"], [200, "DDDR"]]],
    [555, [[40, "Lower Rate"], [200, "60 bpm"]]],
    [540, [[40, "Upper Track"], [200, "130 bpm"]]],
    [525, [[40, "Upper Sensor"], [200, "120 bpm"]]],
    [500, [[40, "Pacing (% of Time Since Jul/01/2026)"]]],
    [485, [[60, "AP"], [200, "12.3 %"]]],
    [470, [[60, "VP"], [200, "<0.1 %"]]],
    [30, [[40, "Medtronic CareLink"], [300, "Printed Aug/16/2026 by jheartwell"], [520, "Page 1 of 3"]]]
  ]),
  items(2, [
    [760, [[40, "Final: Session Summary"]]],
    [740, [[40, "Device"], [120, "Azure XT DR MRI W1DR01"], [300, "RNB123456S"], [400, "Implanted:"], [460, "May/04/2019"]]],
    [720, [[40, "Atrial"], [120, "Medtronic"], [200, "5076"], [260, "PJN1234567"], [460, "May/04/2019"]]],
    [705, [[40, "RV"], [120, "Medtronic"], [200, "5076"], [260, "PJN7654321"], [460, "May/04/2019"]]],
    [30, [[40, "Medtronic CareLink"], [520, "Page 2 of 3"]]]
  ]),
  items(3, [
    [760, [[40, "Arrhythmia Episode List"]]],
    [740, [[40, "AT/AF"], [90, "12"], [140, "Aug/10/2026"], [220, "03:12 PM"], [300, ":45"], [360, "150/210"], [420, "160/230"]]],
    [725, [[40, "AT/AF"], [90, "11"], [140, "Jul/28/2026"], [220, "11:05 AM"], [300, "1:02:36"], [360, "140/190"], [420, "150/200"]]],
    [710, [[40, "AT/AF"], [90, "10"], [140, "Jul/02/2026"], [220, "09:40 PM"], [300, ":20"], [360, "130/170"], [420, "140/180"]]],
    [30, [[40, "Medtronic CareLink"], [520, "Page 3 of 3"]]]
  ])
);

// What the tech left in the form (collectFormData() shape), with one deliberate correction:
// the tech's RV threshold differs from what the report prints.
const snapshot = {
  "pt-name": "SMITH, JOHN Q", "pt-dob": "1950-01-02", "pt-mrn": "00123456", "pt-date": "2026-08-16", "dev-implant": "2019-05-04",
  "pt-provider": "Dr. Jane Heartwell", "r:mfr": "Medtronic", "r:dtype": "PPM-DC", "dev-model": "Azure XT DR MRI W1DR01",
  "dev-serial": "RNB123456S", "bat-lon-cur": "9.5", "bat-lon-unit": "years", "lead-ra-imp": "456", "lead-rv-imp": "589",
  "lead-ra-thr": "0.625", "lead-rv-thr": "0.5", "lead-ra-pw": "0.4", "lead-rv-pw": "0.4", "lead-ra-sens": "2.8", "lead-rv-sens": "11.2",
  "p-mode": "DDDR", "p-lrl": "60", "p-utr": "130", "p-usr": "120", "pct-a": "12.3", "pct-v": "<0.1",
  "obs-text": "Mr SMITH feels well", "r:obs-yn": "No",
  __leadinfo: [
    { location: "Atrial", manufacturer: "Medtronic", model: "5076", serial: "PJN1234567", date: "05/04/2019" },
    { location: "RV", manufacturer: "Medtronic", model: "5076", serial: "PJN7654321", date: "05/04/2019" }
  ],
  __ep: 2,
  "n:ep1-dt": "2026-08-10T15:12", "n:ep1-dur": "00:00:45", "n:ep1-rate": "230", "cx:ep1-type:AF/AHR": true, "cx:ep1-flag:Recent": true, "cx:ep1-type:VT": false,
  "n:ep2-dt": "2026-07-28T11:05", "n:ep2-dur": "01:02:36", "n:ep2-rate": "200", "cx:ep2-type:AF/AHR": true, "cx:ep2-flag:Longest": true
};

const original = C.replay("pdf", report);
assert.strictEqual(original.detected, "Medtronic");
assert.ok(original.bundle, original.error);
assert.strictEqual(original.bundle.RESULT["pt-name"].v, "SMITH, JOHN Q", "fixture sanity: the parser reads the synthetic report");

const known = C.knownFromSources({ snapshot, result: original.bundle.RESULT, leads: original.bundle.LEADS, extraNames: ["SMITH, JOHN"] });
const scrub = C.createScrubber({ known, shiftDays: SHIFT, pivot: PIVOT });
assert.deepStrictEqual(scrub.counts(), { names: 4, serials: 3, ids: 1, dates: 3 }, "SMITH, JOHN, JANE, HEARTWELL (an initial is too short to match)");

const scrubbed = scrub.scrubItems(report);
const exported = C.exportItems(scrubbed.items);
const replayItems = C.importItems(JSON.parse(JSON.stringify(exported)));
const redacted = C.replay("pdf", replayItems);
assert.strictEqual(redacted.detected, "Medtronic", "vendor detection survives de-identification");

const before = C.sanitizeParse(original.bundle, scrub, "original");
const after = C.sanitizeParse(redacted.bundle, scrub, "redacted");
Object.keys(before.fields).forEach((k) => {
  assert.strictEqual(after.fields[k].v, before.fields[k].v, "field " + k + " must parse the same after de-identification");
});
assert.deepStrictEqual(after.leads, before.leads, "the lead inventory must parse the same");
assert.deepStrictEqual(after.episodes, before.episodes, "episode selection (most recent, longest) must survive the date shift");
assert.strictEqual(after.fields["pt-name"].v, "DOE, TEST Q");
assert.strictEqual(after.fields["dev-serial"].v, "XXX000001X");
assert.deepStrictEqual(after.leads.map((l) => l.serial), ["XXX0000002", "XXX0000003"], "distinct serials stay distinct");
assert.strictEqual(after.fields["pt-dob"].v, "1949-01-03");
assert.deepStrictEqual(after.episodes.map((e) => e.flags), [["Recent"], ["Longest"]]);

assert.deepStrictEqual(scrub.residualItems(scrubbed.items), []);
// The one thing no rule replaces, a login that embeds the clinician's surname, goes to the reviewer.
const review = C.suspects(scrub.lines(scrubbed.items), {}, scrub.nameWords()).map((c) => c.text);
assert.deepStrictEqual(review, ["jheartwell"]);
// Once they choose "redact", nothing identifying is left in what would be exported.
scrub.addCustom("jheartwell");
const reviewed = C.exportItems(scrub.scrubItems(report).items);
const text = JSON.stringify(reviewed);
["SMITH", "JOHN", "Heartwell", "RNB123456S", "PJN1234567", "PJN7654321", "00123456", "1950", "Aug/16/2026", "May/04/2019"].forEach((phi) => {
  assert(!text.toLowerCase().includes(phi.toLowerCase()), "exported items still contain " + phi);
});
assert.deepStrictEqual(C.suspects(scrub.lines(C.importItems(reviewed)), {}, scrub.nameWords()), []);
assert.deepStrictEqual(C.replay("pdf", C.importItems(reviewed)).bundle.RESULT["lead-rv-imp"].v, "589", "a review decision does not disturb the parse");

// expected values from the form, through the same scrubber
const expected = C.deidentifyExpected(C.expectedFromSnapshot(snapshot), scrub);
assert.deepStrictEqual(expected.omitted.sort(), ["obs-text", "pt-provider"], "clinician names and free text never leave the form");
assert.strictEqual(expected.fields["pt-dob"], "1949-01-03");
assert.strictEqual(expected.fields["pt-mrn"], "00000001");
assert.strictEqual(expected.fields["mfr"], "Medtronic");
assert.deepStrictEqual(expected.leads[0], { location: "Atrial", manufacturer: "Medtronic", model: "5076", serial: "XXX0000002", date: "05/05/2018" });
assert.deepStrictEqual(expected.episodes, [
  { dt: "2025-08-11T15:12", dur: "00:00:45", rate: "230", types: ["AF/AHR"], flags: ["Recent"] },
  { dt: "2025-07-29T11:05", dur: "01:02:36", rate: "200", types: ["AF/AHR"], flags: ["Longest"] }
]);
assert.deepStrictEqual(scrub.residualObject(expected), []);

const diff = C.compare(after.fields, expected.fields, PIVOT);
assert.deepStrictEqual(diff.map((d) => d.field + ":" + d.kind), ["lead-rv-thr:mismatch"],
  "the only difference is the one the tech corrected (0.750 vs 0.5)");
assert.strictEqual(diff[0].label, "RV Threshold (V)", "a difference names the field the way the form does");
assert.deepStrictEqual(C.compareLeads(after.leads, expected.leads, PIVOT), [], "lead rows match once dates are normalized");

assert.strictEqual(C.sameValue("lead-rv-thr", "0.750", "0.75 V"), true);
assert.strictEqual(C.sameValue("pct-v", "<0.1", "< 0.1 %"), true);
assert.strictEqual(C.sameValue("mfr", "BSc", "BSci"), true);
assert.strictEqual(C.sameValue("pt-date", "Aug/17/2025", "2025-08-17", PIVOT), true);
assert.strictEqual(C.vendorForMfr("BSci"), "Boston Scientific");

/* ---------------------------------------------------------------- manifests and names */
{
  const id = C.newCaseId();
  assert.match(id, /^[a-z0-9]{7}$/);
  assert.strictEqual(C.bundleName("abc1234", "Boston Scientific"), "import-case-boston-abc1234.zip");
  assert.strictEqual(C.bundleName("abc1234", "Abbott / St. Jude"), "import-case-abbott-abc1234.zip");
  const m = C.buildManifest({ id: "abc1234", kind: "pdf", notes: "RV threshold wrong" });
  assert.strictEqual(m.schema, C.SCHEMA);
  assert.deepStrictEqual(Object.keys(m), ["schema", "id", "kind", "source", "detection", "parse", "expected", "diff", "leadDiff", "fidelity", "notes", "deid"]);
}

console.log("import-case de-identification and replay checks passed");
