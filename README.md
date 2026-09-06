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

## Quick start

```bash
cp .env.example .env
```

Put a username and a password hash in `.env`:

```bash
docker compose run --rm iou node scripts/hash-password.js 'your password'
```

Paste the output as `ADMIN_PASSWORD_HASH`, keeping the single quotes around it.
Then:

```bash
docker compose up -d --build
```

It listens on port 3000 and keeps its database in the `iou-data` volume at
`/data/iou.db`.

### Without Docker

```bash
npm install
npm run hash-password -- 'your password'
DATA_DIR=./data ADMIN_USER=me ADMIN_PASSWORD_HASH='...' npm start
```

`npm run dev` reads `.env` automatically and restarts on file changes.

## Environment variables

| Variable | Required | Default | What it does |
| --- | --- | --- | --- |
| `ADMIN_USER` | yes | — | The one login name. There is no registration route. |
| `ADMIN_PASSWORD_HASH` | yes | — | bcrypt hash from `npm run hash-password`. Single-quote it in `.env`. |
| `SESSION_SECRET` | no | generated | Signs the session cookie. Left unset, a random secret is written to `/data/session_secret` on first run and reused. |
| `VENMO_HANDLE` | no | — | Adds a Venmo button to the share page. Unset means no button. |
| `PAYPAL_ME` | no | — | Adds a PayPal button. |
| `CASHAPP_HANDLE` | no | — | Adds a Cash App button. |
| `SITE_TITLE` | no | `IOU` | Shown in the admin header. |
| `OWNER_NAME` | no | — | Share page reads "you owe to `<name>`". |
| `PUBLIC_BASE_URL` | no | from request | The address people actually use, e.g. `https://iou.example.com`. Only needed if your proxy rewrites `Host`. |
| `TZ` | no | `UTC` | Timestamps are stored in UTC and displayed in this zone. |
| `PORT` | no | `3000` | Port inside the container. |
| `DATA_DIR` | no | `/data` | Where the database and generated secret live. |
| `SESSION_TTL_SECONDS` | no | 30 days | How long a login lasts. |
| `TRUST_PROXY` | no | `true` | Passed to Express `trust proxy`. Set `false` if not behind a proxy. |

Payment handles accept a bare handle or a full profile URL; the extra parts are
trimmed off.

## Using it

**Home** lists everyone with their current balance, largest debt first, plus the
total owed to you. Adding a person takes a name and drops you straight onto
their page, so adding someone and charging them is one continuous motion.

**A person's page** has the balance, an *Add charge* form and a *Record payment*
form side by side at the top, the share link with a one-tap copy button, and the
full history with a running balance beside every entry. A payment is stored as a
negative entry on the same tab — there are no separate loans or invoices.

Amounts accept anything a phone keypad or a paste produces: `12`, `12.5`,
`12.34`, `$1,234.56`. More than two decimal places is rejected rather than
rounded, so a typo is visible instead of silent. The form decides the sign, not
the text you type.

**CSV** in the header exports every entry for every person, with `amount_cents`
as the authoritative column and a signed `amount_usd` for spreadsheets.

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

Everything is in the volume: `iou.db` plus the generated `session_secret`.

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
token regeneration, HTML escaping, and the CSV export.

## Layout

```
src/server.js   routes and middleware
src/db.js       SQLite schema and queries
src/auth.js     password check, signed session cookie
src/money.js    cents parsing and formatting
src/views.js    HTML
src/csv.js      export
public/         stylesheet and the person-page script
```
