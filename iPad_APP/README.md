# CRM iPad app

A sideloadable iPad app for the three offline pages: Patient Schedule, CRM Report Generator and PDF
Viewer. It exists because iPad Safari has no File System Access API. In the app, the `.crmdb` you
pick (On My iPad, iCloud Drive or a USB stick) is autosaved in place, exactly as on desktop
Chrome/Edge.

| Path | What it is |
|---|---|
| `CRMiPad/` | The Swift app, plus `crm-native-shim.js`, which is injected into every page |
| `CRMiPad.xcodeproj` | The Xcode project |
| `web-files.txt` | The repo files bundled into the app, copied fresh on every build by `copy-web.sh` |
| `build-ipa.sh` | Builds an unsigned, version-stamped `dist/CRMiPad.ipa` for the Sideloader |

The web pages are not duplicated here. Every build copies the current `protected/`, `src/` and
`vendor/` files listed in `web-files.txt`. The shim is covered by `tests/ipad-native-shim.test.js`.

## Install

**With the Sideloader**, which renews the 7-day free signature automatically. Run from the repo
root, after running the Sideloader's `./install.sh` once so `atvrefresh` understands `--profile`:

    iPad_APP/build-ipa.sh
    atvrefresh --profile ipad setup iPad_APP/dist/CRMiPad.ipa
    atvrefresh --profile ipad refresh

Then add this line to `~/.config/atvrefresh-ipad/config`, which turns on the Mac app's version
card and **Update iPad** button:

    BUILD_COMMAND="/Users/spencer/Documents/Coding/CRM-Project/iPad_APP/build-ipa.sh"

**With Xcode:** open `CRMiPad.xcodeproj`, choose your Apple ID under Signing & Capabilities, select
the iPad, then press ⌘R. You'll need to re-run it every 7 days.

Either way, the first time: connect the iPad by cable, tap **Trust**, and turn on
**Settings › Privacy & Security › Developer Mode**.
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

Nothing else to remember: the app always ships the `protected/`, `src/` and `vendor/` files listed in
`web-files.txt`. If a page starts loading a file that list is missing,
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

## Notes

- USB sticks must be **exFAT**, because iPadOS mounts NTFS read-only.
- You can debug the app from Safari › Develop on the Mac while the iPad is connected.
- Not yet verified on hardware: password-protected databases. The encryption needs a secure
  context. If it fails under the `crmapp://` scheme, serve the pages from a loopback server instead.
