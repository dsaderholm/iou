# IOU

A self-hosted running tab. One admin, a list of people, and a single balance
per person. Each person gets a private read-only link they can open without an
account to see what they owe and pay it.

Not bill splitting, not invoicing, not budgeting.

- Node + Express, SQLite, server-rendered HTML. No build step, no client
  framework, three runtime dependencies.
- Money is stored as integer cents. Floats never touch an amount.
- The admin UI is built for a phone: everything is within two taps of the home
  screen, and amount fields use `inputmode="decimal"` so Android opens the
  number pad.
- Installs to the home screen. Open it from an icon, not a bookmark.

## Quick start

Paste [`docker-compose.yml`](docker-compose.yml) into Dockhand (or run
`docker compose up -d`), change these two lines, and deploy:

```yaml
ADMIN_USER: "me"
ADMIN_PASSWORD: "change-this-to-something-long"
```

That is the whole setup. The image is prebuilt for amd64 and arm64 at
`ghcr.io/dsaderholm/iou:latest`, so there is nothing to clone and no command to
run first. It listens on 3000 and keeps its database in the `iou-data` volume
at `/data/iou.db`.

### If you would rather not keep a plaintext password in the compose file

`ADMIN_PASSWORD` is hashed with bcrypt at startup and never stored in the
clear — but it does sit in your compose file, which is the price of pasting and
walking away. To avoid that, generate a hash:

```bash
docker run --rm ghcr.io/dsaderholm/iou:latest node scripts/hash-password.js 'your password'
```

Then drop `ADMIN_PASSWORD` and set `ADMIN_PASSWORD_HASH` instead. One catch:
compose reads a lone `$` as a variable reference and a bcrypt hash is full of
them, so **double every `$`**:

```yaml
ADMIN_PASSWORD_HASH: "$$2b$$12$$K3nRz8Qm..."
```

Miss that and the app refuses to boot with a message naming this exact cause,
rather than silently rejecting your password forever.

### Without Docker

```bash
npm install
npm run hash-password -- 'your password'
DATA_DIR=./data ADMIN_USER=me ADMIN_PASSWORD_HASH='...' npm start
```

`npm run dev` reads `.env` automatically and restarts on file changes.

Building the image yourself: `docker build -t iou .` — the compose file pulls
the published image, so swap `image:` for `build: .` if you want a local build.

## Environment variables

| Variable | Required | Default | What it does |
| --- | --- | --- | --- |
| `ADMIN_USER` | yes | — | The one login name. There is no registration route. |
| `ADMIN_PASSWORD` | one of these | — | Plaintext password, hashed at boot. Simplest, but it lives in your compose file. |
| `ADMIN_PASSWORD_HASH` | one of these | — | bcrypt hash. Nothing plaintext anywhere. Double every `$` in a compose file. Wins if both are set. |
| `SESSION_SECRET` | no | generated | Signs the session cookie. Left unset, a random secret is written to `/data/session_secret` on first run and reused. |
| `VENMO_HANDLE` | no | — | Adds a Venmo button to the share page. Unset means no button. |
| `PAYPAL_ME` | no | — | Adds a PayPal button. |
| `CASHAPP_HANDLE` | no | — | Adds a Cash App button. |
| `SITE_TITLE` | no | `IOU` | Shown in the admin header. |
| `OWNER_NAME` | no | — | Share page reads "you owe to `<name>`". |
| `PUBLIC_BASE_URL` | no | from request | The address people actually use, e.g. `https://iou.example.com`. Only needed if your proxy rewrites `Host`. |
| `API_TOKEN` | no | — | Enables read-only JSON at `/api/summary.json`. Blank means the route does not exist. Treat it as a password. |
| `BACKUP_ENABLED` | no | `true` | Write a backup into `/data/backups` at every start, then daily. |
| `BACKUP_KEEP` | no | `14` | How many backups to keep. |
| `BACKUP_INTERVAL_HOURS` | no | `24` | How often to take one after the first. |
| `TZ` | no | `UTC` | Timestamps are stored in UTC and displayed in this zone. |
| `PORT` | no | `3000` | Port inside the container. |
| `DATA_DIR` | no | `/data` | Where the database and generated secret live. |
| `SESSION_TTL_SECONDS` | no | 1 year | How long a login lasts. Long on purpose: the phone's own lock screen is the real guard, and a shorter window only means retyping a long password. |
| `TRUST_PROXY` | no | `true` | Passed to Express `trust proxy`. Set `false` if not behind a proxy. |

Payment handles accept a bare handle or a full profile URL; the extra parts are
trimmed off.

## Using it

**Install it first.** Open the app in Chrome on Android, then *Add to home
screen* from the menu. It launches standalone, with no browser chrome, straight
onto the people list. That single step does more for how fast entry feels than
anything else here.

**Home** lists everyone with their current balance, largest debt first, plus the
total owed to you. Adding a person takes a name and drops you straight onto
their page, so adding someone and charging them is one continuous motion.

**A person's page** has the balance, an *Add charge* form and a *Record payment*
form at the top, the share link with one-tap copy (and the Android share sheet,
where the browser supports it), and the full history with a running balance
beside every entry. A payment is stored as a negative entry on the same tab —
there are no separate loans or invoices.

**Settle up** records a payment for exactly what is owed, in one tap. The
balance is read when you tap it rather than trusted from the page, so the tab
always lands on zero even if something changed since it was rendered.

**Descriptions autocomplete** from that person's own history, kept separate for
charges and payments, so a repeat "Gas money" is a tap instead of typing.

Amounts accept anything a phone keypad or a paste produces: `12`, `12.5`,
`12.34`, `$1,234.56`. More than two decimal places is rejected rather than
rounded, so a typo is visible instead of silent. The form decides the sign, not
the text you type.

