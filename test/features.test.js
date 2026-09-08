'use strict';

// Covers the second round of work: settle up, entry editing, undo, archiving,
// description autocomplete, the web app manifest, and the database download.
// Runs in its own process with its own database, so nothing here can disturb
// the ordering assumptions in app.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'iou-feat-'));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, 'iou.db');
process.env.SESSION_SECRET = 'test-secret-not-a-real-one';
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASSWORD_HASH = require('bcryptjs').hashSync('hunter2', 10);
process.env.TRUST_PROXY = 'true';

const { app } = require('../src/server');
const db = require('../src/db');

db.init();

let server;
let base;
let sessionCookie = '';

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await login();
});

test.after(() => {
  server.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* windows lock */ }
});

/* ------------------------------------------------------------------ helpers */

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

async function login() {
  const res = await post('/login', { username: 'admin', password: 'hunter2' }, { cookie: null });
  sessionCookie = res.headers.getSetCookie()
    .find((c) => c.startsWith('iou_session=')).split(';')[0];
}

async function addPerson(name) {
  const res = await post('/people', { name });
  return Number(res.headers.get('location').match(/\/p\/(\d+)/)[1]);
}

async function personToken(id) {
  const body = await (await get(`/p/${id}`)).text();
  return body.match(/\/t\/([A-Za-z0-9_-]{16})/)[1];
}

const text = async (res) => await res.text();

/* ---------------------------------------------------------------- settle up */

test('settle up records a payment for exactly the balance', async () => {
  const id = await addPerson('Settler');
  await post(`/p/${id}/entries`, { kind: 'charge', amount: '87.65' });
  await post(`/p/${id}/entries`, { kind: 'charge', amount: '12.35' });
  assert.equal(db.getBalance(id), 10000);

  const res = await post(`/p/${id}/settle`);
  assert.equal(res.status, 303);
  assert.equal(db.getBalance(id), 0, 'the tab lands on zero');

  const last = db.listEntries(id).at(-1);
  assert.equal(last.amount, -10000);
  assert.equal(last.description, 'Settled up');
});

test('settle up reads the balance server-side, not from the rendered page', async () => {
  const id = await addPerson('Stale Page');
  await post(`/p/${id}/entries`, { kind: 'charge', amount: '10' });
  // Something lands after the page the button was on would have been rendered.
  await post(`/p/${id}/entries`, { kind: 'charge', amount: '5' });
  await post(`/p/${id}/settle`);
  assert.equal(db.getBalance(id), 0, 'zero, not left at -$5.00');
});

test('settle up refuses when nothing is owed, and is not offered', async () => {
  const id = await addPerson('Owes Nothing');
  const res = await post(`/p/${id}/settle`);
  assert.match(res.headers.get('location'), /e=nothing_owed/);
  assert.equal(db.listEntries(id).length, 0);
  assert.doesNotMatch(await text(await get(`/p/${id}`)), /Settle up/);
});

/* --------------------------------------------------------------- edit entry */

test('editing an entry changes it without moving it in history', async () => {
  const id = await addPerson('Typo Fixer');
  await post(`/p/${id}/entries`, { kind: 'charge', amount: '5', description: 'first' });
  await post(`/p/${id}/entries`, { kind: 'charge', amount: '999', description: 'tpyo' });
  await post(`/p/${id}/entries`, { kind: 'charge', amount: '7', description: 'third' });

  const target = db.listEntries(id)[1];
  const originalDate = target.created_at;

  const res = await post(`/p/${id}/entries/${target.id}/edit`,
    { kind: 'charge', amount: '9.99', description: 'typo fixed' });
  assert.equal(res.status, 303);

  const after = db.listEntries(id);
  assert.equal(after[1].id, target.id, 'still in the same position');
  assert.equal(after[1].amount, 999);
  assert.equal(after[1].description, 'typo fixed');
  assert.equal(after[1].created_at, originalDate, 'original timestamp kept');
  assert.equal(db.getBalance(id), 500 + 999 + 700);
});

test('editing can flip a charge into a payment', async () => {
  const id = await addPerson('Wrong Direction');
  await post(`/p/${id}/entries`, { kind: 'charge', amount: '40', description: 'oops' });
  const entry = db.listEntries(id)[0];
  assert.equal(db.getBalance(id), 4000);

  await post(`/p/${id}/entries/${entry.id}/edit`,
    { kind: 'payment', amount: '40', description: 'they paid me' });
  assert.equal(db.getBalance(id), -4000);
});

test('editing rejects a bad amount and changes nothing', async () => {
  const id = await addPerson('Bad Edit');
  await post(`/p/${id}/entries`, { kind: 'charge', amount: '20' });
  const entry = db.listEntries(id)[0];

  const res = await post(`/p/${id}/entries/${entry.id}/edit`, { kind: 'charge', amount: '1.234' });
  assert.match(res.headers.get('location'), /e=decimals/);
  assert.equal(db.getBalance(id), 2000);
});

