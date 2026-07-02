# Mileage Sync — Deployment Guide

This sets up a free Cloudflare Worker + D1 database that stores each user's
mileage profile in the cloud, so you no longer export/import JSON between
stations. It **never** pauses on inactivity, and it only ever touches mileage
data — nothing from the CRM interrogation form goes anywhere near it.

You only do this once. Budget ~15 minutes.

---

## 0. Prerequisites

- A free Cloudflare account: https://dash.cloudflare.com/sign-up
- Node.js installed (https://nodejs.org). Check with: `node -v`

All commands below are run from inside the `mileage-backend/` folder:

```bash
cd mileage-backend
```

Wrangler is Cloudflare's CLI. You don't need to install it globally — `npx`
will fetch it on demand.

---

## 1. Log in to Cloudflare

```bash
npx wrangler login
```

A browser window opens — approve the access. This links the CLI to your account.

---

## 2. Create the D1 database

```bash
npx wrangler d1 create mileage
```

It prints a block like:

```
[[d1_databases]]
binding = "DB"
database_name = "mileage"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Copy the `database_id` value and paste it into **`wrangler.toml`**, replacing
`REPLACE_WITH_YOUR_D1_DATABASE_ID`.

---

## 3. Create the tables

```bash
npx wrangler d1 execute mileage --remote --file=./schema.sql
```

(You can re-run this safely; it uses `CREATE TABLE IF NOT EXISTS`.)

---

## 4. Set your two secrets

**JWT_SECRET** — signs login tokens. Use a long random string. Generate one:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Then store it:

```bash
npx wrangler secret put JWT_SECRET
# paste the random string when prompted
```

**INVITE_CODE** — anyone registering a new account must type this. Pick
something only you and your colleagues will know, then:

```bash
npx wrangler secret put INVITE_CODE
# type your chosen invite code when prompted
```

> To rotate either later, just run the `secret put` command again.
> Changing `INVITE_CODE` doesn't affect existing accounts; changing
> `JWT_SECRET` logs everyone out (they just sign in again).

---

## 5. Deploy

```bash
npx wrangler deploy
```

It prints your Worker URL, e.g.:

```
https://mileage-sync.YOURNAME.workers.dev
```

Copy that URL (no trailing slash).

---

## 6. Point the page at your Worker

Open **`app/mileage-sync.js`** and set the URL near the top:

```js
var WORKER_URL = "https://mileage-sync.YOURNAME.workers.dev";
```

Save, commit, and push to GitHub:

```bash
git add app/mileage-sync.js
git commit -m "Enable mileage cloud sync"
git push
```

While `WORKER_URL` is blank, the page stays 100% local (no sync UI shown), so
nothing breaks before this step.

---

## 7. Try it

1. Open the Mileage Calculator on your live site.
2. Top-right shows a **Sign in / Register** button. Click it → **Create an
   account** → enter a username, an 8+ character passphrase, and your invite code.
3. Add a day or two of mileage. The bar shows **Saving… → Synced**.
4. Open the page on another machine, sign in with the same account — your data
   loads automatically.
5. Have a colleague register with the invite code — they get their own private
   data; they can't see yours and you can't see theirs.

---

## Notes & good hygiene

- **On a shared workstation, click "Sign out" when you're done.** That wipes the
  login token from that browser. Tokens also auto-expire after 12 hours.
- **No pausing.** Unlike some free databases, Cloudflare Workers/D1 don't sleep
  on inactivity — come back after months and it answers instantly.
- **Free-tier limits** (5 GB storage, 5M row reads/day, 100k writes/day) are far
  beyond anything mileage tracking will use.
- **If a hospital network blocks the Worker domain**, the page still works
  offline from its local copy and syncs the next time it can reach the Worker.
- **CORS is locked** to `https://spencer559.github.io` (set in `wrangler.toml`).
  If you ever test from a local web server, add that origin to `ALLOWED_ORIGIN`
  and redeploy.

## Managing data (optional)

Peek at what's stored:

```bash
npx wrangler d1 execute mileage --remote --command "SELECT username, created_at FROM users;"
```

Delete a user's account and data:

```bash
npx wrangler d1 execute mileage --remote --command "DELETE FROM profiles WHERE user_id=(SELECT id FROM users WHERE username='someone'); DELETE FROM users WHERE username='someone';"
```
