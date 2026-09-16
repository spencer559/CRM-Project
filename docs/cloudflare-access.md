# Cloudflare Pages and the Access boundary

## Pages build settings

The site is published from the `site/` folder, and nothing outside it is deployed. In the
Cloudflare dashboard, Workers & Pages → the Pages project → Settings → Build:

| Setting | Value |
|---|---|
| Framework preset | None |
| Build command | *(empty)* |
| Build output directory | `site` |
| Root directory | *(empty, the repo root)* |

Cloudflare reads `_headers` and `_redirects` only from the root of the output directory, which is
why they live in `site/`. Before `site/` existed the output was the repo root, so the README, agent
briefs, tests, git hooks and iPad app source were all publicly downloadable from the site.
`tests/route-boundaries.test.js` pins the top-level entries of `site/` so nothing else slips in.

**Order matters when this setting changes.** Change the output directory in the dashboard first,
then push. A deploy built with the old setting (the repo root) would serve everything under
`/site/…`: nothing at `/`, and the pages at `/site/protected/…`, a path Access does not cover.

## The boundary

The site has one deliberate authentication boundary. URL paths are unaffected by `site/`: the file
`site/protected/Patient_Schedule.html` is served at `/protected/Patient_Schedule.html`.

- `/protected` and `/protected/*` contain the CRM Report Generator, Patient Schedule,
  PDF viewer, dashboard, and developer deck. Cloudflare Access must protect them.
- `/mileage` and `/mileage/*` are public. The calculator must load and work without a
  Cloudflare session. Its optional mileage-sync username/passphrase is a separate,
  application-level login and is not required for local use. The page is self-contained within
  `mileage/`, so no Access path can break it (`tests/route-boundaries.test.js` checks both).
- `/`, `/assets/*`, `/src/*` and `/vendor/*` remain public static assets. Patient data is not stored
  in those files; the clinical pages themselves block network egress with their CSP. They stay
  public on purpose: the public landing page loads its fonts from `/vendor/fonts/`, and the
  protected pages load `/vendor/pdf.worker.min.js` and `/src/pdf-selection-worker.js` lazily, long
  after the page opened, so gating them would break PDF viewing and printing in a tab left open
  past its Access session.
- `/tools/*` (the redactors and the PDF extraction harness) holds no data and is linked only from
  the protected developer deck. It can be public, or added to the protected application below.

## Dashboard configuration

In Zero Trust → Access → Applications, keep one self-hosted application for the protected
toolkit. Add both path entries to the same application because Cloudflare documents that a
`path/*` wildcard does not cover the parent path:

| Hostname | Path |
|---|---|
| `device-tech.pages.dev` | `protected` |
| `device-tech.pages.dev` | `protected/*` |

To keep the developer tools private as well, add `tools` and `tools/*` rows to the same
application. Never add `mileage`, `vendor`, `src` or the bare hostname.

Attach the intended Device Tech / Developer Allow policy to that one application. Delete or
disable the old applications for `app/CRM_Report_Generator.html`, `dev/*`, and
`auth/signin.html` after the new deployment is live. Separate applications are what caused
the browser to need multiple Access cookies and the former iframe/pop-up authorization flow.

Do not create an Access application for the whole `device-tech.pages.dev` hostname. If an
existing zone-wide application cannot yet be removed, create more-specific self-hosted application
paths for both `mileage` and `mileage/*`, each with a Bypass policy using Include → Everyone, until the zone-wide application is
retired. A path-only protected application is the preferred final state.

If the Pages project also has a custom domain, add the same protected paths for that
hostname. Keep the custom domain in `mileage-backend/wrangler.toml`'s `ALLOWED_ORIGIN` so optional
cloud sync can call the Worker.

## Deployment order

1. Deploy this repository so `/protected/` and `/mileage/` exist.
2. Create the new protected Access application/path entries.
3. Confirm an authorized browser can open `/protected/` and the embedded CRM panel in the
   Patient Schedule.
4. In a private browser with no Access cookies, confirm `/mileage/` returns the calculator
   directly and can add/export entries.
5. Remove the legacy Access applications. The `_redirects` file keeps old bookmarks working
   after those old path gates are gone.

## Quick checks

Run these without an Access cookie (replace the host for a custom domain):

```bash
curl -I https://device-tech.pages.dev/mileage/
curl -I https://device-tech.pages.dev/protected/
curl -s https://device-tech.pages.dev/README.md | head -c 15; echo
```

The mileage request should return the site directly (normally `200`). The protected request
should redirect to Cloudflare Access. The `README.md` request should print `<!DOCTYPE html>`, not
Markdown: anything outside `site/` is not deployed, and Pages answers a path it doesn't have with
the home page (with no `404.html`, it treats the site as a single-page app). Also test the
calculator with the Worker unavailable; local entry, calculation, JSON import/export, and XLSX
export must continue to work.

Cloudflare reference: [Application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/).
