'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Env has to be in place before anything requires ./config, which reads it once.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'iou-test-'));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, 'iou.db');
process.env.SESSION_SECRET = 'test-secret-not-a-real-one';
process.env.ADMIN_USER = 'admin';
// bcrypt hash of "hunter2", cost 10.
process.env.ADMIN_PASSWORD_HASH = require('bcryptjs').hashSync('hunter2', 10);
process.env.VENMO_HANDLE = 'test-venmo';
process.env.CASHAPP_HANDLE = '$test-cash';
process.env.PAYPAL_ME = 'https://paypal.me/test-pp';
process.env.TRUST_PROXY = 'true';

const { app } = require('../src/server');
const db = require('../src/db');
const { parseAmount, formatCents, centsToPlainDecimal } = require('../src/money');
const { entriesToCsv } = require('../src/csv');

db.init();

let server;
let base;

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

/* ------------------------------------------------------------------ helpers */

let sessionCookie = '';

function req(method, url, { body, cookie, headers = {}, redirect = 'manual' } = {}) {
  const init = { method, redirect, headers: { ...headers } };
  if (cookie !== null) init.headers.cookie = cookie === undefined ? sessionCookie : cookie;
  if (body) {
    init.headers['content-type'] = 'application/x-www-form-urlencoded';
    init.body = new URLSearchParams(body).toString();
  }
  return fetch(base + url, init);
}

const get = (url, opts) => req('GET', url, opts);
const post = (url, body, opts) => req('POST', url, { ...opts, body });

async function login() {
  const res = await post('/login', { username: 'admin', password: 'hunter2' }, { cookie: null });
  assert.equal(res.status, 303);
  const raw = res.headers.getSetCookie().find((c) => c.startsWith('iou_session='));
  assert.ok(raw, 'login should set a session cookie');
  sessionCookie = raw.split(';')[0];
  return raw;
}

/** Follow a 303 and return the resulting page body. */
async function followTo(res) {
  const location = res.headers.get('location');
  const page = await get(location);
  return { location, status: page.status, body: await page.text() };
}

async function addPerson(name) {
  const res = await post('/people', { name });
  assert.equal(res.status, 303);
  const id = Number(res.headers.get('location').match(/\/p\/(\d+)/)[1]);
  return id;
}

async function personToken(id) {
  const body = await (await get(`/p/${id}`)).text();
  return body.match(/\/t\/([A-Za-z0-9_-]{16})/)[1];
}

/* -------------------------------------------------------------------- money */

test('parseAmount accepts what a decimal keypad produces', () => {
  assert.deepEqual(parseAmount('12'), { ok: true, cents: 1200 });
  assert.deepEqual(parseAmount('12.3'), { ok: true, cents: 1230 });
  assert.deepEqual(parseAmount('12.34'), { ok: true, cents: 1234 });
  assert.deepEqual(parseAmount('$1,234.56'), { ok: true, cents: 123456 });
  assert.deepEqual(parseAmount('  .07 '), { ok: true, cents: 7 });
  assert.deepEqual(parseAmount('12.'), { ok: true, cents: 1200 });
});

test('parseAmount rejects junk, signs, zero and over-precision', () => {
  for (const bad of ['', '  ', 'abc', '-5', '1e3', '1.2.3', '12.345', '0', '0.00', '.']) {
    assert.equal(parseAmount(bad).ok, false, `${JSON.stringify(bad)} should be rejected`);
  }
  assert.equal(parseAmount('12.345').code, 'decimals');
  assert.equal(parseAmount('0').code, 'zero');
  assert.equal(parseAmount('-5').code, 'format');
});

test('parseAmount never goes through a float', () => {
  // 0.1 and 0.29 are the classic float traps: 0.1*100 = 10.000000000000002.
  assert.equal(parseAmount('0.1').cents, 10);
  assert.equal(parseAmount('0.29').cents, 29);
  assert.equal(parseAmount('1.005').ok, false);
  // d = 0 is skipped on purpose: "0.00" is a zero amount and is rejected.
  for (let d = 1; d < 100; d++) {
    const text = `${d}.${String(d).padStart(2, '0')}`;
    assert.equal(parseAmount(text).cents, d * 100 + d, text);
  }
});

test('formatCents renders US currency with grouping and sign', () => {
  assert.equal(formatCents(0), '$0.00');
  assert.equal(formatCents(5), '$0.05');
  assert.equal(formatCents(123456), '$1,234.56');
  assert.equal(formatCents(100000000), '$1,000,000.00');
  assert.equal(formatCents(-500), '-$5.00');
  assert.equal(centsToPlainDecimal(-1234), '12.34');
});

/* --------------------------------------------------------------------- auth */

