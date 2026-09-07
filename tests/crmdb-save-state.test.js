/* Where does my work actually live right now?
 *
 * `onStatus` is transient narration — the next message overwrites it, so a save that failed can be
 * buried by whatever happens next. The save contract is the durable answer, and these are the
 * properties the UI is allowed to rely on:
 *
 *   • nothing open reads as closed, and subscribing delivers the current value immediately
 *   • a staged edit reads as edited until it is actually published
 *   • a commit with no bound file reads as browser — the resting state on iPad, not a transient
 *   • a failed save reads as failed and STAYS failed; typing must not paper over it
 *   • only a real success clears a failure
 *
 * Run with:  node tests/crmdb-save-state.test.js
 */
"use strict";

const assert = require("assert");
const path = require("path");
if (!global.crypto) global.crypto = require("crypto").webcrypto;
global.window = global;
Object.defineProperty(global, "navigator", { value: {}, configurable: true, writable: true });
global.URL = { createObjectURL: function () { return "blob:x"; }, revokeObjectURL: function () {} };
global.document = {
  hidden: false,
  addEventListener: function () {},
  body: { appendChild() {}, removeChild() {} },
  createElement: () => ({ style: {}, click() {}, remove() {}, set href(v) {}, get href() { return ""; } })
};
global.addEventListener = function () {};

function installIndexedDB() {
  let failBundleWrite = false;
  const data = new Map([["kv", new Map()]]);
  function makeTx(storeName) {
    const ops = [];
    const tx = { oncomplete: null, onerror: null, error: null, objectStore: () => store };
    const store = {
      get(k) { const rq = {}; ops.push(() => { rq.result = data.get(storeName).get(k); if (rq.onsuccess) rq.onsuccess(); }); return rq; },
      put(v, k) { const rq = {}; ops.push(() => { if (k === "bundle" && failBundleWrite) throw new Error("disk quota"); data.get(storeName).set(k, v); if (rq.onsuccess) rq.onsuccess(); }); return rq; },
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
  return { wipe: () => data.get("kv").clear(), failWrites: (v) => { failBundleWrite = v; } };
}
const shared = installIndexedDB();

require("../vendor/crmdb-zip.js");
const STORE = path.resolve(__dirname, "../src/crmdb-store.js");
function newTab() { delete require.cache[STORE]; delete global.CRMWorkspace; return require(STORE); }
const settle = () => new Promise((r) => setTimeout(r, 0));
const dir = { prefix: "patients/2026-09-07/0800_AB/" };

async function run() {
  /* 1. Nothing open, and a subscriber learns that without waiting for an event. */
  {
    shared.wipe(); shared.failWrites(false);
    const tab = newTab();
    assert.strictEqual(tab.saveState.state, "closed");
    const seen = [];
    tab.onSaveState = (st) => seen.push(st.state);
    assert.deepStrictEqual(seen, ["closed"], "subscribing must deliver the current state at once");

    await tab.newDatabase();
    await settle();
    assert.strictEqual(tab.saveState.state, "browser",
      "with no bound file, a published database lives in the browser and nowhere else");
    assert.strictEqual(tab.saveState.bound, false);
  }

  /* 2. A staged edit is honestly reported as not-yet-published, then as published. */
  {
    shared.wipe(); shared.failWrites(false);
    const tab = newTab();
    await tab.newDatabase();
    await settle();
    const seen = [];
    tab.onSaveState = (st) => seen.push(st.state);

    await tab.writeFile(dir, "report.json", JSON.stringify({ edit: 1 }), { defer: true });
    assert.strictEqual(tab.saveState.state, "edited", "a staged edit is not in the browser copy yet");

    await tab.writeFile(dir, "report.json", JSON.stringify({ edit: 2 }), { defer: true });
    await tab.writeFile(dir, "notes.txt", "more", { defer: true });
    assert.deepStrictEqual(seen.filter((s) => s === "edited").length, 1,
      "a burst of edits is one transition, not one per written path");

    await tab.flush();
    await settle();
    assert.strictEqual(tab.saveState.state, "browser");
    assert.ok(seen.indexOf("saving") >= 0, "the in-flight state is observable, not skipped");
  }

  /* 3. THE POINT: a failed save is sticky. Typing over it must not make it look fine. */
  {
    shared.wipe(); shared.failWrites(false);
    const tab = newTab();
    await tab.newDatabase();
    await settle();

    shared.failWrites(true);
    await tab.writeFile(dir, "report.json", JSON.stringify({ edit: 3 }), { defer: true });
    await tab.flush().catch(() => {});
    await settle();
    assert.strictEqual(tab.saveState.state, "failed", "a commit that could not be published reads as failed");
    assert.match(tab.saveState.detail, /quota/, "the reason travels with the state");

    // The work is still here, and the technician keeps typing. The indicator must not lie.
    await tab.writeFile(dir, "report.json", JSON.stringify({ edit: 4 }), { defer: true });
    assert.strictEqual(tab.saveState.state, "failed",
      "editing after a failed save must not clear the failure — this is the whole point of the contract");

    // Only a save that actually lands clears it.
    shared.failWrites(false);
    await tab.flush();
    await settle();
    assert.strictEqual(tab.saveState.state, "browser", "a real success is what clears a failure");
    assert.strictEqual(tab.saveState.detail, "");
  }

  /* 4. Closing puts it back to closed, and drops the pending work with the database. */
  {
    shared.wipe(); shared.failWrites(false);
    const tab = newTab();
    await tab.newDatabase();
    await settle();
    await tab.writeFile(dir, "report.json", "x", { defer: true });
    assert.strictEqual(tab.saveState.state, "edited");
    await tab.forget();
    assert.strictEqual(tab.saveState.state, "closed");
  }

  console.log("PASS save contract: edited / saving / browser / failed are observable, and failure is sticky");
}

run().catch((e) => { console.error(e); process.exit(1); });