**Mistakes are recoverable.** *Edit* changes an entry's amount, description,
direction or date, keeping its position in the history. *Delete* is a soft
delete, and the notice that follows offers **Undo** — a mis-tap on a phone costs
nothing.

**Archive** takes someone off the main list and out of its totals while keeping
every entry, which is almost always what you want instead of *Delete
permanently*. Their share link keeps working. Archived people live at
`/archived` with their own total.

Because archiving removes someone from *Owed to you*, it says so twice: it asks
first if they still have a balance, and the home page keeps naming the archived
amount underneath the list. Money never leaves that page silently.

**Activity** in the header lists recent entries across everyone, newest first.
It is the only view that can catch a charge landing on the wrong tab — per-person
history cannot show you a mistake you do not already suspect. Tap a name to open
that tab and fix it.

Editing an entry can also move its **date**, for when you record on Sunday
something that happened on Tuesday. It shifts by whole days and keeps the time
of day, rather than inventing a time the entry never had.

**CSV** in the header exports every entry for every person, with `amount_cents`
as the authoritative column and a signed `amount_usd` for spreadsheets.
**Download database backup** at the bottom of the home page gives you the whole
SQLite file, share tokens included, which the CSV cannot do.

## Health, backups, and integrations

`GET /healthz` runs a real query and returns `{"status":"ok","database":"ok"}`,
or `503` if the database is locked, corrupt, or on a volume that did not mount.
The container healthcheck uses it. It needs no session and reveals nothing —
no names, balances, or counts.

Backups are automatic. One is written to `/data/backups` at every start, so
every upgrade snapshots before the new code touches anything, then once a day,
keeping the newest `BACKUP_KEEP`. They go through SQLite's backup API, so they
are consistent even mid-write. *Download database backup* on the home page
still gives you one on demand.

Set `API_TOKEN` and `GET /api/summary.json` returns totals and per-person
balances as JSON:

```bash
curl -H "X-Api-Key: $API_TOKEN" https://iou.example.com/api/summary.json
```

```json
{
  "generated_at": "2026-09-12T17:40:18.659Z",
  "currency": "USD",
  "totals": { "owed_cents": 25875, "net_cents": 25875, "archived_owed_cents": 0 },
  "people": [
    { "id": 1, "name": "Marcus Webb", "balance_cents": 24000, "balance": "240.00",
      "negative": false, "entry_count": 1, "archived": false }
  ]
}
```

`Authorization: Bearer` works too. It uses its own token rather than the session
cookie, because the admin session is not something to paste into another
service. Share tokens are deliberately absent from the payload: they are bearer
credentials for somebody's private page, and an integration that wants balances
has no business holding them.

That endpoint is the integration point for a dashboard, a Home Assistant sensor,
or a personal finance app. Worth knowing before wiring one up: the money this
app tracks is a *receivable*, which no bank feed will ever tell your finance
app. Pushing these as transactions instead tends to double-count, because the
card payment and the repayment are usually already arriving through your normal
account sync.

## The share page

`/t/<token>` is the only route that works without logging in.

- It shows one person's name, balance, and history. Nothing else, and no way to
  reach any other person's data.
- Read-only. No forms.
- A wrong token returns a plain 404, byte-identical to any other unknown path.
  Nothing confirms whether a token exists or what one looks like.
- `X-Robots-Tag: noindex` on every response, and `robots.txt` disallows
  everything.
- `Referrer-Policy: same-origin`, so the token is never handed to Venmo, PayPal
  or Cash App in a `Referer` header when someone taps a payment button.
- Payment buttons carry the balance where the service supports it: Venmo and
  Cash App as documented, and PayPal.me, which takes an amount in the same way.
  Buttons appear only when the person actually owes something.

The link is a bearer token: anyone holding it can read that page. **Regenerate
link** on the person's page issues a new one and kills the old immediately.

## Behind a reverse proxy

The container speaks plain HTTP on 3000 and trusts `X-Forwarded-Proto` to decide
whether to mark the session cookie `Secure`. That header picks the transport
flag only — no proxy header is ever used to decide who the user is.

Forward the original `Host`, or set `PUBLIC_BASE_URL`, so share links come out
with the right address. Example for nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

## Backups

The quickest backup is **Download database backup** on the home page: it goes
through SQLite's backup API, so it is consistent even mid-write, and it
contains the share tokens a CSV does not.

For a copy taken from outside the app, everything is in the volume: `iou.db`
plus the generated `session_secret`.

```bash
docker compose exec iou sh -c 'ls -la /data'
docker run --rm -v iou-data:/data -v "$PWD:/out" busybox tar czf /out/iou-backup.tgz /data
```

The database runs in WAL mode, so copy `iou.db`, `iou.db-wal` and `iou.db-shm`
together, or stop the container first.

## Tests

```bash
npm test
```

Covers amount parsing and formatting, balance arithmetic including overpayment,
the auth gate, session cookie flags, share-page isolation and 404 behaviour,
token regeneration, HTML escaping, the CSV export, settle-up, entry editing,
undo, archiving, the manifest and icons, the database download, and login
throttling. `test/boot.test.js` spawns real servers to check startup.

## Layout

```
src/server.js   routes and middleware
src/db.js       SQLite schema and queries
src/auth.js     password check, signed session cookie
src/money.js    cents parsing and formatting
src/views.js    HTML
src/csv.js      export
public/         stylesheet, the person-page script, and generated icons
scripts/        password hashing, icon generation
```

Icons are rendered by `node scripts/make-icons.js` from signed distance fields
and committed, so a build never has to run it.

## License

MIT. See [LICENSE](LICENSE).
