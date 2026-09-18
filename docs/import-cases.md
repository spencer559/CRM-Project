# Import-problem cases

How a report that imported badly becomes a de-identified case: something an AI assistant (or anyone
else) can replay, fix the parser against, and keep as a regression test. The parsers themselves are
in [report-import.md](report-import.md). Web paths here (`protected/`, `src/`, `tools/`) are
relative to `site/`.

The idea in one paragraph: when an import fails or comes out wrong, the tech finishes the report by
hand anyway. That finished form is the answer the parser should have given, and it also lists the
patient's own identifiers (name, DOB, MRN, serials). The case builder uses the second to remove
the PHI everywhere it appears and then prove it's gone. It uses the first to show exactly which
fields the import got wrong. Nothing is typed twice, and nobody reads every page looking for names.

## The workflow

1. **Import as usual.** If it fails, or a value is wrong or missing, finish the report by hand.
2. **Report import problem.** Use the button in the import status box, or
   ☰ → Import → *Report import problem* → the file. The menu lists every programmer export in the
   open patient's slot, so a report can be sent days later from a finished patient. The export is
   archived in the slot when it is imported.
3. **The case builder opens in a new tab.** PDFs go to `tools/cied-pdf-redactor.html`, Merlin
   `.log` files to `tools/abbott-log-redactor.html`, each opened with `#case=<id>`. By the time it
   shows anything it has already replaced the patient's identifiers, shifted every date, and run the
   standalone label rules. The panel on the right is the rest of the job:
   - **Needs a decision.** A short list of distinct strings that look like a person, clinician, ID,
     serial, phone number or e-mail address, which nothing replaced. Click *Redact* (replaced
     everywhere) or *Keep* for each one.
   - **Still present.** Anything from the form that survived in another format. *Redact all of
     these* clears it. Export stays blocked while this list has entries.
   - **Pages to look at** (PDF only). Pages the text checks can't vouch for: no text layer, or a
     large raster image that could carry printed text. When the form had nothing to search for, it's
     every page.
   - **Import vs. your report.** The fields that differ, with the import's value and yours.
   - **What went wrong?** An optional note. It is checked for the patient's identifiers too.
   - **Export case.** Enabled only when all of the above is clear. It downloads
     `import-case-<vendor>-<id>.zip`.
4. **Hand the zip to the assistant**, for example by dropping it into the chat or giving its path
   in Downloads. It carries no PHI the checks know about. It is still medical data, so don't post it
   anywhere public.
