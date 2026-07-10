# Cardiac CRM Toolkit

A small suite of browser tools for a cardiac device clinic, served as a static site on **Cloudflare Pages** (`device-tech.pages.dev`). The repo name `spencer559.github.io` is a leftover from the original GitHub Pages hosting, which is being retired.

| Page | What it is |
|---|---|
| `index.html` | Public landing page — self-contained static page (own CSP, self-hosted fonts) |
| `app/CRM_Report_Generator.html` | **The flagship** — CIED interrogation report generator (bulk of this README) |
| `app/Mileage_Calculator.html` | Clinic-coverage mileage log → one-click expense-form .xlsx, optional cloud sync |
| `dev/index.html` | Developer deck — landing page for dev-only tools (`/dev/*` is gated by Cloudflare Access) |
| `dev/dashboard.html` | Command center: markets, device-check tally, clinical reference, notes/to-do |
| `dev/Patient_Schedule.html` | Daily clinic schedule — initials only, zero network egress, print-formatted day sheet |
| `mileage-backend/` | Cloudflare Worker + D1 backend for mileage cloud sync (see its `DEPLOY.md`) |

> This README doubles as a **project handoff / context document** — if you're an AI assistant (e.g. Claude in Cowork) being pointed here to continue the work, read the whole thing; it captures the architecture, conventions, and the vendor-specific gotchas that took real reports to discover.

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
index.html                          Public landing page (self-contained static page, single file)
assets/                             Background images for the landing pages
app/
  CRM_Report_Generator.html         THE ACTIVE APP — edit this one
  Mileage_Calculator.html           Mileage log → expense-form .xlsx (fully self-contained)
  mileage-sync.js                   Optional cloud-sync client for the calculator
