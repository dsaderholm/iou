'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');

const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const views = require('./views');
const { parseAmount, centsToPlainDecimal } = require('./money');
const { entriesToCsv } = require('./csv');
const backup = require('./backup');
const sure = require('./sure');

const app = express();

// The reverse proxy in front of this app terminates TLS, so X-Forwarded-Proto
// is what tells us whether to mark the cookie Secure. Login identity is never
// read from a proxy header. The client address used for login throttling is,
// which is why this trusts a fixed number of proxy hops rather than every
// entry: see parseTrustProxy in config.js.
app.set('trust proxy', config.trustProxy);
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
  sure_added: 'Added to the tab.',
  sure_dismissed: 'Dismissed. It will not come back from Sure.',
  sure_updated: "Updated to match Sure.",
  sure_kept: 'Kept as it is on the tab.',
  sure_removed: 'Removed from the tab.',
  sure_detached: 'Kept on the tab, no longer tracked in Sure.',
  sure_synced: 'Checked Sure.',
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
  bad_date: 'Use a real date, today or earlier.',
  sure_unknown: 'That item is no longer in the list.',
  sure_not_pending: 'That item was already handled.',
  sure_person_required: 'Pick who owes it, or type a new name.',
  sure_sync_failed: 'Could not read Sure. The reason is below.',
};

// Own properties only. A plain lookup resolves ?m=constructor to the Object
// function and ?e=__proto__ to Object.prototype, both truthy, and prints them.
const lookup = (table, key) => (typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : '');
const notice = (req) => lookup(NOTICES, req.query.m);
const errorMsg = (req) => lookup(ERRORS, req.query.e);

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
// Express 5 leaves req.body undefined when a request has no form body at all.
// Every handler reads fields off it, so a bare POST -- curl, a crawler, a
// one-button form -- threw a TypeError and came back as a 500 instead of the
// ordinary 401 or validation message.
app.use((req, res, next) => {
  if (req.body === undefined) req.body = {};
  next();
});
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

/**
 * Liveness for the container healthcheck. It reads the database file, so an
 * unreadable or corrupt database reports 503 instead of the web server looking
 * healthy on its own. It cannot detect a /data volume that failed to mount:
 * that is indistinguishable from a first install, which is why startup logs a
 * warning whenever it creates a new database.
 *
 * Public, because the healthcheck has no session, and it reveals nothing: no
 * counts, no names, no balances.
 */
app.get('/healthz', (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    if (!db.ping()) throw new Error('database did not answer');
    res.json({ status: 'ok', database: 'ok', uptime_seconds: Math.round(process.uptime()) });
  } catch (err) {
    console.error(`[iou] healthz failed: ${err.message}`);
    res.status(503).json({ status: 'error', database: 'unavailable' });
  }
});

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

/**
 * Read-only JSON for dashboards and finance tools.
 *
 * Its own bearer token, not the session cookie: this is for scripts, and the
 * admin session should not be something you paste into another service. With
 * API_TOKEN unset the route does not exist at all, so turning it off is the
 * default rather than an option.
 *
 * Share tokens are deliberately absent from the payload. They are bearer
 * credentials for somebody's private page, and an integration has no business
 * holding them.
 */
app.get('/api/summary.json', (req, res) => {
  if (!config.apiToken) return notFound(res);

  const offered = (req.get('x-api-key') || '')
    || (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!timingSafeEqual(offered, config.apiToken)) {
    return res.status(401).set('Cache-Control', 'no-store')
      .json({ error: 'unauthorized' });
  }

  const active = db.listPeopleWithBalances();
  const archived = db.listArchivedPeople();
  const summary = db.archivedSummary();

  const shape = (p, isArchived) => ({
    id: p.id,
    name: p.name,
    balance_cents: p.balance,
    balance: centsToPlainDecimal(p.balance),
    negative: p.balance < 0,
    entry_count: p.entry_count,
    archived: isArchived,
  });

  res.set('Cache-Control', 'no-store').json({
    generated_at: new Date().toISOString(),
    currency: 'USD',
    totals: {
      // Matches the home page exactly: active people only.
      owed_cents: active.reduce((sum, p) => sum + (p.balance > 0 ? p.balance : 0), 0),
      net_cents: active.reduce((sum, p) => sum + p.balance, 0),
      archived_owed_cents: summary.owed,
      people: active.length,
      archived_people: summary.count,
    },
    people: [
      ...active.map((p) => shape(p, false)),
      ...archived.map((p) => shape(p, true)),
    ],
  });
});