5. **Developer side** ([below](#developer-side)): replay it, fix the parser, add it as a regression
   case.

It works the same in the iPad and iPhone app. Both case builders are bundled (`iPad_APP/web-files.txt`),
and the zip goes to the Files sheet like any other download.

## What the case builder removes, and how

All of it is `src/import-case.js`, shared by both pages. The panel UI is
`src/import-case-panel.js`.

- **Known identifiers.** These are taken from the form (`pt-name`, `pt-dob`, `pt-mrn`, `dev-serial`,
  `pt-provider`, and the lead table's serials and dates), from the parser's own read of the untouched
  export, and from the Schedule's name for the patient. Matching is whole-word and case-insensitive,
  and runs on each text line joined the way `Engine.normalize` groups it. Items with no visible gap
  between them are joined without a space, so a name Biotronik draws as `"S" + "MITH"` is still
  found. A serial also matches with spaces or dashes inside it.
- **Pseudonyms keep the shape.** Names become `DOE` / `TEST` / `SAMPLE`, and a clinician's name
  words become `PROVIDER`. Case follows the source. A patient who is literally named Doe or Test gets
  `ROE` / `CASE` instead. Each distinct serial or ID gets its own pseudonym: letters become `X`, and
  the digits carry a per-case counter (`PJN1234567` → `XXX0000001`).
- **Every date is shifted, not blanked.** One random offset per case applies to every date on every
  page, in every format the vendors print (`Aug/16/2026`, `16 Aug 2026`, `08/16/26`, ISO,
  `Aug 2026`, yearless episode stamps). The offset is a whole number of weeks, one to three years
  back, so weekday names stay true. It lives only in page memory and is never written anywhere. Each
  date keeps its own format: separators, zero padding, month-name case and length, two- or four-digit
  year. Times of day are left alone.
- **Label rules as a second net.** The standalone redactor's rules (Physician, MRN, ID, Serial,
  phone, e-mail, address, facility) run on the original text too. A value they find that the
  known-identifier pass didn't already rewrite is replaced the standalone way. In a `.log` the
  known-PHI codes (`SENSITIVE_CODES`) play the same role.
- **Biotronik's header** (`PDF: BIOTRONIK - model - serial - Last, First - p/N`, one text item) is
  repaired segment by segment, because the parser reads the model and serial out of it.
- **The review list** is described above. Its rules are in `SUSPECT_RULES`. It also catches two
  things no whole-word match can settle. The first is a known name buried in a longer token (a login
  such as `jheartwell` in a "Printed by" footer). The second is a name word that is also report
  vocabulary, standing alone (see the decision about common words below).
- **The residual check** searches the output for every known identifier, including formats the
  shifter doesn't rewrite (a DOB printed `19500102`). It runs on every change, on the note, and one
  last time on the finished `case.json` and items before anything is written.
- **The rebuilt PDF** is the standalone redactor's flattening: page pixels with every rewritten item
  boxed, showing its replacement. The selectable text layer is the de-identified items themselves,
  so it matches `items.json`.

The case builder also checks **fidelity**. It parses both the untouched export and the de-identified
input it is about to write, and lists any field whose import changed because of de-identification
(`fidelity` in `case.json`). The case can't vouch for those fields.

## What a bundle holds

| File | What |
|---|---|
| `case.json` | Schema 1. `detection` (vendor scores, whether the user forced a parser); `parse` (the fields, leads, episodes, route and any error from replaying the de-identified input); `expected` (the tech's finished form, de-identified, minus `pt-provider` and `obs-text`, which never leave the form); `diff` and `leadDiff`; `fidelity`; `notes`; `deid` (what was known, what was replaced, which strings the reviewer kept, which pages they looked at). |
| `items.json` | PDF cases: the parser's input, `crm-import-items-1`, one `[page, x, y, w, str]` row per text item in `Engine.extractItems` coordinates. Replaying it needs no PDF and no pdf.js. |
| `input.log` | `.log` cases: the byte-preserving redacted log that `ABBOTT.runLog` reads. |
| `report.pdf` | Optional (on by default). The flattened, redacted pages, for looking at the layout. Never committed. |

No file name, no case date, and never the date offset.

## Developer side

```bash
node scripts/import-case.js <case.zip|dir>                        # what went wrong, replayed with today's parsers
node scripts/import-case.js <case> --lines --grep "Threshold"     # the parser's input as reading-order lines
node scripts/import-case.js <case> --lines --page 3
node scripts/import-case.js <case> --fields                       # every field the parser produced
node scripts/import-case.js add <case> [--name slug]              # after the fix: install as a regression case
node scripts/import-case.js check                                 # replay every installed case
```

The summary names the detected vendor (and says so if the report's own manufacturer disagrees), the
parser's route or its error and stack frame, and every field that still differs from the tech's
report. `--lines` prints the same `x###|"text"` rows as the PDF extraction harness. Write the anchors
against those rows and replay until the summary is clean.

**`add` is the step that turns a fix into a regression test.** It copies `case.json` plus
`items.json` or `input.log` (never `report.pdf`) into `tests/import-cases/<slug>/`. It records in
`assert` the fields that match the tech's report *now*, plus the lead table, the episodes and the
detected vendor when those match. Anything still different is listed and left out. That is either
something left to fix, or a clinical edit the parser can't know about. `tests/import-cases.test.js`
replays every installed case on every `npm test`. `tests/import-cases/medtronic-synthetic-sample/`
is a synthetic example of the format.

**The PHI lint.** `add` and the regression test both check that `case.json` records a clean residual
check. They also check that every string still shaped like a name, ID, serial or contact, in the
input or the manifest, is one the reviewer explicitly kept. `add` refuses a case that fails. The fix
is to rebuild the case from the Report Generator and decide those strings there, not to edit the
case by hand.

Tests: `import-case.test.js` covers the de-identifier and the property the rest relies on. A
synthetic report run through the real Medtronic parser gives the same answers before and after
de-identification, once the "before" answers are de-identified too. `import-case-pages.test.js`
pins the handoff and the export gate in the pages.

## Limits

- **Pixels are only checked by looking.** Text that exists only as an image (a scanned page, printed
  text inside an EGM strip) never reaches the text checks. Those pages are flagged. Unchecking
  *Include the redacted page images* sends text only.
- **Names the form doesn't know about** (a relative, an unlabeled referring doctor) are caught only
  if they match a review-list shape or a label rule.
- **Short identifiers are not matched globally.** A numeric ID under five digits, or any identifier
  under four characters, would also rewrite measurements (`1234 ms`). The label rules still cover
  those next to an MRN, ID or Serial label, and the MRN field itself is always masked.
- **A lone year** ("implanted 2019") isn't shifted, because a bare four-digit number is as likely to
  be a count. Two-digit years pivot on the current year.
- **The standalone redactors are unchanged.** Dropping a PDF or `.log` on them directly still blanks
  dates to `01/01/2000` and relies on page-by-page review. Case mode only exists when the Report
  Generator opens them.

## Decisions

- **Shift dates, don't blank them.** Parsers choose by date: the most recent and longest episode,
  and the final session over the initial one. With every date set to `01/01/2000`, a replay would
  pick arbitrarily, so the case couldn't reproduce the bug it was filed for.
- **Distinct serial pseudonyms, not all-zero masks.** Masking every serial to `XXX0000000` made two
  leads identical. The Medtronic inventory de-duplicates by serial, so the replayed case silently
  lost its RV lead. The consistency test caught it.
- **A name buried inside a longer word goes to review, not to automatic replacement.** Replacing
  known-name fragments inside words would rewrite report vocabulary (a surname that is a substring
  of "Arrhythmia" would break the section anchor). One click per distinct string is the cheaper
  error.
- **Common words in a name are replaced only next to the rest of the name.** A patient named Page,
  Day or May would otherwise rewrite "Page 3 of 20" and every month label. The same applies to
  two-letter names. On its own, such a word could still be the patient, so it goes on the review
  list: one *Keep* for "Page" rather than a rewritten report.
- **The finished form is the answer.** A case asserts only what matched the form after the fix,
  because the form also carries clinical edits a parser can't know about (a re-measured threshold, a
  reprogrammed mode). Observations, "parameters changed?", the completion date and the provider are
  never compared.
- **The export's file name never leaves the generator.** Export files are often named after the
  patient.
