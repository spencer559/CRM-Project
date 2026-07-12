# `.crmdb` Container Model — Design Sketch

One portable database file that carries the schedule **and** every patient file
association inside it. Desktop keeps silent live autosave; iPad gets a single
"Save database updates" button. Same file, same format, both platforms.

---

## 1. The format: `schedule.crmdb`

A `.crmdb` is just a ZIP with a fixed internal layout. Nothing exotic — it mirrors
today's on-disk `patients/` tree, but *inside one file*:

```
schedule.crmdb  (zip)
├── manifest.json         # format version + integrity + last-modified
├── schedule.json         # the schedule DB — same shape you use today
└── patients/
    └── 2026-07-13/       # dateISO
        ├── 0800_JS/      # slotName(time, initials) — unchanged convention
        │   ├── medtronic-2026-07-13.pdf
        │   └── notes.txt
        └── 1030_SD/
            └── boston-log.txt
```

`manifest.json`:

```json
{
  "type": "crm-workspace-bundle",
  "version": 1,
  "modified": "2026-07-13T18:20:11Z",
  "schedule": "schedule.json",
  "fileCount": 3
}
```

Key point: **file associations are now logical, not physical.** A patient file is
associated to a slot because it lives under that slot's path *inside the zip* — no
live folder handles, no `moveSlot`, no directory API. That's the whole reason iPad
can participate.

---

## 2. In-memory model (while a session is open)

On load, the bundle is hydrated into memory once:

```js
const db = {
  schedule: { type:"patient-schedule", version:1, dates:{} }, // from schedule.json
  files: new Map(),   // "patients/2026-07-13/0800_JS/notes.txt" -> Blob
  dirty: false,
  handle: null        // desktop: FileSystemFileHandle to the .crmdb; iPad: null
};
```

All edits during the session mutate `db` and set `db.dirty = true`. A slot time
change becomes a pure in-memory relabel of the path keys in `db.files` — instant,
no byte copying. Renaming `1030_SD → 0030_SD` is just rewriting map keys.

---

## 3. Load flow (capability-branched)

```js
async function loadBundle() {
  let bytes, handle = null;
  if (window.showOpenFilePicker) {                 // Windows / Chrome / Edge
    const [h] = await window.showOpenFilePicker({
      types:[{ description:"CRM database", accept:{ "application/octet-stream":[".crmdb"] } }]
    });
    handle = h;                                     // keep it for silent autosave
    bytes  = await (await h.getFile()).arrayBuffer();
  } else {                                          // iPad Safari — no API
    bytes = await pickViaFileInput();               // <input type=file accept=".crmdb">
  }
  const zip = await JSZip.loadAsync(bytes);
  db.schedule = JSON.parse(await zip.file("schedule.json").async("string"));
  db.files.clear();
  await Promise.all(Object.keys(zip.files).map(async p => {
    if (p.startsWith("patients/") && !zip.files[p].dir)
      db.files.set(p, await zip.files[p].async("blob"));
  }));
  db.handle = handle; db.dirty = false;
  render();
}
```

On iPad the picker reaches the USB through the Files app; on desktop you keep the
handle so saves are silent.

---

## 4. Save flow — the split that keeps desktop autosave

One serializer, two triggers.

```js
async function serialize() {                        // build the zip bytes once
  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify(makeManifest(), null, 2));
  zip.file("schedule.json", JSON.stringify(db.schedule, null, 2));
  for (const [path, blob] of db.files) zip.file(path, blob);
  return zip.generateAsync({ type:"blob", compression:"DEFLATE" });
}

// Unified entry point
async function persist({ userInitiated=false } = {}) {
  const blob = await serialize();
  if (db.handle) {                                  // DESKTOP: silent, in place
    const w = await db.handle.createWritable();
    await w.write(blob); await w.close();
    db.dirty = false; setStatus("Saved ✓", "ok");
  } else {                                          // iPad: hand off to Files
    downloadBlob(blob, "schedule.crmdb");           // <a download> → Save to Files → USB → Replace
    db.dirty = false; setStatus("Exported — choose Replace on the USB", "ok");
  }
}
```

