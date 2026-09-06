'use strict';

const path = require('node:path');
const express = require('express');

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
};

const ERRORS = {
  empty: 'Enter an amount.',
  format: 'Enter a dollar amount like 12.34',
  decimals: 'Amounts can have at most two decimal places.',
  too_large: 'That amount is too large.',
  zero: 'Enter an amount greater than zero.',
  name_required: 'A name is required.',
  not_found: 'That entry no longer exists.',
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
    "form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
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

// One admin, so a single global window is enough to blunt password guessing.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 20;
let loginFailures = 0;
let loginWindowStart = Date.now();

function loginBlocked() {
  if (Date.now() - loginWindowStart > LOGIN_WINDOW_MS) {
    loginFailures = 0;
    loginWindowStart = Date.now();
  }
  return loginFailures >= LOGIN_MAX_FAILURES;
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

  if (loginBlocked()) {
    return html(res, views.loginPage({
      nextUrl,
      error: 'Too many attempts. Wait a few minutes and try again.',
    }), 429);
  }

  const ok = await auth.checkCredentials(req.body.username, req.body.password);
  if (!ok) {
    loginFailures += 1;
    return html(res, views.loginPage({ nextUrl, error: 'Wrong username or password.' }), 401);
  }

  loginFailures = 0;
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

  const removed = db.deleteEntry(person.id, entryId);
  res.redirect(303, `/p/${person.id}?${removed ? 'm=entry_deleted' : 'e=not_found'}`);
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

/* ------------------------------------------------------------ 404 / errors */

app.use((req, res) => notFound(res));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[iou]', err);
  if (res.headersSent) return res.end();
  html(res, views.errorPage(), 500);
});

/* ------------------------------------------------------------------- start */

function start() {
  const problems = [];
  if (!config.adminUser) problems.push('ADMIN_USER is not set');
  if (!config.adminPasswordHash) problems.push('ADMIN_PASSWORD_HASH is not set');

  if (problems.length) {
    console.error('[iou] refusing to start: ' + problems.join(', '));
    console.error("[iou] generate a hash with: npm run hash-password -- 'your password'");
    process.exit(1);
  }

  // Fail loudly on a malformed hash rather than letting every login fail with
  // no explanation. The overwhelmingly common cause is a hash pasted into a
  // compose file without doubling its dollar signs, so name that directly.
  if (!auth.looksLikeBcryptHash(config.adminPasswordHash)) {
    console.error('[iou] refusing to start: ADMIN_PASSWORD_HASH is not a valid bcrypt hash.');
    console.error(`[iou] got: ${JSON.stringify(config.adminPasswordHash)}`);
    if (!config.adminPasswordHash.startsWith('$2')) {
      console.error('[iou] it should start with "$2b$". If you put it straight into a');
      console.error('[iou] compose file, docker compose ate the dollar signs: write them');
      console.error('[iou] doubled, as $$2b$$12$$... , or move it into an env_file.');
    }
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
