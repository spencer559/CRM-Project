# CRM Interrogation Report Generator

A browser-based tool for documenting **CIED** (cardiac implantable electronic device — pacemakers, ICDs, CRT) interrogation visits. It auto-fills a structured clinical form by reading the manufacturer's own export file locally in the browser, then produces a printable PDF report and a plain-text summary for pasting into an EHR.

Everything runs **client-side** (no server, no upload). It is published as a static GitHub Pages site.

> This README doubles as a **project handoff / context document** — if you're an AI assistant (e.g. Claude in Cowork) being pointed here to continue the work, read the whole thing; it captures the architecture, conventions, and the vendor-specific gotchas that took real reports to discover.

---

## What it does

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

---

## Project layout

| File | Role |
|---|---|
| `CRM_Report_Generator_Test.html` | **The active app.** The whole form UI, auto-fill drop panel, `prefillForm`, lead tables, report builders, save/restore. Edit this one. |
| `CRM_Report_Generator.html` | Older variant, not actively maintained. |
| `engine.js` | Shared **PDF extraction engine** (pdf.js based) + anchor helpers + cleaners. Used by the PDF vendors. |
| `medtronic.js` | Medtronic PDF parser → `window.MEDTRONIC.runMap(LINES, META)` |
| `boston.js` | Boston Scientific PDF parser → `window.BOSTON.runMap(LINES, META)` |
| `abbott.js` | Abbott Merlin **.log** parser → `window.ABBOTT.runLog(text)` |
| `CIED PDF Extraction Harness.html` | Standalone tool to dump a PDF's text items (useful for authoring/adjusting parsers). |
| `CIED_Medtronic_Parser_Preview_v2.html` | Older preview harness. |
| `index.html` | Landing page. |

---

## How it works (data flow)

```
file dropped → handleFile(file)               [in CRM_Report_Generator_Test.html]
   ├─ .log / .txt  → ABBOTT.runLog(text)       (read as text, BOM/encoding-aware)
   └─ .pdf         → pdf.js → Engine.extractItems → Engine.normalize → Engine.tagSections
                     → Engine.guessVendor → PARSERS[vendor].runMap(LINES)
   → resetFormState()        (force a clean "New Patient" slate first)
   → prefillForm(RESULT, LEADS)
```

Every parser returns the **same bundle**:

