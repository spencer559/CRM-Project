# The `.crmdb` database and the pages built on it

The single-file database shared by the Patient Schedule and the Report Generator: its format, the
engine's cross-tab and cross-station guards, and the Schedule and Report Generator features that sit
on top of it. Moved out of the README. Web paths here (`protected/`, `src/`, `vendor/`, `tools/`,
`mileage/`) are relative to `site/`, which is also their URL path.

## The `.crmdb` database container (`src/crmdb-store.js` + `vendor/crmdb-zip.js`)

Jul 2026 the shared USB workspace moved from a **live folder tree** (the old `src/workspace.js`,
which drove the File System Access **directory** API and was Chrome/Edge-desktop only) to a
**single portable file** — `schedule.crmdb` — so the same database works on **iPad** too
(iPadOS has no directory API at all). `workspace.js` is retired; both the Schedule and the CRM
tool now load `crmdb-store.js`. The original trigger was an NTFS bug — see the caveat at the end.

**Format.** An unprotected `.crmdb` is a standard **ZIP** (rename it to `.zip` and Finder/Explorer
opens it — fully recoverable without the app), written by `vendor/crmdb-zip.js`, a dependency-free
reader/writer (STORE on write with correct CRC-32s; inflates DEFLATE on read via the browser's
`DecompressionStream`). It's self-hosted because the pages run under `connect-src crmapp:` /
`script-src 'self'` — no CDN allowed. The internal layout mirrors the old folder tree, so it's
still inspectable:

```
schedule.crmdb  (zip)
  manifest.json                                    {type, version, modified, fileCount}
  schedule.json                                    the Patient Schedule data (+ retentionDays — see Memory)
  patients/<YYYY-MM-DD>/<HHMM>_<NORMALIZED_PATIENT_NAME>/
    report.json  report.txt  report.pdf            CRM tool exports
    <vendor export>.pdf / .log                     raw programmer files (optional)
```

When password protection is enabled, the complete ZIP bytes are wrapped in a versioned binary
envelope and authenticated/encrypted with **AES-256-GCM**. The key is derived locally from the
password with **PBKDF2-HMAC-SHA-256** (unique 16-byte salt, 600,000 iterations); every save uses
a new random 12-byte IV, and the envelope header is authenticated as additional data. This uses
only the browser's built-in Web Crypto API: no password, key, or database content is uploaded.
The password is never stored. After a successful unlock, a temporary derived key is kept in
that tab's `sessionStorage`, allowing Schedule / Report Generator navigation without another
prompt. **Lock database**, closing the database, or closing the tab clears that session unlock;
the next open requires the password. Encrypted files cannot be recovered by renaming them to
`.zip`.

