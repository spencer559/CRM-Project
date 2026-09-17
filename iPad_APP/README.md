# CRM iPad and iPhone app

A sideloadable app for the three offline pages: Patient Schedule, CRM Report Generator and PDF
Viewer. It exists because iPad Safari has no File System Access API. In the app, the `.crmdb` you
pick (On My iPad, iCloud Drive or a USB stick) is autosaved in place, exactly as on desktop
Chrome/Edge.

It is one universal build: the same `dist/CRMiPad.ipa` installs on an iPad or an iPhone. On an iPhone
the pages switch to their phone layout (see [iPhone](#iphone)). The folder and target keep their
iPad names because renaming them would break the Sideloader's `BUILD_COMMAND`.

| Path | What it is |
|---|---|
| `CRMiPad/` | The Swift app, plus `crm-native-shim.js`, which is injected into every page |
| `CRMiPad.xcodeproj` | The Xcode project |
| `web-files.txt` | The `site/` files bundled into the app, copied fresh on every build by `copy-web.sh` |
| `build-ipa.sh` | Builds an unsigned, version-stamped `dist/CRMiPad.ipa` for the Sideloader |

The web pages are not duplicated here. Every build copies the current `site/protected/`, `site/src/`
and `site/vendor/` files listed in `web-files.txt`, keeping the layout under `site/`, so the app serves
each page at the same path as the website (`crmapp://app/protected/Patient_Schedule.html`). The shim is covered by `tests/ipad-native-shim.test.js`.

## Install

**With the Sideloader**, which renews the 7-day signature a free Apple ID gets. Renewal is manual on
purpose: the Apple TV Refresh app's **Refresh Now** button, with its Auto switch deliberately left off
(see *Known gaps*). Run from the repo root, after running the Sideloader's `./install.sh` once so
`atvrefresh` understands `--profile`:

    iPad_APP/build-ipa.sh
    atvrefresh --profile ipad setup iPad_APP/dist/CRMiPad.ipa
    atvrefresh --profile ipad refresh

Then add this line to `~/.config/atvrefresh-ipad/config`, which turns on the Mac app's version
card and **Update iPad** button:

    BUILD_COMMAND="/Users/spencer/Documents/Coding/CRM-Project/iPad_APP/build-ipa.sh"

**With Xcode:** open `CRMiPad.xcodeproj`, choose your Apple ID under Signing & Capabilities, select
the iPad, then press ⌘R. You'll need to re-run it every 7 days.

Either way, the first time: connect the iPad by cable, tap **Trust**, and turn on
**Settings › Privacy & Security › Developer Mode**. The same steps apply to an iPhone.
Xcode also needs its **iOS platform** installed (Settings › Components › iOS). It's separate from
the SDK, and nothing will build for an iPad without it.

## After changing the web pages

**Commit, then press Update iPad** in the Apple TV Refresh app (iPad tab). With the iPad unlocked and
plugged in or on the same Wi-Fi, it builds the last commit and installs it, which also restarts the
7-day signature. That's the whole routine, and anyone can do it.

The iPad tab's version card shows:

- **On the iPad**: the commit that's installed, when it was made, and its message. A build of
  uncommitted edits shows as an orange **Test build**.
- **Up to date**, or **Newer version ready** with the commits that aren't on the iPad yet.
- A note when this Mac has uncommitted edits, which Update leaves out.

**Refresh Now** is different: it reinstalls the version that's already on the iPad with a fresh 7
days, and never changes what the app does. A new version only becomes the one Refresh Now reinstalls
once it has actually installed, so a failed update leaves both the iPad and Refresh Now as they were.

To try an edit on the iPad **before committing it**, from the repo root:

    iPad_APP/deploy.sh

That builds the working tree as it is, uncommitted edits included, and installs it. It shows up as a
test build until the next Update. `iPad_APP/deploy.sh --build` stops after the build.

Nothing else to remember: the app always ships the `site/` files listed in `web-files.txt`. If a page starts loading a file that list is missing,
`tests/ipad-bundle-complete.test.js` fails, in `npm test` and before every build, and names the file.
Add it to `web-files.txt` and build again. Changing the Swift app instead (`CRMiPad/`) needs nothing
extra; both routes rebuild that too.

### How a build knows what it is

`build-ipa.sh` writes a `SideloadBuildInfo` dictionary into the app's `Info.plist`: the last commit
that changed the app, its time and message, whether uncommitted edits went in, and a fingerprint of
exactly the files that go into the app (`CRMiPad/`, the project, and everything `web-files.txt`
lists). The Sideloader records that for whatever it installs, and runs `build-ipa.sh --describe` to
get the fingerprint of what it *would* build now. A different fingerprint means an update is waiting.
Because it covers only app inputs, commits that touch nothing else (tests, README, `dashboard.html`)
don't count as updates.

    iPad_APP/build-ipa.sh --describe              # JSON about the last commit's build
    iPad_APP/build-ipa.sh --describe --worktree   # ...or the working tree's

The version and build number (the build date and the commit count) are still set, and are what the
iPad's Settings ▸ General ▸ iPad Storage shows, but they don't say which code is inside. The stamp
does.

If the app **stops opening**, the 7-day signature has run out: press Refresh Now. It doesn't need a
rebuild.

## iPhone

The iPhone runs the same app: same `.ipa`, same bundle ID (`com.spencer.crmdb.ipad`). It isn't a
second app, so on a free Apple ID it registers no new App ID. The bundle ID stays as it is: changing
it costs one of the 10 App IDs a free account gets per 7 days, and would leave the iPad's data behind in
the old app's container.

**Install** with a second Sideloader profile, from the repo root:

    iPad_APP/build-ipa.sh
    atvrefresh --profile iphone setup iPad_APP/dist/CRMiPad.ipa
    atvrefresh --profile iphone refresh

then add the same `BUILD_COMMAND` line to `~/.config/atvrefresh-iphone/config`. **Before the iPhone is
paired with this Mac,** set `DEVICE_NAME` in `~/.config/atvrefresh-ipad/config` to the iPad's name,
and in the iPhone profile to the iPhone's. An empty `DEVICE_NAME` means "the only paired device", so
once there are two, the iPad profile stops with *More than one iOS device is visible* instead of
installing. Each device has its own 7-day signature, renewed separately.

**What changes on a phone.** Each of the three pages has one `@media (max-width: 640px)` block. Below
640pt, which covers every iPhone in portrait and also iPad Slide Over and narrow Split View, the layout is:

- **Schedule:** each appointment is a card. It's the same `<tr>`/`<td>` markup, laid out on a 12-column
  grid, with each cell's `data-label` shown as its caption, so no handler changes. The header menus
  span the screen.
- **Report panel:** it covers the screen instead of opening under the row. Split view stacks the programmer
  file under the form, and the divider drags vertically.
- **Report Generator:** the app bar is two rows (patient and actions, then last office and save
  status), so Done, Files and ☰ stay on screen.
- **PDF Viewer:** the toolbar drops the file name and tightens up. Contents opens over the page and closes
  when you pick an entry. At 375pt the toolbar is 27px too wide and scrolls sideways, which is the
  intended fallback; at 402pt (Pro) and 440pt (Pro Max) it fits.

The iPhone is portrait only. The iPad keeps its layout, because its narrowest orientation is 744pt.

**Things WebKit on an iPhone does that a desktop browser at the same width doesn't.** Each was found in
the iOS Simulator; each fix carries a comment where it's made:

- `100vh` in the app's web view is the whole screen, safe areas included, while the page sits
  below the Dynamic Island. The Schedule's shell was 96pt taller than the visible area, and the end
  of the list could never scroll into view. It's sized with `height:100%` now; on iPad this also
  frees the 20pt behind the home indicator.
- `-webkit-overflow-scrolling:touch` makes iOS clip a `position:fixed` child to that scroller, which
  hid the full-screen panel's top bar, Close included. The phone block turns it off.
- iOS draws a native time field at its own width and ignores `width:100%`. The phone cards drop its
  native appearance, and tapping it still opens the time picker.
- iOS zooms the whole page into any focused field under 16px, which is every Report Generator
  measurement cell. The shim adds `maximum-scale=1` to the top page's viewport, and
  `WebViewController` sets `ignoresViewportScaleLimits` so pinch zoom still works. The iPad never
  focus-zooms, and the website's own viewport is untouched.

`tests/phone-layout.test.js` pins the universal build, the captions matching the headers, the
stacked divider, the bar heights that must agree, and the shim's viewport change.

**Why universal, not a second target.** Nothing in the Swift app is iPad-specific: the pickers,
bookmarks, scheme handler, printing and popups all run unchanged on iOS. One target means one build,
one fingerprint for the Sideloader's update check, and one App ID. The phone layout is responsive CSS
in the existing pages rather than separate phone pages, because the three pages act as one app (the
embedded generator, the viewer handoff, the shared store), and a second set of pages would split all
of that.

**Verified** on September 16, 2026, in the iOS 18 Simulator, on an iPhone 16 Pro (402pt), using a synthetic
database:

- opening it from the Files picker, and autosave writing back to the file
- the cards and the report panel
- the stacked split and its divider, and Contents
- the Files menu, and a generated report in the viewer window with the print sheet
- focus zoom off, and pinch zoom still working

Overflow was also measured at 375pt and 440pt in a desktop browser.

**On a real iPhone** (an iPhone 14 Pro Max, 430pt wide, on iOS 26) since September 17, 2026: it
installs through its own Sideloader profile and the phone layout looks right in use. The flows the
*Notes* section lists as unverified on hardware are still unverified on the phone too.

## Why it's built this way

The app exists for one reason: WebKit has no File System Access API, so in iPad Safari
`canAutosave` in `src/crmdb-store.js` is false and the desktop path (bound file handle, autosave in
place, the cross-station freshness guard) never runs. A WKWebView alone doesn't change that; it's the
same engine with the same missing API. The app is only worth having because Swift can **supply** the
missing API (`crm-native-shim.js` over `NativeBridge.swift`), so every existing desktop code path
runs unchanged.

Alternatives that were considered and rejected, so they don't get proposed again:

- **A loopback HTTP server** was the original plan, on the belief that WebKit doesn't treat a custom
  scheme as a secure context. That would have disabled `crypto.subtle`, and with it `.crmdb` password
  protection. A startup check in the iPad Simulator showed the pages **are** a secure context under
  `crmapp://`, so the server was dropped. It remains the known fallback (about an hour's work) if
  `crypto.subtle` ever fails on a real device. `file://` was never viable: its opaque origin breaks
  workers and IndexedDB.
- **Capacitor** was passed over for the hand-written bridge. Its filesystem plugin can't keep
  security-scoped bookmarks to files outside the app (a USB stick, a OneDrive folder), so that part
  of the bridge would have been written anyway.

Two constraints to keep:

- **`lastModified` must be the file's real modification time, never faked.** The freshness guard keys
  off it, and that guard is what stops one clinic station's stale copy overwriting another's work.
- **The app is fully offline, with no Cloudflare Access in front of it.** That was a deliberate scope
  decision, and it is why nothing but the iPad's own lock screen gates patient data on the device (see
  *Known gaps*).

`showDirectoryPicker` was at first left out (Download patients fell back to one `.zip`), then
implemented once the zip proved useless for printing patient folders at the clinic.

## Notes

- USB sticks must be **exFAT**, because iPadOS and iOS mount NTFS read-only. (An iPhone needs USB-C,
  or an adapter, to take a stick at all.)
- The **first** file picker after launch takes around 8 seconds to appear, with no visual feedback.
  It looks broken, but it isn't.
- You can debug the app from Safari › Develop on the Mac while the iPad or iPhone is connected.
- **Leaving the app finishes the save.** Edits publish to the `.crmdb` at most every 30 seconds and
  whenever the page is hidden, but iOS suspends a backgrounded app within seconds, so that last save
  used to be frozen part-way: the edits survived in the app's own storage and replayed on the next
  launch, while the file on the stick or in OneDrive didn't have them until then. On entering the
  background the app now asks iOS for time (`saveInBackground` in `WebViewController.swift`), has the
  page finish what an exit does (`flushForBackground` in the shim, `CRMFlushPending` on the page, then
  the store's `persistNow`), and gives the time back as soon as the write lands. A page that never
  answers is given up on after 20 seconds, because an unreleased background assertion is itself a way
  to get killed. Covered by `tests/crmdb-background-flush.test.js`; watch it work with
  `xcrun simctl spawn booted log show --last 2m --predicate 'process == "CRMiPad"' | grep "background save"`.
- The icon's source picture isn't in the repo; only the cropped `icon-1024.png` is. Changing the crop
  with `make-icon.sh` needs the original image.
- **Not yet verified on real hardware** (Simulator or headless tests only): password-protected
  databases, all three print paths (day sheet, report, PDF viewer), the PDF viewer opening as a child
  window, and downloads. Printing is the one most likely to come up in clinic.

## Known gaps

After the first successful day at a clinic (September 2026), a review listed these, in this order of
importance. The app icon was done then, and finishing the save when the app goes to the background on
2026-09-17 (see *Notes*); the rest were **deliberately deferred**. The first two below were
re-checked against the code on 2026-09-17 and are still open.

1. **The signature expires without warning.** A free Apple ID signature lasts 7 days and automatic
   renewal is off, so the app simply stops opening, possibly mid-clinic, and the fix needs the Mac.
   Options: turn Auto on, pay for a developer account (1-year signatures), or have the app read its
   own expiry at launch and warn a few days ahead.
2. **Nothing locks the app.** On the website, `/protected/` sits behind Cloudflare Access; the offline
   app has no equivalent, and the `.crmdb` password is optional. An unlocked iPad opens straight into
   patient data. Fix: Face ID or passcode on launch and on return from the background (about an hour).
   An iPhone that leaves the clinic in a pocket makes this one sharper too.
3. **iPad portrait still scrolls sideways.** The column trim targeted landscape (1194pt wide, with 10px
   to spare). Portrait is 834pt and the schedule table needs 1122pt. The phone layout's cards start
   below 640pt, so they don't reach it; widening that breakpoint is the obvious fix to try.
4. **Multiple windows are allowed.** Stage Manager can open two windows on one database. That behaves
   like two browser tabs (the store's writer lease leaves the second read-only), but it was flagged to
   be turned off.
5. **A lost file link needs a manual re-pick.** After an iPadOS update or a USB replug the page shows
   "Can't reach the database file". It could retry, and offer the picker on its own.
6. **There's only one copy.** One `.crmdb` on one stick. Each save to USB could also drop a dated
   backup on the iPad.