test('an entry cannot be edited through another person', async () => {
  const a = await addPerson('Edit Owner');
  const b = await addPerson('Edit Stranger');
  await post(`/p/${a}/entries`, { kind: 'charge', amount: '11' });
  const entry = db.listEntries(a)[0];

  assert.equal((await post(`/p/${b}/entries/${entry.id}/edit`,
    { kind: 'charge', amount: '1' })).status, 404);
  assert.equal(db.getBalance(a), 1100, 'untouched');
});

/* -------------------------------------------------------------- soft delete */

test('undo brings back a deleted entry with the same amount', async () => {
  const id = await addPerson('Mis Tap');
  await post(`/p/${id}/entries`, { kind: 'charge', amount: '5' });
  await post(`/p/${id}/entries`, { kind: 'charge', amount: '5000' });
  const doomed = db.listEntries(id).find((e) => e.amount === 500000);

  const res = await post(`/p/${id}/entries/${doomed.id}/delete`);
  assert.match(res.headers.get('location'), new RegExp(`undo=${doomed.id}`));
  assert.equal(db.getBalance(id), 500);

  const page = await text(await get(res.headers.get('location')));
  // Assert the Undo sits *inside* the notice, not merely somewhere on the page:
  // a <form> inside a <p> gets hoisted out by the parser and renders orphaned,
  // which a plain "is the URL present" check happily accepts.
  const notice = page.match(/<div class="flash flash-notice"[^>]*>([\s\S]*?)<\/div>/);
  assert.ok(notice, 'the deletion notice should be a div that can hold a form');
  assert.match(notice[1], new RegExp(`/entries/${doomed.id}/restore`),
    'the Undo control belongs inside the notice');

  await post(`/p/${id}/entries/${doomed.id}/restore`);
  assert.equal(db.getBalance(id), 500500);
  assert.equal(db.listEntries(id).length, 2);
});

test('a deleted entry leaves the share page and the CSV', async () => {
  const id = await addPerson('Deleted Rows');
  await post(`/p/${id}/entries`, { kind: 'charge', amount: '10', description: 'keep-me' });
  await post(`/p/${id}/entries`, { kind: 'charge', amount: '20', description: 'zap-me' });
  const doomed = db.listEntries(id).find((e) => e.description === 'zap-me');
  await post(`/p/${id}/entries/${doomed.id}/delete`);

  const share = await text(await get(`/t/${await personToken(id)}`, { cookie: null }));
  assert.match(share, /keep-me/);
  assert.doesNotMatch(share, /zap-me/);
  assert.match(share, /\$10\.00/);

  const csv = await text(await get('/export.csv'));
  assert.match(csv, /keep-me/);
  assert.doesNotMatch(csv, /zap-me/);
});

test('the home list balance drops when an entry is deleted', async () => {
  const id = await addPerson('Listed Balance');
  await post(`/p/${id}/entries`, { kind: 'charge', amount: '100' });
  await post(`/p/${id}/entries`, { kind: 'charge', amount: '900' });

  const rowFor = async (name) => {
    const home = await text(await get('/'));
    // The row's own amount, not any total elsewhere on the page.
    const row = home.match(
      new RegExp(`<span class="person-name">${name}</span>\\s*<span class="amount [a-z]+">([^<]+)<`)
    );
    assert.ok(row, `no row found for ${name}`);
    return row[1];
  };

  assert.equal(await rowFor('Listed Balance'), '$1,000.00');

  const doomed = db.listEntries(id).find((e) => e.amount === 90000);
  await post(`/p/${id}/entries/${doomed.id}/delete`);

  // Regression guard: the deleted_at test must be inside the JOIN. Without it
  // the list keeps totalling hidden rows and shows $1,000.00 forever.
  assert.equal(await rowFor('Listed Balance'), '$100.00');
});

test('deleting every entry leaves the person on the list at zero', async () => {
  const id = await addPerson('Emptied');
  await post(`/p/${id}/entries`, { kind: 'charge', amount: '3' });
  const only = db.listEntries(id)[0];
  await post(`/p/${id}/entries/${only.id}/delete`);

  // Regression guard: if the deleted_at test moved from the JOIN to a WHERE,
  // this person would vanish from the list entirely.
  const home = await text(await get('/'));
  assert.match(home, /Emptied/);
  assert.equal(db.getBalance(id), 0);
});

/* ------------------------------------------------------------------ archive */

