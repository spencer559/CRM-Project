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
| `build-ipa.sh` | Builds an unsigned `dist/CRMiPad.ipa` for the Sideloader |

The web pages are not duplicated here. Every build copies the current `protected/`, `src/` and
`vendor/` files listed in `web-files.txt`. The shim is covered by `tests/ipad-native-shim.test.js`.

## Install

**With the Sideloader**, which renews the 7-day free signature automatically. Run from the repo
root, after running the Sideloader's `./install.sh` once so `atvrefresh` understands `--profile`:

    iPad_APP/build-ipa.sh
    atvrefresh --profile ipad setup iPad_APP/dist/CRMiPad.ipa
    atvrefresh --profile ipad refresh
    atvrefresh --profile ipad timer install

**With Xcode:** open `CRMiPad.xcodeproj`, choose your Apple ID under Signing & Capabilities, select
the iPad, then press ⌘R. You'll need to re-run it every 7 days.

Either way, the first time: connect the iPad by cable, tap **Trust**, and turn on
**Settings › Privacy & Security › Developer Mode**.
Xcode also needs its **iOS platform** installed (Settings › Components › iOS). It's separate from
the SDK, and nothing will build for an iPad without it.

## After changing the web pages

One command, from the repo root, with the iPad unlocked and plugged in or on the same Wi-Fi:

    iPad_APP/deploy.sh

It checks the bundle list, rebuilds `dist/CRMiPad.ipa`, adopts it, then re-signs and installs —
which also restarts the 7-day signature. `iPad_APP/deploy.sh --build` stops after the build.

Nothing else to remember: the app always ships the current `protected/`, `src/` and `vendor/` files
listed in `web-files.txt`. If a page starts loading a file that list is missing,
`tests/ipad-bundle-complete.test.js` fails — in `npm test` and at the start of every deploy — and
names the file. Add it to `web-files.txt` and deploy again.

Each build is stamped with the day it was built, so the Apple TV Refresh app's **Version** row (iPad
tab) and the iPad's Settings ▸ General ▸ iPad Storage tell you which build is installed.

Changing the Swift app instead (`CRMiPad/`) needs nothing extra — `deploy.sh` rebuilds that too.

## Notes

- USB sticks must be **exFAT**, because iPadOS mounts NTFS read-only.
- You can debug the app from Safari › Develop on the Mac while the iPad is connected.
- Not yet verified on hardware: password-protected databases. The encryption needs a secure
  context. If it fails under the `crmapp://` scheme, serve the pages from a loopback server instead.
