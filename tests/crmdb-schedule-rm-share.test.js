/* One remote-monitoring status, shared by the Schedule and the Report Generator.
 *
 * The status is precharted in the Schedule's "Remote" column and shown again in the Report
 * Generator's Final Session Summary. They are not two fields that are kept in step — they are
 * one field, and schedule.json inside the .crmdb is where it lives. So the Report Generator
 * has to write BACK into the schedule row, which is the only place either page writes a file
 * the other one owns.
 *
 * This pins the store contract that write-back rides on:
 *   · the virtual root hands out a handle to schedule.json (and to one that doesn't exist yet);
 *   · a deferred write + flush lands the change in the shared working copy, where the Schedule
 *     page reads it on the way back;
 *   · the revision stamp goes UP, because a Schedule tab holding an older copy compares stamps
 *     to decide who wins — without the bump it would put the stale status straight back.
 *
 * The mutation itself is replicated here rather than imported: it lives inline in
 * app/CRM_Report_Generator.html (see pushRmToSchedule), which has no module boundary.
 *
 * Run with:  node tests/crmdb-schedule-rm-share.test.js
 */
"use strict";

const assert = require("assert");
const path = require("path");
if (!global.crypto) global.crypto = require("crypto").webcrypto;
// The read path goes through the virtual file handle's getFile(), which builds a File — a browser
// global that older Node versions don't expose.
if (!global.File) global.File = require("buffer").File;
global.window = global;

global.showOpenFilePicker = function () {};
global.showSaveFilePicker = function () {};

Object.defineProperty(global, "navigator", { value: {}, configurable: true, writable: true });
global.URL = { createObjectURL: function () { return "blob:x"; }, revokeObjectURL: function () {} };
global.document = {
  body: { appendChild: function () {}, removeChild: function () {} },
  createElement: function () { return { style: {}, click: function () {}, remove: function () {}, set href(v) {}, get href() { return ""; } }; }
};