/** Constant-time string compare that does not leak length through timing. */
function timingSafeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

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
  // Bound the map, dropping the oldest records first. Clearing the whole map
  // would let anyone who rotates past the cap wipe every active lockout,
  // including the one on the address they are guessing from.
  const excess = failuresByIp.size - 10000;
  if (excess > 0) {
    let dropped = 0;
    for (const ip of failuresByIp.keys()) {
      if (dropped++ >= excess) break;
      failuresByIp.delete(ip);
    }
  }
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
    // The address, never the username: people type passwords into the wrong
    // box. Also the quickest way to confirm TRUST_PROXY is right behind proxies:
    // this should show your own public address, not Cloudflare's or the proxy's.
    console.warn(`[iou] failed login from ${req.ip}`);
    return html(res, views.loginPage({ nextUrl, error: 'Wrong username or password.' }), 401);
  }

  clearLoginFailures(req);
  auth.setSessionCookie(req, res, config.adminUser);
  res.redirect(303, nextUrl);
});

/**
 * Ends this session on the server, not just in this browser. Clearing the
 * cookie alone left any copy of it valid until it expired.
 */
app.post('/logout', (req, res) => {
  if (req.session && req.session.sid) {
    try { db.revokeSession(req.session.sid); } catch { /* cookie still goes */ }
  }
  auth.clearSessionCookie(req, res);
  res.redirect(303, '/login');
});

/* ------------------------------------------------------- everything else is */
/* ------------------------------------------------------- behind the session */

app.use(auth.requireAuth);

app.get('/', (req, res) => {
  html(res, views.homePage({
    people: db.listPeopleWithBalances(),
    archived: db.archivedSummary(),
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
    sureEntryIds: config.sureEnabled ? db.sureEntryIds(person.id) : new Set(),
  }));
});