**Desktop (handle present): no button.** Reuse the existing `syncTimer` debounce
pattern — exactly what `writeDataFile()` does now:

```js
function markChanged() {
  db.dirty = true;
  if (db.handle) { clearTimeout(syncTimer); syncTimer = setTimeout(() => persist(), 1500); }
  else { showSaveButton(true); }                    // iPad path lights the button
}
document.addEventListener("visibilitychange", () => {  // flush on tab hide, like today
  if (document.hidden && db.dirty && db.handle) persist();
});
```

**iPad (no handle): the button.** A prominent "Save database updates" that is greyed
when `db.dirty === false` and active when there are unsaved changes. One tap →
`persist()` → the Files sheet → pick the USB → Replace.

```js
saveBtn.onclick = () => persist({ userInitiated:true });
window.addEventListener("beforeunload", e => {       // guard against losing a session
  if (db.dirty && !db.handle) { e.preventDefault(); e.returnValue = ""; }
});
```

Net effect: Windows behaves like it does today (progressive, no save press);
iPad gets one deliberate Save/Replace. The only code that knows the difference is
the three lines that check `db.handle`.

---

## 5. First-time migration (desktop, one time)

The existing loose-folder workspace becomes a `.crmdb` once, using the directory
reader you already have in `src/workspace.js`:

```js
// Desktop only — needs the directory API to read the old tree
async function migrateFolderToBundle(root) {         // root = current CRMWorkspace dir
  const zip = new JSZip();
  zip.file("schedule.json", await WS.readText(root, "schedule.json"));
  const patients = await root.getDirectoryHandle("patients");
  for await (const day of patients.values())         // walk dates → slots → files
    if (day.kind === "directory")
      for await (const slot of day.values())
        if (slot.kind === "directory")
          for (const fh of await WS.listFiles(slot))
            zip.file(`patients/${day.name}/${slot.name}/${fh.name}`,
                     await (await fh.getFile()).arrayBuffer());
  return zip.generateAsync({ type:"blob" });          // → save as schedule.crmdb
}
```

Run once on the Windows machine, drop `schedule.crmdb` on the stick, and from then
on both platforms use the bundle.

---

## 6. Safety, performance, honest limits

- **Whole-file writes.** Every autosave re-serializes the entire bundle. Unchanged
  file blobs are cached in `db.files`, so you're re-zipping (fast) not re-reading
  from disk — but a very large PDF/log set makes each write heavier. Debounce
  (1.5–3s) keeps it invisible on desktop.
- **Backups (recommended for PHI).** Before overwriting, keep a rolling copy —
  e.g. write `schedule.bak.crmdb` every Nth save. On desktop the File System Access
  write is already staged-then-swapped (a crash mid-write won't shred the file);
  the `.bak` guards against logical mistakes too.
- **Memory.** The open bundle lives in RAM. Fine for a normal day; a multi-GB
  archive would strain iPad Safari. If it ever grows that big, split by month
  (`2026-07.crmdb`).
- **Single writer.** Last save wins on the whole file. For one person moving one
  stick between a PC and an iPad, that's exactly the model you want; it only bites
  if two devices edit the same bundle simultaneously.

---

## 7. What actually changes in the codebase

- `src/workspace.js` — `moveSlot` / `slotDir` directory operations retire in favor
  of in-memory key relabels; `readText`/`writeFile` get bundle-aware equivalents.
  Keep the directory reader for the one-time migration only.
- `dev/Patient_Schedule.html` — swap the `dataFileHandle` + `wsRoot` dual layer for
  the single `db` model above; the existing `syncTimer`, visibility-flush, and
  `<input type=file>` import are reused almost as-is.
- `app/CRM_Report_Generator.html` — its tiered saver (`showSaveFilePicker` →
  `<a download>`) already matches this split; point it at the shared bundle.
- Add JSZip (one small vendored file) to `vendor/`.

The desktop experience you have today is preserved; the iPad gains a working,
one-button round trip; and there's one storage format instead of two code paths.