function installIndexedDB() {
  const data = new Map([["kv", new Map()]]);
  function makeTx(storeName) {
    const ops = [];
    const tx = { oncomplete: null, onerror: null, error: null, objectStore: () => store };
    const store = {
      get(k) { const rq = {}; ops.push(() => { rq.result = data.get(storeName).get(k); if (rq.onsuccess) rq.onsuccess(); }); return rq; },
      put(v, k) { const rq = {}; ops.push(() => { data.get(storeName).set(k, v); if (rq.onsuccess) rq.onsuccess(); }); return rq; },
      delete(k) { const rq = {}; ops.push(() => { data.get(storeName).delete(k); if (rq.onsuccess) rq.onsuccess(); }); return rq; }
    };
    queueMicrotask(() => {
      try { while (ops.length) ops.shift()(); } catch (e) { tx.error = e; if (tx.onerror) tx.onerror(); return; }
      if (tx.oncomplete) tx.oncomplete();
    });
    return tx;
  }
  global.indexedDB = {
    open() {
      const req = {};
      queueMicrotask(() => {
        req.result = { objectStoreNames: { contains: (n) => data.has(n) }, createObjectStore: (n) => { if (!data.has(n)) data.set(n, new Map()); return {}; }, transaction: (n) => makeTx(n), close() {} };
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    }
  };
  return { set: (k, v) => data.get("kv").set(k, v), wipe: () => data.get("kv").clear() };
}
const shared = installIndexedDB();

require("../vendor/crmdb-zip.js");
const STORE = path.resolve(__dirname, "../src/crmdb-store.js");
// A fresh require is a fresh page: the Schedule and the Report Generator are two loads of the
// same store over one shared IndexedDB working copy, exactly as the two HTML pages are.
function newPage() { delete require.cache[STORE]; delete global.CRMWorkspace; return require(STORE); }

/* ---- the Report Generator's half, replicated from pushRmToSchedule / pullRmFromSchedule ---- */

function readSchedule(WS, root) {
  return root.getFileHandle("schedule.json")
    .then((fh) => fh.getFile())
    .then((f) => f.text())
    .then((t) => JSON.parse(t || "{}"));
}
function scheduleRowFor(WS, sched, dt, slot) {
  const day = (sched && sched.dates && sched.dates[dt]) || [];
  for (const row of day) if (row && WS.slotName(row.time, row.pt) === slot) return row;
  return null;
}
async function pushRmToSchedule(WS, root, dt, slot, value) {
  const sched = await readSchedule(WS, root);
  const row = scheduleRowFor(WS, sched, dt, slot);
  if (!row || String(row.rm || "") === value) return false;
  row.rm = value;
  sched._updatedAt = Math.max(Date.now(), Number(sched._updatedAt || 0) + 1);
  sched._updatedBy = "reportgen-tab";
  const text = JSON.stringify(sched, null, 2);
  const fh = await root.getFileHandle("schedule.json", { create: true });
  const w = await fh.createWritable({ defer: true });
  await w.write(text);
  await w.close();
  await WS.flush();
  return true;
}

/* ---- the day the Schedule precharted ---- */

function seedSchedule() {
  return {
    type: "patient-schedule", version: 1, providers: ["Tech"],
    _updatedAt: 1000, _updatedBy: "schedule-tab",
    dates: {
      "2026-07-31": [
        { time: "09:00", pt: "Alpha", mfr: "Medtronic", dtype: "PPM", provider: "Tech", check: "In-clinic", lastOff: "", rm: "", cerner: false, notes: "" },
        { time: "10:30", pt: "Bravo", mfr: "Abbott", dtype: "ICD", provider: "Tech", check: "In-clinic", lastOff: "", rm: "Connected", cerner: false, notes: "" }
      ]
    }
  };
}

// Publish a day into the shared working copy, then open it as the Report Generator would.
async function openSeededDatabase(scheduleJson) {
  shared.wipe();
  const seeder = newPage();
  seeder._bundle.clear();
  seeder._bundle.set("marker.txt", new Blob(["crmdb"]));
  if (scheduleJson !== null) seeder._bundle.set("schedule.json", new Blob([scheduleJson || JSON.stringify(seedSchedule(), null, 2)]));
  shared.set("bundle", await seeder._serialize());
  shared.set("rev", 1);

  const WS = newPage();
  const root = await WS.stored();
  assert.ok(root, "the Report Generator must pick up the working copy the Schedule left behind");
  return { WS, root };
}

async function run() {
  /* 1. Schedule -> Report Generator: the precharted status is found by slot name. */
  {
    const { WS, root } = await openSeededDatabase();
    const sched = await readSchedule(WS, root);
    const slot = WS.slotName("10:30", "Bravo");

    const row = scheduleRowFor(WS, sched, "2026-07-31", slot);
    assert.ok(row, "the Report Generator must find the schedule row for the slot it was handed");
    assert.strictEqual(row.rm, "Connected",
      "the status precharted on the Schedule is what the Final Session Summary should open with");
    assert.strictEqual(scheduleRowFor(WS, sched, "2026-07-31", WS.slotName("09:00", "Alpha")).rm, "",
      "an un-precharted row must come through blank, not as another patient's status");
    assert.strictEqual(scheduleRowFor(WS, sched, "2026-08-01", slot), null,
      "the slot key must be scoped to its own day");
  }

  /* 2. Report Generator -> Schedule: the change reaches the copy the Schedule page reads back. */
  {
    const { WS, root } = await openSeededDatabase();
    const slot = WS.slotName("09:00", "Alpha");
    const before = (await readSchedule(WS, root))._updatedAt;

    const wrote = await pushRmToSchedule(WS, root, "2026-07-31", slot, "Not connected");
    assert.strictEqual(wrote, true, "a real change must be written");

    // What the Schedule page picks up when it comes back: the shared working copy, not the
    // Report Generator's memory.
    const schedulePage = newPage();
    await schedulePage.reloadWorkingCopy();
    const after = JSON.parse(await schedulePage.readText({ prefix: "" }, "schedule.json"));
    const row = scheduleRowFor(schedulePage, after, "2026-07-31", slot);

    assert.strictEqual(row.rm, "Not connected",
      "the status set in the Final Session Summary must come back on the Schedule row");
    assert.ok(after._updatedAt > before,
      "without a newer revision a Schedule tab treats its own copy as current and reverts the status");
    assert.strictEqual(after._updatedBy, "reportgen-tab", "the revision must be attributed to the writer");
    assert.strictEqual(scheduleRowFor(schedulePage, after, "2026-07-31", WS.slotName("10:30", "Bravo")).rm, "Connected",
      "writing one row must not disturb the rest of the day");
    assert.strictEqual(after.dates["2026-07-31"][0].notes, "",
      "the rest of the row (notes, provider, flags) must survive the write-back untouched");
    assert.strictEqual(after.providers.length, 1, "the provider roster must survive too");
  }

  /* 3. Re-selecting the value already on the row writes nothing — no revision churn, and no
        stale-tab fight started over a no-op. */
  {
    const { WS, root } = await openSeededDatabase();
    const slot = WS.slotName("10:30", "Bravo");
    const before = (await readSchedule(WS, root))._updatedAt;

    const wrote = await pushRmToSchedule(WS, root, "2026-07-31", slot, "Connected");
    assert.strictEqual(wrote, false, "an unchanged status must not rewrite schedule.json");
    assert.strictEqual((await readSchedule(WS, root))._updatedAt, before,
      "a no-op must not bump the revision");
  }

  /* 4. A patient who isn't on the schedule (report opened standalone) is a no-op, not a crash
        and not a phantom row. */
  {
    const { WS, root } = await openSeededDatabase();
    const wrote = await pushRmToSchedule(WS, root, "2026-07-31", WS.slotName("14:00", "Nobody"), "N/A");
    assert.strictEqual(wrote, false, "an unscheduled patient must not be written into the schedule");
    assert.strictEqual((await readSchedule(WS, root)).dates["2026-07-31"].length, 2,
      "the day must not gain a row");
  }

  /* 5. A database whose schedule has never been filled in reads cleanly instead of throwing —
        the Report Generator can be opened before anyone has built a day. (The store scaffolds
        schedule.json into every database, so this arrives as an empty `dates`, not a missing
        file — but the read has to survive either.) */
  {
    const { WS, root } = await openSeededDatabase(null);
    const sched = await readSchedule(WS, root);
    assert.deepStrictEqual(sched.dates, {}, "an unbuilt schedule must read as no days at all");
    assert.strictEqual(scheduleRowFor(WS, sched, "2026-07-31", "x"), null, "and yield no row");
    assert.strictEqual(await pushRmToSchedule(WS, root, "2026-07-31", "x", "Connected"), false,
      "with nothing to write back to, the status change must simply stay in the report");
  }

  console.log("ok");
}

run().catch((e) => { console.error(e); process.exit(1); });