app.get('/activity', (req, res) => {
  html(res, views.activityPage({
    entries: db.recentActivity(100),
    notice: notice(req),
    error: errorMsg(req),
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

  const movedTo = shiftedCreatedAt(entry.created_at, req.body.date);
  if (movedTo === false) return res.redirect(303, `/p/${person.id}/entries/${entry.id}/edit?e=bad_date`);

  db.updateEntry(person.id, entry.id, amount, description, movedTo);
  res.redirect(303, `/p/${person.id}?m=entry_updated`);
});

/**
 * Work out the new created_at when the date field has been changed.
 *
 * Returns null to leave the timestamp alone, false if the input is unusable,
 * or a "YYYY-MM-DD HH:MM:SS" UTC string.
 *
 * It moves the stored timestamp by whole days rather than rebuilding it, which
 * keeps the time of day the entry was recorded at. Across a daylight saving
 * boundary the displayed time shifts by an hour; that is a better trade than
 * inventing a time the entry never had.
 */
function shiftedCreatedAt(currentCreatedAt, submitted) {
  const wanted = String(submitted == null ? '' : submitted).trim();
  if (!wanted) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(wanted)) return false;

  const currentLocal = views.localDateInputValue(currentCreatedAt);
  if (wanted === currentLocal) return null;

  const target = Date.parse(`${wanted}T00:00:00Z`);
  const origin = Date.parse(`${currentLocal}T00:00:00Z`);
  if (Number.isNaN(target) || Number.isNaN(origin)) return false;

  // Date.parse rolls impossible dates forward -- 2026-02-30 becomes March 2 --
  // so a date is only real if it survives the round trip unchanged.
  if (new Date(target).toISOString().slice(0, 10) !== wanted) return false;

  // Not after today in the server's own zone: the same "today" the date picker
  // uses as its maximum, and the one the error message promises.
  const today = views.localDateInputValue(new Date().toISOString().replace('T', ' ').slice(0, 19));
  if (wanted > today || wanted < '2000-01-01') return false;

  const shifted = new Date(Date.parse(`${currentCreatedAt.replace(' ', 'T')}Z`) + (target - origin));
  if (Number.isNaN(shifted.getTime())) return false;
  return shifted.toISOString().replace('T', ' ').slice(0, 19);
}

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

/* ----------------------------------------------------------- Sure inbox */

/** Every /sure route 404s when the integration is not configured. */
function sureOnly(req, res, next) {
  if (!config.sureEnabled) return notFound(res);
  next();
}

/** Sure ids from the URL, refused before they reach the database. */
function sureIdParam(req) {
  const id = String(req.params.sureId || '');
  return sure.SURE_ID.test(id) ? id : null;
}

app.get('/sure', sureOnly, (req, res) => {
  html(res, views.surePage({
    pending: db.listSurePending(),
    changed: db.listSureChanged(),
    gone: db.listSureGone(),
    people: db.listPeopleForMatching(),
    status: sure.status,
    category: config.sureCategory,
    autoAdd: config.sureAutoAdd,
    notice: notice(req),
    error: errorMsg(req),
  }));
});

app.post('/sure/sync', sureOnly, async (req, res) => {
  const result = await sure.syncOnce();
  res.redirect(303, result && result.error ? '/sure?e=sure_sync_failed' : '/sure?m=sure_synced');
});

/**
 * One handler per action, all shaped the same: validate the id, act, and go
 * back to the inbox with a message. Nothing here reaches Sure; Sure is only
 * ever read.
 */
const sureAction = (action, done) => (req, res) => {
  const id = sureIdParam(req);
  if (!id) return res.redirect(303, '/sure?e=sure_unknown');
  // Express 5 leaves req.body undefined when a request carries no form body,
  // which a one-button form such as "Use Sure's" does not. Reading a field off
  // it would throw and turn the tap into a 500.
  const outcome = action(id, req.body || {});
  res.redirect(303, outcome.ok ? `/sure?m=${done}` : `/sure?e=${outcome.code}`);
};

app.post('/sure/items/:sureId/add', sureOnly, sureAction((id, body) => sure.addItem(id, {
  personId: parseId(body.person_id),
  newPersonName: body.new_person,
  amount: body.amount,
  description: body.description,
}), 'sure_added'));

app.post('/sure/items/:sureId/dismiss', sureOnly, sureAction((id) => sure.dismissItem(id), 'sure_dismissed'));
app.post('/sure/items/:sureId/accept', sureOnly, sureAction((id, body) => sure.acceptChange(id, {
  amount: body.amount,
}), 'sure_updated'));
app.post('/sure/items/:sureId/keep', sureOnly, sureAction((id) => sure.keepTabValue(id), 'sure_kept'));
app.post('/sure/items/:sureId/remove', sureOnly, sureAction((id) => sure.removeGone(id), 'sure_removed'));
app.post('/sure/items/:sureId/keep-gone', sureOnly, sureAction((id) => sure.keepGone(id), 'sure_detached'));

/** For a lost phone or a browser you no longer control. */
app.post('/logout-all', (req, res) => {
  db.revokeAllSessions();
  auth.clearSessionCookie(req, res);
  res.redirect(303, '/login');
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

async function start() {
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

  // Order matters here. The snapshot that exists to survive a bad upgrade has
  // to be taken before this version's migrations run. Opening the file,
  // backing it up, and only then applying the schema is what makes the
  // "pre-upgrade" backup mean what it says.
  const existed = fs.existsSync(db.DB_PATH);
  db.open();

  if (existed && config.backupEnabled) {
    try {
      const { file } = await backup.runOnce('pre-upgrade');
      console.log(`[iou] backup ${path.basename(file)} taken before migrations`);
    } catch (err) {
      // Keep starting: current migrations only add columns, and refusing to
      // boot on a full disk would take the whole app down over a backup.
      console.error(`[iou] pre-upgrade backup FAILED, migrating anyway: ${err.message}`);
    }
  }

  db.ensureSchema();

  if (!existed) {
    // A missing volume and a first install look identical from inside the
    // container: an empty directory. Nothing can tell them apart, so say it
    // plainly where it will be seen instead of reporting healthy in silence.
    console.warn(`[iou] created a NEW, EMPTY database at ${db.DB_PATH}.`);
    console.warn('[iou] Expected on a first install. If this instance already had data,');
    console.warn('[iou] the /data volume is not mounted: stop before adding entries.');
  }

  const server = app.listen(config.port, () => {
    console.log(`[iou] listening on :${config.port}  db=${db.DB_PATH}`);
    if (config.apiToken) console.log('[iou] JSON summary enabled at /api/summary.json');
  });

  const stopBackups = backup.start();
  const stopSure = sure.start();
  server.on('close', () => {
    stopBackups();
    stopSure();
  });

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}

if (require.main === module) {
  start().catch((err) => {
    console.error('[iou] failed to start:', err);
    process.exit(1);
  });
}

module.exports = { app, start };
