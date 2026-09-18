#!/usr/bin/env node
/* Import-problem cases, developer side (docs/import-cases.md).
 *
 *   node scripts/import-case.js <case.zip|dir>                       what went wrong, replayed with today's parsers
 *   node scripts/import-case.js <case> --lines [--page N] [--grep RE]  the parser's input as reading-order lines
 *   node scripts/import-case.js <case> --fields                      every field the parser produced
 *   node scripts/import-case.js add <case> [--name slug]             install it as a regression case in tests/import-cases/
 *   node scripts/import-case.js check                                replay every installed case (npm test does too)
 *
 * A bundle comes from the case builder: the PDF or .log redactor, opened by the Report Generator's
 * "Report import problem". It is de-identified before it is written, so nothing here needs, or
 * ever sees, the original export. `add` runs a PHI lint first and refuses anything that fails it.
 */
"use strict";

const fs = require("fs");
const path = require("path");

global.window = global;
const repo = path.join(__dirname, "..");
const site = path.join(repo, "site");
["engine.js", "parsers/medtronic.js", "parsers/boston.js", "parsers/biotronik.js", "parsers/abbott.js"]
  .forEach((f) => require(path.join(site, "src", f)));
const IC = require(path.join(site, "src", "import-case.js"));
const CRMDB = require(path.join(site, "vendor", "crmdb-zip.js"));
const CASES_DIR = path.join(repo, "tests", "import-cases");
const FS = String.fromCharCode(28);

function clean(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }

// A Merlin .log can be UTF-16 with a BOM, like the Report Generator reads it.
function decodeLog(buf) {
  const b = new Uint8Array(buf);
  const enc = b[0] === 0xff && b[1] === 0xfe ? "utf-16le" : b[0] === 0xfe && b[1] === 0xff ? "utf-16be" : "utf-8";
  return new TextDecoder(enc).decode(b);
}

