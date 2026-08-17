# Cloudflare Access boundary

The repository now has one deliberate authentication boundary:

- `/protected` and `/protected/*` contain the CRM Report Generator, Patient Schedule,
  PDF viewer, dashboard, and developer deck. Cloudflare Access must protect them.
- `/mileage` and `/mileage/*` are public. The calculator must load and work without a
  Cloudflare session. Its optional mileage-sync username/passphrase is a separate,
  application-level login and is not required for local use.
- `/`, `/assets/*`, `/src/*`, `/vendor/*`, and `/tools/*` remain public static assets.
  Patient data is not stored in those files; the clinical pages themselves block network
  egress with their CSP.

## Dashboard configuration

In Zero Trust → Access → Applications, keep one self-hosted application for the protected
toolkit. Add both path entries to the same application because Cloudflare documents that a
`path/*` wildcard does not cover the parent path:

| Hostname | Path |
|---|---|
| `device-tech.pages.dev` | `protected` |
| `device-tech.pages.dev` | `protected/*` |

Attach the intended Device Tech / Developer Allow policy to that one application. Delete or
disable the old applications for `app/CRM_Report_Generator.html`, `dev/*`, and
`auth/signin.html` after the new deployment is live. Separate applications are what caused
the browser to need multiple Access cookies and the former iframe/pop-up authorization flow.

Do not create an Access application for the whole `device-tech.pages.dev` hostname. If an
existing zone-wide application cannot yet be removed, create more-specific self-hosted application
paths for both `mileage` and `mileage/*`, each with a Bypass policy using Include → Everyone, until the zone-wide application is
retired. A path-only protected application is the preferred final state.

If the Pages project also has a custom domain, add the same two protected paths for that
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
```

The mileage request should return the site directly (normally `200`). The protected request
should redirect to Cloudflare Access. Also test the calculator with the Worker unavailable;
local entry, calculation, JSON import/export, and XLSX export must continue to work.

Cloudflare reference: [Application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/).