dev/
  index.html                        Developer deck (Cloudflare Access gates /dev/*)
  dashboard.html                    Command-center dashboard (single file)
mileage-backend/
  src/worker.js  wrangler.toml      Cloudflare Worker + D1 sync backend
  schema.sql  DEPLOY.md             (see DEPLOY.md for one-time setup)
src/
  engine.js                         Shared PDF extraction engine + anchor helpers + cleaners
  parsers/
    medtronic.js                    Medtronic PDF parser  → window.MEDTRONIC.runMap(LINES, META)
    boston.js                       Boston Scientific PDF  → window.BOSTON.runMap(LINES, META)
    abbott.js                       Abbott Merlin .log     → window.ABBOTT.runLog(text)
    biotronik.js                    Biotronik PDF parser  → window.BIOTRONIK.runMap(LINES, META)
vendor/
  pdf.min.js  pdf.worker.min.js     Vendored pdf.js 3.11.174 (self-hosted, not a CDN)
  jspdf.umd.min.js (+ autotable)    Vector-PDF export
  fonts/                            Self-hosted landing-page fonts
tools/
  CIED PDF Extraction Harness.html  Dump a PDF's text items (parser authoring/debugging)
  CIED_Medtronic_Parser_Preview_v2.html   Older preview harness
```

**Path conventions:** the app lives in `app/`, so its includes are relative — `../src/engine.js`,
`../src/parsers/*.js`, `../vendor/pdf.min.js`, and `pdfjsLib.GlobalWorkerOptions.workerSrc =
'../vendor/pdf.worker.min.js'`. The two dev tools in `tools/` use the same `../src` / `../vendor`
prefixes. Test fixtures (`Abbott Test Cases/`) stay local and are git-ignored.

| Component | Role |
|---|---|
| `app/CRM_Report_Generator.html` | **The active app.** Form UI, auto-fill drop panel, `prefillForm`, lead tables, report builders, save/restore, JSON import/export. |
| `src/engine.js` | Shared **PDF extraction engine** (pdf.js based) + anchor helpers + cleaners. |
| `src/parsers/medtronic.js` | Medtronic PDF parser → `window.MEDTRONIC.runMap(LINES, META)` |
| `src/parsers/boston.js` | Boston Scientific PDF parser → `window.BOSTON.runMap(LINES, META)` |
| `src/parsers/abbott.js` | Abbott Merlin **.log** parser → `window.ABBOTT.runLog(text)` |
| `src/parsers/biotronik.js` | Biotronik PDF parser (two report layouts) → `window.BIOTRONIK.runMap(LINES, META)` |
| `vendor/` | Self-hosted pdf.js **+ jsPDF/autotable** (no runtime CDN dependency). |

---

## How it works (data flow)

```
file dropped → handleFile(file)               [in app/CRM_Report_Generator.html]
   ├─ .log / .txt  → ABBOTT.runLog(text)       (read as text, BOM/encoding-aware)
   └─ .pdf         → pdf.js → Engine.extractItems → Engine.normalize → Engine.tagSections
                     → Engine.guessVendor → PARSERS[vendor].runMap(LINES)
   → (unless "Merge" is ticked) resetFormState()   — clean "New Patient" slate
   → prefillForm(RESULT, LEADS, EPISODES, { merge })
```

Every parser returns the **same bundle** (`EPISODES` optional):

```js
{ RESULT, LEADS, ROUTE, ORDER, GOTCHAS, EPISODES? }
```

**Merge import.** The auto-fill panel has a **"Merge — keep what I've entered"** checkbox. With it
off (default), import resets the form and fills fresh. With it on, `resetFormState()` is skipped and
`prefillForm(..., { merge:true })`: scalar fields fill **only where blank** (your typed values are
kept), the lead table is left alone if you've already started one, and parser `EPISODES` are
**appended** as new logbook rows instead of overwriting. Use it to chart episodes live, then drop the
PDF later to fill in the rest.

### The `RESULT` contract

`RESULT` is an object keyed by **form field id/name**. Each value:

```js
{ label, field, v, src, status, note }
//  v      = the string value to put in the field
//  status = 'auto' (confident) | 'review' (flagged for the tech to verify) | 'empty'
//  note   = short explanation, shown on review items
```

`prefillForm` sets manufacturer + device type first (they rebuild the lead rows and toggles), then loops the rest and calls `setField(key, v)`, counting fills and collecting review labels.

### The `LEADS` contract (verbatim lead inventory)

`LEADS` is an array, one entry per **physical lead**, captured **exactly as the report prints it** (no chamber normalization, duplicates/typos preserved):

```js
{ location, manufacturer, model, serial, date }
```

`setLeadInfoRows(LEADS)` rebuilds the form's lead-information table with one editable row per lead. Location/Manufacturer/Model/Serial/Implant-Date are all free-text so the table reads exactly like the source.

### Field keys used by `RESULT`

`pt-name, pt-dob, pt-mrn, pt-date, dev-implant, pt-provider, mfr, dtype, dev-model, dev-serial,
bat-lon-cur, bat-lon-unit, bat-cc-cur, pct-a, pct-v, pct-lv, pct-biv, p-mode, p-lrl, p-utr, p-usr,
dyn-av, p-sav, p-sav-hi, p-pav, p-pav-hi, p-ms, p-msrate,
lead-ra-{imp,sens,thr,pw}, lead-rv-{imp,sens,thr,pw}, lead-lv-{imp,sens,thr,pw},
lead-rv-coil-imp, lead-svc-coil-imp, ep-af-burden, ep-ahr, ep-hvr, obs-yn, obs-text, rp-chg, sig-date`

**Conventions:**
- `mfr` radio values: `Medtronic`, `Abbott`, `BSci`, `Biotronik`. (boston.js still returns the legacy `BSc`; `prefillForm` maps it to `BSci` — don't "fix" the parser, it would break nothing but it's shared history with older saves.)
- `dtype` radio values: `PPM-SC`, `PPM-DC`, `CRT-P`, `ICD-SC`, `ICD-DC`, `CRT-D`, `S-ICD`, `Leadless`, `Aveir`.
- Discrete date fields (`pt-dob`, `pt-date`, `dev-implant`) are `<input type="date">` → need ISO `yyyy-mm-dd`. The lead-table dates are free text → kept as printed.
- **Aveir (leadless)** has its own UI mode keyed off the `aveir-chamber` RA/RV checkboxes: the lead-info columns relabel "Lead …" → "Module …", the single Longevity row is replaced by per-module rows (`bat-lon-ra-cur`/`-unit`, `bat-lon-rv-cur`/`-unit`) shown only for implanted chambers, and A/V Paced % show only when the RA/RV module is present. There is no Aveir importer — it's filled manually.

### Optional bundle keys
Besides `RESULT`/`LEADS`, a parser may return `EPISODES` — an array of arrhythmia-log rows `{dt, dur, rate, types[], flags?, notes?}` that `prefillForm` writes into the logbook via `setEpisodeRows`. Currently only Boston populates it (the "Longest" AT/AF episode). Each logbook row has **flag checkboxes** (`Longest` / `Recent` / `Fastest`, name `ep{n}-flag`) that replaced the old "Approp.?" radios; a parser `notes` value that is *exactly* a flag name (e.g. Boston's `Longest`) checks the flag instead of filling Notes.

---

## `engine.js` (shared PDF helpers)

- `extractItems(pdf)` → `[{page,x,y,w,str}]`; `normalize(items)` → reading-order `LINES` (each line = `{page,y,items:[{x,str}]}`); `tagSections` marks each line `secType: 'initial'|'final'|'other'`.
- Anchor helpers: `findRight(LINES, re, {match, prefer, notLabel})`, `colsRightOf`, `twoCol` (split a row into A/RV[/LV] columns), `lineWith`.
- Cleaners: `toISO` (Medtronic `Mon/DD/YYYY`), `num`, **`cmpNum`** (keeps comparator values like `<1`, `>99`, `<0.1` instead of flattening them — used so "% paced / AF burden" can show `<1`).
- `guessVendor(items)` matches vendor signatures.

---

## Vendor specifics & hard-won gotchas

### Medtronic (`medtronic.js`)
- Routes by model + lead evidence into leadless / dual / CRT / single, then a CRT safety-net upgrade if an LV/CS lead or AdaptivCRT text is present.
- **Generator implant date** must come from device-level anchors ("Device … Implanted:" / "Device Status (Implanted: …)"), **not** the first "Implant Date" line — that one is the *first lead's* date.
- **Two-column lead measurements**: the Atrial/RV[/LV] column x-positions differ between the Quick Look and the (compressed) Session Summary, so the column split is **derived dynamically from the chamber header row** (`Atrial(####) RV(####) [LV]`), not a fixed x. **Single-chamber** reports have just one chamber token (`RV(####)` only); the split then routes that lone column to RV (or RA for an atrial-only device) so the values don't fall into the wrong chamber. Single-chamber RV reports also label sensing **"R Wave"** (not "P/R Wave"), so the sensing match accepts both.
- **MVP (Managed Ventricular Pacing)** prints two mode tokens (e.g. `AAIR  DDDR`); record the pair verbatim as `AAIR/DDDR`, don't collapse to `DDD`.
- **Pacing % comes from the "Therapy Summary" block on the Quick Look page** (`therapySummaryVal()`), which lists single, since-last-session values: dual chamber → `VP` / `AP`; CRT → `Total VP*` / `AP` plus an `Effective` row (Total VP Effective → **BiV Paced %**). Scoping to that block is essential — the Rate-Histogram pages repeat `Total VP` / `VP` as **two-column** rows (`prior | since-last`) and as a `% of AT/AF` metric, so a document-wide search grabbed the wrong number (a prior-session value, or the AT/AF-paced VP). `pct-v` ← Total VP/VP, `pct-a` ← AP/Total AP, `pct-biv` ← Effective (CRT only). Fallback when no Therapy Summary: sum the four pacing states (`AS-VP + AP-VP`, etc.).
- ICD coil impedance / charge time come from single-value rows (RV Defib / SVC Defib / Charge Time).
- Lead inventory: from the "Device Information" rows; **de-dup by serial** (the rows repeat across pages) — never by chamber (two same-chamber leads must both survive).

### Boston Scientific (`boston.js`)
- **Stacked header fields**: "Last Office Interrogation" and "Implant Date" print the value on the line *below* the label → `valueBelow()`. Interrogation date = the **"Report Created"** stamp (parsed out of that token), not "Last Office Interrogation".
- Dates are `D Mon YYYY` → vendor-local `bToISO`.
- Lead measurements are a 3-column table (Implant | Previous | **Most Recent**); read the Most-Recent column (`x ≥ ~470`).
- Quadripolar LV prints `Left Ventricular (LVa)` / `(LVb)`; LVa is the active vector. Pace-impedance rows are `Pace Impedance LVa/LVb` — keep the first (LVa).
- Dynamic AV delays print as a range (`260 - 300 ms`) → fills both bounds and flips the form's **Dynamic AV** toggle to Yes. A fixed range like `170 - 170` collapses to a single value.
- **Routing by shock evidence**, not model name (VISIONIST is CRT-P, not CRT-D!): CRT + shock = CRT-D, CRT without shock = CRT-P.
- Lead inventory is **verbatim** and read from the Patient-Data **"Leads" table column header** (`Implant Date | Manufacturer | Model | Serial | Polarity | Position`): each row's cells are assigned to the nearest header column by x, real rows are those whose Manufacturer isn't `N/R`. This captures **any** manufacturer verbatim (e.g. a legacy **Guidant** or St. Jude lead), not just Boston's own, and never pulls in the `Boston Scientific Corporation` footer (it's outside the table). (Earlier this matched the manufacturer cell exactly against `Boston Scientific`, which silently dropped non-Boston leads.)
- **Episode / arrhythmia-log mapping** — both values come from the *Since Last Reset* column, but **that column is in a different position in two adjacent blocks**, which is the subtle trap:
  - `ep-hvr` ← **Total Episodes**, which lives in the *Ventricular Tachy Counters* block laid out `Since Last Reset | Device Totals` → Since-Last-Reset is the **first/left** value (`findRight` returns it).
  - `ep-ahr` ← **prefer the device's own pre-totaled `AT/AF Events: N`** value, which prints inside the *AT/AF Overview: Since Last Reset* block (`atafEventsTotal()`). It's a **mid-row token** (e.g. `AT/AF: <1 %` | `AT/AF Events: 139` | `Total Time…`), not the first cell, so the scan checks **every** token on each line of that block. When that line is absent, **fall back** to `sumByDuration()` — the **sum of the "Episodes by Duration" buckets** (<1m + 1m–1h + 1h–24h + 24h–48h + >48h, walking to "Total PACs" which is **excluded**). Those rows are in the *Brady / Atrial Arrhythmia* block laid out `Reset Before Last | Since Last Reset` → Since-Last-Reset is the **rightmost** value, so `sumByDuration()` takes the rightmost numeric cell on each row, **not** the first (the first is Reset Before Last — often 0, which was the bug that returned AHR = 0). The two agree when both are present (the total == the bucket sum); the source note records which path filled the field.
  - The **"Longest"** episode under *AT/AF Overview: Since Last Reset* (not *Reset Before Last*) is pushed to the logbook as one row (date/time, duration, avg V rate, type AF/AHR, note "Longest").
  - (There is no `ep-total` — that field was removed; episodes are entered/typed, and HVR/AHR are the counters.)

### Biotronik (`biotronik.js`)
Biotronik exports come in (at least) **two very different templates**, and the parser handles both:
- **(A) Home-Monitoring report** — text fragmented into per-character tokens (`"R"+"ecent"`), bold headers drawn 2–4× (duplicate tokens), values in far-right columns (A ~x407, V ~x485), device on a `… S/N: …` line.
- **(B) Standard / BIOSTD report** — whole-word tokens, a clean first line `PDF: BIOTRONIK - <model> - <serial> - <Last, First> - p/N`, values closer in (A/V ~x315/x406 or x334/x378/x400), leads as an A|V table (no per-lead serials), and different labels (`Atrial burden`, `P/R wave amplitude`, fixed `AV delay`).

Unifying tricks:
- **Dynamic label/value split** at `VSPLIT≈305`: tokens left of it are the (joined, de-spaced) label — so both fragmentation styles normalize to the same key (`leftStr`); tokens right of it are values. A value row's **first** value token = Atrial, **second** = Ventricular (`avField`); `-----` = not measured.
- **Header** is read from the clean `PDF: BIOTRONIK - …` line when present, else from the `S/N:` line (model from the fragmented header tokens → flagged review).
- **Leads**: Home-Monitoring lists per-lead blocks (with serials, deduped); Standard lists an A|V table (Type/Manufacturer/Position, no serials → uses the device implant date).
- Dates `MM/DD/YYYY` → `bToISO`. Longevity from "Calculated/Expected ERI N Y. M Mo." → years. AV is dynamic (`300/260` → min–max + Dynamic AV = Yes) or fixed (`AV delay [ms] 240`). Multiple interrogations/test runs appear, so values come from the **last (non-empty)** matching row.
- **Lead measurements (impedance / sensing / threshold / pulse width) are scoped to the last "Test results" block** (`avScoped`): if a chamber's row there shows `-----` (not measured), the field stays **blank**. Without this, the label "Pulse width [ms]" also appears in the programmed-output and test-program sections, and a whole-document "keep last non-empty" search leaked the *programmed* atrial pulse width (e.g. `1.0`) into a chamber whose measured value was `-----`. Fields whose row is genuinely absent from the block fall back to the wider search (e.g. the Home-Monitoring threshold lives in a different section).
- **Validated against one dual-chamber PPM in each layout** — ICD/CRT and single-chamber Biotronik are unverified.

### Abbott / St. Jude (`abbott.js`)
- Input is the Merlin **.log**, which is **FS-delimited**: each line is `code <FS> name <FS> value <FS> unit <FS>` where `<FS>` = ASCII `0x1C`. Pasted into an editor the separators are invisible (so `2.0V` looks concatenated — it's `2.0<FS>V`). Values are keyed by the **numeric code** (unique per line).
- The reader is **encoding-aware**: `handleFile` decodes with a BOM-sniffing `TextDecoder` (UTF-16/UTF-8); `runLog` also strips stray BOM/null bytes and accepts any line ending.
- **Routing is structural**: an LV lead ⇒ CRT; shock evidence (HV-lead impedance / shock config / capacitor charge) ⇒ defibrillator. So CRT+shock = CRT-D, CRT no-shock = CRT-P, non-CRT+shock = ICD, else PPM.
- Abbott uses **different codes for different lead types** — e.g. RV pace/sense lead (`2461/2470/2463/2460`) vs RV defib lead (`2448/2449|2450/2469/2451`); model can be "SJM …" vs "Other …". A `first(...candidates)` helper resolves each cell.
- Key codes: `200/201` model, `202` serial, `203` interrogation, `2442` implant, `2430/2431` name/DOB, `301` mode, `302/323/406` LRL/UTR/USR, `337/322` sensed/paced AV, `320` rate-responsive AV (dynamic), `339` AMS, `512/507/2720` RA/RV/LV impedance, `2721/2722` RA/RV sensing, `1610/1606/1616` RA/RV/LV capture-test thresholds, `2730` HV (coil) impedance, `2745` charge time, `533` longevity.

---

## Form / UI features (in `app/CRM_Report_Generator.html`)

- **Auto-fill drop panel** accepts PDF (Medtronic/Boston) and `.log` (Abbott), with the **"Merge — keep what I've entered"** checkbox described in the data-flow section above.
- **Force "New Patient" on every import** — `resetFormState()` clears the form in-memory (no page reload, which would abort the file read) so nothing from a prior patient lingers. (Skipped in merge mode.)
- **Lead-info table is verbatim**: editable Location, a **Manufacturer** column, free-text model/serial/implant-date; one row per scraped lead. (Aveir relabels these columns "Module …".)
- **Dynamic AV** Yes/No toggle with min/max fields (defaults No; importer flips it for true ranges).
- **% paced & AF burden are text inputs** and comparator-aware (`<1` survives instead of becoming `1`).
- **Aveir leadless mode** — picking the `Aveir` device type reveals RA/RV chamber checkboxes that drive the lead-info rows, per-module Longevity rows, and which pacing-% fields show (see Conventions above).
- **Episode logbook** — a **"Logbook / Free text"** radio (`ep-mode`, default Logbook) lets you either use the row-based table or type a single free-text block (`ep-freetext`). The logbook defaults to 1 row ("+ Add Episode" for more); a parser's `EPISODES` rows are written in automatically. **Observations** (`obs-yn` + `obs-text`) live at the bottom of this section.
- **Section layout — follows the in-room device-check flow:** Patient & Device · Battery / Device Status · Stored Episodes / Arrhythmia Log (+ Observations) · Lead / Electrode Measurements · Programmed Parameters · **Final Session Summary** (a merge of Reprogramming changes + Remote Monitoring + the Device Technician / Date-Completed sign-off, all under one header). Rationale: interrogate → review counters/episodes → run lead tests → confirm/adjust programming → sign off. Sidebar groups mirror this (Interrogation / Testing / Programming / Documentation).
- **Export buttons:** New Patient · Copy to Clipboard · Export .txt · **JSON** (a dropdown: Import / Export) · **PDF** (a dropdown: **Print** = browser print, **Save (PDF file)** = a real vector PDF built with jsPDF and saved like the JSON exports).
  - **JSON export/import** round-trips the whole form via `collectFormData()` / `applyFormData()`. It serializes the dynamic lead-table rows separately as `__leadinfo` (the cells have no id/name) and **excludes file inputs / auto-fill tool controls** (`pdp-*`, `json-import-file`) — those threw on import (you can't set `input[type=file].value`), which used to abort the whole restore. Import does a clean reset first.
  - **Save-location aware** — `saveFile()` uses `showSaveFilePicker` (desktop/Android Chrome → pick folder/USB), else `navigator.share` (iOS Safari → share sheet → "Save to Files"; shares the file **only**, no title/text, or iOS writes a stray `.txt`), else a classic download. The same path saves both JSON and the vector PDF; the export menu is closed in a `finally` (after the picker/share resolves) so the trigger element survives until the sheet presents.
  - **iPad share-sheet caveat** — on **iPad Safari**, `navigator.share` is a *popover* whose anchor iPadOS controls; with nothing focused it falls back to the page body (top-left, scrolling off as you scroll down). Mitigation: on iPad (`isIPad()`), focus a visible top-toolbar button right before sharing so the popover anchors on-screen. This is a Safari limitation, not web-fixable in general — **Chrome on iPad** wraps the sheet in its own centered UI and works regardless; iPhone shows a bottom sheet regardless. If reliable placement is ever required on iPad Safari, the fallback is a direct download (no popover).
- **Text/clipboard report** (`buildSummaryLines`) — a single **compact** format (the older labeled "Full" format was removed): single-space ` | ` pipes, no blank lines between sections, no `Mfr:`/`Model:` labels (manufacturer + model are joined), `SN:`/`Impl:` shorthand. BATTERY / STATUS folds onto ≤4 lines — Longevity|Battery · Function|Dependency|Rhythm · Mode|LRL|UTR|USR · pacing-% (BiV only when present). MEASUREMENTS are one line per lead: `RA Lead: 512 Ω | 2.9 mV | 0.7 V @ 0.4 ms` (Thr+PW merged). Empty AF Burden is omitted (no `—%` placeholder). FINAL SESSION SUMMARY carries Changes+Provider on one line and Remote Monitoring on one line. The *Device Technician* block is intentionally omitted (the EHR stamps it); the **PDF keeps it**.
  - **Episode rows** print tight under the counter line, unnumbered; each row is one pipe-separated line ending with any checked **flags** (`Longest, Fastest` …). **Notes print on their own line below the episode** as `    Notes: <text>` (4-space indent, like reprogramming rows), word-wrapped to ~78 cols with continuation lines aligned.
  - **Observations** render only when `obs-yn` = **Yes** (`N/A` is omitted entirely) as `Obs: <free text>`, word-wrapped by `wrapLines()` to the same right margin.
  - **Import-time normalizers** (in the app, *not* the parsers): lead-info implant dates from any vendor are normalized to `MM/DD/YYYY` (unparseable → verbatim), and all numeric measurement fields pass through one cleaner (units stripped, comparators like `<1` kept, `3,2`→`3.2`, `1,045`→`1045`).
- **PDF report** (vector, jsPDF): compact one-page-oriented layout; Provider on the patient line; Stored Episodes omitted when empty; renders the episode free-text block when that mode is active. The key/value `grid()` takes a **column count** — Patient & Device renders at **5 columns** and Programmed Parameters at **4** so each fits in 2 rows. Its `val()` looks up by `id` **then `name`**, so the battery-table inputs (Longevity, per-module RA/RV longevity, charge time) — which carry only a `name` — are no longer dropped from the PDF.
- Autosave to `localStorage` (key `crm-digital`) — now including the lead table (`__leadinfo`); "New Patient" button clears + reloads.
- **Responsive layout** — below 820px the sidebar collapses, the auto-fill panel flows inline at the top of the form, dense field grids reflow, and wide tables scroll horizontally. The JSON/PDF menus live at body level (the app bar gets `overflow:auto` on mobile, which would clip them) and are **`position:fixed`, anchored in viewport coordinates** under the (fixed) app-bar button — `r.bottom + 4` with **no** scroll offset. (An earlier version used `position:absolute` + `pageYOffset`; mixing document coordinates with the share popover is what pushed the iOS share sheet off-screen when scrolled.)

---

## The other tools

### Landing pages (`index.html`, `dev/index.html`)

Both landing pages were redesigned Jul 2026 as **single self-contained static pages**: no scripts, cards hardcoded in the HTML, inline styles, fonts self-hosted in `vendor/fonts` (no Google Fonts at runtime), and each ships its own CSP (`script-src 'none'; connect-src 'none'`, no external origins) per the per-page-CSP rule below. **Adding/editing a tool card is an edit in the page itself.** The old shared renderer (`home.js`) and theme (`assets/site.css`) were removed with this redesign (git history has them).

- `index.html` — public index (Public Sans + JetBrains Mono). Shows the two public tools plus a locked "Developer Deck" card.
- `dev/index.html` — developer deck, pirate-themed (Pirata One / Cinzel / Spectral, background `assets/dev-bg-crew.webp`). Lists all four tools. Card hrefs are relative (`../app/…`), so it works from `file://` and from the web root. The `/dev/*` gate is Cloudflare Access, configured in the Cloudflare dashboard — nothing in this repo enforces it.

### Mileage Calculator (`app/Mileage_Calculator.html` + `app/mileage-sync.js`)

Logs clinic-coverage days (AM clinic → PM clinic) and computes reimbursable miles by the home-adjustment method: `(home→AM) + (AM↔PM leg) + (PM→home) − normal round-trip commute to the base clinic`, floored at 0. Up to 5 locations with per-user distances, drag-to-reorder log, config/profile JSON import-export, and a one-click **expense-form .xlsx** (xlsx-js-style embedded inline — no CDN). State lives in localStorage (`mileageToolV1`); new rows default to the **local** date (not UTC — that bug put evening entries on tomorrow).

**Cloud sync** is an optional layer in `mileage-sync.js`: username/passphrase accounts (invite-code gated), 12-hour JWT sessions, offline-first with a debounced push on every save, pull-then-reconcile on load, and last-write-wins conflict resolution keyed off a server-side version number. If `WORKER_URL` is blank the file does nothing and the page stays local-only.

### Mileage sync backend (`mileage-backend/`)

Cloudflare Worker + D1 (`mileage-sync.spencer559.workers.dev`). One JSON blob per user, PBKDF2-SHA256 password hashing, HS256 JWTs, optimistic-concurrency writes (stale version → 409 with the server copy; `force:true` for a client-resolved LWW push), CORS restricted to the origins in `wrangler.toml` `ALLOWED_ORIGIN`. Secrets (`JWT_SECRET`, `INVITE_CODE`) are set with `wrangler secret put`; setup steps are in `DEPLOY.md`. **It only ever touches mileage data — no PHI.** The local `.wrangler/` cache is git-ignored.

### Developer dashboard (`dev/dashboard.html`)

Single-file command center behind the `/dev/` gate: clock + Open-Meteo weather (currently hard-coded to LA coords); Finnhub-powered watchlist, index strip and sector heatmap (bring your own free key, stored locally; requests are queued/paced/cached to respect the 60-calls-per-minute free tier); a device-check tally with 7-day history; clinical reference tabs (portals, a **Timing Lab** — ms⇄bpm + TARP/upper-rate calculators, EGM gain/sweep box-scale calculators, and a DDD timing-cycle simulator (static canvas marker-channel strip — simulates to steady state and redraws on any change — showing 1:1 tracking / pseudo-Wenckebach / 2:1 block / LRL pacing) — a **Tachy Lab** (zone/therapy planner: VT-1/VT/VF boundaries with detection and therapy sequences, SVT-discriminator limit, a color-banded rate ladder in bpm+ms, and a rate probe reporting zone / discriminator status / time-to-detect / therapy path) — measurement ranges, SVT–VT discriminators, patient alerts, troubleshooting, MRI lookups, magnet rates) plus an EGM marker glossary; notes and a to-do list. A **Modules** dropdown in the header (left of the panel filter) links to the other tools so the dashboard can serve as home base.

Persistence details worth knowing before editing:

- All state is localStorage. An optional **portable data file** (File System Access API, with the handle remembered in IndexedDB) mirrors it to a JSON file — e.g. on a USB stick — and auto-reconnects on load.
- The snapshot/restore is **whitelisted** to dashboard-owned keys (`watchlist`, `finnhubKey`, `notes`, `todos`, `viewMode`, `refTab`, `tachyLab`, `tally-*`). This matters: the dashboard shares an origin — and therefore localStorage — with the CRM tool's PHI autosave (`crm-digital`) and the mileage auth token, so an unfiltered mirror would write PHI into the data file. Don't widen the whitelist casually.
- Tally keys use **local** dates (`localISO()`), not `toISOString()` (UTC), so evening checks don't land on tomorrow's tally.
- Its CSP allows egress only to `api.open-meteo.com` and `finnhub.io`, and no third-party scripts run (TradingView widgets were removed for exactly this reason).

### Patient Schedule (`dev/Patient_Schedule.html`)

A daily device-clinic schedule behind the `/dev/` Cloudflare Access gate. **Data-minimized by design**: rows hold time, patient *initials only* (no MRN/DOB/name fields exist), manufacturer, device type, check type (in-clinic / remote / pre-op), a **last in-office check** date, a remote-monitoring connection status (Connected / Not connected / External clinic / N/A — "Not connected" rows are tallied in the count line and the printed header), and a notes line. A **"Move day…"** button beside the date picker reassigns an entire day to a different date (merge-confirm if the target day already has rows, blocked past the 7-day retention window) — the fix for a schedule accidentally entered under the wrong date. Its CSP is `connect-src 'none'` like the CRM tool — nothing typed on the page can reach a network.

Workflow/storage: localStorage per day (days older than 7 are auto-purged), an optional **schedule file** connected via the File System Access API (e.g. a JSON in OneDrive — remembered handle, auto-saves on every change, auto-reconnects), plain JSON export/import, a dedicated **print view** (`@media print` day sheet — sorted by time, serif, count summary, "shred after use" footer), and a **"Walk away — clear this station"** button that flushes to the connected file, wipes localStorage, and forgets the file handle. Storage is deliberately *not* encrypted (user decision: relies on the Access gate, workstation login, and the walk-away habit) — revisit if that assumption changes. Never wire this page to the mileage sync Worker or any other backend.

---

## Security / hosting

- **Self-hosted libraries** — `vendor/pdf.min.js` + `pdf.worker.min.js` (pdf.js v3.11.174) **and** `jspdf.umd.min.js` + `jspdf.plugin.autotable.min.js` (the vector-PDF generator) are committed to the repo; nothing is pulled from a CDN at runtime. `engine.js` derives the worker URL from the page's own `pdf.min.js` `<script>` tag (and respects a `workerSrc` the page set explicitly), so no third-party script ever runs in the same context as PHI.
- **Content-Security-Policy** — the app HTML ships a `<meta http-equiv="Content-Security-Policy">` whose key directive is `connect-src 'none'`: the page cannot make *any* network request, so PHI cannot be exfiltrated. `script-src`/`style-src` keep `'unsafe-inline'` only because the form uses inline handlers + `<script>` blocks (that allowance grants no network egress); `worker-src 'self' blob:` lets the local pdf.js worker run.
- **Per-page CSPs across the origin** — every page on this origin shares localStorage with the CRM autosave, so each ships its own CSP: the Mileage Calculator's `connect-src` permits only the sync Worker, and the dashboard's only its two data feeds (Open-Meteo, Finnhub). No page may load third-party scripts.
- **Hosting** — Cloudflare Pages (`device-tech.pages.dev`), with `/dev/*` behind Cloudflare Access. The old GitHub Pages origin is kept in the Worker's `ALLOWED_ORIGIN` during the transition; drop it once disabled.
- **Still out of scope (deployment-level):** access controls on the public tools, audit logging, encryption at rest (localStorage + downloaded files are plaintext), and the fact that a public static host is not automatically HIPAA-eligible. See any compliance review before clinical use.

---

## Current status

**Working & verified against real (redacted) reports:**
- Medtronic PPM / ICD / CRT (incl. MVP, dynamic two-column split, verbatim inventory, Therapy-Summary-scoped pacing % with CRT `Total VP` / `Effective`→BiV; validated on Azure dual + Cobalt XT CRT).
- Boston PPM-DC / ICD-DC / CRT-D / CRT-P (incl. quadripolar LV, dynamic AV, comparators, shock-based routing, and episode/arrhythmia-log mapping → HVR / AHR (prefers the `AT/AF Events` total, falls back to the bucket sum) + Longest AT/AF row).
- Abbott PPM-DC / ICD-DC / CRT-D / CRT-P via `.log` (Fortify / Gallant DR/HF / Quadra Allure/Assure families).
- Biotronik dual-chamber **PPM** via both report layouts (Home-Monitoring + Standard/BIOSTD); per-character text handling, A/V column split, and lead measurements scoped to the "Test results" block so an unmeasured (`-----`) chamber stays blank instead of inheriting the programmed pulse width.
- **Aveir** dual-chamber leadless — manual entry only (no importer), with per-module lead rows, longevity, and pacing % driven by the RA/RV chamber checkboxes.
- **JSON export/import** round-trips a full record (incl. the lead table); **pdf.js self-hosted** under a strict CSP (no network egress).
- **Workflow / UI:** merge-import (keep live-typed data), episode logbook ↔ free-text toggle, merged **Final Session Summary** section, save-location-aware exports (desktop picker / iOS share sheet), and a mobile-fixed JSON menu.
- **Patient Schedule** (initials-only day sheet, local-only, print view, OneDrive-file persistence, walk-away wipe) added behind the `/dev/` gate.
- **Site passover (Jul 2026):** dashboard data-file snapshot/restore whitelisted to dashboard-owned keys (a full-localStorage mirror was writing the CRM PHI autosave into exports); tally + mileage "Add day" switched to local dates (UTC `toISOString` rolled evening entries to tomorrow); Mileage Calculator got a CSP matching the other pages; `mileage-backend/.wrangler/` untracked and git-ignored.

**Known gaps / TODO ideas:**
- Abbott PDF (scanned image) is **not** supported — `.log` only. (OCR would be the only PDF route.)
- Abbott `ep-af-burden` / `ep-hvr` aren't pulled (no single value in the `.log`); left for manual entry.
- Abbott `% paced` uses the recent Event-Histogram value; lifetime figures are in the note. Confirm which the clinic wants.
- A few Abbott edge cases (legacy/other-manufacturer leads) may leave a lead model blank (serial still captured).
- Boston **single-chamber** and several less-common families are scaffolded but not validated with real exports.
- **Biotronik** parser handles two report layouts (Home-Monitoring + Standard/BIOSTD), each validated against one dual-chamber PPM; ICD/CRT and single-chamber Biotronik are unverified, and the Home-Monitoring `dev-model` needs verification (fragmented header text).
- Lead-table cells have no `id`/`name`, so they're saved/restored via the dedicated `__leadinfo` array (handled — autosave + JSON now persist the lead table). Anything else without an id/name would still be missed by the generic serializer.

---

## Testing / continuing the work

- **Manual:** open `app/CRM_Report_Generator.html` locally (or on the Pages site) and drop a vendor PDF or Abbott `.log` on the "Auto-fill" panel.
- **PDF authoring:** use `tools/CIED PDF Extraction Harness.html` to dump a PDF's text items, then write/adjust anchors in the vendor parser under `src/parsers/`.
- **Headless checks:** the parser logic is plain JS and can be exercised in Node by `eval`-ing the vendor file (with `globalThis.window = globalThis`) and feeding it a reconstructed `LINES` array (PDF) or raw `.log` text — the fastest way to verify a change against a sample before clicking through the form. UI-logic changes can be checked with jsdom (load the app HTML, stub `IntersectionObserver`, drive the functions).

### To add a new vendor
1. Add a parser file under `src/parsers/` exposing `runMap(LINES)` (PDF) or a text entry point (like Abbott's `runLog`), returning the `{RESULT, LEADS, ROUTE, ORDER, GOTCHAS}` bundle (optionally `EPISODES`) with the field keys above.
2. Register it: PDF vendors go in `Engine.VENDORS` + the `PARSERS` map in the app HTML; a text format gets its own branch in `handleFile`.
3. Add the `<script src="../src/parsers/yourvendor.js">` include in `app/CRM_Report_Generator.html` (after `../src/engine.js`).

---

## Privacy note

This repo is **public** and the site is served from Cloudflare Pages (`device-tech.pages.dev`); only `/dev/*` sits behind Cloudflare Access.
- Keep patient data (names, DOBs, device serial numbers, raw vendor exports) out of anything committed. Sample/scratch files used for testing should stay local or be `.gitignore`d (currently `Info.txt`, `Abbott Test Cases/`, and `mileage-backend/.wrangler/`).
- The app itself never transmits data — all parsing happens in the browser, pdf.js is self-hosted, and the CSP's `connect-src 'none'` blocks every network request (see **Security / hosting**).
- This covers only what the page controls. Hosting, access control, audit logging, and encryption at rest are deployment concerns a compliance review must address before clinical use.