# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Browser tools for a cardiac device (CIED) clinic: a daily patient schedule, an interrogation report
generator that auto-fills from vendor programmer exports, and a PDF viewer. These three handle full
patient PHI and run entirely client-side. The site is static on Cloudflare Pages; the same three pages
also ship inside a sideloaded iPad app. This is a **public repo**.

`README.md` is the detailed handoff document (vendor parser gotchas, `.crmdb` internals, UI
decisions and why). It is updated in nearly every commit. Read the section for the subsystem you're
changing before changing it, and update that section when you change documented behavior.

## Commands

No dependencies, no install, no build, no linter. `package.json` exists only for `npm test`.

```bash
npm test                              # whole suite, ~5s: one child process per tests/*.test.js, run in parallel
node tests/crmdb-freshness.test.js    # one file; each is a standalone script that exits non-zero on failure
TEST_JOBS=1 npm test                  # serial, for a failure that only shows up under load
```

Serve the repo root to use the pages locally (the `crm-static` preview config does this on port 8765),
then open `/protected/Patient_Schedule.html` — the Schedule is the entry point that embeds the others.

iPad app (needs a full Xcode with the iOS platform; see `iPad_APP/README.md`):

```bash
iPad_APP/deploy.sh                      # build the working tree (uncommitted edits too) and install on the iPad
iPad_APP/deploy.sh --build              # build dist/CRMiPad.ipa only
iPad_APP/build-ipa.sh                   # build the LAST COMMIT — what the Sideloader app's "Update iPad" runs
iPad_APP/build-ipa.sh --describe        # JSON stamp/fingerprint of what would be built
```

Mileage sync backend (`mileage-backend/`, Cloudflare Worker + D1): `npx wrangler deploy` from that
folder; one-time setup and D1 commands are in `mileage-backend/DEPLOY.md`.

## Architecture

**No bundler, no modules.** Each page is one large HTML file with inline `<script>` blocks. Shared code
in `src/` and `vendor/` is loaded as classic scripts via `../` relative paths and hangs off globals
(`window.CRMWorkspace`, `Engine`, `MEDTRONIC`, `CRMCadence`, `CRMDB`, …). Shared modules also assign
`module.exports` when present, which is how Node tests load them.

**The three offline pages act as one app.** `protected/Patient_Schedule.html` hosts it:
- It embeds `CRM_Report_Generator.html?embed=1` in an `<iframe>` under a patient's row. The embedded
  generator does **not** open its own store: `src/crmdb-store.js` sees `window.CRM_EMBED` and reuses the
  parent's `CRMWorkspace` (`CRMWorkspaceUsesHost`). Standalone, the generator opens its own.
- `PDF_Viewer.html` runs as an embedded split pane or a separate tab. The document reaches it by
  `postMessage` as a transferred `ArrayBuffer` (`pdfviewer:*` / `crm:*` message types), not base64.
- Schedule state is announced across tabs on the `patientScheduleSyncV1` `BroadcastChannel`.

**Data: one `.crmdb` file.** It is a ZIP written STORE-only by `vendor/crmdb-zip.js`, so renaming it to
`.zip` recovers it. With a password it is wrapped in an AES-GCM envelope. Inside are `schedule.json` and
`patients/<YYYY-MM-DD>/<HHMM>_<NAME>/{report.json,report.txt,report.pdf,<programmer export>}`.
`src/crmdb-store.js` holds it as an in-memory `Map<path, Blob>`, mirrors it to IndexedDB (which is
what carries state between pages), and on desktop Chromium binds it to a file handle and autosaves in
place. The file lives on OneDrive or USB and moves between clinic workstations. Several independent
guards sit on top, each with its own `tests/crmdb-*.test.js`:
- writer lease (Web Locks): one writer tab per database; the others are read-only
- `journal` + revision compare-and-swap: a commit replays only this tab's changed paths
- durable sealed journal in IndexedDB: uncommitted edits survive a crash or reload
- cross-station freshness: a stale local cache must never overwrite a newer file, and this station's
  own writes are recognized by content signature
- save-state machine (`closed/edited/saving/browser/file/blocked/failed/readonly`): the UI's answer to
  "where does my work live right now"

`src/crmdb-commit-cadence.js` decides *when* staged edits commit: at most every 30s, plus immediately on
every exit (patient switch, Save, tab hide, pagehide). Pages stage cheap `writeFile(..., { defer: true })`
writes in between.

**Platforms.** Desktop Chrome/Edge have the File System Access API and autosave. iPad Safari has none:
Save goes out through the share sheet. The **iPad app** (`iPad_APP/`) is a WKWebView serving the bundled
pages at `crmapp://app/`. It injects `CRMiPad/crm-native-shim.js`, which supplies
`showOpenFilePicker`/`showSaveFilePicker`/`showDirectoryPicker` backed by native pickers
(`NativeBridge.swift`), so the store's desktop code path runs unchanged. Browsers without the API
(Firefox, iPad Safari) fall back to the share sheet or a download, and to one `.zip` in place of real
folders.