test('every admin route requires a session', async () => {
  const paths = ['/', '/p/1', '/export.csv'];
  for (const p of paths) {
    const res = await get(p, { cookie: null });
    assert.equal(res.status, 303, p);
    assert.match(res.headers.get('location'), /^\/login\?next=/, p);
  }
  const posted = await post('/people', { name: 'Mallory' }, { cookie: null });
  assert.equal(posted.status, 401);
});

test('there is no registration route', async () => {
  for (const p of ['/register', '/signup', '/users/new']) {
    const res = await get(p, { cookie: null });
    assert.equal(res.status, 303); // bounced to login, never a signup form
  }
});

test('login rejects wrong credentials and accepts the right ones', async () => {
  const bad = await post('/login', { username: 'admin', password: 'wrong' }, { cookie: null });
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.getSetCookie().length, 0);

  const wrongUser = await post('/login', { username: 'nope', password: 'hunter2' }, { cookie: null });
  assert.equal(wrongUser.status, 401);

  const raw = await login();
  assert.match(raw, /HttpOnly/i);
  assert.match(raw, /SameSite=Lax/i);
  // Not Secure here because the test client speaks plain http.
  assert.doesNotMatch(raw, /Secure/i);
});

test('X-Forwarded-Proto: https marks the cookie Secure, and only that', async () => {
  const res = await post('/login', { username: 'admin', password: 'hunter2' },
    { cookie: null, headers: { 'x-forwarded-proto': 'https' } });
  assert.equal(res.status, 303);
  assert.match(res.headers.getSetCookie()[0], /Secure/i);

  // The same header does not grant a session on its own.
  const spoof = await get('/', {
    cookie: null,
    headers: { 'x-forwarded-proto': 'https', 'x-forwarded-user': 'admin', 'x-remote-user': 'admin' },
  });
  assert.equal(spoof.status, 303);
  assert.match(spoof.headers.get('location'), /^\/login/);
});

test('a tampered session cookie is not a session', async () => {
  const forged = sessionCookie.slice(0, -1) + (sessionCookie.endsWith('a') ? 'b' : 'a');
  const res = await get('/', { cookie: forged });
  assert.equal(res.status, 303);
  assert.match(res.headers.get('location'), /^\/login/);
});

test('the login redirect cannot be pointed off-site', async () => {
  const hostile = [
    '//evil.example/',
    '/\\evil.example/',        // Chrome normalises the backslash to a slash
    'https://evil.example/',
    '\\\\evil.example',
    'javascript:alert(1)',
  ];
  for (const next of hostile) {
    const res = await post('/login',
      { username: 'admin', password: 'hunter2', next }, { cookie: null });
    assert.equal(res.status, 303, next);
    assert.equal(res.headers.get('location'), '/', `next=${next} should be dropped`);
  }

  // A genuine in-app path still round-trips.
  const good = await post('/login',
    { username: 'admin', password: 'hunter2', next: '/p/1?m=x' }, { cookie: null });
  assert.equal(good.headers.get('location'), '/p/1?m=x');
});

test('malformed person ids are 404, not crashes', async () => {
  await login();
  for (const id of ['0', '-1', '1.5', 'abc', '99999999999999999999', '1%20OR%201']) {
    const res = await get(`/p/${id}`);
    assert.equal(res.status, 404, id);
  }
});

test('cross-origin POSTs are refused', async () => {
  const res = await post('/people', { name: 'Evil' }, { headers: { origin: 'https://evil.example' } });
  assert.equal(res.status, 403);
});

/* ------------------------------------------------------------- balance math */

test('a running tab sums charges and payments correctly', async () => {
  await login();
  const id = await addPerson('Balance Check');

  await post(`/p/${id}/entries`, { kind: 'charge', amount: '20', description: 'Dinner' });
  await post(`/p/${id}/entries`, { kind: 'charge', amount: '5.55', description: 'Coffee' });
  await post(`/p/${id}/entries`, { kind: 'payment', amount: '10.05', description: 'Venmo' });

  assert.equal(db.getBalance(id), 2000 + 555 - 1005);
  assert.equal(db.getBalance(id), 1550);

  const body = await (await get(`/p/${id}`)).text();
  assert.match(body, /\$15\.50/);
  // The payment is stored negative and displayed negative.
  assert.match(body, /-\$10\.05/);
});

test('payments are stored as negative entries regardless of what is typed', async () => {
  const id = await addPerson('Sign Check');
  await post(`/p/${id}/entries`, { kind: 'payment', amount: '7.00', description: '' });
  const entries = db.listEntries(id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].amount, -700);
});