```js
{ RESULT, LEADS, ROUTE, ORDER, GOTCHAS }
```

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
bat-lon-cur, bat-lon-unit, bat-cc-cur, pct-a, pct-v, pct-lv, p-mode, p-lrl, p-utr, p-usr,
dyn-av, p-sav, p-sav-hi, p-pav, p-pav-hi, p-ms, p-msrate,
lead-ra-{imp,sens,thr,pw}, lead-rv-{imp,sens,thr,pw}, lead-lv-{imp,sens,thr,pw},
lead-rv-coil-imp, lead-svc-coil-imp, ep-af-burden, ep-hvr, obs-yn, obs-text, rp-chg, sig-date`

**Conventions:**
- `mfr` radio values: `Medtronic`, `Abbott`, `BSc`, `Biotronik`.
- `dtype` radio values: `PPM-SC`, `PPM-DC`, `CRT-P`, `ICD-SC`, `ICD-DC`, `CRT-D`, `S-ICD`, `Leadless`, `Aveir`.
- Discrete date fields (`pt-dob`, `pt-date`, `dev-implant`) are `<input type="date">` → need ISO `yyyy-mm-dd`. The lead-table dates are free text → kept as printed.

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
- **Two-column lead measurements**: the Atrial/RV[/LV] column x-positions differ between the Quick Look and the (compressed) Session Summary, so the column split is **derived dynamically from the chamber header row** (`Atrial(####) RV(####) [LV]`), not a fixed x.
- **MVP (Managed Ventricular Pacing)** prints two mode tokens (e.g. `AAIR  DDDR`); record the pair verbatim as `AAIR/DDDR`, don't collapse to `DDD`.
- ICD coil impedance / charge time come from single-value rows (RV Defib / SVC Defib / Charge Time).
- Lead inventory: from the "Device Information" rows; **de-dup by serial** (the rows repeat across pages) — never by chamber (two same-chamber leads must both survive).

### Boston Scientific (`boston.js`)
- **Stacked header fields**: "Last Office Interrogation" and "Implant Date" print the value on the line *below* the label → `valueBelow()`. Interrogation date = the **"Report Created"** stamp (parsed out of that token), not "Last Office Interrogation".
- Dates are `D Mon YYYY` → vendor-local `bToISO`.
- Lead measurements are a 3-column table (Implant | Previous | **Most Recent**); read the Most-Recent column (`x ≥ ~470`).
- Quadripolar LV prints `Left Ventricular (LVa)` / `(LVb)`; LVa is the active vector. Pace-impedance rows are `Pace Impedance LVa/LVb` — keep the first (LVa).
- Dynamic AV delays print as a range (`260 - 300 ms`) → fills both bounds and flips the form's **Dynamic AV** toggle to Yes. A fixed range like `170 - 170` collapses to a single value.
- **Routing by shock evidence**, not model name (VISIONIST is CRT-P, not CRT-D!): CRT + shock = CRT-D, CRT without shock = CRT-P.
- Lead inventory is **verbatim** — manufacturer cell must match exactly `Boston Scientific` (the page footer says `Boston Scientific Corporation`).

### Abbott / St. Jude (`abbott.js`)
- Input is the Merlin **.log**, which is **FS-delimited**: each line is `code <FS> name <FS> value <FS> unit <FS>` where `<FS>` = ASCII `0x1C`. Pasted into an editor the separators are invisible (so `2.0V` looks concatenated — it's `2.0<FS>V`). Values are keyed by the **numeric code** (unique per line).
- The reader is **encoding-aware**: `handleFile` decodes with a BOM-sniffing `TextDecoder` (UTF-16/UTF-8); `runLog` also strips stray BOM/null bytes and accepts any line ending.
- **Routing is structural**: an LV lead ⇒ CRT; shock evidence (HV-lead impedance / shock config / capacitor charge) ⇒ defibrillator. So CRT+shock = CRT-D, CRT no-shock = CRT-P, non-CRT+shock = ICD, else PPM.
- Abbott uses **different codes for different lead types** — e.g. RV pace/sense lead (`2461/2470/2463/2460`) vs RV defib lead (`2448/2449|2450/2469/2451`); model can be "SJM …" vs "Other …". A `first(...candidates)` helper resolves each cell.
- Key codes: `200/201` model, `202` serial, `203` interrogation, `2442` implant, `2430/2431` name/DOB, `301` mode, `302/323/406` LRL/UTR/USR, `337/322` sensed/paced AV, `320` rate-responsive AV (dynamic), `339` AMS, `512/507/2720` RA/RV/LV impedance, `2721/2722` RA/RV sensing, `1610/1606/1616` RA/RV/LV capture-test thresholds, `2730` HV (coil) impedance, `2745` charge time, `533` longevity.

---

## Form / UI features (in `CRM_Report_Generator_Test.html`)

- **Auto-fill drop panel** accepts PDF (Medtronic/Boston) and `.log` (Abbott).
- **Force "New Patient" on every import** — `resetFormState()` clears the form in-memory (no page reload, which would abort the file read) so nothing from a prior patient lingers.
- **Lead-info table is verbatim**: editable Location, a **Manufacturer** column, free-text model/serial/implant-date; one row per scraped lead.
- **Dynamic AV** Yes/No toggle with min/max fields (defaults No; importer flips it for true ranges).
- **% paced & AF burden are text inputs** and comparator-aware (`<1` survives instead of becoming `1`).
- **Episode table defaults to 1 row** ("+ Add Episode" for more).
- **PDF report**: compact one-page-oriented layout; Provider on the patient line; the Stored Episodes section is omitted when empty.
- **Text report (clipboard / .txt)** omits the *Device Technician* block (the EHR stamps date + signing tech); the **PDF keeps it** (that copy is printed/signed).
- Autosave to `localStorage` (key `crm-digital`); "New Patient" button clears + reloads.

---

## Current status

**Working & verified against real (redacted) reports:**
- Medtronic PPM / ICD / CRT (incl. MVP, dynamic two-column split, verbatim inventory).
- Boston PPM-DC / ICD-DC / CRT-D / CRT-P (incl. quadripolar LV, dynamic AV, comparators, shock-based routing).
- Abbott PPM-DC / ICD-DC / CRT-D / CRT-P via `.log` (Fortify / Gallant DR/HF / Quadra Allure/Assure families).

**Known gaps / TODO ideas:**
- Abbott PDF (scanned image) is **not** supported — `.log` only. (OCR would be the only PDF route.)
- Abbott `ep-af-burden` / `ep-hvr` aren't pulled (no single value in the `.log`); left for manual entry.
- Abbott `% paced` uses the recent Event-Histogram value; lifetime figures are in the note. Confirm which the clinic wants.
- A few Abbott edge cases (legacy/other-manufacturer leads) may leave a lead model blank (serial still captured).
- Boston **single-chamber** and several less-common families are scaffolded but not validated with real exports.
- **Biotronik** is recognized by signature but has **no parser** yet.
- Lead-table values aren't persisted by the `localStorage` autosave (the inputs have no id/name) — only in-session.

---

## Testing / continuing the work

- **Manual:** open `CRM_Report_Generator_Test.html` locally (or on the Pages site) and drop a vendor PDF or Abbott `.log` on the "Auto-fill" panel.
- **PDF authoring:** use `CIED PDF Extraction Harness.html` to dump a PDF's text items, then write/adjust anchors in the vendor `.js`.
- **Headless checks:** the parser logic is plain JS and can be exercised in Node by `eval`-ing the vendor file (with `globalThis.window = globalThis`) and feeding it a reconstructed `LINES` array (PDF) or raw `.log` text. Since the browser can't be driven in a quick dev loop, that's the fastest way to verify a change against a sample before clicking through the form.

### To add a new vendor
1. Add a parser file exposing `runMap(LINES)` (PDF) or a text entry point (like Abbott's `runLog`), returning the `{RESULT, LEADS, ROUTE, ORDER, GOTCHAS}` bundle with the field keys above.
2. Register it: PDF vendors go in `Engine.VENDORS` + the `PARSERS` map in the HTML; a text format gets its own branch in `handleFile`.
3. Add the `<script src>` include in `CRM_Report_Generator_Test.html`.

---

## Privacy note

This repo is a **public** GitHub Pages site.
- Keep patient data (names, DOBs, device serial numbers, raw vendor exports) out of anything committed. Sample/scratch files used for testing should stay local or be `.gitignore`d.
- The app itself never transmits data — all parsing happens in the browser.
