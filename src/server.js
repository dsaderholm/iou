'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const bcrypt = require('bcryptjs');

const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const views = require('./views');
const { parseAmount } = require('./money');
const { entriesToCsv } = require('./csv');

const app = express();

// The reverse proxy in front of this app terminates TLS, so X-Forwarded-Proto
// is what tells us whether to mark the cookie Secure. It decides transport
// only. Nothing about identity is ever read from a proxy header.
const TRUST_PROXY = process.env.TRUST_PROXY || 'true';
app.set('trust proxy', TRUST_PROXY === 'false' ? false : TRUST_PROXY === 'true' ? true : TRUST_PROXY);
app.set('x-powered-by', false);
app.set('etag', false);

/* --------------------------------------------------------------- messages */

// Flash text lives here, not in the query string, so nothing user-supplied is
// ever reflected back into a page.
const NOTICES = {
  person_added: 'Person added.',
  charge_added: 'Charge added.',
  payment_added: 'Payment recorded.',
  entry_deleted: 'Entry deleted.',
  token_regenerated: 'New share link generated. The old link no longer works.',
  renamed: 'Name updated.',
  person_deleted: 'Person deleted.',
  entry_restored: 'Entry restored.',
  entry_updated: 'Entry updated.',
  settled: 'Settled up.',
  archived: 'Archived.',
  unarchived: 'Moved back to the main list.',
};

const ERRORS = {
  empty: 'Enter an amount.',
  format: 'Enter a dollar amount like 12.34',
  decimals: 'Amounts can have at most two decimal places.',
  too_large: 'That amount is too large.',
  zero: 'Enter an amount greater than zero.',
  name_required: 'A name is required.',
  not_found: 'That entry no longer exists.',
  nothing_owed: 'Nothing to settle: they do not owe anything.',
};

const notice = (req) => NOTICES[req.query.m] || '';
const errorMsg = (req) => ERRORS[req.query.e] || '';

/* -------------------------------------------------------------- middleware */

app.use((req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Keeps the share token out of the Referer sent to Venmo/PayPal/Cash App:
  // cross-origin requests carry no referrer at all under this policy.
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; " +
    // manifest-src is required explicitly: under default-src 'none' the
    // browser blocks the manifest fetch and never offers to install the app.
    "manifest-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
  );
  next();
});

app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.use(auth.attachSession);

/**
 * Same-origin check for state-changing requests.
 *
 * The real CSRF defense is SameSite=Lax on the session cookie: a cross-site
 * POST never carries the cookie, so a forged request arrives with no session
 * and gets a 401 from requireAuth. This check is a second layer, and it only
 * fires on positive evidence of a cross-origin post -- an Origin header that
 * is present, parseable, and names a different host.
 *
 * A missing or opaque ("null") Origin is treated as no evidence rather than as
 * an attack. Some embeddings (sandboxed frames, preview panes, privacy modes)
 * send "null" on perfectly ordinary same-origin form posts, and rejecting it
 * would lock a legitimate user out of every form without adding protection
 * that SameSite=Lax is not already providing.
 */
app.use((req, res, next) => {
  if (req.method !== 'POST') return next();
  const origin = req.get('origin');
  if (!origin || origin === 'null') return next();

  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    return next(); // unparseable: no evidence either way
  }

  if (allowedHosts(req).includes(originHost)) return next();

  // Nearly always a proxy that rewrites Host without setting X-Forwarded-Host.
  // Say so, because the symptom (every form 403s) does not point at the cause.
  console.warn(
    `[iou] rejected POST ${req.path}: Origin host "${originHost}" matches none of ` +
    `${JSON.stringify(allowedHosts(req))}. If this app is behind a proxy, forward ` +
    'the original Host, or set PUBLIC_BASE_URL to the address people actually use.'
  );
  return res.status(403).type('text/plain').send('Bad origin');
});

/**
 * Host names this app legitimately answers to: the configured public URL, the
 * host the proxy says the client asked for, and the raw Host header.
 */
