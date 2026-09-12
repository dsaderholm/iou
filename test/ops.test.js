'use strict';

// Operational surface: the health probe, the JSON summary, automatic backups,
// the cross-person activity view, and correcting an entry's date.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'iou-ops-'));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, 'iou.db');
process.env.SESSION_SECRET = 'test-secret-not-a-real-one';
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASSWORD_HASH = require('bcryptjs').hashSync('hunter2', 10);
process.env.API_TOKEN = 'test-api-token-abcdef';
process.env.BACKUP_KEEP = '3';
process.env.TZ = 'America/Denver';

const { app } = require('../src/server');
const db = require('../src/db');
const backup = require('../src/backup');
const views = require('../src/views');

db.init();

let server;
let base;
let sessionCookie = '';

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await post('/login', { username: 'admin', password: 'hunter2' }, { cookie: null });
  sessionCookie = res.headers.getSetCookie()
    .find((c) => c.startsWith('iou_session=')).split(';')[0];
});

test.after(() => {
  server.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* windows lock */ }
});

function req(method, url, { body, cookie, headers = {} } = {}) {
  const init = { method, redirect: 'manual', headers: { ...headers } };
  if (cookie !== null) init.headers.cookie = cookie === undefined ? sessionCookie : cookie;
  if (body) {
    init.headers['content-type'] = 'application/x-www-form-urlencoded';
    init.body = new URLSearchParams(body).toString();
  }
  return fetch(base + url, init);
}
const get = (url, opts) => req('GET', url, opts);
const post = (url, body, opts) => req('POST', url, { ...opts, body });

async function addPerson(name) {
  const res = await post('/people', { name });
  return Number(res.headers.get('location').match(/\/p\/(\d+)/)[1]);
}

/* ----------------------------------------------------------------- health */

test('the health probe queries the database, not just the web server', async () => {
  const res = await get('/healthz', { cookie: null });
  assert.equal(res.status, 200, 'must not need a session: the healthcheck has none');

  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.database, 'ok');
  assert.ok(typeof body.uptime_seconds === 'number');

  // It must report a broken database rather than a cheerful 200. This is the
  // whole point: the old probe hit /robots.txt, a static string that keeps
  // being served happily while the data underneath is gone.
  const realPing = db.ping;
  db.ping = () => { throw new Error('database is locked'); };
  try {
    const sick = await get('/healthz', { cookie: null });
    assert.equal(sick.status, 503);
    assert.equal((await sick.json()).database, 'unavailable');
  } finally {
    db.ping = realPing;
  }

  assert.equal((await get('/healthz', { cookie: null })).status, 200, 'and recovers');
});

test('the health probe leaks nothing about the data', async () => {
  await addPerson('Secret Person');
  const body = await (await get('/healthz', { cookie: null })).text();
  assert.doesNotMatch(body, /Secret Person/);
  assert.doesNotMatch(body, /people|balance|count/i);
});

/* -------------------------------------------------------------- JSON API */

test('the summary API needs its own token, not the session', async () => {
  assert.equal((await get('/api/summary.json', { cookie: null })).status, 401);
  // A logged-in browser session is deliberately not enough.
  assert.equal((await get('/api/summary.json')).status, 401);
  assert.equal((await get('/api/summary.json', {
    cookie: null, headers: { 'x-api-key': 'wrong-token' },
  })).status, 401);

  const ok = await get('/api/summary.json', {
    cookie: null, headers: { 'x-api-key': process.env.API_TOKEN },
  });
  assert.equal(ok.status, 200);

  const bearer = await get('/api/summary.json', {
    cookie: null, headers: { authorization: `Bearer ${process.env.API_TOKEN}` },
  });
  assert.equal(bearer.status, 200, 'Bearer works too');
});

