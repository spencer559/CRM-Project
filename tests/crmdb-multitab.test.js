/* Two same-origin tabs sharing one .crmdb working copy (the everyday Schedule + Report Generator
 * pair). Each tab holds its own in-memory bundle and a save serializes the WHOLE bundle, so
 * without the journal/revision CAS in crmdb-store.js the tabs silently overwrite each other:
 * schedule edits revert, reports revert, and attached files are deleted outright.
 *
 * Run with:  node tests/crmdb-multitab.test.js
 */
"use strict";

const assert = require("assert");
const path = require("path");
if (!global.crypto) global.crypto = require("crypto").webcrypto;
global.window = global;

/* Minimal in-memory IndexedDB. The repo ships no npm dependencies (see vendor/crmdb-zip.js), and
 * the store only ever does open/get/put/delete against one "kv" object store. Each transaction
 * drains its queued ops synchronously — including ops queued from a request's own onsuccess,
 * which is exactly how idbCas issues its conditional put — then fires oncomplete. */
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
    open(name) {
      const req = {};
      queueMicrotask(() => {
        req.result = {
          objectStoreNames: { contains: (n) => data.has(n) },
          createObjectStore: (n) => { if (!data.has(n)) data.set(n, new Map()); return {}; },
          transaction: (n) => makeTx(n),
          close() {}
        };
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    },
    _raw: data
  };
  return {
    get: (k) => data.get("kv").get(k),
    set: (k, v) => data.get("kv").set(k, v),
    wipe: () => { if (data.has("kv")) data.get("kv").clear(); }
  };
}
const shared = installIndexedDB();

require("../vendor/crmdb-zip.js");
const STORE = path.resolve(__dirname, "../src/crmdb-store.js");
// A fresh module instance is a fresh tab: its own `bundle`, `journal` and revision baseline.
function newTab() { delete require.cache[STORE]; delete global.CRMWorkspace; return require(STORE); }

const D = "2026-07-15", S = "0900_TEST_PT";
const P = (n) => "patients/" + D + "/" + S + "/" + n;

async function seed(files) {
  shared.wipe();
  const s = newTab();
  s._bundle.set("schedule.json", new Blob(['{"seed":1}']));
  Object.keys(files).forEach((k) => s._bundle.set(P(k), new Blob([files[k]])));
  shared.set("bundle", await s._serialize());
  shared.set("rev", 1);
}
async function observe() {                       // a third tab reading the committed truth
  const o = newTab();
  await o.reloadWorkingCopy();
  const dir = await o.slotDir("ROOT", D, S, false);
  const files = (await o.listFiles(dir)).map((f) => f.name).sort();
  const read = async (n) => { try { return await o.readText(dir, n); } catch (e) { return null; } };
  const sched = await o.readText({ prefix: "" }, "schedule.json");
  return { files, read, schedule: sched };
}
const dirOf = (tab) => tab.slotDir("ROOT", D, S, true);

