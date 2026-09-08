/* The durable journal: what survives a tab that never got to commit.
 *
 * A commit rewrites the whole container, so it runs on a cadence rather than per keystroke. That
 * leaves a window where an edit exists only in memory — close Chrome with a report open and it is
 * gone. The journal writes those same pending changes to IndexedDB as they happen and replays them
 * on reopen. Crashing here is modelled the only honest way: build a tab, stage edits, throw the tab
 * away WITHOUT committing, then open a fresh one against the same IndexedDB.
 *
 * What must remain true:
 *   • an edit staged and never committed comes back
 *   • so does a deletion
 *   • a commit supersedes the journal, and the row does not survive to be replayed on top
 *   • a row describing a different revision is discarded, never guessed at
 *   • a corrupt row loses the journal, not the database
 *   • forget() leaves nothing behind
 *   • on a protected database the row is CIPHERTEXT: no path, patient name or content in clear
 *   • typing never serializes the whole container
 *
 * Run with:  node tests/crmdb-journal.test.js
 */
"use strict";

const assert = require("assert");
const path = require("path");
if (!global.crypto) global.crypto = require("crypto").webcrypto;
global.window = global;
Object.defineProperty(global, "navigator", { value: {}, configurable: true, writable: true });
global.URL = { createObjectURL: function () { return "blob:x"; }, revokeObjectURL: function () {} };
global.document = {
  hidden: false, addEventListener: function () {},
  body: { appendChild() {}, removeChild() {} },
  createElement: () => ({ style: {}, click() {}, remove() {}, set href(v) {}, get href() { return ""; } })
};
global.addEventListener = function () {};
global.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };

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
        req.result = {
          objectStoreNames: { contains: (n) => data.has(n) },
          createObjectStore: (n) => { if (!data.has(n)) data.set(n, new Map()); return {}; },
          transaction: (n) => makeTx(n), close() {}
        };
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    }
  };
  const kv = () => data.get("kv");
  return { wipe: () => kv().clear(), get: (k) => kv().get(k), set: (k, v) => kv().set(k, v), keys: () => [...kv().keys()] };
}
const shared = installIndexedDB();

require("../vendor/crmdb-zip.js");
const realWrite = global.CRMDB.write;
let containerWrites = 0;
global.CRMDB.write = function (entries) {
  if (Array.isArray(entries) && entries.some((e) => e && e.name === "manifest.json")) containerWrites++;
  return realWrite.apply(this, arguments);
};

const STORE = path.resolve(__dirname, "../src/crmdb-store.js");
// Every instance ever created, because each case makes two (the one that "crashes" and the one
// that reopens) and BOTH keep live timers.
const tabs = [];
function newTab() { delete require.cache[STORE]; delete global.CRMWorkspace; const t = require(STORE); tabs.push(t); return t; }
// The journal write is debounced by 250ms, so "the user paused typing" is a real wait.
const paused = () => new Promise((r) => setTimeout(r, 400));
const settle = () => new Promise((r) => setTimeout(r, 0));
const dir = { prefix: "patients/2026-09-07/0800_DEMOAB/" };

// A tab that dies without committing: keep the IndexedDB, throw the module instance away.
function crashAndReopen() { return newTab(); }
// Discarding a module instance does not cancel its timers — persist() is on a 1200ms debounce and
// a queued journal write survives too. A stale instance whose journal is empty deletes the row this
// case just wrote, which is a test artefact, not a product bug: a real page has exactly one store.
// forget() cancels both timers, so retire every instance before starting.
async function fresh() {
  while (tabs.length) { const t = tabs.pop(); try { await t.forget(); } catch (e) {} }
  await settle();
  shared.wipe();
  const tab = newTab();
  await tab.newDatabase();
  await settle();
  return tab;
}