test('the summary totals match what the home page shows', async () => {
  const a = await addPerson('Api Owes');
  const b = await addPerson('Api Credit');
  await post(`/p/${a}/entries`, { kind: 'charge', amount: '120.50' });
  await post(`/p/${b}/entries`, { kind: 'payment', amount: '20' });

  const data = await (await get('/api/summary.json', {
    cookie: null, headers: { 'x-api-key': process.env.API_TOKEN },
  })).json();

  const home = await (await get('/')).text();
  const shownOwed = home.match(/Owed to you<\/span><span class="amount owed">([^<]+)</)[1];

  const { formatCents } = require('../src/money');
  assert.equal(formatCents(data.totals.owed_cents), shownOwed,
    'the API and the page must not disagree about what you are owed');

  const owes = data.people.find((p) => p.name === 'Api Owes');
  assert.equal(owes.balance_cents, 12050);
  assert.equal(owes.balance, '120.50');
  assert.equal(owes.negative, false);

  const credit = data.people.find((p) => p.name === 'Api Credit');
  assert.equal(credit.balance_cents, -2000);
  assert.equal(credit.negative, true, 'sign is explicit, since balance is unsigned');
});

test('the summary never hands out share tokens', async () => {
  const id = await addPerson('Token Holder');
  const token = db.getPerson(id).share_token;

  const raw = await (await get('/api/summary.json', {
    cookie: null, headers: { 'x-api-key': process.env.API_TOKEN },
  })).text();

  // A share token is a bearer credential for someone's private page. An
  // integration that only needs balances must never be handed one.
  assert.doesNotMatch(raw, new RegExp(token));
  assert.doesNotMatch(raw, /share_token/);
});

test('archived people are labelled and totalled separately', async () => {
  const id = await addPerson('Api Archived');
  await post(`/p/${id}/entries`, { kind: 'charge', amount: '90' });
  await post(`/p/${id}/archive`);

  const data = await (await get('/api/summary.json', {
    cookie: null, headers: { 'x-api-key': process.env.API_TOKEN },
  })).json();

  const row = data.people.find((p) => p.name === 'Api Archived');
  assert.equal(row.archived, true);
  assert.ok(data.totals.archived_owed_cents >= 9000);
  assert.ok(data.totals.owed_cents >= 0);
});

/* -------------------------------------------------------------- activity */

test('activity shows entries across everyone, newest first', async () => {
  const x = await addPerson('Feed One');
  const y = await addPerson('Feed Two');
  await post(`/p/${x}/entries`, { kind: 'charge', amount: '11', description: 'older thing' });
  await post(`/p/${y}/entries`, { kind: 'charge', amount: '22', description: 'newer thing' });

  const body = await (await get('/activity')).text();
  assert.match(body, /Feed One/);
  assert.match(body, /Feed Two/);
  assert.ok(body.indexOf('newer thing') < body.indexOf('older thing'), 'newest first');
  // Each row links to the tab it landed on, which is how a misfiled charge
  // gets corrected once it is spotted.
  assert.match(body, new RegExp(`href="/p/${y}"`));
});

test('activity hides deleted entries', async () => {
  const id = await addPerson('Feed Deleted');
  await post(`/p/${id}/entries`, { kind: 'charge', amount: '5', description: 'gone-from-feed' });
  const entry = db.listEntries(id)[0];
  await post(`/p/${id}/entries/${entry.id}/delete`);

  assert.doesNotMatch(await (await get('/activity')).text(), /gone-from-feed/);
});

/* ------------------------------------------------------------- entry date */

test('an entry can be moved to an earlier date, keeping its time of day', async () => {
  const id = await addPerson('Backdater');
  await post(`/p/${id}/entries`, { kind: 'charge', amount: '30', description: 'paid Tuesday' });
  const entry = db.listEntries(id)[0];

  const wasLocal = views.localDateInputValue(entry.created_at);
  const target = new Date(Date.parse(`${wasLocal}T00:00:00Z`) - 3 * 86400000)
    .toISOString().slice(0, 10);

  const res = await post(`/p/${id}/entries/${entry.id}/edit`, {
    kind: 'charge', amount: '30', description: 'paid Tuesday', date: target,
  });
  assert.equal(res.status, 303);

  const after = db.listEntries(id)[0];
  assert.equal(views.localDateInputValue(after.created_at), target, 'landed on the chosen day');
  assert.equal(after.created_at.slice(11), entry.created_at.slice(11),
    'time of day is preserved, not invented');
  assert.equal(db.getBalance(id), 3000, 'and the balance is untouched');
});