async function loadCase(target) {
  const files = {};
  if (fs.statSync(target).isDirectory()) {
    for (const f of fs.readdirSync(target)) files[f] = fs.readFileSync(path.join(target, f));
  } else {
    const buf = fs.readFileSync(target);
    const entries = await CRMDB.read(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    entries.forEach((e) => { files[e.name] = Buffer.from(e.data); });
  }
  if (!files["case.json"]) throw new Error(target + " holds no case.json: is it an import-case bundle?");
  const c = JSON.parse(files["case.json"].toString("utf8"));
  if (c.schema !== IC.SCHEMA) throw new Error("case schema " + c.schema + " is not the " + IC.SCHEMA + " this script reads");
  const input = c.kind === "log" ? decodeLog(files["input.log"]) : IC.importItems(JSON.parse(files["items.json"].toString("utf8")));
  return { c, input, files };
}

/* Replay the case the way the import ran it: detection, unless the user had forced a parser. */
function replayCase(c, input) {
  const forced = c.detection && c.detection.forced ? c.detection.vendor : null;
  const r = IC.replay(c.kind, input, { vendor: forced });
  const guard = IC.createScrubber({ known: {}, shiftDays: 0 });
  const parsed = r.bundle ? IC.sanitizeParse(r.bundle, guard, "redacted") : null;
  const exp = c.expected || { fields: {}, leads: [], episodes: [] };
  return {
    r, parsed,
    diff: parsed ? IC.compare(parsed.fields, exp.fields) : [],
    leadDiff: parsed ? IC.compareLeads(parsed.leads, exp.leads) : [],
    episodeDiff: parsed ? IC.compareEpisodes(parsed.episodes, exp.episodes) : []
  };
}

// The parser's input as text lines: PDF items grouped the way the redactor grouped them, or log rows.
function textLines(c, input) {
  if (c.kind === "log") return input.split(/\r?\n/).map((t, i) => ({ page: i + 1, text: t.split(FS).join(" | ") }));
  return IC.createScrubber({ known: {}, shiftDays: 0 }).lines(input).map((l) => ({ page: l.page, text: l.text }));
}

/* The PHI lint `add` and the regression test run on every case. The case builder already refused
   to export anything carrying the patient's own identifiers; this re-checks what can be checked
   without them. Every string still shaped like a name, ID, serial or contact must be one the
   reviewer explicitly kept, and the manifest must record a clean residual check. */
function lint(c, input) {
  const problems = [];
  if (!c.deid || c.deid.residual !== 0) problems.push("case.json does not record a clean identifier check (deid.residual)");
  const kept = {};
  ((c.deid && c.deid.kept) || []).forEach((k) => { kept[k] = "keep"; });
  const unit = c.kind === "log" ? "line " : "p";
  IC.suspects(textLines(c, input), kept).forEach((s) => {
    problems.push("unreviewed " + s.kind + " in the input: " + s.text + " (" + unit + s.pages.slice(0, 5).join(", ") + ")");
  });
  const strings = [];
  (function walk(v, at) {
    if (typeof v === "string") { if (v) strings.push({ page: at, text: v }); return; }
    if (v && typeof v === "object") Object.keys(v).forEach((k) => walk(v[k], at ? at + "." + k : k));
  })({ notes: c.notes, parse: c.parse, expected: c.expected }, "");
  IC.suspects(strings, kept).forEach((s) => problems.push("unreviewed " + s.kind + " in case.json: " + s.text + " (" + s.pages.join(", ") + ")"));
  return problems;
}

function vendorOf(c) {
  const mfr = c.expected && c.expected.fields && c.expected.fields.mfr;
  return IC.vendorForMfr(mfr) || (c.detection && c.detection.vendor) || "unknown";
}

function show(v) { v = clean(v); return v ? JSON.stringify(v) : "-"; }

function summary(c, input, out) {
  const log = [];
  const src = c.source || {};
  log.push("Case " + c.id + "  (" + c.kind + (c.kind === "pdf" ? ", " + src.pages + " pages, " + (src.textItems || input.length) + " text items" : ", " + (src.fields || "?") + " fields") + ")");
  if (clean(c.notes)) log.push("Reviewer's note: " + clean(c.notes));
  if (c.kind === "pdf") {
    const ranked = (out.r.ranked || []).filter((v) => v.score).map((v) => v.name + " " + v.score).join(", ") || "nothing matched";
    log.push("Detected: " + out.r.detected + "  (" + ranked + ")" + (c.detection && c.detection.forced ? "  - the user forced " + c.detection.vendor : ""));
    const expectVendor = IC.vendorForMfr(c.expected && c.expected.fields.mfr);
    if (expectVendor && expectVendor !== out.r.detected) log.push("  ! the report is " + expectVendor + ": detection is part of the problem");
  }
  if (out.r.error) {
    log.push("Parser " + out.r.vendor + " FAILED: " + out.r.error);
    const frame = (out.r.stack || "").split("\n").find((l) => /site[\\/]src/.test(l));
    if (frame) log.push("  at " + frame.trim().replace(/^at /, ""));
  } else {
    log.push("Parser " + out.r.vendor + " -> " + (out.parsed.route.label || out.parsed.route.dtype || "no route"));
  }
  if (!c.expected || !Object.keys(c.expected.fields || {}).some((k) => clean(c.expected.fields[k]))) {
    log.push("The form was empty when this was reported, so there is no expected answer. Work from the note.");
  } else if (out.parsed) {
    log.push("");
    log.push(out.diff.length ? "Differs from the tech's report (replayed with today's parsers):" : "Every compared field matches the tech's report.");
    const w = Math.max(10, ...out.diff.map((d) => d.field.length));
    out.diff.forEach((d) => log.push("  " + d.field.padEnd(w) + "  import " + show(d.parsed).padEnd(16) + "  report " + show(d.expected).padEnd(16) + "  " + d.kind));
    out.leadDiff.forEach((d) => log.push("  lead row " + d.row + ": " + d.cells.join(", ") + " differ  (import " + show(Object.values(d.parsed).join(" / ")) + ", report " + show(Object.values(d.expected).join(" / ")) + ")"));
    out.episodeDiff.forEach((d) => log.push("  episode row " + d.row + ": " + d.cells.join(", ") + " differ"));
    const omitted = (c.expected.omitted || []);
    if (omitted.length) log.push("  (not taken from the form: " + omitted.join(", ") + ")");
  }
  if ((c.fidelity || []).length) log.push("Caution: de-identifying changed how these imported, so the case may not show them faithfully: " + c.fidelity.join(", "));
  const d = c.deid || {};
  log.push("");
  log.push("De-identified: " + JSON.stringify(d.replaced || {}) + "; kept after review: " + ((d.kept || []).length ? d.kept.map((k) => JSON.stringify(k)).join(", ") : "none"));
  return log.join("\n");
}

function printLines(c, input, opts) {
  if (c.kind === "log") {
    input.split(/\r?\n/).forEach((t, i) => {
      if (opts.grep && !opts.grep.test(t)) return;
      const cells = t.split(FS);
      if (cells.length > 2) console.log(String(i + 1).padStart(4) + "  " + cells[0].padEnd(6) + " " + cells[1].padEnd(46) + " " + JSON.stringify(cells[2]) + (cells[3] ? " " + cells[3] : ""));
    });
    return;
  }
  const E = global.Engine, lines = E.tagSections(E.normalize(input));
  let page = 0;
  lines.forEach((l) => {
    if (opts.page && l.page !== opts.page) return;
    if (opts.grep && !opts.grep.test(E.text(l))) return;
    if (l.page !== page) { page = l.page; console.log("=== PAGE " + page + (l.section ? "  (" + l.section + ")" : "") + " ==="); }
    console.log("[y" + String(Math.round(l.y)).padStart(4) + "] " + l.items.map((it) => "x" + Math.round(it.x) + '|"' + it.str + '"').join("  "));
  });
}

function printFields(out) {
  if (!out.parsed) { console.log("The parser failed: " + out.r.error); return; }
  const f = out.parsed.fields, w = Math.max(...Object.keys(f).map((k) => k.length));
  Object.keys(f).forEach((k) => console.log(k.padEnd(w) + "  " + show(f[k].v).padEnd(22) + " " + (f[k].status || "").padEnd(7) + " " + (f[k].src || "") + (f[k].note ? "  - " + f[k].note : "")));
  out.parsed.leads.forEach((L, i) => console.log("lead " + (i + 1) + ": " + [L.location, L.manufacturer, L.model, L.serial, L.date].join(" | ")));
  out.parsed.episodes.forEach((e, i) => console.log("episode " + (i + 1) + ": " + [e.dt, e.dur, e.rate, (e.types || []).join("+"), (e.flags || []).join("+"), e.notes].join(" | ")));
}

/* Install a case as a regression test. It asserts what matches the tech's report TODAY, so run it
   after the fix: fields that still differ are listed and left out (a clinical edit, not a parser
   bug, or something still to fix). */
async function add(target, name) {
  const { c, input } = await loadCase(target);
  const problems = lint(c, input);
  if (problems.length) {
    console.error("Not added: the PHI lint failed.\n  " + problems.join("\n  ") +
      "\nRebuild the case from the Report Generator and decide each of these in the review list.");
    process.exitCode = 1;
    return;
  }
  const out = replayCase(c, input);
  if (!out.parsed) { console.error("Not added: the parser still fails on this case (" + out.r.error + "). Fix it first."); process.exitCode = 1; return; }
  const exp = c.expected;
  const fields = Object.keys(exp.fields).filter((k) => {
    const pv = out.parsed.fields[k] ? out.parsed.fields[k].v : "";
    return !IC.JUDGMENT_FIELDS[k] && (clean(pv) || clean(exp.fields[k])) && IC.sameValue(k, pv, exp.fields[k]);
  });
  c.assert = {
    fields,
    leads: exp.leads.length > 0 && out.leadDiff.length === 0,
    episodes: exp.episodes.length > 0 && out.episodeDiff.length === 0,
    vendor: c.kind === "pdf" && IC.vendorForMfr(exp.fields.mfr) === out.r.detected ? out.r.detected : null
  };
  const slug = (name || (vendorOf(c).split(/[\s\/]/)[0] + "-" + c.id)).toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const dir = path.join(CASES_DIR, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "case.json"), JSON.stringify(c, null, 2) + "\n");
  if (c.kind === "log") {
    const { files } = await loadCase(target);
    fs.writeFileSync(path.join(dir, "input.log"), files["input.log"]);
  } else {
    fs.writeFileSync(path.join(dir, "items.json"), JSON.stringify(IC.exportItems(input)) + "\n");
  }
  console.log("Added " + path.relative(repo, dir) + ": asserts " + fields.length + " fields" +
    (c.assert.leads ? ", the lead table" : "") + (c.assert.episodes ? ", the episodes" : "") + (c.assert.vendor ? ", detection as " + c.assert.vendor : "") + ".");
  if (out.diff.length) console.log("Not asserted (still differs): " + out.diff.map((d) => d.field).join(", "));
}