async function run() {
  /* 1. THE POINT: an edit staged and never committed survives the tab. */
  {
    const tab = await fresh();
    await tab.writeFile(dir, "report.json", JSON.stringify({ finding: "NS-VT at 09:18" }), { defer: true });
    await paused();
    assert.ok(shared.get("journal"), "a staged edit must be durable before any commit");

    const next = crashAndReopen();
    await next.stored();
    await settle();
    assert.strictEqual(JSON.parse(await next.readText(dir, "report.json")).finding, "NS-VT at 09:18",
      "the edit the crashed tab never committed must come back");
    // And it is still pending, so the next commit carries it into the container.
    assert.strictEqual(next.saveState.state, "edited");
  }

  /* 2. Deletions survive too — a replay that only re-adds files would resurrect deleted ones. */
  {
    const tab = await fresh();
    await tab.writeFile(dir, "scratch.txt", "delete me");
    await tab.flush();
    await settle();
    await tab.removeSlotFiles(null, "2026-09-07", "0800_DEMOAB");
    await paused();

    const next = crashAndReopen();
    await next.stored();
    await settle();
    await assert.rejects(() => next.readText(dir, "scratch.txt"), /not found/,
      "a deletion staged before the crash must not come back as a resurrected file");
  }

  /* 3. A commit supersedes the journal. The row must not survive to be replayed onto it. */
  {
    const tab = await fresh();
    await tab.writeFile(dir, "report.json", JSON.stringify({ v: 1 }), { defer: true });
    await paused();
    assert.ok(shared.get("journal"), "staged");
    await tab.flush();
    await settle();
    assert.ok(!shared.get("journal"), "a published commit must take its journal row with it");

    const next = crashAndReopen();
    await next.stored();
    await settle();
    assert.strictEqual(JSON.parse(await next.readText(dir, "report.json")).v, 1);
    assert.strictEqual(next.saveState.state, "browser", "nothing should still be pending after a commit");
  }

  /* 4. A row describing a different revision is discarded, not guessed at. */
  {
    const tab = await fresh();
    await tab.writeFile(dir, "report.json", JSON.stringify({ v: 1 }), { defer: true });
    await paused();
    const row = shared.get("journal");
    shared.set("journal", { rev: Number(row.rev) + 99, blob: row.blob });

    const next = crashAndReopen();
    await next.stored();
    await settle();
    await assert.rejects(() => next.readText(dir, "report.json"), /not found/,
      "a journal from another revision describes a bundle that is not this one");
    assert.ok(!shared.get("journal"), "and it is cleared rather than left to be retried forever");
  }

  /* 5. A corrupt row costs the journal, never the database. */
  {
    const tab = await fresh();
    await tab.writeFile(dir, "keeper.txt", "committed content");
    await tab.flush();
    await settle();
    await tab.writeFile(dir, "report.json", "staged", { defer: true });
    await paused();
    const row = shared.get("journal");
    shared.set("journal", { rev: row.rev, blob: new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])]) });

    const next = crashAndReopen();
    await next.stored();
    await settle();
    assert.strictEqual(await next.readText(dir, "keeper.txt"), "committed content",
      "a malformed journal must degrade to the committed container, not lose it");
    assert.ok(!shared.get("journal"));
  }

  /* 6. forget() leaves nothing behind — "wipes this browser's copy" has to be true. */
  {
    const tab = await fresh();
    await tab.writeFile(dir, "report.json", "sensitive", { defer: true });
    await paused();
    assert.ok(shared.get("journal"));
    await tab.forget();
    await settle();
    assert.ok(!shared.get("journal"), "a journal row surviving forget() is clinical data left on the station");
    assert.deepStrictEqual(shared.keys().filter((k) => k !== "fileMeta"), [], "nothing else may linger either");
  }

  /* 7. On a protected database the row is ciphertext — filenames included. */
  {
    const tab = await fresh();
    await tab.enableProtection("correct horse battery staple");
    await settle();
    await tab.writeFile(dir, "report.json", JSON.stringify({ patient: "DEMOAB", finding: "NS-VT" }), { defer: true });
    await paused();
    const row = shared.get("journal");
    assert.ok(row && row.blob, "protected databases still journal");
    const bytes = Buffer.from(await row.blob.arrayBuffer());
    for (const secret of ["DEMOAB", "NS-VT", "report.json", "patients/", "__deleted"]) {
      assert.ok(!bytes.includes(Buffer.from(secret, "latin1")),
        "the sealed journal leaked " + JSON.stringify(secret) + " — paths and content must stay inside the envelope");
    }
    assert.strictEqual(bytes.slice(0, 8).toString("latin1"), "CRMDBENC", "it must be the same sealed envelope the container uses");

    // ...and it still replays, through the session key rather than a password prompt.
    const next = crashAndReopen();
    next.onPasswordRequest = () => Promise.resolve("correct horse battery staple");
    await next.stored();
    await settle();
    assert.strictEqual(JSON.parse(await next.readText(dir, "report.json")).finding, "NS-VT",
      "a sealed journal must replay for the database it belongs to");
  }

  /* 8. None of this made typing serialize the container. */
  {
    const tab = await fresh();
    const before = containerWrites;
    for (let i = 0; i < 10; i++) await tab.writeFile(dir, "report.json", JSON.stringify({ edit: i }), { defer: true });
    await paused();
    assert.strictEqual(containerWrites, before,
      "the journal must cost pending changes, not the whole container (saw " + (containerWrites - before) + " container writes)");
  }

  console.log("PASS durable journal: staged work survives a crash, a commit supersedes it, and the row is sealed");
}

run().catch((e) => { console.error(e); process.exit(1); });
