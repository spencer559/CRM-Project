/**
 * Mileage cloud sync (client) — talks to the Cloudflare Worker.
 * -----------------------------------------------------------------
 * Offline-first: the calculator keeps working entirely from localStorage
 * ("mileageToolV1"). This layer adds optional login + cross-device sync.
 * If WORKER_URL is blank, this file does nothing and the page stays local-only.
 *
 * This file is loaded ONLY by the Mileage Calculator page. It shares no code
 * with the CRM interrogation form and never reads or writes CRM/PHI data.
 */
(function () {
  "use strict";

  // ======= CONFIG — paste your deployed Worker URL here after `wrangler deploy` =======
  // Example: "https://mileage-sync.yourname.workers.dev"  (no trailing slash)
  var WORKER_URL = "https://mileage-sync.spencer559.workers.dev";
  // ====================================================================================

  if (!WORKER_URL) return; // not configured yet -> stay purely local, no UI

  var DATA_KEY = "mileageToolV1";   // the calculator's own data blob
  var AUTH_KEY = "mileageAuthV1";   // { token, username, exp }
  var META_KEY = "mileageSyncV1";   // { lastVersion, lastSyncHash, localEditedAt, lastSyncAt }
  var pushTimer = null;

  // ---------- tiny storage helpers ----------
  function getJSON(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } }
  function setJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function getData() { return localStorage.getItem(DATA_KEY) || ""; }
  function setData(s) { try { localStorage.setItem(DATA_KEY, s == null ? "" : s); } catch (e) {} }
  function meta() { return getJSON(META_KEY) || { lastVersion: 0, lastSyncHash: 0, localEditedAt: 0, lastSyncAt: 0 }; }
  function setMeta(m) { setJSON(META_KEY, m); }
  function auth() { return getJSON(AUTH_KEY); }
  function hashStr(s) { var h = 5381; for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return h >>> 0; }

  function tokenValid() {
    var a = auth();
    return a && a.token && a.exp && Date.now() / 1000 < a.exp;
  }

  // ---------- API ----------
  function api(path, method, bodyObj, withAuth) {
    var headers = { "Content-Type": "application/json" };
    if (withAuth) { var a = auth(); if (a && a.token) headers["Authorization"] = "Bearer " + a.token; }
    return fetch(WORKER_URL + path, {
      method: method,
      headers: headers,
      body: bodyObj ? JSON.stringify(bodyObj) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { status: res.status, ok: res.ok, data: data };
      });
    });
  }

  function decodeExp(token) {
    try {
      var p = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      while (p.length % 4) p += "=";
      return JSON.parse(atob(p)).exp || 0;
    } catch (e) { return 0; }
  }

  // ---------- sync core ----------
  function pushNow() {
    if (!tokenValid()) return Promise.resolve();
    var data = getData();
    var m = meta();
    if (hashStr(data) === m.lastSyncHash) { setStatus("Synced"); return Promise.resolve(); }
    setStatus("Saving…");
    return api("/profile", "PUT", { data: data, baseVersion: m.lastVersion }, true).then(function (r) {
      if (r.ok) {
        setMeta({ lastVersion: r.data.version, lastSyncHash: hashStr(data), localEditedAt: m.localEditedAt, lastSyncAt: Date.now() });
        setStatus("Synced");
      } else if (r.status === 409) {
        resolveConflict(r.data);
      } else if (r.status === 401) {
        signOut(true);
      } else {
        setStatus("Sync error");
      }
    }).catch(function () { setStatus("Offline — will retry"); });
  }

  function resolveConflict(server) {
    // Last-write-wins by timestamp. If our local edit is newer than the server
    // copy, force-push ours; otherwise adopt the server copy.
    var m = meta();
    var serverTime = server.updatedAt ? Date.parse(server.updatedAt) : 0;
    if (m.localEditedAt && m.localEditedAt > serverTime) {
      var data = getData();
      api("/profile", "PUT", { data: data, force: true }, true).then(function (r) {
        if (r.ok) { setMeta({ lastVersion: r.data.version, lastSyncHash: hashStr(data), localEditedAt: m.localEditedAt, lastSyncAt: Date.now() }); setStatus("Synced"); }
      });
    } else {
      adoptServer(server.data, server.version);
    }
  }

  function adoptServer(data, version) {
    setData(data);
    setMeta({ lastVersion: version, lastSyncHash: hashStr(data || ""), localEditedAt: 0, lastSyncAt: Date.now() });
    // The calculator reads localStorage at load; reload once so it re-renders
    // with the freshly pulled data. Guarded so we never loop.
    if (!sessionStorage.getItem("mileageSyncReloaded")) {
      sessionStorage.setItem("mileageSyncReloaded", "1");
      location.reload();
    } else {
      setStatus("Synced");
    }
  }

  function pullThenReconcile() {
    if (!tokenValid()) return;
    setStatus("Checking…");
    api("/profile", "GET", null, true).then(function (r) {
      if (r.status === 401) { signOut(true); return; }
      if (!r.ok) { setStatus("Offline"); return; }
      var m = meta();
      var localData = getData();
      var localDirty = hashStr(localData) !== m.lastSyncHash;
      var serverHasNewer = (r.data.version || 0) > m.lastVersion;
      var serverHasData = r.data.data && r.data.data.length;

      if (serverHasNewer && !localDirty) {
        adoptServer(r.data.data, r.data.version);
      } else if (serverHasNewer && localDirty) {
        // both changed -> LWW
        resolveConflict(r.data);
      } else if (!serverHasData && localData && localData.length) {
        // first login on a fresh account: seed server from this device
        pushNow();
      } else if (localDirty) {
        pushNow();
      } else {
        setMeta({ lastVersion: r.data.version || m.lastVersion, lastSyncHash: hashStr(localData), localEditedAt: m.localEditedAt, lastSyncAt: Date.now() });
        setStatus("Synced");
      }
    }).catch(function () { setStatus("Offline"); });
  }

  // called by the page whenever the calculator saves
  function onLocalSave() {
    if (!tokenValid()) return;
    var m = meta();
    m.localEditedAt = Date.now();
    setMeta(m);
    setStatus("Saving…");
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(pushNow, 1500);
  }

  // ---------- auth actions ----------
  function saveAuth(token, username) {
    setJSON(AUTH_KEY, { token: token, username: username, exp: decodeExp(token) });
  }
  function signOut(expired) {
    localStorage.removeItem(AUTH_KEY);
    // Clear the sync bookkeeping but LEAVE the local data in place so the
    // calculator still works offline after signing out.
    localStorage.removeItem(META_KEY);
    sessionStorage.removeItem("mileageSyncReloaded");
    renderBar();
    if (expired) openModal("Your session expired — please sign in again.");
  }

  // ---------- UI ----------
  var barEl, statusEl, modalEl;

  function setStatus(text) { if (statusEl) statusEl.textContent = text; }

  function renderBar() {
    if (!barEl) {
      barEl = document.createElement("div");
      barEl.id = "mileageSyncBar";
      barEl.style.cssText = "display:flex;align-items:center;gap:12px;justify-content:flex-end;" +
        "padding:8px 14px;font:500 13px system-ui,Segoe UI,Roboto,sans-serif;" +
        "background:#0b2230;color:#f5ead0;border-bottom:1px solid rgba(232,192,89,.35);";
      document.body.insertBefore(barEl, document.body.firstChild);
    }
    var a = auth();
    if (tokenValid()) {
      barEl.innerHTML =
        '<span style="opacity:.8">☁ <span id="mSyncStatus">Synced</span> · ' + escapeHtml(a.username) + "</span>" +
        '<button id="mSyncPush" style="' + btnCss() + '">Sync now</button>' +
        '<button id="mSyncOut" style="' + btnCss() + '">Sign out</button>';
      statusEl = document.getElementById("mSyncStatus");
      document.getElementById("mSyncPush").onclick = pullThenReconcile;
      document.getElementById("mSyncOut").onclick = function () { signOut(false); };
    } else {
      barEl.innerHTML =
        '<span style="opacity:.8">☁ Cloud sync</span>' +
        '<button id="mSyncIn" style="' + btnCss() + '">Sign in / Register</button>';
      statusEl = null;
      document.getElementById("mSyncIn").onclick = function () { openModal(""); };
    }
  }

  function btnCss() {
    return "cursor:pointer;background:rgba(232,192,89,.15);color:#f5ead0;border:1px solid rgba(232,192,89,.55);" +
      "border-radius:7px;padding:5px 12px;font:500 13px system-ui,sans-serif;";
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  function openModal(notice) {
    closeModal();
    modalEl = document.createElement("div");
    modalEl.style.cssText = "position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;" +
      "background:rgba(3,12,18,.72);font:400 14px system-ui,Segoe UI,Roboto,sans-serif;";
    var mode = "login"; // or "register"
    function card() {
      var isReg = mode === "register";
      return '<div style="background:#0b2230;color:#f5ead0;width:min(380px,92vw);padding:22px;border-radius:12px;' +
        'border:1px solid rgba(232,192,89,.4);box-shadow:0 18px 50px rgba(0,0,0,.5);">' +
        '<div style="font:600 17px system-ui;margin-bottom:4px;">' + (isReg ? "Create account" : "Sign in") + "</div>" +
        (notice ? '<div style="color:#f8db7e;font-size:13px;margin-bottom:8px;">' + escapeHtml(notice) + "</div>" : "") +
        '<div id="mErr" style="color:#ff9b7a;font-size:13px;min-height:16px;margin:6px 0;"></div>' +
        row("Username", '<input id="mUser" autocomplete="username" style="' + inpCss() + '">') +
        row("Passphrase", '<input id="mPass" type="password" autocomplete="current-password" style="' + inpCss() + '">') +
        (isReg ? row("Invite code", '<input id="mInvite" style="' + inpCss() + '">') : "") +
        '<button id="mGo" style="' + goCss() + '">' + (isReg ? "Create account" : "Sign in") + "</button>" +
        '<div style="text-align:center;margin-top:12px;font-size:13px;opacity:.85;">' +
        (isReg ? 'Have an account? <a id="mSwap" href="#" style="color:#f8db7e;">Sign in</a>'
               : 'New here? <a id="mSwap" href="#" style="color:#f8db7e;">Create an account</a>') +
        '</div>' +
        '<div style="text-align:center;margin-top:10px;"><a id="mClose" href="#" style="color:#9fb3bd;font-size:12px;">Cancel</a></div>' +
        "</div>";
    }
    function inpCss() { return "width:100%;margin:4px 0 10px;padding:9px 10px;border-radius:7px;border:1px solid rgba(232,192,89,.4);background:#06141d;color:#f5ead0;font:400 14px system-ui;box-sizing:border-box;"; }
    function goCss() { return "width:100%;cursor:pointer;background:#e8c059;color:#1a1206;border:none;border-radius:8px;padding:11px;font:700 14px system-ui;margin-top:4px;"; }
    function row(label, field) { return '<label style="display:block;font-size:12px;opacity:.8;">' + label + "</label>" + field; }

    function bind() {
      modalEl.innerHTML = card();
      document.getElementById("mClose").onclick = function (e) { e.preventDefault(); closeModal(); };
      document.getElementById("mSwap").onclick = function (e) { e.preventDefault(); mode = mode === "register" ? "login" : "register"; bind(); };
      document.getElementById("mGo").onclick = submit;
      modalEl.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });
      document.getElementById("mUser").focus();
    }
    function submit() {
      var err = document.getElementById("mErr");
      err.textContent = "";
      var username = (document.getElementById("mUser").value || "").trim();
      var password = document.getElementById("mPass").value || "";
      var isReg = mode === "register";
      var path = isReg ? "/register" : "/login";
      var payload = { username: username, password: password };
      if (isReg) payload.inviteCode = (document.getElementById("mInvite").value || "").trim();
      document.getElementById("mGo").textContent = "…";
      api(path, "POST", payload, false).then(function (r) {
        if (r.ok && r.data.token) {
          saveAuth(r.data.token, r.data.username);
          closeModal();
          renderBar();
          pullThenReconcile();
        } else {
          err.textContent = (r.data && r.data.message) || (r.data && r.data.error) || "Something went wrong.";
          document.getElementById("mGo").textContent = isReg ? "Create account" : "Sign in";
        }
      }).catch(function () {
        err.textContent = "Could not reach the sync server.";
        document.getElementById("mGo").textContent = isReg ? "Create account" : "Sign in";
      });
    }
    bind();
    document.body.appendChild(modalEl);
  }
  function closeModal() { if (modalEl && modalEl.parentNode) modalEl.parentNode.removeChild(modalEl); modalEl = null; }

  // ---------- boot ----------
  function boot() {
    renderBar();
    // Let the calculator tell us when it saved.
    window.addEventListener("mileage:saved", onLocalSave);
    if (tokenValid()) pullThenReconcile();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