test('archiving hides someone from the list and its totals', async () => {
  const id = await addPerson('Archive Me');
  await post(`/p/${id}/entries`, { kind: 'charge', amount: '250' });

  assert.match(await text(await get('/')), /Archive Me/);
  await post(`/p/${id}/archive`);

  const home = await text(await get('/'));
  assert.doesNotMatch(home, /Archive Me/, 'gone from the main list');
  assert.match(home, /Archived \(\d+\)/, 'but the count is visible');

  const archived = await text(await get('/archived'));
  assert.match(archived, /Archive Me/);
  assert.match(archived, /\$250\.00/);

  // History survives, which is the whole point of archive over delete.
  assert.equal(db.getBalance(id), 25000);
});

test('an archived share link still works, and unarchiving restores the row', async () => {
  const id = await addPerson('Round Trip');
  await post(`/p/${id}/entries`, { kind: 'charge', amount: '5' });
  const token = await personToken(id);
  await post(`/p/${id}/archive`);

  assert.equal((await get(`/t/${token}`, { cookie: null })).status, 200);

  await post(`/p/${id}/unarchive`);
  assert.match(await text(await get('/')), /Round Trip/);
});

/* ------------------------------------------------------------- autocomplete */

test('past descriptions are offered, split by charge and payment', async () => {
  const id = await addPerson('Repeat Buyer');
  await post(`/p/${id}/entries`, { kind: 'charge', amount: '9', description: 'Gas money' });
  await post(`/p/${id}/entries`, { kind: 'payment', amount: '4', description: 'Venmo transfer' });

  const body = await text(await get(`/p/${id}`));
  const charges = body.match(/<datalist id="charge-history">(.*?)<\/datalist>/s)[1];
  const payments = body.match(/<datalist id="payment-history">(.*?)<\/datalist>/s)[1];

  assert.match(charges, /Gas money/);
  assert.doesNotMatch(charges, /Venmo transfer/,
    'a payment note must not suggest itself on a charge');
  assert.match(payments, /Venmo transfer/);
  assert.doesNotMatch(payments, /Gas money/);
});

test('a suggestion with quotes in it is escaped, not injected', async () => {
  const id = await addPerson('Quoter');
  await post(`/p/${id}/entries`,
    { kind: 'charge', amount: '1', description: '"><script>alert(1)</script>' });

  const body = await text(await get(`/p/${id}`));
  assert.doesNotMatch(body, /<script>alert\(1\)<\/script>/);
  assert.match(body, /&quot;&gt;&lt;script&gt;/);
});

/* ---------------------------------------------------------------------- PWA */

test('the web app manifest is public and well formed', async () => {
  const res = await get('/manifest.webmanifest', { cookie: null });
  assert.equal(res.status, 200, 'behind auth, the install prompt would never appear');
  assert.match(res.headers.get('content-type'), /manifest\+json/);

  const manifest = JSON.parse(await res.text());
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'), 'needs a maskable icon');

  for (const icon of manifest.icons) {
    const img = await get(icon.src, { cookie: null });
    assert.equal(img.status, 200, icon.src);
    const bytes = Buffer.from(await img.arrayBuffer());
    assert.equal(bytes.subarray(1, 4).toString('latin1'), 'PNG', `${icon.src} is a real PNG`);
    const [w, h] = icon.sizes.split('x').map(Number);
    assert.equal(bytes.readUInt32BE(16), w, `${icon.src} width`);
    assert.equal(bytes.readUInt32BE(20), h, `${icon.src} height`);
  }
});

test('the CSP allows the manifest to load', async () => {
  const csp = (await get('/login', { cookie: null })).headers.get('content-security-policy');
  // Under default-src 'none' an omitted manifest-src silently blocks install.
  assert.match(csp, /manifest-src 'self'/);
});

test('admin pages link the manifest and the share page does not', async () => {
  const id = await addPerson('Manifest Check');
  assert.match(await text(await get(`/p/${id}`)), /rel="manifest"/);

  const share = await text(await get(`/t/${await personToken(id)}`, { cookie: null }));
  assert.doesNotMatch(share, /rel="manifest"/,
    'a friend should not be offered an app icon leading to a login form');
});

/* -------------------------------------------------------------- db download */

test('the database download is a real, openable SQLite file', async () => {
  const res = await get('/export.db');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'),
    /attachment; filename="iou-\d{4}-\d{2}-\d{2}\.db"/);

  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(bytes.subarray(0, 15).toString('latin1'), 'SQLite format 3');

  const copyPath = path.join(TMP, 'downloaded.db');
  fs.writeFileSync(copyPath, bytes);
  const copy = require('better-sqlite3')(copyPath, { readonly: true });
  const people = copy.prepare('SELECT COUNT(*) AS n FROM people').get().n;
  const withTokens = copy.prepare(
    "SELECT COUNT(*) AS n FROM people WHERE share_token <> ''"
  ).get().n;
  copy.close();

  assert.ok(people > 0, 'the backup contains the data');
  assert.equal(withTokens, people, 'share tokens included, so it can be restored');
});

