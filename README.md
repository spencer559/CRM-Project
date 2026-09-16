# Cardiac CRM Toolkit

A small suite of browser tools for a cardiac device clinic, served as a static site on **Cloudflare Pages** (`device-tech.pages.dev`). The repo name `spencer559.github.io` is a leftover from the original GitHub Pages hosting, which is being retired. The repository is private; the site is public except for the paths Cloudflare Access gates.

Everything the website serves lives in **`site/`**, which is the Pages build output directory. Web paths in this README and in `docs/` (`index.html`, `protected/`, `mileage/`, `src/`, `vendor/`, `tools/`) are relative to `site/`, which makes them URL paths too.

| Page | What it is |
|---|---|
| `index.html` | Public landing page — self-contained static page (own CSP, self-hosted fonts) |
| `protected/CRM_Report_Generator.html` | **The flagship** — CIED interrogation report generator (see `docs/report-import.md` and `docs/report-generator.md`) |
| `mileage/index.html` | **Public** clinic-coverage mileage log → one-click expense-form .xlsx, optional cloud sync |
| `protected/index.html` | Developer deck — landing page for protected tools (`/protected/*` is gated by Cloudflare Access) |
| `protected/dashboard.html` | Command center: markets, device-check tally, clinical reference, notes/to-do |
| `protected/Patient_Schedule.html` | Daily clinic schedule — full patient names, zero network egress, print-formatted day sheet; stores the schedule **and** every patient's files in one portable `.crmdb` database (iPad-ready) |
| `protected/LV_Lead_Testing.html` | LV lead vector-testing capture — per-vector impedance/QRS and sitting/supine threshold + phrenic results, lead-model picker, text/JSON/print output; holds no patient identifiers |
| `mileage-backend/` | Cloudflare Worker + D1 backend for mileage cloud sync (see its `DEPLOY.md`) |
| `iPad_APP/` | Sideloadable iPad app bundling the Schedule, Report Generator and PDF Viewer, with a native File System Access shim so the `.crmdb` autosaves in place (see its `README.md`) |