function allowedHosts(req) {
  const hosts = [];
  const configured = (process.env.PUBLIC_BASE_URL || '').trim();
  if (configured) {
    try { hosts.push(new URL(configured).host); } catch { /* ignore a bad value */ }
  }
  const forwarded = req.get('x-forwarded-host');
  if (forwarded) hosts.push(forwarded.split(',')[0].trim());
  const host = req.get('host');
  if (host) hosts.push(host);
  return hosts.filter(Boolean);
}

app.use(express.static(path.join(__dirname, '..', 'public'), {
  maxAge: '1h',
  index: false,
  redirect: false,
  dotfiles: 'ignore',
}));

/* ----------------------------------------------------------------- helpers */

function baseUrl(req) {
  const configured = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  return `${req.protocol}://${req.get('host')}`;
}

function html(res, markup, status = 200) {
  res.status(status).type('html').set('Cache-Control', 'no-store').send(markup);
}

function notFound(res) {
  html(res, views.notFoundPage(), 404);
}

/**
 * Route params are strings; only a clean positive integer is a real id.
 * Capped at 15 digits so the result is always a safe integer.
 */
function parseId(raw) {
  if (!/^[1-9]\d{0,14}$/.test(String(raw))) return null;
  return Number(raw);
}

function trimName(raw) {
  return String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim().slice(0, 80);
}

/* ------------------------------------------------------------ public routes */

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').set('Cache-Control', 'public, max-age=86400')
    .send('User-agent: *\nDisallow: /\n');
});

/**
 * Served rather than static because the title is configurable. Public because
 * a manifest is fetched without credentials: behind the session gate it would
 * redirect to the login form and the install prompt would never appear.
 */
app.get('/manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json').set('Cache-Control', 'public, max-age=3600').send(JSON.stringify({
    name: config.siteTitle,
    short_name: config.siteTitle,
    description: 'Who owes you what.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#f6f6f4',
    theme_color: '#1f6f4a',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }, null, 2));
});

/**
 * The one unauthenticated view. A wrong token gets the same plain 404 as any
 * other unknown path: no hint about token length, alphabet, or existence.
 */
app.get('/t/:token', (req, res) => {
  const person = db.getPersonByToken(String(req.params.token));
  if (!person) return notFound(res);

  const entries = db.listEntries(person.id);
  const balance = entries.length ? entries[entries.length - 1].running_balance : 0;
  html(res, views.sharePage({ person, entries, balance }));
});

/* ------------------------------------------------------------------- login */

/*
 * Login throttling.
 *
 * Per-IP first, so a stranger guessing passwords locks themselves out and not
 * the one person who actually uses this. The global counter is a backstop for
 * a spread-out attack: with `trust proxy` on, the client-facing IP comes from
 * X-Forwarded-For and an attacker upstream could rotate it, which would slip
 * past a per-IP limit alone. It is set high enough that ordinary fat-fingering
 * never reaches it.
 */
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const PER_IP_MAX_FAILURES = 10;
const GLOBAL_MAX_FAILURES = 100;

const failuresByIp = new Map();
let globalFailures = 0;
let globalWindowStart = Date.now();

function pruneThrottle(now) {
  if (now - globalWindowStart > LOGIN_WINDOW_MS) {
    globalFailures = 0;
    globalWindowStart = now;
  }
  for (const [ip, record] of failuresByIp) {
    if (now - record.start > LOGIN_WINDOW_MS) failuresByIp.delete(ip);
  }
  // Never let an attacker grow this without bound by rotating addresses.
  if (failuresByIp.size > 10000) failuresByIp.clear();
}

function loginBlocked(req) {
  const now = Date.now();
  pruneThrottle(now);
  const record = failuresByIp.get(req.ip);
  if (record && record.count >= PER_IP_MAX_FAILURES) return true;
  return globalFailures >= GLOBAL_MAX_FAILURES;
}

function noteLoginFailure(req) {
  const now = Date.now();
  const record = failuresByIp.get(req.ip);
  if (record && now - record.start <= LOGIN_WINDOW_MS) record.count += 1;
  else failuresByIp.set(req.ip, { count: 1, start: now });
  globalFailures += 1;
}