async function run() {
  /* 1. A CRM live-sync must not revert a schedule edit made in the other tab. */
  await seed({ "report.json": '{"pt":"ORIGINAL"}' });
  let crm = newTab(), sched = newTab();
  await crm.reloadWorkingCopy(); await sched.reloadWorkingCopy();
  await sched.writeFile({ prefix: "" }, "schedule.json", '{"rows":["EDITED"]}');
  await sched.flush();
  await crm.writeFile(await dirOf(crm), "report.json", '{"pt":"UPDATED"}');
  await crm.flush();                              // fires on every keystroke, 1.5s debounced
  // Read through helpers that degrade to a readable value, so a regression reports what the
  // database actually holds instead of throwing on a missing key.
  const rowOf = (txt) => ((JSON.parse(txt) || {}).rows || ["<no rows — reverted to seed>"])[0];
  const ptOf = async (o) => (JSON.parse((await o.read("report.json")) || "{}").pt || "<missing>");

  let o = await observe();
  assert.strictEqual(rowOf(o.schedule), "EDITED",
    "schedule edit was reverted by the CRM tab's live-sync; schedule.json is now " + o.schedule);
  assert.strictEqual(await ptOf(o), "UPDATED", "CRM's own write did not land");

  /* 2. ...and the reverse: a Schedule save must not revert the report. */
  await sched.writeFile({ prefix: "" }, "schedule.json", '{"rows":["EDITED-AGAIN"]}');
  await sched.flush();
  o = await observe();
  assert.strictEqual(await ptOf(o), "UPDATED", "report was reverted by the Schedule tab's save");

  /* 3. A file attached in one tab must not be DELETED by the other tab's next save. */
  await sched.writeFile(await dirOf(sched), "prog-report.pdf", new Blob(["%PDF-1.4"]));
  await sched.flush();
  await crm.writeFile(await dirOf(crm), "report.json", '{"pt":"AGAIN"}');
  await crm.flush();
  o = await observe();
  assert.ok(o.files.includes("prog-report.pdf"),
    "attached PDF was DELETED by the other tab's save; slot now holds " + JSON.stringify(o.files));

  /* 4. A deletion must not be resurrected by a stale tab. */
  await seed({ "report.json": '{"v":1}', "old.pdf": "X" });
  let a = newTab(), b = newTab();
  await a.reloadWorkingCopy(); await b.reloadWorkingCopy();
  await a.removeFile("ROOT", D, S, "old.pdf");
  await a.flush();
  await b.writeFile(await dirOf(b), "report.json", '{"v":2}');
  await b.flush();
  o = await observe();
  assert.ok(!o.files.includes("old.pdf"), "a stale tab resurrected a deleted file");
  assert.strictEqual(JSON.parse(await o.read("report.json")).v, 2);

  /* 5. An idle tab's flush (e.g. on navigation) must not republish its stale bundle. */
  await seed({ "report.json": '{"v":1}' });
  a = newTab(); b = newTab();
  await a.reloadWorkingCopy(); await b.reloadWorkingCopy();
  await a.writeFile(await dirOf(a), "report.json", '{"v":"NEWER"}');
  await a.flush();
  await b.flush();                                // nothing journalled → must be a no-op
  o = await observe();
  assert.strictEqual(JSON.parse(await o.read("report.json")).v, "NEWER", "an idle tab's flush reverted newer data");

  /* 6. Opening a database from a file REPLACES the working copy (authoritative), not merges. */
  await seed({ "report.json": '{"from":"working-copy"}', "stale.pdf": "S" });
  const fresh = newTab();
  fresh._bundle.set("schedule.json", new Blob(['{"fresh":1}']));
  fresh._bundle.set(P("report.json"), new Blob(['{"from":"opened-file"}']));
  const bytes = await (await fresh._serialize()).arrayBuffer();
  const c = newTab();
  await c._ingest(bytes);                         // what connect() does with the picked file
  c._markAuthoritativeForTest();
  await c.flush();
  o = await observe();
  assert.strictEqual(JSON.parse(await o.read("report.json")).from, "opened-file", "opening a file did not replace the working copy");
  assert.ok(!o.files.includes("stale.pdf"), "opening a file kept the old working copy's files");

  /* 7. The CAS: another tab commits mid-serialize → retry, don't clobber. */
  await seed({ "report.json": '{"v":1}' });
  a = newTab();
  await a.reloadWorkingCopy();
  await a.writeFile(await dirOf(a), "racer.txt", "A");
  const inflight = a.flush();                     // read rev=1, then serialize…
  shared.set("rev", 99);                          // …someone else commits underneath
  await inflight;
  assert.ok(Number(shared.get("rev")) > 99, "a blind write ignored the moved revision");
  o = await observe();
  assert.ok(o.files.includes("racer.txt"), "the racing tab's data was lost");

  console.log("crmdb multi-tab: journal + revision CAS keeps two tabs from overwriting each other — passed");
}

run().catch((e) => { console.error(e); process.exit(1); });
