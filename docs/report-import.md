# Report import pipeline and vendor parsers

How a dropped programmer export becomes a filled-in form: the parser contract, the shared PDF
engine, and the vendor-specific gotchas that took real reports to discover. Moved out of the README;
the form itself is in [report-generator.md](report-generator.md). When an import goes wrong, the
Report Generator's *Report import problem* turns the report into a de-identified, replayable case:
[import-cases.md](import-cases.md). Web paths here (`protected/`, `src/`, `vendor/`, `tools/`,
`mileage/`) are relative to `site/`, which is also their URL path.

## How it works (data flow)

```
file dropped → handleFile(file)               [in protected/CRM_Report_Generator.html]
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

**Merge import.** Merge is a **toggle at the bottom of the Import menu** (`Import ▸ Merge — keep
what I've entered`) that governs **every** import path: `Import PDF / .log…`, and the
`Auto-fill from <file>` items under **Import Database** (a programmer export attached to the
patient's slot in the Schedule). It works because `#pdp-merge` — the checkbox in the hidden
auto-fill panel — is the single source of truth that `handleFile` reads, and the database items go
through `handleFile` too; the toggle just drives that checkbox. (It replaced a separate
`Merge PDF / .log…` menu item, which only ever covered the file-picker path — there was no way to
merge a database import.) Merge is a **sticky mode**, so note the safety property: `openSlot()`
calls `resetFormState()`, which unchecks every checkbox including `#pdp-merge` — opening a patient
turns Merge back **off**, so it can't leak across patients and merge one patient's export into
another's form. Don't make `#pdp-merge` survive a patient switch.

With it off (default), import resets the form and fills fresh. With it on, `resetFormState()` is skipped and
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

Parsers capture **every** lead the report prints, including abandoned/capped ones (a CRT-P with 5 leads is a real case) — deciding which are still in use is the tech's job, not the parser's, so each row has an **×** to remove it and a **+ Add Lead** button for one the importer missed. All three report builders read the table through `leadInfoRows()`, which drops rows whose cells are all blank; clearing a row is equivalent to ×-ing it. Don't reintroduce a `data-loc` fallback that fires on a fully-blank row — that's what used to keep a cleared row (and once, a literal `RV#0`) on the PDF.

### Field keys used by `RESULT`

`pt-name, pt-dob, pt-mrn, pt-date, dev-implant, pt-provider, mfr, dtype, dev-model, dev-serial,
bat-lon-cur, bat-lon-unit, bat-cc-cur, bat-status, pct-a, pct-v, pct-lv, pct-biv, p-mode, p-lrl, p-utr, p-usr,
dyn-av, p-sav, p-sav-hi, p-pav, p-pav-hi, p-ms, p-msrate,
lead-ra-{imp,sens,thr,pw}, lead-rv-{imp,sens,thr,pw}, lead-lv-{imp,sens,thr,pw},
lead-rv-coil-imp, lead-svc-coil-imp, ep-since-date, ep-af-burden, ep-ahr, ep-hvr, ep-pmt, obs-yn, obs-text, rp-chg, sig-date`

**Conventions:**
- `mfr` radio values: `Medtronic`, `Abbott`, `BSci`, `Biotronik`. (boston.js still returns the legacy `BSc`; `prefillForm` maps it to `BSci` — don't "fix" the parser, it would break nothing but it's shared history with older saves.)
- `dtype` radio values: `PPM-SC`, `PPM-DC`, `CRT-P`, `ICD-SC`, `ICD-DC`, `CRT-D`, `S-ICD`, `Leadless`, `Aveir`.
- Discrete date fields (`pt-dob`, `pt-date`, `dev-implant`) are `<input type="date">` → need ISO `yyyy-mm-dd`. The lead-table dates are free text → kept as printed.
- **Aveir (leadless)** has its own UI mode keyed off the `aveir-chamber` RA/RV checkboxes: the lead-info columns relabel "Lead …" → "Module …", the single Longevity row is replaced by per-module rows (`bat-lon-ra-cur`/`-unit`, `bat-lon-rv-cur`/`-unit`) shown only for implanted chambers, and A/V Paced % show only when the RA/RV module is present. There is no Aveir importer — it's filled manually.

### Optional bundle keys
Besides `RESULT`/`LEADS`, a parser may return `EPISODES` — an array of arrhythmia-log rows `{dt, dur, rate, types[], flags?, notes?}` that `prefillForm` writes into the logbook via `setEpisodeRows`. Boston populates its "Longest" AT/AF episode; Biotronik Home-Monitoring selects the most recent AHR, longest AHR, and fastest non-AHR recording (deduplicating an AHR that satisfies both criteria). Each logbook row has **flag checkboxes** (`Longest` / `Recent` / `Fastest`, name `ep{n}-flag`) that replaced the old "Approp.?" radios; a parser `notes` value that is *exactly* a flag name (e.g. Boston's `Longest`) checks the flag instead of filling Notes.

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
  - The `(####)` model number is **optional**: a conduction-system implant has no lead registered to the RV port, so the header prints a bare `RV` (e.g. `Atrial(4076)  RV`). Requiring `RV(` read that as an atrial-only header and pushed every cell into the atrial column, blanking all four `lead-rv-*` fields. Header rows are now identified as **lines made up entirely of chamber tokens** (bare or parenthesized), preferring the Final section and then the row with the most chambers — that keeps decoys out (the EGM-source row `EGM2  RVtip to RVring  ±8 mV  RV  0.9 mV`, `Pacing Details  Atrial  RV`, and the Patient-Information implant table's `ATRIAL  RV`).
- **MVP (Managed Ventricular Pacing)** prints two mode tokens (e.g. `AAIR  DDDR`); record the pair verbatim as `AAIR/DDDR`, don't collapse to `DDD`.
- **Pacing % comes from the "Therapy Summary" block on the Quick Look page** (`therapySummaryVal()`), which lists single, since-last-session values: dual chamber → `VP` / `AP`; CRT → `Total VP*` / `AP` plus an `Effective` row (Total VP Effective → **BiV Paced %**). Scoping to that block is essential — the Rate-Histogram pages repeat `Total VP` / `VP` as **two-column** rows (`prior | since-last`) and as a `% of AT/AF` metric, so a document-wide search grabbed the wrong number (a prior-session value, or the AT/AF-paced VP). `pct-v` ← Total VP/VP, `pct-a` ← AP/Total AP, `pct-biv` ← Effective (CRT only). Fallback when no Therapy Summary: sum the four pacing states (`AS-VP + AP-VP`, etc.).
- ICD coil impedance / charge time come from single-value rows (RV Defib / SVC Defib / Charge Time).
- Lead inventory: from the "Device Information" rows; **de-dup by serial** (the rows repeat across pages) — never by chamber (two same-chamber leads must both survive).
- **Conduction-system pacing (LBB / His)**: the lead row is labeled by implant *site* (`LBB  Medtronic  3830 SelectSecure™  …`), not `RV`, so a chamber-only match dropped it and the report came out with no ventricular lead at all. The inventory accepts `LBB/LBBAP/LBBP/His/HB/HBP` (plus `RA`), keeps `location` verbatim, and normalizes `chamber` to **RV** — the lead is on the RV port, which is why its measurements are in the RV column. Those `lead-rv-*` fields get a note naming the actual lead so the report doesn't read as a conventional RV lead.

### Boston Scientific (`boston.js`)
- **Stacked header fields**: "Last Office Interrogation" and "Implant Date" print the value on the line *below* the label → `valueBelow()`. Interrogation date = the **"Report Created"** stamp (parsed out of that token), not "Last Office Interrogation".
- Dates are `D Mon YYYY` → vendor-local `bToISO`.
- Lead measurements are a 3-column table (Implant | Previous | **Most Recent**); read the Most-Recent column (`x ≥ ~470`).
- Quadripolar LV prints `Left Ventricular (LVa)` / `(LVb)`; LVa is the active vector. Pace-impedance rows are `Pace Impedance LVa/LVb` — keep the first (LVa).
- Dynamic AV delays print as a range (`260 - 300 ms`) → fills both bounds and flips the form's **Dynamic AV** toggle to Yes. A fixed range like `170 - 170` collapses to a single value.
- Programmed parameters are read only from Boston's **Brady Settings** / **Brady → Normal Settings** blocks. This prevents the Heart Rate Variability page's historical/reference **Sensed AV Delay** from being imported as active programming (notably in DDI reports, where the active block contains only Paced AV Delay).
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
- **Leads**: Home-Monitoring uses either per-lead blocks or a horizontal Lead Model / Manufacturer / Serial / Implantation / Channel inventory (with serials, deduped); Standard lists an A|V table (Type/Manufacturer/Position, no serials → uses the device implant date).
- Dates `MM/DD/YYYY` → `bToISO`. Longevity from "Calculated/Expected ERI N Y. M Mo." → years. AV is dynamic (`300/260` → min–max + Dynamic AV = Yes) or fixed (`AV delay [ms] 240`). Multiple interrogations/test runs appear, so values come from the **last (non-empty)** matching row.
- **Home-Monitoring diagnostics** map battery status, mode-switch state/rate, AHR/HVR/PMT counters, plus a focused `EPISODES` summary: most recent AHR, longest AHR, and fastest non-AHR recording (date/time, duration, mean ventricular rate). HVR rows stay explicitly flagged for rhythm classification instead of being guessed as VT/VF/NS-VT.
- **Lead measurements (impedance / sensing / threshold / pulse width) are scoped to the last "Test results" block** (`avScoped`): if a chamber's row there shows `-----` (not measured), the field stays **blank**. Without this, the label "Pulse width [ms]" also appears in the programmed-output and test-program sections, and a whole-document "keep last non-empty" search leaked the *programmed* atrial pulse width (e.g. `1.0`) into a chamber whose measured value was `-----`. Fields whose row is genuinely absent from the block fall back to the wider search (e.g. the Home-Monitoring threshold lives in a different section).
- **Validated against one dual-chamber PPM in each layout** — ICD/CRT and single-chamber Biotronik are unverified.

### Abbott / St. Jude (`abbott.js`)
- Input is the Merlin **.log**, which is **FS-delimited**: each line is `code <FS> name <FS> value <FS> unit <FS>` where `<FS>` = ASCII `0x1C`. Pasted into an editor the separators are invisible (so `2.0V` looks concatenated — it's `2.0<FS>V`). Values are keyed by the **numeric code** (unique per line).
- The reader is **encoding-aware**: `handleFile` decodes with a BOM-sniffing `TextDecoder` (UTF-16/UTF-8); `runLog` also strips stray BOM/null bytes and accepts any line ending.
- **Routing is structural**: an LV lead ⇒ CRT; shock evidence (HV-lead impedance / shock config / capacitor charge) ⇒ defibrillator. So CRT+shock = CRT-D, CRT no-shock = CRT-P, non-CRT+shock = ICD, else PPM.
- Abbott uses **different codes for different lead types** — e.g. RV pace/sense lead (`2461|2462/2470/2463/2460`) vs RV defib lead (`2448/2449|2450/2469/2451`); model can be "SJM …" vs "Other …", and a lead entered as "Other" fills only the Other code (RV `2462`, atrial `2458`, LV `2466`) — even when its manufacturer reads St. Jude Medical. A `first(...candidates)` helper resolves each cell.
- Key codes: `200/201` model, `202` serial, `203` interrogation, `2442` implant, `2430/2431` name/DOB, `301` mode, `302/323/406` LRL/UTR/USR, `337/322` sensed/paced AV, `320` rate-responsive AV (dynamic), `339` AMS, `512/507/2720` RA/RV/LV impedance, `2721/2722` RA/RV sensing, `1610/1606/1616` RA/RV/LV capture-test thresholds, `2730` HV (coil) impedance, `2745` charge time, `533` longevity. CRT pacing compartments are `2709/2710/2711` (RVP/LVP/BP); episode aggregates are `2754` (AT/AF count), `2630` (ICD VT/VF count), and `2750/2642` (atrial/tachy last-cleared dates).
- **Episode limits:** these `.log` exports contain aggregate counters but no individual episode timestamps, durations, or peak rates, so the parser cannot populate recent/longest logbook rows. Code `2755` is a raw unitless recent-week AT/AF time rather than the displayed since-clear burden percentage; only an unambiguous zero is auto-filled.
- **Redacting samples:** `tools/abbott-log-redactor.html` accepts multiple logs entirely client-side, detects UTF-8/UTF-16LE/UTF-16BE, exposes the invisible FS-delimited fields in a table, and preselects common PHI plus device/lead serial numbers. Only selected value byte ranges are replaced; BOM, encoding, line endings, FS delimiters and all unselected bytes are retained. It can download one redacted `.log` or all loaded samples as a ZIP. Opened by the Report Generator's *Report import problem*, it runs in case mode instead ([import-cases.md](import-cases.md)).
- **Redacting vendor PDFs:** `tools/cied-pdf-redactor.html` handles Medtronic, Boston Scientific, Biotronik, and scanned Abbott PDFs entirely client-side. On load it scans **every page before enabling download**, auto-boxing common identifiers (including names, MRNs, providers/facilities, contacts, device/lead serials, and patient-related dates); the all-page rescan preserves click-drag manual boxes. Its taller preview fits one complete page using both available width and height, refits on resize, and wheel-navigates one page at a time like `protected/PDF_Viewer.html`. It exports generic filenames. The output is rebuilt from page pixels plus a new selectable text layer made from pdf.js items that do **not** intersect any redaction. Automatic boxes contribute structure-preserving synthetic values: serials/MRNs retain character counts and punctuation (`ABC-12345` -> `XXX-00000`), dates retain ordering, separators, month-word style, and time punctuation (`Aug/16/2026` -> `Jan/01/2000`), and phone numbers retain their displayed pattern. An inline label/value item is rebuilt as the original label plus the synthetic value instead of a generic token. This keeps regex anchors and realistic value formats available to the extraction harness while preventing source selectable/hidden PHI, metadata, annotations, attachments, and layers from surviving. Automatic detection is only a first pass; every page must be reviewed, and scanned PDFs need manual boxes. Opened by the Report Generator's *Report import problem*, it runs in case mode instead: the patient's own identifiers from the form are replaced everywhere, dates are shifted rather than blanked, and review shrinks to a short list of strings ([import-cases.md](import-cases.md)).

---

## To add a new vendor
1. Add a parser file under `src/parsers/` exposing `runMap(LINES)` (PDF) or a text entry point (like Abbott's `runLog`), returning the `{RESULT, LEADS, ROUTE, ORDER, GOTCHAS}` bundle (optionally `EPISODES`) with the field keys above.
2. Register it: PDF vendors go in `Engine.VENDORS` + the `PARSERS` map in the app HTML; a text format gets its own branch in `handleFile`. `engine.js` is the **only** detection list — parser modules deliberately carry no signature of their own (two lists drift, and they did). A `VENDORS` entry is `{ name, strong, weak }`: `strong` = company / remote-system names that print in the page header or footer, written as separate `|` alternatives (`scoreVendors` counts how many distinct ones matched); `weak` = device family names, which are only suggestive because a family name can also appear in a lead row.
3. Add the `<script src="../src/parsers/yourvendor.js">` include in `protected/CRM_Report_Generator.html` (after `../src/engine.js`).