> This README is the entry point of the **project handoff / context documentation**; the deep dives live in [`docs/`](#documentation). Together they capture the architecture, conventions, and the vendor-specific gotchas that took real reports to discover. **AI coding agents** (Claude Code, Codex/ChatGPT, or anything else) start from [`AGENTS.md`](AGENTS.md), the short working brief — commands, architecture, rules that are easy to break — which points back into the relevant sections. `CLAUDE.md` just imports it.

---

## CRM Interrogation Report Generator

A browser-based tool for documenting **CIED** (cardiac implantable electronic device — pacemakers, ICDs, CRT) interrogation visits. It auto-fills a structured clinical form by reading the manufacturer's own export file locally in the browser, then produces a printable PDF report and a plain-text summary for pasting into an EHR. Everything runs **client-side** (no server, no upload).

### What it does

1. The user drops a vendor export onto the "Auto-fill" panel.
2. The right parser reads it and produces a normalized result.
3. The form is reset to a clean state and auto-filled; fields the parser is unsure about are flagged for review.
4. The user reviews/edits, then exports: **Save PDF** (printable, one-page-oriented), **Copy to Clipboard** / **Export .txt** (for the EHR).

Supported inputs:

| Vendor | Input | Notes |
|---|---|---|
| **Medtronic** | SmartSync **PDF** (text-based) | Quick Look / Session Summary / Parameters / Patient Info pages |
| **Boston Scientific** | LATITUDE **PDF** (text-based) | Quick Look / Combined Follow-up / Patient Data pages |
| **Abbott / St. Jude** | Merlin **.log** (text) | Their PDF is a scanned **image** with no selectable text → use the `.log` export instead |
| **Biotronik** | **PDF** (text-based) | Two report layouts handled: Home-Monitoring (per-character fragmented text) and Standard/BIOSTD (whole-word). See gotchas. |

---

## Project layout

```
site/                               Cloudflare Pages build output: everything here is published, nothing outside it is
  index.html                        Public landing page (self-contained static page, single file)
  _headers                          Cloudflare Pages security headers (frame-ancestors, HSTS, nosniff…)
  _redirects                        Compatibility redirects from the retired app/, dev/ and auth/ paths
  assets/                           Background image for the developer deck
  mileage/
    index.html                      Public mileage log → expense-form .xlsx (fully self-contained)
    mileage-sync.js                 Optional cloud-sync client; its login is not Cloudflare Access
  protected/
    index.html                      Developer deck (Cloudflare Access gates /protected and /protected/*)
    CRM_Report_Generator.html       THE ACTIVE APP — edit this one
    PDF_Viewer.html                 Local PDF viewer used by the Schedule
    dashboard.html                  Command-center dashboard (single file)
    Patient_Schedule.html           Daily clinic schedule — the .crmdb's other page (see docs/crmdb.md)
    LV_Lead_Testing.html            LV lead vector-testing capture (single file, no patient identifiers)
    auth-check.json                 Same-origin Access-session probe used by the landing page
  src/
    crmdb-store.js                  Shared .crmdb database engine (CRMWorkspace API over an in-memory bundle; see docs/crmdb.md)
    crmdb-commit-cadence.js         WHEN a staged edit gets published — the shared commit timer + teardown hooks
    engine.js                       Shared PDF extraction engine + anchor helpers + cleaners
    crm-episode-links.js            Logbook ↔ PDF page links + named EGM shortcuts, kept in report JSON (never in clinical exports)
    crm-keyboard-focus.js           Keeps the focused field visible inside the report's own scroll panes, never the host's
    pdf-page-selection.js           Parse/validate physical PDF page ranges ("12–15, 18") for EGM shortcuts
    pdf-egm-navigation.js           The PDF viewer's EGM menu — save, jump to, reorder and select page shortcuts
    pdf-selection-worker.js         Worker for "Print selected": copies the chosen original pages into a new PDF (pdf-lib)
    abbott-log-redactor.js          Byte-preserving Abbott .log redaction helpers (behind the Abbott Log Redactor tool)
    cied-pdf-redactor.js            Vendor-neutral identifier detection → redaction boxes (behind the PDF Redactor tool)
    parsers/
      medtronic.js                  Medtronic PDF parser  → window.MEDTRONIC.runMap(LINES, META)
      boston.js                     Boston Scientific PDF  → window.BOSTON.runMap(LINES, META)
      abbott.js                     Abbott Merlin .log     → window.ABBOTT.runLog(text)
      biotronik.js                  Biotronik PDF parser  → window.BIOTRONIK.runMap(LINES, META)
  vendor/
    crmdb-zip.js                    Dependency-free ZIP reader/writer for the .crmdb container (CSP-safe, no CDN)
    pdf.min.js  pdf.worker.min.js   Vendored pdf.js 3.11.174 (self-hosted, not a CDN)
    jspdf.umd.min.js (+ autotable)  Vector-PDF export
    pdf-lib.min.js (+ license files) Vendored pdf-lib 1.17.1 — loaded only inside the selected-page print worker
    fonts/                          Self-hosted landing-page fonts
    THIRD_PARTY_NOTICES.md          Versions, copyright lines and full license texts for everything vendored
  tools/
    pdf-extraction-harness.html     Dump a PDF's text items (parser authoring/debugging)
    abbott-log-redactor.html        Locally inspect/redact Abbott .log files without damaging FS delimiters
    cied-pdf-redactor.html          Locally redact/flatten vendor PDFs before sharing samples
docs/                               Subsystem docs (see Documentation below); docs/archive/ holds superseded design notes
mileage-backend/
  src/worker.js  wrangler.toml      Cloudflare Worker + D1 sync backend
  schema.sql  DEPLOY.md             (see DEPLOY.md for one-time setup)
iPad_APP/                           Sideloadable iPad app for the three offline pages (see iPad_APP/README.md)
  CRMiPad/                          Swift WKWebView app + crm-native-shim.js (File System Access API, injected into every page)
  web-files.txt                     Exactly which site/ files the app bundles — a page's new script goes here
  build-ipa.sh  deploy.sh           Build the last commit (what "Update iPad" installs) / build + install the working tree
tests/
  run.js                            Test runner — one child process per *.test.js, run in parallel (see Testing)
  *.test.js                         Node tests: .crmdb engine, parsers, page logic, PDF viewer, iPad bundle/shim, routes
.githooks/pre-commit                Refuses a commit whose staged files fail the tests (enable with git config core.hooksPath .githooks)
package.json                        No dependencies and no build step — it exists to give `npm test` an entrypoint
```

**Path conventions:** protected pages live together at one directory depth, so their includes are relative — `../src/engine.js`,
`../src/parsers/*.js`, `../vendor/pdf.min.js`, and `pdfjsLib.GlobalWorkerOptions.workerSrc =
'../vendor/pdf.worker.min.js'`. The standalone utilities in `tools/` use the same `../src` / `../vendor`
prefixes. The iPad app copies these files into its bundle with the same layout, so the relative
paths hold there too. Test fixtures (`Abbott Test Cases/`) stay local and are git-ignored.

**Running locally:** serve `site/` (for example `python3 -m http.server 8765 --directory site`) and open `/protected/Patient_Schedule.html`, the entry point that embeds the other two offline pages.

| Component | Role |
|---|---|
| `protected/CRM_Report_Generator.html` | **The active app.** Form UI, auto-fill drop panel, `prefillForm`, lead tables, report builders, save/restore, JSON import/export. |
| `src/engine.js` | Shared **PDF extraction engine** (pdf.js based) + anchor helpers + cleaners. |
| `src/parsers/medtronic.js` | Medtronic PDF parser → `window.MEDTRONIC.runMap(LINES, META)` |
| `src/parsers/boston.js` | Boston Scientific PDF parser → `window.BOSTON.runMap(LINES, META)` |
| `src/parsers/abbott.js` | Abbott Merlin **.log** parser → `window.ABBOTT.runLog(text)` |
| `src/parsers/biotronik.js` | Biotronik PDF parser (two report layouts) → `window.BIOTRONIK.runMap(LINES, META)` |
| `vendor/` | Self-hosted pdf.js **+ jsPDF/autotable + pdf-lib** (no runtime CDN dependency). |

---

## Documentation

| Doc | Covers |
|---|---|
| [`docs/report-import.md`](docs/report-import.md) | The import data flow, the `RESULT` / `LEADS` parser contracts and field keys, `engine.js`, every vendor's hard-won gotchas, and how to add a vendor |
| [`docs/report-generator.md`](docs/report-generator.md) | The Report Generator's form, exports (text, JSON, vector PDF) and the UI decisions behind them |
| [`docs/crmdb.md`](docs/crmdb.md) | The `.crmdb` container: format, encryption, the engine's cross-tab and cross-station guards, and the Schedule / Report Generator features built on it |
| [`docs/cloudflare-access.md`](docs/cloudflare-access.md) | Cloudflare Pages build settings and the Access boundary (`/protected` gated, `/mileage` public) |
| [`iPad_APP/README.md`](iPad_APP/README.md) | The sideloaded iPad app: why it's built this way, building, updating, known gaps |
| [`mileage-backend/DEPLOY.md`](mileage-backend/DEPLOY.md) | One-time setup of the mileage sync Worker and D1 database |
| [`site/vendor/THIRD_PARTY_NOTICES.md`](site/vendor/THIRD_PARTY_NOTICES.md) | Vendored libraries and fonts, their licenses and copyright lines |
| [`docs/archive/`](docs/archive/) | Superseded design notes, kept for history — they do not describe today's code |

---

## The other tools

### Landing pages (`index.html`, `protected/index.html`)

Both landing pages are **single self-contained static pages**: cards are hardcoded in the HTML, inline styles, and fonts are self-hosted in `vendor/fonts` (no Google Fonts at runtime). The public index has one small same-origin Access-session probe; the protected deck needs no auth script because Cloudflare gates the whole namespace. **Adding/editing a tool card is an edit in the page itself.** The old shared renderer (`home.js`) and theme (`assets/site.css`) were removed with this redesign (git history has them).

- `index.html` — public index (Public Sans + JetBrains Mono). The Mileage card is always public; the CRM and Developer Deck cards unlock together after the single protected-session probe succeeds.
- `protected/index.html` — developer deck, pirate-themed (Pirata One / Cinzel / Spectral, background `assets/dev-bg-crew.webp`). Lists six tools: the Report Generator, Mileage Calculator, Dashboard, Patient Schedule, LV Lead Testing and the CIED PDF Redactor. The `/protected` and `/protected/*` gates are Cloudflare Access, configured in the Cloudflare dashboard — nothing in this repo enforces them.

### Mileage Calculator (`mileage/index.html` + `mileage/mileage-sync.js`)

Logs clinic-coverage days (AM clinic → PM clinic) and computes reimbursable miles by the home-adjustment method: `(home→AM) + (AM↔PM leg) + (PM→home) − normal round-trip commute to the base clinic`, floored at 0. Up to 5 locations with per-user distances, drag-to-reorder log, config/profile JSON import-export, and a one-click **expense-form .xlsx** (xlsx-js-style embedded inline — no CDN). State lives in localStorage (`mileageToolV1`); new rows default to the **local** date (not UTC — that bug put evening entries on tomorrow).

**Cloud sync** is an optional layer in `mileage-sync.js`: username/passphrase accounts (invite-code gated), 12-hour JWT sessions, offline-first with a debounced push on every save, pull-then-reconcile on load, and last-write-wins conflict resolution keyed off a server-side version number. If `WORKER_URL` is blank the file does nothing and the page stays local-only.

The calculator deliberately lives outside `protected/`. Its optional Worker login belongs only to mileage sync and must never be replaced by or placed behind Cloudflare Access; the calculator remains usable without signing in and when the Worker is unavailable.

### Mileage sync backend (`mileage-backend/`)

Cloudflare Worker + D1 (`mileage-sync.spencer559.workers.dev`). One JSON blob per user, PBKDF2-SHA256 password hashing, HS256 JWTs, optimistic-concurrency writes (stale version → 409 with the server copy; `force:true` for a client-resolved LWW push), CORS restricted to the origins in `wrangler.toml` `ALLOWED_ORIGIN`. Secrets (`JWT_SECRET`, `INVITE_CODE`) are set with `wrangler secret put`; setup steps are in `DEPLOY.md`. **It only ever touches mileage data — no PHI.** The local `.wrangler/` cache is git-ignored.

### Developer dashboard (`protected/dashboard.html`)

Single-file command center behind the `/protected/` gate: clock + Open-Meteo weather (currently hard-coded to LA coords); Finnhub-powered watchlist, index strip and sector heatmap (bring your own free key, stored locally; requests are queued/paced/cached to respect the 60-calls-per-minute free tier); a device-check tally with 7-day history; clinical reference tabs (portals, a **Timing Lab** — ms⇄bpm + TARP/upper-rate calculators, EGM gain/sweep box-scale calculators, and a DDD timing-cycle simulator (static canvas marker-channel strip — simulates to steady state and redraws on any change — showing 1:1 tracking / pseudo-Wenckebach / 2:1 block / LRL pacing) — a **Tachy Lab** (zone/therapy planner: VT-1/VT/VF boundaries with detection and therapy sequences, SVT-discriminator limit, a color-banded rate ladder in bpm+ms, and a rate probe reporting zone / discriminator status / time-to-detect / therapy path) — measurement ranges, SVT–VT discriminators, patient alerts, troubleshooting, MRI lookups, magnet rates) plus an EGM marker glossary; notes and a to-do list. A **Modules** dropdown in the header (left of the panel filter) links to the other tools so the dashboard can serve as home base.

Persistence details worth knowing before editing:

- All state is localStorage. An optional **portable data file** (File System Access API, with the handle remembered in IndexedDB) mirrors it to a JSON file — e.g. on a USB stick — and auto-reconnects on load.
- The snapshot/restore is **whitelisted** to dashboard-owned keys (`watchlist`, `finnhubKey`, `notes`, `todos`, `viewMode`, `refTab`, `tachyLab`, `tally-*`). This matters: the dashboard shares an origin — and therefore localStorage — with the CRM tool's PHI autosave (`crm-digital`) and the mileage auth token, so an unfiltered mirror would write PHI into the data file. Don't widen the whitelist casually.
- Tally keys use **local** dates (`localISO()`), not `toISOString()` (UTC), so evening checks don't land on tomorrow's tally.
- Its CSP allows egress only to `api.open-meteo.com` and `finnhub.io`, and no third-party scripts run (TradingView widgets were removed for exactly this reason).

### Patient Schedule (`protected/Patient_Schedule.html`)

A daily device-clinic schedule behind the `/protected/` Cloudflare Access gate. Rows hold time, the patient's **full name**, manufacturer, device type, check type (in-clinic / remote / pre-op), a **last in-office check** date, a remote-monitoring connection status (Connected / Not connected / External clinic / N/A — "Not connected" rows are tallied in the count line and the printed header), and a notes line. A **"Move day…" dropdown** beside the date picker contains the destination date and confirmation controls; it reassigns an entire day to a different date (merge-confirm if the target day already has rows, and it moves that day's patient files too) — the fix for a schedule accidentally entered under the wrong date. Its CSP is `connect-src crmapp:` like the CRM tool — nothing typed on the page can reach a network (`crmapp:` is the iPad app's own scheme and resolves to nothing in a browser; see **Security / hosting**).

Workflow/storage: the schedule **and every patient's files** now live in a **single `.crmdb` database file** — see [`docs/crmdb.md`](docs/crmdb.md) for the full model. On Mac/PC it auto-saves in place as you edit; on iPad you press **Save** to write it back through the Files sheet. Data-lifetime is user-controlled **per database** via the **Memory** menu (retention window + Clear-all-past + a size readout; default is keep-everything — the old fixed 7-day purge is gone). Also: a header **All patients** overview, a manual **+ PDF** attach chip per row (for device types with no parser), plain JSON export/import, a dedicated **print view** (`@media print` day sheet — sorted by time, serif, count summary, "shred after use" footer), and a **"Leave Station"** action (now inside the Memory menu) that saves the database, wipes localStorage, and forgets the connection — the file keeps the data; only the browser is cleaned. Optional per-database password protection encrypts both the `.crmdb` file and its IndexedDB working copy entirely on-device; protected databases suppress the plaintext schedule localStorage mirror. There is deliberately no password recovery or server involvement. Never wire this page to the mileage sync Worker or any other backend.

**Reminders** (Aug 2026) is a second panel directly under the schedule: a running list of follow-ups the day generates — *"Call Doe, Jane about her ERI battery"*, *"Tell Dr. Smith that Roe, John stopped his blood thinners"*. Type it, press Enter, tick it off when it's done. Each entry is editable in place (a follow-up gets rewritten far more often than retyped), carries an age label once it's older than today (`yesterday`, `3d ago`, then a date), and completed ones sink to the bottom struck through — with a *Show completed* toggle and *Clear completed*. **Deliberately not per-day:** the list lives at `state.reminders`, *outside* `state.dates`, so stepping to another date never hides an outstanding task and the Memory retention window — which only ever prunes `state.dates` — can never quietly delete one. It rides in the same `schedule.json`, so it travels between stations with the rest of the database and syncs across tabs on the existing revision/broadcast path. It is also **not printed**: the day sheet is what goes out to the clinic, the reminder list is the tech's own. Covered by `tests/schedule-reminders.test.js`.

**Download patients** (beside *Print schedule*) is the bulk way out of the container. Nothing inside a `.crmdb` is reachable from a native file dialog — it is one ZIP — so a stored file used to leave only by being dragged out one at a time, which is impractical when a whole day has to be attached in Cerner. The button opens the OS **directory picker** (so the destination can be a USB stick or a network share as easily as Downloads) and writes:

```
<chosen folder>/<YYYY-MM-DD>/<Patient name>/<file>
```

Details worth keeping: the picker is opened **synchronously on the click**, before anything is awaited — awaiting first spends the transient user activation the File System Access API requires and the dialog never appears. Scope follows *Print schedule* (the current provider filter). Only the files the **Files** menu lists travel — the generated report plus raw programmer exports; `report.json` / `report.txt` stay behind as support files. `report.pdf` leaves under its chart name (`LASTNAME_<date>_CRM_Report.pdf`, the shared `chartReportFilename` rule); programmer exports keep their own filenames and their exact bytes. A patient whose report is open in the panel is finalized first, because their stored `report.pdf` is only as new as the last finalize. Folder names are sanitized for Explorer/Finder, patients with no files get no folder, and a name that appears twice in one day carries its appointment time so the two visits cannot overwrite each other. Firefox and iPad Safari have no directory picker: there the identical tree is delivered as one `.zip` (`vendor/crmdb-zip.js`, STORE-only). The iPad app (`iPad_APP/`) supplies one natively, so it writes the real folders. Covered by `tests/patient-folder-export.test.js`.

---

## Security / hosting

- **Self-hosted libraries** — `vendor/pdf.min.js` + `pdf.worker.min.js` (pdf.js v3.11.174) **and** `jspdf.umd.min.js` + `jspdf.plugin.autotable.min.js` (the vector-PDF generator) are committed to the repo; nothing is pulled from a CDN at runtime. `engine.js` derives the worker URL from the page's own `pdf.min.js` `<script>` tag (and respects a `workerSrc` the page set explicitly), so no third-party script ever runs in the same context as PHI.
- **Content-Security-Policy** — the three PHI pages (`CRM_Report_Generator.html`, `Patient_Schedule.html`, `PDF_Viewer.html`) ship a `<meta http-equiv="Content-Security-Policy">` whose key directive is `connect-src crmapp:`: no http/https origin is reachable, so the page cannot make a network request and PHI cannot be exfiltrated. `crmapp:` is the **iPad app's own custom scheme** (`iPad_APP/`) — served by the app itself, naming no network destination — and is how the app hands a page the bytes of a picked `.crmdb` as binary (`crmapp://app/__native/file`) instead of base64-ing a 55 MB database through a message handler. In a browser nothing resolves `crmapp:` at all, so on the website it is exactly as tight as `'none'`; never widen it to a real origin. Pages the app doesn't bundle and that need no network — `LV_Lead_Testing.html`, the developer deck and the `tools/` redactors — keep `connect-src 'none'`. `script-src`/`style-src` keep `'unsafe-inline'` only because the form uses inline handlers + `<script>` blocks (that allowance grants no network egress); `worker-src 'self' blob:` lets the local pdf.js worker run.
- **Per-page CSPs across the origin** — every page on this origin shares localStorage with the CRM autosave, so each ships its own CSP: the Mileage Calculator's `connect-src` permits only the sync Worker, and the dashboard's only its two data feeds (Open-Meteo, Finnhub). No page may load third-party scripts.
- **HTTP security headers** — `site/_headers` makes Cloudflare Pages send real headers on every response: `X-Frame-Options: SAMEORIGIN` + `frame-ancestors 'self'` (the Schedule embeds the CRM and PDF viewer from the same origin), `nosniff`, `Referrer-Policy: no-referrer` (outbound portal clicks don't leak URLs), a locked-down `Permissions-Policy`, and HSTS. The per-page meta CSPs remain as defense-in-depth.
- **CRM autosave retention** — the `crm-digital` autosave carries a `__savedAt` stamp; saves older than **24 h** are cleared on load instead of restored (the autosave exists to survive a refresh mid-visit, not to store records).
- **Hosting** — Cloudflare Pages (`device-tech.pages.dev`) publishes `site/` (the project's build output directory, no build command), with only `/protected` and `/protected/*` behind Cloudflare Access. Everything outside `site/` — docs, tests, the iPad app, the Worker — is never deployed, and `tests/route-boundaries.test.js` pins the list of what is. `/mileage/` must remain outside every Access application. The old GitHub Pages origin is kept in the Worker's `ALLOWED_ORIGIN` during the transition; drop it once disabled. Exact dashboard steps are in `docs/cloudflare-access.md`.
- **Still out of scope (deployment-level):** access controls on the public tools, audit logging, encryption at rest (localStorage + downloaded files are plaintext), and the fact that a public static host is not automatically HIPAA-eligible. See any compliance review before clinical use.

---

## Current status

**Working & verified against real (redacted) reports:**
- Medtronic PPM / ICD / CRT (incl. MVP, dynamic two-column split, verbatim inventory, Therapy-Summary-scoped pacing % with CRT `Total VP` / `Effective`→BiV; validated on Azure dual + Cobalt XT CRT).
- Boston PPM-DC / ICD-DC / CRT-D / CRT-P (incl. quadripolar LV, dynamic AV, comparators, shock-based routing, and episode/arrhythmia-log mapping → HVR / AHR (prefers the `AT/AF Events` total, falls back to the bucket sum) + Longest AT/AF row).
- Abbott PPM-DC / ICD-DC / CRT-D / CRT-P via `.log` (Fortify / Gallant DR/HF / Quadra Allure/Assure families).
- Biotronik dual-chamber **PPM** via both report layouts (Home-Monitoring + Standard/BIOSTD); per-character text handling, horizontal lead inventory, diagnostics/episode import, A/V column split, and lead measurements scoped to the "Test results" block so an unmeasured (`-----`) chamber stays blank instead of inheriting the programmed pulse width.
- **Aveir** dual-chamber leadless — manual entry only (no importer), with per-module lead rows, longevity, and pacing % driven by the RA/RV chamber checkboxes.
- **JSON export/import** round-trips a full record (incl. the lead table); **pdf.js self-hosted** under a strict CSP (no network egress).
- **Workflow / UI:** merge-import (keep live-typed data), episode logbook ↔ free-text toggle, merged **Final Session Summary** section, save-location-aware exports (desktop picker / iOS share sheet), and a mobile-fixed JSON menu.
- **Patient Schedule** (full-name day sheet, print view, walk-away wipe) behind the `/protected/` gate — now backed by the `.crmdb` container ([`docs/crmdb.md`](docs/crmdb.md)) with per-database Memory retention, an All-patients overview, and manual PDF attach.
- **`.crmdb` single-file database (Jul 2026):** the shared USB workspace was rebuilt from a live folder tree into one portable ZIP (`schedule.crmdb`) so the Schedule **and** the CRM Report Generator work on **iPad** as well as desktop. New `src/crmdb-store.js` (CRMWorkspace API over an in-memory bundle + IndexedDB cross-page copy + desktop file-handle autosave / iPad share-sheet save) and `vendor/crmdb-zip.js` (dependency-free, CSP-safe ZIP). Verified headlessly in Node: bundle round-trips (valid zip per `unzip -t`), slot moves/renames, file counts, retention pruning, per-database `retentionDays` persistence, delete-with-files, and the two-page handoff sequence. Browser click-through (iPad share sheet, desktop reconnect) has since been confirmed on real hardware.
- **Vendor detection rewritten (Jul 2026):** a Boston Scientific report carrying an **Abbott / St. Jude RV lead** was detected as Abbott and refused to import — `guessVendor` joined every page into one string and took the *first* matching signature, and `boston.js` reads the Leads table verbatim by design, so one foreign lead row decided the routing (Abbott sits higher in the list, and Abbott has no PDF parser → hard dead end). `Engine.scoreVendors` now ranks vendors by **page spread**: a report's own brand repeats in the page furniture on every page, a foreign lead is one cell on one page. The importer also gained a **"Parse as:" override** (buttons in the status box that re-parse the cached text) so no misdetect can wall off the auto-fill again, the Abbott dead end now points at the Merlin `.log` export, and the parsers' dead `sig` regexes — which had drifted a full 10 Boston families ahead of the engine — are gone. Covered by `tests/vendor-detect.test.js`.
- **Latency overhaul (Jul 2026):** committing re-serialized the **whole** database and wrote it into the shared IndexedDB working copy, and both pages did that on their typing debounce — so every ~1.5s pause cost a multi-megabyte round trip, and it got worse the bigger the `.crmdb` grew. Four changes, all of them about *when* and *how much*: (1) an edit now **stages** into the in-memory bundle (`{ defer: true }` on `writeFile` / `createWritable`), which is free; (2) new `src/crmdb-commit-cadence.js` owns **when** staged edits publish — at most once every 30s, plus an immediate commit on every deliberate exit (patient switch, Save, tab-hide, pagehide, unload). Continuous typing can't starve it, because `stage()` deliberately does *not* restart an in-flight timer; and one page exit is **one** commit even though a browser fires up to three teardown events for it, so a page that claims its own teardown work isn't doubled up. The cadence window is therefore only ever exposed by a hard crash, never a normal close. (3) a commit costs the **delta** rather than the whole database — unchanged entries are carried by reference, and their CRC-32 is memoized on the (immutable) Blob instead of recomputed: at 53 MB that CRC loop was ~135 ms of a ~145 ms serialize, and a steady-state commit is now ~0.4 ms; (4) `CRMDB.readBlob` reads a container we wrote ourselves **by reference** — nothing but the central directory is parsed and each entry comes back as a `blob.slice()` view, so a page load holds one copy of the database instead of the two or three `read()` materialized. Anything unfamiliar (a DEFLATE entry, a layout whose local headers don't tile) falls back to `read()`. Covered by `tests/crmdb-commit-cadence.test.js`, `crmdb-commit-cost.test.js`, `crmdb-deferred-write.test.js`, `crmdb-zero-copy-read.test.js`. **Two directions were measured and rejected — don't revisit them:** DEFLATE would save only ~9% (programmer PDFs are already Flate/DCT-compressed inside) for ~890 ms of CPU per serialize — about six times the whole cost it was meant to cut; moving serialization to a **Web Worker** is unnecessary once the CRC loop is gone (SHA-256 and AES-GCM already run natively off the main thread). Database growth is capped only by the Memory menu's retention window, whose default of *keep everything* is a deliberate choice: nothing is pruned without the user picking it, and size now affects OneDrive sync time, not UI responsiveness.
- **Remote-monitoring status shared between the two pages (Jul 2026):** the Schedule's **Remote** precharting column and the Report Generator's Final Session Summary **Status** dropdown are one field, not two — it travels in the schedule row (`r.rm`) inside `schedule.json`. Opening a patient pulls the precharted value into the form (the schedule wins, since that's where precharting happens; if it's blank and the report has a value, the schedule is seeded instead so the two never disagree), and changing it in the report writes back, bumps `schedule.json`'s revision stamp and broadcasts a `committed` message — otherwise an open Schedule tab would treat its own copy as newer and put the old value straight back. Covered by `tests/crmdb-schedule-rm-share.test.js`. **Coupling to keep in mind:** the `RMS` list in `protected/Patient_Schedule.html` and the `#rm-status` `<select>` in `protected/CRM_Report_Generator.html` must stay in step (both carry a comment saying so).
- **Site passover (Jul 2026):** dashboard data-file snapshot/restore whitelisted to dashboard-owned keys (a full-localStorage mirror was writing the CRM PHI autosave into exports); tally + mileage "Add day" switched to local dates (UTC `toISOString` rolled evening entries to tomorrow); Mileage Calculator got a CSP matching the other pages; `mileage-backend/.wrangler/` untracked and git-ignored.

**Known gaps / TODO ideas:**
- Abbott PDF (scanned image) is **not** supported — `.log` only. (OCR would be the only PDF route.)
- Abbott individual episode rows and nonzero AF burden cannot be derived from the tested `.log` exports. AHR and ICD VT/VF aggregate counters, zero burden, and a common last-cleared date are supported.
- Abbott CRT ventricular percentages use the lifetime RVP/LVP/BP compartments; non-CRT V paced uses the recent Event-Histogram value.
- A few Abbott edge cases (legacy/other-manufacturer leads) may leave a lead model blank (serial still captured).
- Boston **single-chamber** and several less-common families are scaffolded but not validated with real exports.
- **Biotronik** parser handles two report layouts (Home-Monitoring + Standard/BIOSTD), each validated against a dual-chamber PPM; ICD/CRT and single-chamber Biotronik are unverified.
- Lead-table cells have no `id`/`name`, so they're saved/restored via the dedicated `__leadinfo` array (handled — autosave + JSON now persist the lead table). Anything else without an id/name would still be missed by the generic serializer.

---

## Testing / continuing the work

- **Manual:** serve `site/` and open `protected/CRM_Report_Generator.html` (or use the Pages site), then drop a vendor PDF or Abbott `.log` on the "Auto-fill" panel.
- **PDF authoring:** use `tools/pdf-extraction-harness.html` to dump a PDF's text items, then write/adjust anchors in the vendor parser under `src/parsers/`.
- **Node tests:** `npm test` (or `node tests/run.js`) runs the whole suite — 54 files, about 5 s. The
  runner gives each `tests/*.test.js` its **own child process** on purpose — every file installs its
  own fake `window` / `document` / `indexedDB` into the Node global scope and re-`require`s
  `site/src/crmdb-store.js` to simulate a separate tab, so they cannot share a process without
  contaminating each other. Those processes run **in parallel** (one core left free; results still
  print in file order), because most of a file's time is spent waiting on its own timers — serially
  the suite took ~23 s. `TEST_JOBS=1 npm test` runs them one at a time, for chasing a failure that
  only shows under load. Run a single file directly (`node tests/crmdb-multitab.test.js`) when
  you're iterating on one.

  The `.crmdb` store guards, one file each:

  | Test | What it pins down |
  |---|---|
  | `crmdb-encryption` | password round-trips |
  | `crmdb-writer-lease` | one writer per database (Web Locks): a second tab writes nothing and reports itself read-only, and is promoted automatically when the writer tab — or just its database — closes |
  | `crmdb-multitab` | two tabs sharing one working copy — the journal/revision-CAS guard |
  | `crmdb-journal` | the durable journal: edits staged but never committed survive a crash and replay on reopen; a commit supersedes the row, a stale or corrupt row is discarded without harming the database, and on a protected database the row is ciphertext |
  | `crmdb-freshness` | a stale station cache must never overwrite a newer OneDrive file |
  | `crmdb-selfwrite` | the other direction: this station's own saves — including one interrupted by navigation — must never be *mistaken* for another station's, while a real foreign edit still raises the conflict prompt |
  | `crmdb-manifest-sig` | that "own write" signature hashes the ZIP central directory (`m2:`), not every byte — deterministic, sensitive to any content change, and still recognizing files signed the old full-byte way |
  | `crmdb-save-state` | the save contract behind "where does my work live right now": a staged edit reads *edited* until it is published, a commit with no bound file reads *browser* (the resting state on iPad), and a failed save stays *failed* — typing can't clear it, only a real success |
  | `crmdb-slot-collision` | renaming a patient onto a slot key another appointment already uses (`0800_DEMOAB`) is refused, leaving both folders intact |
  | `crmdb-handoff` | the two-page handoff: what one page commits, the other reads |
  | `crmdb-embedded-host` | the generator embedded in the Schedule reuses the Schedule's `CRMWorkspace` instead of opening a second store |
  | `crmdb-cross-realm-blob` | a `File` created inside the embedded iframe (another JS realm, so `instanceof Blob` is false) is stored as its bytes, not as the string `[object File]` |
  | `crmdb-deferred-write` | a staged (`{ defer: true }`) write costs no serialization, and is readable immediately |
  | `crmdb-commit-cadence` | *when* staged edits publish — typing can't starve the cadence, one page exit is one commit across all three teardown events, an idle exit costs nothing |
  | `crmdb-commit-cost` | a commit re-reads (and CRC-32s) only files whose Blob changed — unchanged or merely renamed entries reuse a memoized CRC |
  | `crmdb-zero-copy-read` | `readBlob` hands back `blob.slice()` views, and falls back to `read()` on any layout it didn't write |
  | `crmdb-schedule-rm-share` | the remote-status field stays one value across both pages |

  The rest of the suite is named for what it covers: the vendor parsers (`vendor-detect` —
  `Engine.scoreVendors` / `guessVendor`, so a foreign lead row can't outvote the report's own brand —
  plus `abbott-log-parser`, `boston-*`, `biotronik-*`, `medtronic-*`), the redaction helpers
  (`*-redactor`), Report Generator and Schedule page logic (`report-*`, `schedule-*`, `patient-*`,
  `crm-*`), the PDF viewer and EGM shortcuts (`pdf-*`, `egm-print-order`), LV Lead Testing
  (`lv-lead-*`), the iPad app (`ipad-bundle-complete` — every file a bundled page loads is listed in
  `iPad_APP/web-files.txt` — and `ipad-native-shim`), the auth/route boundary and what `site/`
  publishes (`route-boundaries`). Page logic lives inline in the
  HTML, so those tests read the page source and either lift a function out by brace-matching and run
  it with `new Function`, or assert on the markup — renaming or restructuring an inline function can
  fail one with no change in behavior.

  No npm install: `crmdb-store.js` exports itself under `module.exports`, a fresh `require` is a
  fresh "tab" (or a fresh page load), and the tests ship a ~40-line in-memory IndexedDB shim to keep
  the repo dependency-free. Each fails loudly against the store it was written for.

  One thing to know when writing a *timing* test here: `setTimeout` has a ~15.6ms floor on Windows,
  so a loop of `await wait(4)` takes roughly four times as long as it reads. Derive any bound on
  "how many times did this fire" from a measured `Date.now()` delta rather than from the nominal
  delay — see the top case in `crmdb-commit-cadence.test.js`.
- **Headless checks:** the parser logic is plain JS and can be exercised in Node by `eval`-ing the vendor file (with `globalThis.window = globalThis`) and feeding it a reconstructed `LINES` array (PDF) or raw `.log` text — the fastest way to verify a change against a sample before clicking through the form. UI-logic changes can be checked with jsdom (load the app HTML, stub `IntersectionObserver`, drive the functions).
- **Adding a vendor:** see [`docs/report-import.md`](docs/report-import.md#to-add-a-new-vendor).

---

## Privacy note

The repo is **private**, but the site is public: Cloudflare Pages (`device-tech.pages.dev`) serves everything in `site/`, and only `/protected` and `/protected/*` sit behind Cloudflare Access.
- Keep patient data (names, DOBs, device serial numbers, raw vendor exports) out of anything committed — a private repo is still not a place for PHI. Sample/scratch files used for testing should stay local or be `.gitignore`d (currently `Info.txt`, `Abbott Test Cases/`, and `mileage-backend/.wrangler/`).
- The app itself never transmits data — all parsing happens in the browser, pdf.js is self-hosted, and the CSP's `connect-src crmapp:` blocks every network request — `crmapp:` resolves only inside the iPad app, to the app itself (see **Security / hosting**).
- This covers only what the page controls. Hosting, access control, audit logging, and encryption at rest are deployment concerns a compliance review must address before clinical use.