test('a balance can go negative when they overpay', async () => {
  const id = await addPerson('Overpayer');
  await post(`/p/${id}/entries`, { kind: 'charge', amount: '10' });
  await post(`/p/${id}/entries`, { kind: 'payment', amount: '25' });
  assert.equal(db.getBalance(id), -1500);
  const body = await (await get(`/p/${id}`)).text();
  assert.match(body, /-\$15\.00/);
  assert.match(body, /you owe them/);
});

test('running balance is cumulative and in chronological order', async () => {
  const id = await addPerson('Running');
  for (const amount of ['1', '2', '3']) {
    await post(`/p/${id}/entries`, { kind: 'charge', amount });
  }
  assert.deepEqual(db.listEntries(id).map((e) => e.running_balance), [100, 300, 600]);
});

test('a bad amount adds nothing and reports why', async () => {
  const id = await addPerson('Rejects');
  const res = await post(`/p/${id}/entries`, { kind: 'charge', amount: '12.345' });
  assert.equal(res.status, 303);
  const { body } = await followTo(res);
  assert.match(body, /at most two decimal places/);
  assert.equal(db.listEntries(id).length, 0);
});

test('deleting an entry corrects the balance', async () => {
  const id = await addPerson('Fat Finger');
  await post(`/p/${id}/entries`, { kind: 'charge', amount: '5' });
  await post(`/p/${id}/entries`, { kind: 'charge', amount: '5000' });
  assert.equal(db.getBalance(id), 500500);

  const typo = db.listEntries(id).find((e) => e.amount === 500000);
  const res = await post(`/p/${id}/entries/${typo.id}/delete`);
  assert.equal(res.status, 303);
  assert.equal(db.getBalance(id), 500);
});

test('an entry cannot be deleted through another person', async () => {
  const a = await addPerson('Owner A');
  const b = await addPerson('Owner B');
  await post(`/p/${a}/entries`, { kind: 'charge', amount: '9' });
  const entry = db.listEntries(a)[0];

  await post(`/p/${b}/entries/${entry.id}/delete`);
  assert.equal(db.getBalance(a), 900, 'entry should survive a cross-person delete');
});

test('people are listed with the biggest debtor first', async () => {
  const body = await (await get('/')).text();
  const order = [...body.matchAll(/class="person-name">([^<]+)</g)].map((m) => m[1]);
  const balances = order.map((name) => {
    const p = db.listPeopleWithBalances().find((x) => x.name === name);
    return p.balance;
  });
  const sorted = [...balances].sort((x, y) => y - x);
  assert.deepEqual(balances, sorted);
});

/* --------------------------------------------------------------- share page */