function clearLoginFailures(req) {
  failuresByIp.delete(req.ip);
}

/**
 * Only allow redirects back into this app, never to another site.
 *
 * The second character matters as much as the first: "//evil.example" is
 * protocol-relative, and Chrome normalises a backslash to a slash, so
 * "/\evil.example" leaves as an off-site redirect too.
 */
function safeNext(raw) {
  const value = String(raw == null ? '' : raw);
  if (value === '/') return '/';
  if (!/^\/[^/\\]/.test(value)) return '/';
  return value;
}

app.get('/login', (req, res) => {
  if (req.session) return res.redirect(303, '/');
  html(res, views.loginPage({ nextUrl: safeNext(req.query.next), error: '' }));
});

app.post('/login', async (req, res) => {
  const nextUrl = safeNext(req.body.next);

  if (loginBlocked(req)) {
    return html(res, views.loginPage({
      nextUrl,
      error: 'Too many attempts. Wait a few minutes and try again.',
    }), 429);
  }

  const ok = await auth.checkCredentials(req.body.username, req.body.password);
  if (!ok) {
    noteLoginFailure(req);
    return html(res, views.loginPage({ nextUrl, error: 'Wrong username or password.' }), 401);
  }

  clearLoginFailures(req);
  auth.setSessionCookie(req, res, config.adminUser);
  res.redirect(303, nextUrl);
});

app.post('/logout', (req, res) => {
  auth.clearSessionCookie(req, res);
  res.redirect(303, '/login');
});

/* ------------------------------------------------------- everything else is */
/* ------------------------------------------------------- behind the session */

app.use(auth.requireAuth);

app.get('/', (req, res) => {
  html(res, views.homePage({
    people: db.listPeopleWithBalances(),
    archivedCount: db.countArchived(),
    notice: notice(req),
    error: errorMsg(req),
  }));
});

app.post('/people', (req, res) => {
  const name = trimName(req.body.name);
  if (!name) return res.redirect(303, '/?e=name_required');
  const id = db.createPerson(name);
  // Straight to the new person's page: adding someone and charging them is one
  // continuous motion.
  res.redirect(303, `/p/${id}?m=person_added`);
});

app.get('/p/:id', (req, res) => {
  const id = parseId(req.params.id);
  const person = id && db.getPerson(id);
  if (!person) return notFound(res);

  const entries = db.listEntries(person.id);
  const balance = entries.length ? entries[entries.length - 1].running_balance : 0;

  html(res, views.personPage({
    person,
    entries,
    balance,
    shareUrl: `${baseUrl(req)}/t/${person.share_token}`,
    chargeSuggestions: db.recentDescriptions(person.id, false),
    paymentSuggestions: db.recentDescriptions(person.id, true),
    notice: notice(req),
    error: errorMsg(req),
    undoEntryId: parseId(req.query.undo),
  }));
});

app.get('/archived', (req, res) => {
  html(res, views.archivedPage({
    people: db.listArchivedPeople(),
    notice: notice(req),
    error: errorMsg(req),
  }));
});

app.post('/p/:id/entries', (req, res) => {
  const id = parseId(req.params.id);
  const person = id && db.getPerson(id);
  if (!person) return notFound(res);

  const parsed = parseAmount(req.body.amount);
  if (!parsed.ok) return res.redirect(303, `/p/${person.id}?e=${parsed.code}`);

  // The form decides the sign, never the typed text: a payment is stored as a
  // negative entry, a charge as a positive one.
  const isPayment = req.body.kind === 'payment';
  const amount = isPayment ? -parsed.cents : parsed.cents;
  const description = String(req.body.description == null ? '' : req.body.description)
    .trim().slice(0, 200);

  db.addEntry(person.id, amount, description);
  res.redirect(303, `/p/${person.id}?m=${isPayment ? 'payment_added' : 'charge_added'}`);
});