test('the database download needs a session', async () => {
  const res = await get('/export.db', { cookie: null });
  assert.equal(res.status, 303);
  assert.match(res.headers.get('location'), /^\/login/);
});

/* ----------------------------------------------------------- login throttle */

test('a guessing address locks itself out without locking out the owner', async () => {
  const attacker = { 'x-forwarded-for': '203.0.113.66' };
  const owner = { 'x-forwarded-for': '198.51.100.9' };

  for (let i = 0; i < 10; i++) {
    await post('/login', { username: 'admin', password: `guess-${i}` },
      { cookie: null, headers: attacker });
  }

  assert.equal(
    (await post('/login', { username: 'admin', password: 'hunter2' },
      { cookie: null, headers: attacker })).status,
    429, 'the guessing address is throttled');

  assert.equal(
    (await post('/login', { username: 'admin', password: 'hunter2' },
      { cookie: null, headers: owner })).status,
    303, 'a different address is unaffected');
});

/* ------------------------------------------------ archiving discloses money */

test('archiving someone who owes asks first, naming the amount', async () => {
  const id = await addPerson('Still Owes');
  await post(`/p/${id}/entries`, { kind: 'charge', amount: '250' });

  const page = await text(await get(`/p/${id}`));
  const form = page.match(/<form method="post" action="\/p\/\d+\/archive"[\s\S]*?>/);
  assert.ok(form, 'the archive form should be present');
  assert.match(form[0], /data-confirm="/, 'it must ask before hiding a balance');
  assert.match(form[0], /\$250\.00/, 'and say how much is at stake');
  assert.match(form[0], /Owed to you/, 'and name the consequence');
});

test('archiving a settled person asks nothing', async () => {
  const id = await addPerson('All Square');
  await post(`/p/${id}/entries`, { kind: 'charge', amount: '10' });
  await post(`/p/${id}/entries`, { kind: 'payment', amount: '10' });

  const page = await text(await get(`/p/${id}`));
  const form = page.match(/<form method="post" action="\/p\/\d+\/archive"[\s\S]*?>/);
  assert.ok(form);
  assert.doesNotMatch(form[0], /data-confirm/, 'nothing is at stake, so no dialog');
});

test('unarchiving never asks', async () => {
  const id = await addPerson('Coming Back');
  await post(`/p/${id}/entries`, { kind: 'charge', amount: '75' });
  await post(`/p/${id}/archive`);

  const page = await text(await get(`/p/${id}`));
  const form = page.match(/<form method="post" action="\/p\/\d+\/unarchive"[\s\S]*?>/);
  assert.ok(form);
  assert.doesNotMatch(form[0], /data-confirm/);
});

test('the home page names archived money instead of dropping it', async () => {
  const id = await addPerson('Hidden Debt');
  await post(`/p/${id}/entries`, { kind: 'charge', amount: '410' });

  const before = await text(await get('/'));
  const owedBefore = before.match(/Owed to you<\/span><span class="amount owed">([^<]+)</)[1];
  const archivedBefore = db.archivedSummary().owed;

  await post(`/p/${id}/archive`);

  const after = await text(await get('/'));
  const owedAfter = after.match(/Owed to you<\/span><span class="amount owed">([^<]+)</)[1];
  const archivedAfter = db.archivedSummary().owed;

  // The headline total legitimately drops: archived people are not active.
  assert.notEqual(owedAfter, owedBefore);
  // The same money moves into the archived figure, penny for penny.
  assert.equal(archivedAfter - archivedBefore, 41000);

  // And that figure must be stated on the page, not silently gone. This is the
  // second layer, and the one that still works with JavaScript off, when the
  // confirm() dialog does not.
  const { formatCents } = require('../src/money');
  assert.ok(
    after.includes(`${formatCents(archivedAfter)} owed, not counted above`),
    `home page should name ${formatCents(archivedAfter)} as archived and uncounted`
  );
});

test('archived credit is not reported as money owed', async () => {
  const id = await addPerson('Overpaid Then Left');
  await post(`/p/${id}/entries`, { kind: 'payment', amount: '30' });
  await post(`/p/${id}/archive`);

  const summary = db.archivedSummary();
  assert.ok(summary.count > 0);
  // A negative balance is a credit, not something owed; it must not net off
  // against another archived person's debt either.
  assert.ok(summary.owed >= 0, 'owed is a sum of debts, never a net');
});

/* ------------------------------------------------------- session lifetime */

test('a login lasts a year, not a month', async () => {
  const res = await post('/login', { username: 'admin', password: 'hunter2' }, { cookie: null });
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('iou_session='));
  const maxAge = Number(cookie.match(/Max-Age=(\d+)/i)[1]);

  const days = maxAge / 86400;
  assert.ok(days > 300, `expected roughly a year, got ${Math.round(days)} days`);
});