/* Every installed case, replayed. Returns failure messages; the regression test asserts none. */
async function checkAll() {
  const failures = [], names = fs.existsSync(CASES_DIR)
    ? fs.readdirSync(CASES_DIR).filter((d) => fs.existsSync(path.join(CASES_DIR, d, "case.json"))).sort() : [];
  for (const name of names) {
    const { c, input } = await loadCase(path.join(CASES_DIR, name));
    lint(c, input).forEach((p) => failures.push(name + ": PHI lint: " + p));
    const out = replayCase(c, input), a = c.assert || {};
    if (!out.parsed) { failures.push(name + ": the parser throws: " + out.r.error); continue; }
    if (a.vendor && out.r.detected !== a.vendor) failures.push(name + ": detected " + out.r.detected + ", expected " + a.vendor);
    (a.fields || []).forEach((k) => {
      const pv = out.parsed.fields[k] ? out.parsed.fields[k].v : "";
      if (!IC.sameValue(k, pv, c.expected.fields[k])) failures.push(name + ": " + k + " imports " + show(pv) + ", expected " + show(c.expected.fields[k]));
    });
    if (a.leads && out.leadDiff.length) failures.push(name + ": lead table differs in rows " + out.leadDiff.map((d) => d.row).join(", "));
    if (a.episodes && out.episodeDiff.length) failures.push(name + ": episodes differ in rows " + out.episodeDiff.map((d) => d.row).join(", "));
  }
  return { names, failures };
}