app.post('/p/:id/entries/:entryId/delete', (req, res) => {
  const id = parseId(req.params.id);
  const entryId = parseId(req.params.entryId);
  const person = id && db.getPerson(id);
  if (!person || !entryId) return notFound(res);

  // Soft delete, so the redirect can carry an Undo for the row just hidden.
  const removed = db.softDeleteEntry(person.id, entryId);
  res.redirect(303, removed
    ? `/p/${person.id}?m=entry_deleted&undo=${entryId}`
    : `/p/${person.id}?e=not_found`);
});

app.post('/p/:id/entries/:entryId/restore', (req, res) => {
  const id = parseId(req.params.id);
  const entryId = parseId(req.params.entryId);
  const person = id && db.getPerson(id);
  if (!person || !entryId) return notFound(res);

  const restored = db.restoreEntry(person.id, entryId);
  res.redirect(303, `/p/${person.id}?${restored ? 'm=entry_restored' : 'e=not_found'}`);
});

app.get('/p/:id/entries/:entryId/edit', (req, res) => {
  const id = parseId(req.params.id);
  const entryId = parseId(req.params.entryId);
  const person = id && db.getPerson(id);
  const entry = person && entryId && db.getEntry(person.id, entryId);
  if (!person || !entry) return notFound(res);

  html(res, views.editEntryPage({ person, entry, error: errorMsg(req) }));
});

app.post('/p/:id/entries/:entryId/edit', (req, res) => {
  const id = parseId(req.params.id);
  const entryId = parseId(req.params.entryId);
  const person = id && db.getPerson(id);
  const entry = person && entryId && db.getEntry(person.id, entryId);
  if (!person || !entry) return notFound(res);

  const parsed = parseAmount(req.body.amount);
  if (!parsed.ok) {
    return res.redirect(303, `/p/${person.id}/entries/${entry.id}/edit?e=${parsed.code}`);
  }

  const amount = req.body.kind === 'payment' ? -parsed.cents : parsed.cents;
  const description = String(req.body.description == null ? '' : req.body.description)
    .trim().slice(0, 200);

  db.updateEntry(person.id, entry.id, amount, description);
  res.redirect(303, `/p/${person.id}?m=entry_updated`);
});

/**
 * Record a payment for exactly what is owed. The balance is read here rather
 * than trusted from the form, so the tab always lands on zero even if it moved
 * since the page was rendered.
 */
app.post('/p/:id/settle', (req, res) => {
  const id = parseId(req.params.id);
  const person = id && db.getPerson(id);
  if (!person) return notFound(res);

  const balance = db.getBalance(person.id);
  if (balance <= 0) return res.redirect(303, `/p/${person.id}?e=nothing_owed`);

  db.addEntry(person.id, -balance, 'Settled up');
  res.redirect(303, `/p/${person.id}?m=settled`);
});

app.post('/p/:id/archive', (req, res) => {
  const id = parseId(req.params.id);
  const person = id && db.getPerson(id);
  if (!person) return notFound(res);
  db.setArchived(person.id, true);
  res.redirect(303, '/?m=archived');
});

app.post('/p/:id/unarchive', (req, res) => {
  const id = parseId(req.params.id);
  const person = id && db.getPerson(id);
  if (!person) return notFound(res);
  db.setArchived(person.id, false);
  res.redirect(303, `/p/${person.id}?m=unarchived`);
});

app.post('/p/:id/rename', (req, res) => {
  const id = parseId(req.params.id);
  const person = id && db.getPerson(id);
  if (!person) return notFound(res);

  const name = trimName(req.body.name);
  if (!name) return res.redirect(303, `/p/${person.id}?e=name_required`);
  db.renamePerson(person.id, name);
  res.redirect(303, `/p/${person.id}?m=renamed`);
});

app.post('/p/:id/token', (req, res) => {
  const id = parseId(req.params.id);
  const person = id && db.getPerson(id);
  if (!person) return notFound(res);

  db.regenerateToken(person.id);
  res.redirect(303, `/p/${person.id}?m=token_regenerated`);
});