**Engine (`crmdb-store.js`).** It exposes the **same `window.CRMWorkspace` API the two pages
already called** (`connect`, `slotDir`, `readText`, `writeFile`, `listFiles`, `moveSlot`, `moveDate`,
`slotName`, `stored`, `permission`, `forget` …) but backed by an **in-memory
`bundle` = `Map<path, Blob>`** instead of live directory handles. Slot/file ops became map
reads/writes; `moveSlot` (renaming a slot when a row's time/patient name changes) and `moveDate`
(relocating every patient-folder prefix when Move Day changes the schedule date) became key
relabel; `readText` on a missing file rejects (so the CRM "new patient" catch still fires).
Because the API surface is unchanged, migrating the 2500-line CRM tool was mostly a script-swap.
**Cross-tab writes (`journal` + revision CAS).** Each tab holds its **own** `bundle`, and a save
serializes the **whole** bundle — so a plain write replaces whatever another tab committed. Two
tabs on one database (typically Schedule + Report Generator, the normal way this gets used) could
therefore silently revert a schedule edit, revert a report, or **delete a file** the other tab
attached (`serialize` only emits the paths the saving tab happens to hold). Every commit is now a
**compare-and-swap** against a `rev` counter stored beside the `bundle` key:

- `journal` (`path → Blob | null`) records what **this** tab changed since its last commit. All
  mutations go through `bset`/`bdel` — never `bundle.set`/`.delete` directly, or the change becomes
  invisible to the merge.
- Commit reads `rev` (one small key, **~0.3 ms**). Unchanged → straight write, the normal case and
  always true with one tab open. Moved → another tab wrote, so `adoptShared()` pulls the shared copy
  and replays **only journalled paths** on top. Replaying only touched paths is what stops a stale
  tab resurrecting a deleted file or deleting one it never saw.
- The re-read and both puts ride in **one** IDB transaction, so a tab that commits while we were
  serializing loses the CAS and retries instead of clobbering.
- **Nothing journalled and not `authoritative` → the commit is skipped entirely.** This is what
  stops an idle tab's `flush()` (e.g. on navigation) from republishing its stale bundle.
- `authoritative` (via `markAuthoritative()`) means "our bundle is a whole database we just
  opened/created/re-encrypted" — overwrite the shared copy rather than merge into it. Without it,
  opening a `.crmdb` would rebase onto, and therefore keep, the working copy it was meant to
  replace. The three protection paths set it too, and must `adoptShared()` **before** installing a
  new key (`ingest()` resets `protection` from the envelope it reads).
- Cost, measured in-browser on a 10.6 MB / 12-patient database: **43.2 ms** fast path (the serialize
  the code already paid, plus the 0.3 ms revision read) vs **63.5 ms** when a rebase is actually
  needed. The pre-existing whole-bundle serialize — ~95 ms on a 35 MB database, on a 1.2 s debounce
  while typing — is the real cost here, and is what to optimize if this ever gets slow.

**Cross-station freshness (`fileMeta`).** The revision CAS above only orders two **tabs on one
machine**. It says nothing about the other half of the problem: the same `.crmdb` sits on OneDrive
and gets edited from a second workstation, while each station's IndexedDB working copy lingers
between visits. A station reopening with an **older** cache used to flush it straight over the newer
file — which is how a day's schedule was lost moving Monterey Park → Arcadia. So the cache is pinned
to the file it came from (`baseFileMod`, `cacheMatchesFile`, persisted beside the bundle), and a
bound-file session starts **unverified**: until `verifyFreshness()` has compared the file to the
cache, `writeThroughToFile` refuses to write at all. File unchanged → keep the cache; file newer +
clean cache → the file silently wins; file newer + unsaved edits → the page's `onConflict` asks
which copy wins (file / keep mine / save mine aside then take the file).

- **A newer mtime does not mean someone else wrote it.** Chasing a "Database changed elsewhere"
  prompt that fired on the ordinary Schedule → Report Generator handoff: the newer file was **this**
  station's own autosave. A save is `commit` → file write → metadata write, and navigation tears the
  page down mid-chain, so the file moves forward while the recorded base does not. (OneDrive
  re-stamping the file after syncing it up does the same with identical bytes.) The store now
  **signs the bytes it puts on the file** — `pendingSig` written *before* the file write so even an
  interrupted save is recognizable, `baseSig` after it. On reconnect, a newer file whose content
  matches either signature is our own work: re-pin and carry on, local edits still pending. Only
  genuinely foreign bytes reach the conflict prompt.
- **One save at a time** (`enqueue`). Two overlapping save chains — the Schedule deletes a patient's
  files *and* writes `schedule.json` — interleaved their metadata writes, so IndexedDB could end up
  describing a state that never existed. `persist`/`flush`/`saveNow`/`verifyFreshness` now run one
  after another, and a navigation that waits on `flush()` waits for everything queued ahead of it.
- **`cacheMatchesFile` is earned, not assumed.** A write-through marks the cache clean only if the
  bundle's mutation counter hasn't moved since the snapshot was serialized; an edit made *during*
  the write stays unsaved work rather than being written off as already on disk.

The bundle **is** the one database, and it is:
- **serialized to the `.crmdb`** on save;
- **mirrored to IndexedDB immediately when opened and again on every change** (`crmdbStore` db,
  `bundle` + `rev` keys; edits are debounced) — this
  working copy is what carries state **across the two pages** on a full navigation, which is
  what makes the two-page handoff work on iPad (there's no persistent file handle there);
- on **desktop** (Chrome/Edge) additionally bound to a real `.crmdb` **file handle** (also stored
  in IndexedDB, so both same-origin pages share it) and **autosaved in place** — no button.

**WebKit's IndexedDB copies (Sep 2026).** Symptom: in the iPad/iPhone app, relaunching after
opening a `.crmdb` showed "Database is closed — open schedule.crmdb to reconnect", with
`lastOpenError()` reporting `crmdb: corrupt central directory`. The zero-copy container (the
README's *Latency overhaul*, item 4) runs into two WebKit IndexedDB bugs. They hit Safari, every iOS
browser, and the app's WKWebView. Both were measured in the iOS 18.0 Simulator, in Safari, killing
and relaunching it between steps:

1. **A sliced Blob is stored as its whole parent.** WebKit writes each backing part of a Blob out
   whole, so a `slice()` reaches disk as the entire buffer or file it was cut from, while the record
   keeps its original size. In the process that wrote it, reads come from the original Blob and look
   right. After a restart they come from disk: a 950-byte Blob built from two slices of a 10 KB buffer
   was stored as 20,150 bytes and read back that way. Every committed container is made of slices
   (`CRMDB.readBlob` hands them out, `buildZip` passes them through by reference), so the working copy
   read back corrupt. It was slow as well. Storing a synthetic 55 MB, 181-entry container wrote a
   **9.94 GB** blob file (the whole database once per entry) and took **12.8 s**.
2. **A Blob read back after a restart dies with its record.** It is backed by the record's file, and
   overwriting or deleting the record deletes that file while the Blob is still in use. Every later
   read of it, or of a slice of it, fails with `NotFoundError` ("The object can not be found here.").
   Commits replace `bundle` and journal writes replace `journal`, so a bundle sliced from what
   IndexedDB returned lost its unchanged entries at the next save. Fixing only the first bug showed
   this: the second commit after a relaunch failed. In the app, the file write-through after the
   first one would fail too.

The fix, WebKit only (`isWebKitIdb()`: Apple's `navigator.vendor`, or an AppleWebKit user agent that
isn't Chromium's): `forIdb` rebuilds what goes into IndexedDB (the container and the unsealed
journal row) from whole parts, and `fromIdb` copies the working copy that `stored()`/`adoptShared()`
read out before the bundle slices it. `unsealJournal` does the same with the journal bytes it
already holds. Sealed envelopes are whole buffers already and are never copied again. Chromium does
exactly what it did before. The bundle still holds one copy of the database, serializing stays by
reference, and the file write-through still sends the by-reference container. On WebKit that one
copy now lives in memory (outside the JS heap), as a freshly opened file's bytes already did, where
before it was the IndexedDB file that the next save deleted.

Cost on the synthetic 55 MB database, in the Simulator (a Mac's CPU and SSD, so an iPad will be
slower):

| | before | after |
|---|---|---|
| storing a commit's container in IndexedDB | 12.8 s, 9.94 GB written | 30–50 ms copy + 40–190 ms write, 55 MB written |
| edit commit, end to end | — (failed after a relaunch) | 60–125 ms (one 273 ms outlier) |
| page load after a relaunch (`stored()`) | failed | 110–190 ms (51 ms by reference, without the copy) |
| WebContent peak while copying | — | 82 MB (8 MB groups via `stream()`); a single `arrayBuffer()` or `new Response(blob).blob()` peaked at 182–188 MB |

Copy methods compared: one `arrayBuffer()`, `slice()` in 8 MB chunks, `stream()` in 8 MB groups, and
`Response.blob()`. All four read back correctly after a relaunch, in similar time (30–65 ms from
memory, 45–126 ms from an IndexedDB file). `stream()` won on peak memory, which matters because a
jetsammed WebContent process takes the unsaved edit window with it.

**Rejected, so it isn't proposed again:** keeping page loads by reference and re-pointing the bundle
at the flattened copy after each commit. It saves the 60–130 ms load copy, but anything that still
holds a slice of the old record breaks as soon as a commit lands: another window's store until it
adopts, a file write-through still streaming the previous container, a `File` the Files menu
resolved before the commit. Generational IndexedDB keys that are never overwritten fail the same way
(the bundle keeps referencing whichever generation it loaded) and leave extra PHI copies on disk.
Flattening on every engine would hand Chromium a full copy per commit for a bug it doesn't have.

A working copy that an older build already stored corrupt stays unreadable: after updating, reopen
the file once. The app build was checked on the iPhone 16 Pro Simulator. After that one reopen, the
database reconnected by itself across two kill-and-relaunch cycles (one of them after pressing Home
first), where the old build had failed 3 of 3. Covered by `tests/crmdb-webkit-idb-slices.test.js`. Node's Blob has neither bug, so
the test models both (Blobs that record which whole buffers they are cut from, and an IndexedDB whose
`restart()` swaps in what WebKit's disk holds and deletes a record's file when the record is
replaced). It also runs a control showing that the unflattened container reproduces the field error.

**Capability split.** `WS.canAutosave = !!showSaveFilePicker` (true on desktop Chromium). Desktop:
silent debounced autosave to the file + IndexedDB. iPad: the green **Save** button (`saveNow`)
hands the whole `.crmdb` to `navigator.share` → "Save to Files → USB" (falls back to a download),
and a `flush()` (IndexedDB-only, no download) runs before every cross-page navigation so the other
page opens the latest bundle. MIME types are re-assigned by extension on read, so a `report.pdf`
chip still opens inline after a round-trip strips the raw blob's type.

**`persistNow()`** is the third save entry point, for the iPad/iPhone app's background save. It
commits and then *waits for the file*, which `flush()` deliberately doesn't, and it never falls back
to the share sheet or a download, which `saveNow()` does — nothing can answer a dialog once iOS has
backgrounded the app. It resolves true only when the bytes reached the file, and queues behind the
cadence's own write-through, so "already current" from the app's log means the page's tab-hide save
got there first, not that nothing was saved. See the *Leaving the app finishes the save* note in
`iPad_APP/README.md` and `tests/crmdb-background-flush.test.js`.

The custom PDF viewer's **Download** button uses the system **Save As** picker on supported
Chromium browsers, allowing a USB drive or any other folder to be selected. Browsers without the
File System Access picker retain the standard download-to-default-folder behavior.

**Schedule-side features built on the container:**
- **Database menu** (replaces the old dual "schedule file" + "USB workspace" menus): Open / New
  database, reconnect the remembered file, add/change/remove password protection, and Close
  database. A separate **Save** button
  ("Save now" on desktop, "Save database" on iPad) sits in the header; **Leave Station** moved
  into the **Memory** menu. Header order: Modules · All patients · Memory · Database · Save.
- **Memory menu** — a **per-database retention window** (`state.retentionDays`, stored **inside**
  the `.crmdb` so it travels with that specific file; `0`/absent = never). Options 1 / 3 / 7 /
  30 days / Never; on selection and on every open, rows **and their files** older than the cutoff
  are pruned (`WS.pruneFilesBefore` also catches orphaned files, so the file stays bounded). Plus
  a one-off **Clear all past data** and a live **size readout** (`WS.stats`). The old hard-coded
  7-day `purge()` on load was removed in favor of this.
- **All patients** overview (header button) — a searchable modal listing every appointment across
  all dates with a green file-count badge (`WS.slotFileCounts`); click a row to jump to that day.
- **Provider roster and day filter** — the schedule stores an ordered provider list inside the
  database, starting with **Tech**. The All Providers menu supports add, drag-to-reorder, and
  accessible up/down controls, plus deletion of non-Tech providers. **Tech cannot be deleted**;
  appointments assigned to a deleted provider automatically fall back to Tech. Each appointment
  has a Provider field between Device and Check type.
  The table gives provider names extra width and shortens display labels after 17 characters with
  an ellipsis (the stored name, roster, and printout remain complete). Filtering changes the visible
  day, counts, and printout without deleting or moving appointments.
- **Multi-tab schedule safety** — schedule revisions are announced across same-origin tabs. A tab
  with an older revision skips its pending write instead of replacing newer Cerner/provider/row
  edits, then reloads the committed IndexedDB working bundle from the tab that saved most recently.
  This is the *Schedule-side* guard (page-level, keyed on `schedule.json`'s own `_updatedAt`); the
  database-level guard that protects **any** two tabs — including CRM ↔ Schedule — lives in
  `crmdb-store.js`, above.
- **Files menu** on each row condenses the old chip list into one status button. It exposes only
  the two useful clinical links — the generated `report.pdf` and the raw programmer report — while
  JSON/TXT support files stay hidden. **Report ✓** appears in green only when a programmer report
  is attached; a generated report by itself reads **Generated**. The menu retains remove controls
  and the manual attach action for loop recorders, Aveir, S-ICD, or anything with no parser. Its
  **↓ Save original** control exports the stored `File` bytes directly (desktop save picker, iPad
  share sheet, or classic download fallback), so Abbott `.log` control delimiters and encoding are
  preserved byte-for-byte rather than passing through a text decoder.
  Won't clobber a generated `report.*` (an upload named `report.pdf` is stored `prog-report.pdf`).
- **Delete a patient** (the row ×) confirms only when the row is substantially filled
  (time + patient name + manufacturer + device + check all set) and **also removes that slot's files**
  from the database (`WS.removeSlotFiles`); a mostly-blank new row still deletes silently.
- UI: the page is a **scroll-locked shell** (`body{overflow:hidden}` + a `.main-scroll` pane) so
  the iPad share popover never drifts off-screen no matter how many rows exist; the table was
  compacted and **Notes is a wrapping, auto-growing textarea spanning the visible schedule width**;
  the header divider spans that same visible pane, and each row's delete control aligns with the
  Notes field's right edge. Each patient has a separate narrow
  **CRM** column for opening the Report Generator, while the compact Files status/menu preserves
  horizontal room on an iPad and leaves space for future columns.

**CRM-tool-side:** **Export ▸ Save database** force-rebuilds json+txt+pdf, then writes/downloads
the whole database as a backup (label follows the platform: "Save database now" on desktop, "Save
database to USB…" on iPad). It was a standalone app-bar button; it moved into the Export menu to
free the top-right slot for **Files**.

The app-bar **Files** menu lists the active patient's saved files and opens one in a new tab, so a
programmer PDF can be read side-by-side while the rest of the form is filled in. It mirrors the
Schedule's Files menu: only `report.pdf` (**Generated**) and the raw programmer export
(**Programmer**, listed first) — `report.json`/`.txt` are support files and stay hidden. It needs a
selected patient, not just an open database, so `updateFilesBtn()` hangs off `setPatientBtn()` (the
hook every slot change runs through).

**Drag-out to Cerner (why it exists).** A `.crmdb` is one ZIP, so **no native file dialog can see
the reports inside it** — Cerner's document upload can't browse to `report.pdf`. That's the
inherent cost of the single-file container. Rather than export PDFs to a folder and then have to
purge plaintext PHI, the Files rows are **draggable straight onto Cerner's upload** (`attachDragOut`).
Each drag sets **two** payloads because the plausible targets read different things: `items.add(File)`
populates `DataTransfer.files` (what a web drop zone reads) and `DownloadURL` is what the OS shell
honours when dropping on the desktop/Explorer. Verified under a real trusted dragstart:
`items.add` succeeds and `dataTransfer.types` becomes `["Files"]`. Nothing is written to disk, so
there is nothing to clean up. **If Cerner's uploader turns out to be an `<input type=file>` with no
drop zone**, drag can't help and the fallback is a remembered export folder (`showDirectoryPicker`
+ handle in IndexedDB — the pattern the retired `src/workspace.js` used) with an auto-purge, since
those exports are unencrypted PHI at rest. **`openStoredFile` must stay synchronous:** `window.open`
called from a promise callback has lost the click's user activation and gets popup-blocked (Safari
is strictest, and this runs on iPad), so `buildFilesMenu` resolves every `File` up front — the
bytes are already in memory, `getFile()` is only nominally async — and the click handler just does
`createObjectURL` + `window.open`. `getFile()` re-assigns the MIME by extension, which is what makes
a PDF render inline instead of downloading.

On **leave** (the Schedule button),
**patient-switch**, and **backgrounding** — whenever edits are pending (a `dirty` flag) —
`finalizeReports()` rebuilds the full report set (`report.json` + `report.txt` + `report.pdf`)
from the current form so the Schedule's chips are never stale; the cheap 1.5s live sync still
writes only `report.json` mid-edit. Patient List / Import / Export menus are otherwise unchanged,
now sourcing the patient list from the bundle's `schedule.json`. A `.crmdb` opened directly on the
CRM tool works the same as opening it on the Schedule (shared IndexedDB working copy + file handle).
**EGM page shortcuts and selected-page printing (Sep 2026).** The split-pane viewer keeps its
single **EGM** dropdown. Save the current page or enter physical PDF page ranges (such as
`12–15, 18`), optionally assigned to a logbook entry. **Save to** defaults to **New shortcut…**
and also lists saved named shortcuts and logbook episodes. Selecting an existing item loads its
name/pages and changes **Save** to **Update**; the pencil selects that same item for editing.
New shortcuts accept a free-text label for summary/settings pages. **+ Current** extends a selection while browsing; the pencil edits
its name/range, **×** removes only that shortcut, and the grip reorders shortcuts by dragging
(mouse or touch) or Alt+Up/Down. Clicking an episode's row number still jumps to its first page.
**Back to p. N** restores the previous page/zoom/pan. No pages are automatically classified.

Links and named shortcuts save in the existing report JSON, scoped to source filename and SHA-256
fingerprint; old single-page links still work. They remain outside clinical PDF/TXT/RTF content.
The metadata is small (page numbers, label, order). Checkboxes select shortcuts for **Print selected**;
overlapping pages print once in original PDF order, independently of shortcut order. The toolbar's
**Print** still prints the complete source. Selected-page printing copies original PDF pages in a
temporary worker using vendored pdf-lib 1.17.1, preserving text and page geometry. The worker is
loaded only on request and terminated afterward. No derived PDF is stored in the database or added
to patient-folder downloads, and the 30-second container-save cadence is unchanged.

Implementation: `src/pdf-page-selection.js` (ranges), `src/pdf-egm-navigation.js` (menu),
`src/crm-episode-links.js` (report metadata), and `src/pdf-selection-worker.js` (printing).
Tests cover ranges, backward compatibility, source isolation, labels, removal, ordering, the
active-frame bridge, and the selected PDF's text, page count, dimensions and rotation.


When a scheduled patient has a pre-charted **Last Office** date, the Report Generator shows it in
the fixed app bar between the patient name and save status, including in the full split view.
When the Schedule opens a patient in a fresh browser session and the encrypted working copy is not
yet unlocked, the Report Generator now places a blocking **Patient database is locked** guard over
the form. Password entry happens directly in that guard (including an inline incorrect-password
retry), avoiding unreliable startup password popups on iPad. Unlocking uses the encrypted local
working copy directly; external-file permission affects desktop autosave but never blocks patient
loading. It also offers **Open database…** and
**Return to Schedule**, and does not allow report entry to begin against an unlinked blank form.

**NTFS caveat** — the bug that started all this: macOS and
iPadOS mount **NTFS read-only**, so *every* write fails there regardless of mechanism (the original
"could not be modified due to the state of the underlying filesystem" error). Format the stick
**exFAT** for cross-device read-write. A single `.crmdb` (vs. thousands of loose files) is also far
friendlier to USB/sync filesystems. The Schedule's **Leave Station** saves the database, wipes
localStorage, and forgets the connection.