async function main(argv) {
  const args = argv.slice(2);
  const flag = (f) => args.indexOf(f) >= 0;
  const value = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
  if (!args.length || flag("--help")) {
    console.log(fs.readFileSync(__filename, "utf8").split("\n").slice(3, 8).map((l) => l.replace(/^ \*\s{0,3}/, "")).join("\n"));
    return;
  }
  if (args[0] === "check") {
    const { names, failures } = await checkAll();
    console.log(names.length + " import case" + (names.length === 1 ? "" : "s") + " replayed" + (failures.length ? ", " + failures.length + " failing:" : ", all passing."));
    failures.forEach((f) => console.log("  " + f));
    if (failures.length) process.exitCode = 1;
    return;
  }
  if (args[0] === "add") return add(args[1], value("--name"));
  const { c, input } = await loadCase(args[0]);
  if (flag("--lines")) return printLines(c, input, { page: +value("--page") || 0, grep: value("--grep") ? new RegExp(value("--grep"), "i") : null });
  const out = replayCase(c, input);
  if (flag("--fields")) return printFields(out);
  console.log(summary(c, input, out));
  const problems = lint(c, input);
  if (problems.length) console.log("\nPHI lint (fix before `add`):\n  " + problems.join("\n  "));
}

module.exports = { loadCase, replayCase, lint, checkAll };
if (require.main === module) main(process.argv).catch((e) => { console.error(e.message); process.exitCode = 1; });