**Report import pipeline.** A vendor file is dropped into the generator. PDFs go through pdf.js →
`Engine.extractItems/normalize/tagSections` → `Engine.scoreVendors` → `src/parsers/<vendor>.js`
`runMap(LINES)`. Abbott is a Merlin `.log` text file → `ABBOTT.runLog(text)`. Every parser returns
`{ RESULT, LEADS, ROUTE, ORDER, GOTCHAS, EPISODES? }`, with `RESULT` keyed by form field id, and that
bundle goes to `prefillForm`. `engine.js` holds the only vendor-detection list.

**Everything else:** `index.html` is the public landing page. `mileage/` is a public calculator whose
optional sync talks to `mileage-backend/`, the only code that makes network calls, and it never touches
PHI. `protected/dashboard.html` and `protected/LV_Lead_Testing.html` are standalone. `tools/` holds
local redaction and PDF-extraction harness pages for preparing sample exports.

## Invariants that are easy to break

- **No network egress from PHI pages.** The Schedule, generator and viewer ship a meta CSP with
  `connect-src crmapp:` (only the iPad app's own scheme resolves; in a browser nothing does). Never add
  a CDN script, fetch, analytics or third-party resource to them or to `tools/`; libraries are
  self-hosted in `vendor/`. Every page on the origin shares localStorage with the generator's PHI
  autosave (`crm-digital`), so each page carries its own restrictive CSP.
- **Store mutations go through `bset`/`bdel`.** A direct `bundle.set/delete` is invisible to the journal
  and the cross-tab merge. Only the store's own ingest and journal-replay code touches `bundle` directly.
- **A page that loads a new file must list it in `iPad_APP/web-files.txt`,** or the iPad app ships
  without it. `tests/ipad-bundle-complete.test.js` enforces this, and `build-ipa.sh` runs it before
  every build.
- **Web changes reach the iPad only once committed.** "Update iPad" builds HEAD; `deploy.sh` is the
  path for trying uncommitted work.
- **Auth boundary.** `/protected/*` is gated by Cloudflare Access, configured in the dashboard with
  nothing in the repo enforcing it. `mileage/` must stay public and never depend on Access. Don't
  recreate top-level `app/`, `dev/` or `auth/`; old URLs live on as `_redirects`
  (`tests/route-boundaries.test.js`).
- **Paired lists:** `RMS` in `Patient_Schedule.html` and the `#rm-status` `<select>` in
  `CRM_Report_Generator.html` are one field shared through `schedule.json`, and must stay in step.
- **User activation:** calls that need a click (`window.open` for stored files, directory/save
  pickers) must happen synchronously in the click handler, before any `await`. iPad Safari is strictest.
- **Dates:** day keys use local dates, never `toISOString()` (UTC rolls evening entries to tomorrow).
- The dashboard's data-file mirror is whitelisted to dashboard-owned localStorage keys. Widening it
  would export the PHI autosave.

## Tests

- Plain Node + `assert`, no framework. Any `tests/*.test.js` is picked up automatically.
- `crmdb-*` tests install fake `window`/`document`/`indexedDB`/Web Locks on the global scope and
  `delete require.cache[...]` + re-`require` the store to simulate another tab or a page reload. That is
  why each file needs its own process.
- Page logic lives inline in the HTML, so page tests read the `.html` source and either extract a
  function by brace matching (`functionSource`) or regex and run it with `new Function`, or assert on
  markup and source patterns. Renaming or restructuring an inline function can fail such a test with
  no change in behavior: update the extraction, don't loosen the assertion.
- Timing tests must also hold on Windows, where `setTimeout` has a ~15.6ms floor. Derive bounds from
  measured `Date.now()` deltas, not nominal delays (see `crmdb-commit-cadence.test.js`).
- Fixtures must be synthetic or redacted (`tools/` has the redactors). `Info.txt` and
  `Abbott Test Cases/` are git-ignored local samples containing **real patient data**: don't print them
  and never commit them.

**Test gate hook.** `.claude/settings.json` runs `.claude/hooks/test-gate.js`. It snapshots the
working tree when a prompt arrives. When Claude stops, if files changed during the turn, it runs
`npm test` and blocks the stop with the failure output if the suite fails. When blocked, fix the
failure. If it comes from changes not made in this turn (the user's own work, or another session in
this checkout), end the turn and say so rather than editing around it.

## Conventions

- Comments explain *why*, often naming the incident or measurement behind a decision. Match that in
  code you touch, and don't strip existing rationale comments.
- Commit subjects are plain-English statements of the user-visible change ("Fix every .crmdb read
  stalling for 30s per chunk on iPad"); the body gives the cause and the reasoning.