test('leaving the date alone does not disturb the timestamp', async () => {
  const id = await addPerson('Unmoved');
  await post(`/p/${id}/entries`, { kind: 'charge', amount: '15' });
  const entry = db.listEntries(id)[0];

  await post(`/p/${id}/entries/${entry.id}/edit`, {
    kind: 'charge', amount: '16', description: 'edited',
    date: views.localDateInputValue(entry.created_at),
  });

  const after = db.listEntries(id)[0];
  assert.equal(after.created_at, entry.created_at, 'exactly the same string');
  assert.equal(after.amount, 1600);
});

test('a nonsense or future date is refused and nothing changes', async () => {
  const id = await addPerson('Bad Dates');
  await post(`/p/${id}/entries`, { kind: 'charge', amount: '40' });
  const entry = db.listEntries(id)[0];

  const future = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
  for (const date of ['not-a-date', '1776-07-04', future, '2026-13-45']) {
    const res = await post(`/p/${id}/entries/${entry.id}/edit`, {
      kind: 'charge', amount: '40', date,
    });
    assert.match(res.headers.get('location'), /e=bad_date/, `should refuse ${date}`);
    assert.equal(db.listEntries(id)[0].created_at, entry.created_at, `unchanged for ${date}`);
  }
});

/* --------------------------------------------------------------- backups */

test('a backup is a real database, and old ones are pruned', async () => {
  await addPerson('Backed Up');

  const first = await backup.runOnce();
  assert.ok(fs.existsSync(first.file));

  const bytes = fs.readFileSync(first.file);
  assert.equal(bytes.subarray(0, 15).toString('latin1'), 'SQLite format 3');

  const copy = require('better-sqlite3')(first.file, { readonly: true });
  const names = copy.prepare('SELECT name FROM people').all().map((r) => r.name);
  copy.close();
  assert.ok(names.includes('Backed Up'), 'the snapshot has the data in it');

  // BACKUP_KEEP is 3 for this run; more than that must be pruned away.
  for (let i = 0; i < 5; i++) {
    const name = path.join(backup.DIR, `iou-2020-01-0${i + 1}T0000.db`);
    fs.writeFileSync(name, 'placeholder');
  }
  backup.prune();

  const left = fs.readdirSync(backup.DIR).filter((f) => f.endsWith('.db'));
  assert.equal(left.length, 3, `expected 3 kept, found ${left.join(', ')}`);
  // Pruning keeps the newest by name, and the real one sorts last.
  assert.ok(left.includes(path.basename(first.file)), 'the newest survives');
});

test('the edit form actually renders a date control', async () => {
  const id = await addPerson('Renders Date');
  await post(`/p/${id}/entries`, { kind: 'charge', amount: '12' });
  const entry = db.listEntries(id)[0];

  const page = await (await get(`/p/${id}/entries/${entry.id}/edit`)).text();
  // The POST tests above would all pass with no control on the page at all,
  // which would make backdating a feature only reachable by curl.
  const field = page.replace(/\s+/g, ' ').match(/<input id="edit-date"[^>]*>/);
  assert.ok(field, 'no date input on the edit form');
  assert.match(field[0], /type="date"/);
  assert.match(field[0], /name="date"/);
  assert.match(field[0], new RegExp(`value="${views.localDateInputValue(entry.created_at)}"`));
  assert.match(field[0], /max="/, 'and it should refuse future dates in the picker');
});
