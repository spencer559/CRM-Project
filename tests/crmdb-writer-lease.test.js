/* One writer per database.
 *
 * Two tabs on one database is what every guard in the store is weakest against, and the durable
 * journal sharpened it: a second tab's commit advances the revision, which makes the first tab's
 * staged row unreplayable, so a crash silently drops that work. Rather than merge two writers
 * correctly, only one is allowed to write at all.
 *
 * Web Locks is the primitive because the browser releases a held lock when the tab dies — there is
 * no heartbeat to tune and no judgement call about whether silence means a crash. This exercises
 * the store's use of it against a fake lock manager with the same semantics.
 *
 * What must remain true:
 *   • the first tab to open gets the lease and writes normally
 *   • a second tab writes NOTHING: no commit, no journal row, no file write-through
 *   • a reader reports itself as read-only rather than pretending to save
 *   • closing the writer promotes the waiting reader automatically
 *   • closing the DATABASE hands the lease over too, not just closing the tab
 *   • a browser with no Web Locks keeps working, and says it is unprotected
 *
 * Run with:  node tests/crmdb-writer-lease.test.js
 */
"use strict";

const assert = require("assert");
const path = require("path");
if (!global.crypto) global.crypto = require("crypto").webcrypto;
global.window = global;
global.URL = { createObjectURL: () => "blob:x", revokeObjectURL() {} };
global.document = {
  hidden: false, addEventListener() {},
  body: { appendChild() {}, removeChild() {} },
  createElement: () => ({ style: {}, click() {}, remove() {}, set href(v) {}, get href() { return ""; } })
};
global.addEventListener = function () {};
global.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };

/* A lock manager with the semantics that matter: exclusive, queued, and released when the holder's
   promise settles (which is how a real browser frees a lock for a tab that died). */
function makeLocks() {
  const held = new Map();      // name -> { release }
  const queue = new Map();     // name -> [fn]
  function grant(name, cb) {
    // A lock is held until the callback's promise settles — that is how the store releases it on
    // "Close database". A dying tab is different: the browser frees the lock whatever the callback
    // is doing, so killHolder has to win the race rather than wait for it.
    let kill;
    const killed = new Promise((r) => { kill = r; });
    held.set(name, { kill });
    const done = Promise.race([Promise.resolve(cb({ name })), killed]);
    done.then(() => {
      held.delete(name);
      const waiting = (queue.get(name) || []).shift();
      if (waiting) waiting();
    });
    return done;
  }
  return {
    api: {
      request(name, opts, cb) {
        if (typeof opts === "function") { cb = opts; opts = {}; }
        if (!held.has(name)) return Promise.resolve(grant(name, cb));
        if (opts && opts.ifAvailable) return Promise.resolve(cb(null));
        return new Promise((resolve) => {
          (queue.get(name) || queue.set(name, []).get(name)).push(() => resolve(grant(name, cb)));
        });
      }
    },
    // What the browser does when a tab is closed or crashes.
    killHolder(name) { const h = held.get(name); if (h) h.kill(); }
  };
}

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
  return { wipe: () => kv().clear(), get: (k) => kv().get(k), keys: () => [...kv().keys()] };
}
const shared = installIndexedDB();

require("../vendor/crmdb-zip.js");
const STORE = path.resolve(__dirname, "../src/crmdb-store.js");
function newTab() { delete require.cache[STORE]; delete global.CRMWorkspace; return require(STORE); }
const settle = () => new Promise((r) => setTimeout(r, 0));
const paused = () => new Promise((r) => setTimeout(r, 400));
const dir = { prefix: "patients/2026-09-07/0800_DEMOAB/" };

async function run() {
  /* 1. First tab writes; second tab writes nothing at all. */
  {
    shared.wipe();
    const locks = makeLocks();
    Object.defineProperty(global, "navigator", { value: { locks: locks.api }, configurable: true, writable: true });

    const first = newTab();
    await first.newDatabase();
    await settle();
    assert.deepStrictEqual(first.leaseStatus(), { writer: true, supported: true },
      "the first tab to open owns the lease");

    const second = newTab();
    await second.stored();
    await settle();
    assert.strictEqual(second.leaseStatus().writer, false, "a second tab must not become a writer");
    assert.strictEqual(second.saveState.state, "readonly", "and must say so rather than look normal");

    // Nothing the reader does may reach storage.
    const before = JSON.stringify(shared.keys().sort());
    await second.writeFile(dir, "report.json", "from the reader", { defer: true });
    await paused();
    await second.flush();
    await settle();
    assert.strictEqual(JSON.stringify(shared.keys().sort()), before,
      "a reader must not commit, and must not leave a journal row either");
    assert.strictEqual(second.saveState.state, "readonly", "typing in a reader does not make it a writer");

    // The writer is unaffected and still works.
    await first.writeFile(dir, "report.json", "from the writer", { defer: true });
    await paused();
    assert.ok(shared.get("journal"), "the real writer still journals normally");
  }

  /* 2. Closing the writer promotes the waiting reader — no user action, no polling. */
  {
    shared.wipe();
    const locks = makeLocks();
    Object.defineProperty(global, "navigator", { value: { locks: locks.api }, configurable: true, writable: true });

    const first = newTab();
    await first.newDatabase();
    await settle();
    const second = newTab();
    await second.stored();
    await settle();
    assert.strictEqual(second.leaseStatus().writer, false);

    // The reader typed while it could not save. bset still mutates its in-memory bundle, so those
    // ghost edits must be dropped on promotion rather than published over the other tab's work.
    await second.writeFile(dir, "report.json", "typed while read-only", { defer: true });
    await settle();

    locks.killHolder("crmdb-writer");           // the writing tab is closed
    await settle(); await settle(); await settle(); await settle();
    assert.strictEqual(second.leaseStatus().writer, true, "the waiting tab must take over by itself");
    assert.notStrictEqual(second.saveState.state, "readonly");
    await assert.rejects(() => second.readText(dir, "report.json"), /not found/,
      "work typed while read-only must not survive promotion — it was never publishable");

    await second.writeFile(dir, "report.json", "now allowed", { defer: true });
    await paused();
    assert.ok(shared.get("journal"), "and it can write once promoted");
  }

  /* 3. Closing the DATABASE releases the lease too — not only closing the tab. */
  {
    shared.wipe();
    const locks = makeLocks();
    Object.defineProperty(global, "navigator", { value: { locks: locks.api }, configurable: true, writable: true });

    const first = newTab();
    await first.newDatabase();
    await settle();
    const second = newTab();
    await second.stored();
    await settle();
    assert.strictEqual(second.leaseStatus().writer, false);

    await first.forget();                        // "Close database", tab stays open
    await settle(); await settle();
    assert.strictEqual(second.leaseStatus().writer, true,
      "a waiting tab should not have to wait for the other page to close");
  }

  /* 4. No Web Locks: keep working, but do not claim to be protected. */
  {
    shared.wipe();
    Object.defineProperty(global, "navigator", { value: {}, configurable: true, writable: true });
    const only = newTab();
    await only.newDatabase();
    await settle();
    assert.deepStrictEqual(only.leaseStatus(), { writer: true, supported: false },
      "an unsupported browser must report that nothing is enforcing single-writer");
    await only.writeFile(dir, "report.json", "still works", { defer: true });
    await paused();
    assert.ok(shared.get("journal"), "and must behave exactly as it did before the lease existed");
  }

  console.log("PASS writer lease: one writer, a silent reader writes nothing, and promotion is automatic");
}

run().catch((e) => { console.error(e); process.exit(1); });