test('the share page shows only that person, and needs no login', async () => {
  const id = await addPerson('Shared Sam');
  await post(`/p/${id}/entries`, { kind: 'charge', amount: '42.50', description: 'Concert ticket' });
  const token = await personToken(id);

  const res = await get(`/t/${token}`, { cookie: null });
  assert.equal(res.status, 200);
  const body = await res.text();

  assert.match(body, /Shared Sam/);
  assert.match(body, /\$42\.50/);
  assert.match(body, /Concert ticket/);

  // No other person's name, and no way to reach one.
  assert.doesNotMatch(body, /Balance Check|Overpayer|Fat Finger/);
  assert.doesNotMatch(body, /href="\/p\//);
  assert.doesNotMatch(body, /<form/, 'the share page is read-only');
  assert.doesNotMatch(body, /Log out|export/i);
});

test('a bad token is a plain 404, not a hint about the format', async () => {
  const probes = [
    '/t/nope',
    '/t/aaaaaaaaaaaaaaaa',            // right length, wrong value
    '/t/' + 'x'.repeat(200),
    '/t/..%2F..%2Fetc%2Fpasswd',
    '/t/1',
    "/t/' OR 1=1 --",
  ];
  const seen = new Set();
  for (const p of probes) {
    const res = await get(p, { cookie: null });
    assert.equal(res.status, 404, p);
    const body = await res.text();
    assert.doesNotMatch(body, /token/i, p);
    seen.add(body);
  }
  assert.equal(seen.size, 1, 'every bad token gets a byte-identical page');
});

test('the share page sends X-Robots-Tag and robots.txt disallows everything', async () => {
  const id = await addPerson('Robots');
  const token = await personToken(id);
  const res = await get(`/t/${token}`, { cookie: null });
  assert.match(res.headers.get('x-robots-tag'), /noindex/);

  const robots = await get('/robots.txt', { cookie: null });
  assert.equal(robots.status, 200);
  assert.equal(await robots.text(), 'User-agent: *\nDisallow: /\n');
});

test('regenerating a token kills the old link', async () => {
  const id = await addPerson('Rotator');
  const oldToken = await personToken(id);
  assert.equal((await get(`/t/${oldToken}`, { cookie: null })).status, 200);

  const res = await post(`/p/${id}/token`);
  assert.equal(res.status, 303);
  const newToken = await personToken(id);

  assert.notEqual(newToken, oldToken);
  assert.equal(newToken.length, 16);
  assert.equal((await get(`/t/${oldToken}`, { cookie: null })).status, 404);
  assert.equal((await get(`/t/${newToken}`, { cookie: null })).status, 200);
});

test('share tokens are 16 url-safe chars and unique', () => {
  const tokens = new Set();
  for (let i = 0; i < 2000; i++) {
    const t = db.newShareToken();
    assert.match(t, /^[A-Za-z0-9_-]{16}$/);
    tokens.add(t);
  }
  assert.equal(tokens.size, 2000);
});

test('payment links carry the balance, and unset services are omitted', async () => {
  const id = await addPerson('Payer');
  await post(`/p/${id}/entries`, { kind: 'charge', amount: '1234.56' });
  const token = await personToken(id);
  const body = await (await get(`/t/${token}`, { cookie: null })).text();

  assert.match(body, /https:\/\/venmo\.com\/test-venmo\?txn=charge&amp;amount=1234\.56&amp;note=/);
  assert.match(body, /https:\/\/cash\.app\/\$test-cash\/1234\.56/);
  assert.match(body, /https:\/\/paypal\.me\/test-pp\/1234\.56USD/);
});

test('a settled balance shows no payment links', async () => {
  const id = await addPerson('Settled');
  await post(`/p/${id}/entries`, { kind: 'charge', amount: '10' });
  await post(`/p/${id}/entries`, { kind: 'payment', amount: '10' });
  const token = await personToken(id);
  const body = await (await get(`/t/${token}`, { cookie: null })).text();

  assert.match(body, /all settled up/);
  assert.doesNotMatch(body, /venmo\.com/);
  assert.doesNotMatch(body, /cash\.app/);
});

test('names and descriptions are escaped, not rendered', async () => {
  const id = await addPerson('<script>alert(1)</script>');
  await post(`/p/${id}/entries`, {
    kind: 'charge', amount: '1', description: '"><img src=x onerror=alert(2)>',
  });
  const token = await personToken(id);

  for (const [label, body] of [
    ['admin', await (await get(`/p/${id}`)).text()],
    ['share', await (await get(`/t/${token}`, { cookie: null })).text()],
  ]) {
    assert.doesNotMatch(body, /<script>alert\(1\)<\/script>/, label);
    assert.doesNotMatch(body, /<img src=x/, label);
    assert.match(body, /&lt;script&gt;/, label);
  }
});

/* ---------------------------------------------------------------- csv export */

test('CSV export covers every entry and quotes correctly', async () => {
  const res = await get('/export.csv');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="iou-entries-\d{4}-\d{2}-\d{2}\.csv"/);

  const text = await res.text();
  const lines = text.trim().split('\r\n');
  assert.equal(lines[0], 'person_id,person_name,entry_id,created_at_utc,amount_cents,amount_usd,kind,description');
  assert.equal(lines.length - 1, db.allEntriesForExport().length);
  assert.match(text, /"charge"/);
  assert.match(text, /"payment"/);
});

test('CSV escapes quotes, commas and newlines', () => {
  const csv = entriesToCsv([{
    person_id: 1, person_name: 'A, B', id: 9, created_at: '2026-01-01 00:00:00',
    amount: -1234, description: 'he said "hi"\nthen left',
  }]);
  const [, row] = csv.trim().split('\r\n');
  assert.ok(row.includes('"A, B"'));
  assert.ok(row.includes('"he said ""hi""\nthen left"'));
  assert.ok(row.includes('"-12.34"'));
  assert.ok(row.includes('"payment"'));
});

/* -------------------------------------------------------------------- misc */

test('the amount inputs ask Android for the number pad', async () => {
  const id = await addPerson('Keypad');
  const body = await (await get(`/p/${id}`)).text();
  const inputs = body.match(/<input[^>]*name="amount"[^>]*>/g);
  assert.equal(inputs.length, 2, 'a charge field and a payment field');
  for (const input of inputs) {
    assert.match(input, /inputmode="decimal"/);
    assert.match(input, /type="text"/);
  }
});

test('adding a person lands on their page, one tap from a first charge', async () => {
  const res = await post('/people', { name: 'Two Taps' });
  assert.equal(res.status, 303);
  const { status, body } = await followTo(res);
  assert.equal(status, 200);
  assert.match(body, /Add charge/);
  assert.match(body, /Record payment/);
  assert.match(body, /Copy link/);
});

test('logout clears the session', async () => {
  const res = await post('/logout');
  assert.equal(res.status, 303);
  const cleared = res.headers.getSetCookie()[0];
  assert.match(cleared, /^iou_session=;/);
  await login(); // restore for any later test
});