app.post('/p/:id/delete', (req, res) => {
  const id = parseId(req.params.id);
  const person = id && db.getPerson(id);
  if (!person) return notFound(res);

  db.deletePerson(person.id);
  res.redirect(303, '/?m=person_deleted');
});

app.get('/export.csv', (req, res) => {
  const stamp = new Date().toISOString().slice(0, 10);
  res.status(200)
    .type('text/csv; charset=utf-8')
    .set('Cache-Control', 'no-store')
    .set('Content-Disposition', `attachment; filename="iou-entries-${stamp}.csv"`)
    .send(entriesToCsv(db.allEntriesForExport()));
});

/**
 * A consistent copy of the whole database, for backups.
 *
 * Goes through SQLite's backup API into a temp file rather than streaming the
 * live file: with WAL enabled the .db on its own is missing whatever is still
 * in the write-ahead log, so a naive copy can restore short of where you were.
 * Unlike the CSV this includes share tokens, so it can actually be restored.
 */
app.get('/export.db', async (req, res, next) => {
  const stamp = new Date().toISOString().slice(0, 10);
  const tmp = path.join(os.tmpdir(), `iou-backup-${process.pid}-${Date.now()}.db`);
  try {
    await db.backupTo(tmp);
    res.set('Cache-Control', 'no-store')
      .set('Content-Disposition', `attachment; filename="iou-${stamp}.db"`)
      .type('application/octet-stream')
      .sendFile(tmp, (err) => {
        fs.rm(tmp, { force: true }, () => {});
        if (err && !res.headersSent) next(err);
      });
  } catch (err) {
    fs.rm(tmp, { force: true }, () => {});
    next(err);
  }
});

/* ------------------------------------------------------------ 404 / errors */

app.use((req, res) => notFound(res));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[iou]', err);
  if (res.headersSent) return res.end();
  html(res, views.errorPage(), 500);
});

/* ------------------------------------------------------------------- start */

function start() {
  if (!config.adminUser) {
    console.error('[iou] refusing to start: ADMIN_USER is not set.');
    process.exit(1);
  }

  if (config.adminPasswordHash) {
    // Fail loudly on a malformed hash rather than letting every login fail with
    // no explanation. The overwhelmingly common cause is a hash pasted into a
    // compose file without doubling its dollar signs, so name that directly.
    if (!auth.looksLikeBcryptHash(config.adminPasswordHash)) {
      console.error('[iou] refusing to start: ADMIN_PASSWORD_HASH is not a valid bcrypt hash.');
      console.error(`[iou] got: ${JSON.stringify(config.adminPasswordHash)}`);
      if (!config.adminPasswordHash.startsWith('$2')) {
        console.error('[iou] it should start with "$2b$". If you put it straight into a');
        console.error('[iou] compose file, docker compose ate the dollar signs: write them');
        console.error('[iou] doubled as $$2b$$12$$... , or just use ADMIN_PASSWORD instead');
        console.error('[iou] and let the app do the hashing.');
      }
      process.exit(1);
    }
  } else if (config.adminPassword) {
    // Hash the plaintext once, here, so nothing downstream ever sees it. The
    // password still sits in the compose file, which is the tradeoff for not
    // having to run a command to deploy.
    config.adminPasswordHash = bcrypt.hashSync(config.adminPassword, 12);
    console.warn('[iou] using ADMIN_PASSWORD; it is stored in plaintext wherever you');
    console.warn("[iou] set it. To avoid that, run: npm run hash-password -- 'pw'");
    console.warn('[iou] and set ADMIN_PASSWORD_HASH instead.');
  } else {
    console.error('[iou] refusing to start: set ADMIN_PASSWORD (simplest) or');
    console.error('[iou] ADMIN_PASSWORD_HASH (no plaintext in your config).');
    process.exit(1);
  }

  db.init();
  const server = app.listen(config.port, () => {
    console.log(`[iou] listening on :${config.port}  db=${db.DB_PATH}`);
  });

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}

if (require.main === module) start();

module.exports = { app, start };
