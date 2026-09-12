'use strict';

// The Sure review inbox, tested against a fake Sure that answers with the JSON
// shapes Sure's own source renders:
//   app/views/api/v1/transactions/_transaction.json.jbuilder
//   app/views/api/v1/transactions/index.json.jbuilder
//   app/views/api/v1/categories/index.json.jbuilder
// There is no real Sure reachable from here, so the fake is the contract. If
// Sure changes its JSON, these tests keep passing and the real sync breaks --
// which is why the sync reports shape problems loudly instead of guessing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'iou-sure-'));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, 'iou.db');
process.env.SESSION_SECRET = 'sure-test-secret';
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASSWORD_HASH = require('bcryptjs').hashSync('hunter2', 10);
process.env.SURE_API_KEY = 'test-sure-key';
process.env.SURE_LOOKBACK_DAYS = '60';
process.env.TZ = 'America/Denver';
delete process.env.SURE_URL; // set on config once the fake is listening

const { app } = require('../src/server');
const config = require('../src/config');
const db = require('../src/db');
const sure = require('../src/sure');
const views = require('../src/views');

db.init();

const OWED = 'cat-owed-0000-4000-8000-000000000001';
const FOOD = 'cat-food-0000-4000-8000-000000000002';

/* --------------------------------------------------------------- fake Sure */

const fake = { categories: [], txns: [], mode: null, hits: [] };

function paged(res, key, rows, url) {
  const asked = Number(url.searchParams.get('per_page'));
  const per = asked >= 1 && asked <= 100 ? asked : (asked > 100 ? 100 : 25);
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const body = { [key]: rows.slice((page - 1) * per, page * per) };
  if (fake.mode !== 'nopagination') {
    body.pagination = {
      page, per_page: per, total_count: rows.length,
      total_pages: Math.max(1, Math.ceil(rows.length / per)),
    };
  }
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const fakeServer = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fake');
  fake.hits.push({ path: url.pathname, query: url.searchParams, key: req.headers['x-api-key'] });
  const json = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  if (req.headers['x-api-key'] !== 'test-sure-key') {
    return json(401, { error: 'unauthorized', message: 'Access token or API key is invalid, expired, or missing' });
  }
  if (fake.mode === 'html') {
    res.writeHead(403, { 'content-type': 'text/html; charset=UTF-8' });
    return res.end('<!DOCTYPE html><title>Just a moment...</title>');
  }
  if (fake.mode === '500') return json(500, { error: 'internal_server_error' });

  if (url.pathname === '/api/v1/categories') return paged(res, 'categories', fake.categories, url);
  if (url.pathname === '/api/v1/transactions') {
    const cats = url.searchParams.getAll('category_ids[]');
    const start = url.searchParams.get('start_date');
    const rows = fake.txns
      .filter((t) => !cats.length || (t.category && cats.includes(t.category.id)))
      .filter((t) => !start || t.date >= start)
      .sort((a, b) => b.date.localeCompare(a.date));
    return paged(res, 'transactions', rows, url);
  }
  return json(404, { error: 'not_found' });
});

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

/** A transaction exactly as Sure's jbuilder partial renders one. */
function txn({
  id = uuid(), date, cents, classification = 'expense', name = '', notes = null,
  merchant = null, category = OWED, currency = 'USD',
}) {
  return {
    id,
    date,
    // Localized display string. Deliberately wrong here, to prove it is never read.
    amount: '$9,999.99',
    amount_cents: cents,
    signed_amount_cents: classification === 'income' ? cents : -cents,
    currency,
    name,
    notes,
    external_id: null,
    source: null,
    user_modified: true,
    classification,
    account: { id: 'acct-1', name: 'Everyday Checking', account_type: 'depository' },
    category: category ? { id: category, name: category === OWED ? 'Owed to me' : 'Food', color: '#e99537', icon: 'circle' } : null,
    merchant: merchant ? { id: 'merchant-1', name: merchant } : null,
    tags: [],
    transfer: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

/** A date n days ago, in the server's zone. */
function daysAgo(n) {
  const d = new Date(Date.now() - n * 86400000);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/* --------------------------------------------------------------- app client */

let base;
let server;
let cookie = '';

test.before(async () => {
  await new Promise((r) => fakeServer.listen(0, '127.0.0.1', r));
  config.sureUrl = `http://127.0.0.1:${fakeServer.address().port}`;

  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const res = await req('POST', '/login', { body: { username: 'admin', password: 'hunter2' }, auth: false });
  cookie = res.headers.getSetCookie().find((c) => c.startsWith('iou_session=')).split(';')[0];
});

test.after(() => {
  server.close();
  fakeServer.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* windows lock */ }
});

function req(method, url, { body, auth = true } = {}) {
  const init = { method, redirect: 'manual', headers: {} };
  if (auth) init.headers.cookie = cookie;
  if (body) {
    init.headers['content-type'] = 'application/x-www-form-urlencoded';
    init.body = new URLSearchParams(body).toString();
  }
  return fetch(base + url, init);
}
const page = async (url) => (await req('GET', url)).text();

/** A clean slate: no Sure items, and a fake Sure with just the two categories. */
function reset() {
  db.handle.exec('DELETE FROM sure_items');
  fake.categories = [{ id: OWED, name: 'Owed to me' }, { id: FOOD, name: 'Food' }];
  fake.txns = [];
  fake.mode = null;
  fake.hits = [];
  config.sureAutoAdd = false;
}

function person(name) {
  return db.createPerson(name);
}

const item = (id) => db.getSureItem(id);

/* ---------------------------------------------------------------- tests */

test('with no Sure configured, the inbox does not exist', async () => {
  const saved = config.sureUrl;
  config.sureUrl = null;
  try {
    assert.equal((await req('GET', '/sure')).status, 404);
    assert.doesNotMatch(await page('/'), /From Sure/);
  } finally {
    config.sureUrl = saved;
  }
});

test('Owed-to-me transactions arrive in the inbox and touch no balance', async () => {
  reset();
  const who = person('Inbox Ivy');
  const t = txn({ date: daysAgo(3), cents: 4200, name: 'Inbox Ivy', merchant: 'Hardware Hut' });
  fake.txns = [t, txn({ date: daysAgo(3), cents: 999, name: 'Lunch', category: FOOD })];

  const result = await sure.syncOnce();
  assert.equal(result.error, undefined, result.error);

  assert.equal(item(t.id).status, 'pending');
  assert.equal(db.listSurePending().length, 1, 'only the Owed to me transaction, not Food');
  assert.equal(db.getBalance(who), 0, 'nothing reaches a balance until it is added');

  const sent = fake.hits.find((h) => h.path === '/api/v1/transactions');
  assert.deepEqual(sent.query.getAll('category_ids[]'), [OWED], 'asks Sure for that one category');
  assert.ok(sent.query.get('start_date'), 'with a date window');
});

test('amounts come from amount_cents and classification, never the display string', async () => {
  reset();
  const spent = txn({ date: daysAgo(2), cents: 12345, name: 'Spent' });
  const received = txn({ date: daysAgo(2), cents: 6000, classification: 'income', name: 'Received' });
  fake.txns = [spent, received];
  await sure.syncOnce();

  assert.equal(item(spent.id).amount_cents, 12345, 'an expense is a charge: positive');
  assert.equal(item(received.id).amount_cents, -6000, 'income is a payment: negative');
  // The fake's `amount` string says $9,999.99 on both. It must have been ignored.
});

test('the Sure API key is sent as X-Api-Key and never shown on the page', async () => {
  reset();
  fake.txns = [txn({ date: daysAgo(1), cents: 100, name: 'Key check' })];
  await sure.syncOnce();

  assert.ok(fake.hits.length > 0);
  for (const hit of fake.hits) assert.equal(hit.key, 'test-sure-key');

  const html = await page('/sure');
  assert.doesNotMatch(html, /test-sure-key/);
});

test('people are matched by full name from a split part name or from notes', () => {
  const people = [
    { id: 1, name: 'Marcus Webb' },
    { id: 2, name: 'Tyler Brooks' },
    { id: 3, name: 'Tyler Nguyen' },
    { id: 4, name: 'Aunt Rosalie' },
    { id: 5, name: 'Josue Nunez' },
  ];
  const s = (name, notes) => sure.suggestPerson([name, notes], people);

  assert.deepEqual(s('Marcus Webb', ''), { personId: 1, confident: true }, 'a split part named for them');
  assert.deepEqual(s('HOME DEPOT #4410', 'marcus webb, half'), { personId: 1, confident: true }, 'a note');
  assert.deepEqual(s('Josué Núñez', ''), { personId: 5, confident: true }, 'accents do not matter');
  assert.deepEqual(s('Marcus', ''), { personId: 1, confident: false }, 'a unique first name is only a guess');
  assert.deepEqual(s('Tyler', ''), { personId: null, confident: false }, 'two Tylers: no guess at all');
  assert.deepEqual(s('Rent', ''), { personId: null, confident: false });
  assert.deepEqual(s('Marcusville Storage', ''), { personId: null, confident: false }, 'whole words only');
});

test('adding posts it on the Sure date, with the merchant as description', async () => {
  reset();
  const who = person('Adding Adam');
  const t = txn({ date: daysAgo(5), cents: 8800, name: 'Adding Adam', merchant: 'Cabin Rentals' });
  fake.txns = [t];
  await sure.syncOnce();

  const res = await req('POST', `/sure/items/${t.id}/add`, {
    body: { person_id: who, amount: '88.00', description: 'Cabin Rentals' },
  });
  assert.equal(res.status, 303);
  assert.match(res.headers.get('location'), /m=sure_added/);

  assert.equal(item(t.id).status, 'added');
  assert.equal(db.getBalance(who), 8800);
  const entry = db.listEntries(who)[0];
  assert.equal(entry.description, 'Cabin Rentals');
  assert.equal(views.localDateInputValue(entry.created_at), t.date, 'dated the day it happened in Sure');
});

test('the amount can be changed before adding, and someone new created on the spot', async () => {
  reset();
  const t = txn({ date: daysAgo(4), cents: 9000, name: 'Group dinner' });
  const refund = txn({ date: daysAgo(4), cents: 2500, classification: 'income', name: 'Venmo' });
  fake.txns = [t, refund];
  await sure.syncOnce();

  // Only a third of the $90 dinner is theirs.
  await req('POST', `/sure/items/${t.id}/add`, {
    body: { person_id: '', new_person: 'Brand New Bea', amount: '30', description: 'Dinner' },
  });
  const bea = db.listPeopleForMatching().find((p) => p.name === 'Brand New Bea');
  assert.ok(bea, 'the person was created');
  assert.equal(db.getBalance(bea.id), 3000, 'the typed share, not the whole bill');

  // A typed amount on a payment stays a payment.
  await req('POST', `/sure/items/${refund.id}/add`, { body: { person_id: bea.id, amount: '20' } });
  assert.equal(db.getBalance(bea.id), 1000);
});

test('adding needs a person, and a double tap only adds once', async () => {
  reset();
  const who = person('Double Tap Dan');
  const t = txn({ date: daysAgo(2), cents: 1500, name: 'Something' });
  fake.txns = [t];
  await sure.syncOnce();

  const none = await req('POST', `/sure/items/${t.id}/add`, { body: { person_id: '' } });
  assert.match(none.headers.get('location'), /e=sure_person_required/);
  assert.equal(item(t.id).status, 'pending');

  const [a, b] = await Promise.all([
    req('POST', `/sure/items/${t.id}/add`, { body: { person_id: who } }),
    req('POST', `/sure/items/${t.id}/add`, { body: { person_id: who } }),
  ]);
  const locations = [a, b].map((r) => r.headers.get('location'));
  assert.equal(locations.filter((l) => /sure_added/.test(l)).length, 1, 'exactly one succeeds');
  assert.equal(db.listEntries(who).length, 1);
  assert.equal(db.getBalance(who), 1500);
});

test('a dismissed transaction never comes back', async () => {
  reset();
  const t = txn({ date: daysAgo(2), cents: 700, name: 'Not an IOU after all' });
  fake.txns = [t];
  await sure.syncOnce();

  await req('POST', `/sure/items/${t.id}/dismiss`);
  await sure.syncOnce();
  await sure.syncOnce();

  assert.equal(item(t.id).status, 'dismissed');
  assert.equal(db.listSurePending().length, 0);
});

test('editing a split in Sure flags the old part and offers the new ones, changing no balance', async () => {
  reset();
  const who = person('Resplit Rex');
  const oldPart = txn({ date: daysAgo(6), cents: 12000, name: 'Resplit Rex' });
  fake.txns = [oldPart];
  await sure.syncOnce();
  await req('POST', `/sure/items/${oldPart.id}/add`, { body: { person_id: who } });
  assert.equal(db.getBalance(who), 12000);

  // Sure's split editor deletes the parts and recreates them under new ids.
  const newPart = txn({ date: daysAgo(6), cents: 10000, name: 'Resplit Rex' });
  fake.txns = [newPart];

  await sure.syncOnce();
  assert.equal(item(oldPart.id).gone_at, null, 'one missed read is not enough to call it gone');

  await sure.syncOnce();
  assert.ok(item(oldPart.id).gone_at, 'gone after two reads in a row');
  assert.equal(item(newPart.id).status, 'pending', 'the new part waits for review');
  assert.equal(db.getBalance(who), 12000, 'and nothing moved on its own: no double count, no silent change');

  const inbox = await page('/sure');
  assert.match(inbox, /No longer in Sure/);

  await req('POST', `/sure/items/${oldPart.id}/remove`);
  await req('POST', `/sure/items/${newPart.id}/add`, { body: { person_id: who } });
  assert.equal(db.getBalance(who), 10000, 'resolved to exactly the new share');
});

test('keeping a gone item leaves it on the tab and stops tracking it', async () => {
  reset();
  const who = person('Keeper Kim');
  const t = txn({ date: daysAgo(3), cents: 5000, name: 'Keeper Kim' });
  fake.txns = [t];
  await sure.syncOnce();
  await req('POST', `/sure/items/${t.id}/add`, { body: { person_id: who } });

  fake.txns = [];
  await sure.syncOnce();
  await sure.syncOnce();
  await req('POST', `/sure/items/${t.id}/keep-gone`);

  assert.equal(item(t.id).status, 'detached');
  assert.equal(db.getBalance(who), 5000);
  assert.doesNotMatch(await page('/sure'), /No longer in Sure/);
});

test('an unreviewed item that disappears from Sure quietly leaves the inbox', async () => {
  reset();
  const t = txn({ date: daysAgo(2), cents: 300, name: 'Vanishing' });
  fake.txns = [t];
  await sure.syncOnce();
  fake.txns = [];
  await sure.syncOnce();
  assert.ok(item(t.id), 'still there after one missed read');
  await sure.syncOnce();
  assert.equal(item(t.id), undefined, 'gone after two, with nothing to undo');
});

test('a change in Sure after adding is flagged, then taken or declined', async () => {
  reset();
  const who = person('Changing Chen');
  const t = txn({ date: daysAgo(8), cents: 6000, name: 'Changing Chen' });
  fake.txns = [t];
  await sure.syncOnce();
  await req('POST', `/sure/items/${t.id}/add`, { body: { person_id: who } });

  fake.txns = [{ ...t, amount_cents: 4500, signed_amount_cents: -4500, date: daysAgo(7) }];
  await sure.syncOnce();

  assert.equal(db.listSureChanged().length, 1);
  assert.equal(db.getBalance(who), 6000, 'flagged, not rewritten');

  await req('POST', `/sure/items/${t.id}/accept`);
  assert.equal(db.getBalance(who), 4500);
  assert.equal(views.localDateInputValue(db.listEntries(who)[0].created_at), daysAgo(7), 'date follows too');
  assert.equal(db.listSureChanged().length, 0);

  fake.txns = [{ ...t, amount_cents: 1, signed_amount_cents: -1, date: daysAgo(7) }];
  await sure.syncOnce();
  await req('POST', `/sure/items/${t.id}/keep`);
  assert.equal(db.getBalance(who), 4500, 'keeping the tab value leaves it alone');
  assert.equal(db.listSureChanged().length, 0);
});

test('a change in Sure never replaces a typed share with the whole total', async () => {
  reset();
  const who = person('Share Shelby');
  const dinner = txn({ date: daysAgo(9), cents: 9000, name: 'Group dinner' });
  fake.txns = [dinner];
  await sure.syncOnce();

  // Only a third of the $90 dinner is theirs.
  await req('POST', `/sure/items/${dinner.id}/add`, { body: { person_id: who, amount: '30' } });
  assert.equal(db.getBalance(who), 3000);

  // The dinner is corrected to $120 in Sure.
  fake.txns = [{ ...dinner, amount_cents: 12000, signed_amount_cents: -12000, date: daysAgo(8) }];
  await sure.syncOnce();
  assert.equal(db.listSureChanged().length, 1);

  const card = await page('/sure');
  assert.match(card, /Their share on the tab is <strong>\$30\.00<\/strong>/, 'the card knows it is a share');
  assert.match(card, /value="40\.00"/, 'and suggests the same third of the new total');

  // Accepting without typing a share keeps the share and moves only the date.
  await req('POST', `/sure/items/${dinner.id}/accept`);
  assert.equal(db.getBalance(who), 3000, 'never silently becomes the $120 total');
  assert.equal(views.localDateInputValue(db.listEntries(who)[0].created_at), daysAgo(8));

  // A later change, accepted with the suggested share typed in.
  fake.txns = [{ ...dinner, amount_cents: 15000, signed_amount_cents: -15000, date: daysAgo(8) }];
  await sure.syncOnce();
  await req('POST', `/sure/items/${dinner.id}/accept`, { body: { amount: '50' } });
  assert.equal(db.getBalance(who), 5000);
});

test('a failed read never counts anything as missing', async () => {
  for (const mode of ['500', 'html']) {
    reset();
    const who = person(`Outage ${mode}`);
    const t = txn({ date: daysAgo(3), cents: 2000, name: `Outage ${mode}` });
    fake.txns = [t];
    await sure.syncOnce();
    await req('POST', `/sure/items/${t.id}/add`, { body: { person_id: who } });

    fake.mode = mode;
    for (let i = 0; i < 3; i++) {
      const r = await sure.syncOnce();
      assert.ok(r.error, `${mode}: should report an error`);
    }
    assert.equal(item(t.id).missed_polls, 0, `${mode}: an outage is not evidence of deletion`);
    assert.equal(item(t.id).gone_at, null);

    const html = await page('/sure');
    assert.match(html, /Sure sync failed/);
    if (mode === 'html') assert.match(html, /instead of JSON/, 'a proxy challenge is named as such');
  }
  fake.mode = null;
});

test('a rejected key and a proxy challenge are told apart', async () => {
  reset();
  fake.txns = [txn({ date: daysAgo(1), cents: 100, name: 'Diagnosis' })];

  // Sure itself rejecting the key: JSON 401, like the real finance.saderholm.us returns.
  const savedKey = config.sureApiKey;
  config.sureApiKey = 'wrong-key';
  try {
    const r = await sure.syncOnce();
    assert.match(r.error, /refused the API key/);
  } finally {
    config.sureApiKey = savedKey;
  }

  // Something in front of Sure: an HTML 403, which is what a challenge looks like.
  fake.mode = 'html';
  const r = await sure.syncOnce();
  assert.match(r.error, /instead of JSON/);
  assert.doesNotMatch(r.error, /refused the API key/, 'must not send you to replace a working key');
  fake.mode = null;
});

test('a renamed or missing category is an error, not an empty list', async () => {
  reset();
  const who = person('Renamed Rita');
  const t = txn({ date: daysAgo(3), cents: 1000, name: 'Renamed Rita' });
  fake.txns = [t];
  await sure.syncOnce();
  await req('POST', `/sure/items/${t.id}/add`, { body: { person_id: who } });

  fake.categories = [{ id: OWED, name: 'IOUs' }]; // renamed in Sure
  const r1 = await sure.syncOnce();
  const r2 = await sure.syncOnce();
  assert.match(r1.error, /no category named "Owed to me"/);
  assert.ok(r2.error);
  assert.equal(item(t.id).gone_at, null, 'renaming the category must not make everything look deleted');
});

test('a full page with no page count is refused rather than treated as complete', async () => {
  reset();
  fake.txns = Array.from({ length: 100 }, (_, i) => txn({ date: daysAgo(1), cents: 100 + i, name: `Row ${i}` }));
  fake.mode = 'nopagination';
  const r = await sure.syncOnce();
  assert.match(r.error, /cannot tell whether the list is complete/);
  fake.mode = null;
});

test('every page is read', async () => {
  reset();
  fake.txns = Array.from({ length: 237 }, (_, i) => txn({ date: daysAgo(i % 50), cents: 100 + i, name: `Bulk ${i}` }));
  const r = await sure.syncOnce();
  assert.equal(r.error, undefined, r.error);
  assert.equal(db.listSurePending().length, 237);
  assert.equal(fake.hits.filter((h) => h.path === '/api/v1/transactions').length, 3, '100 + 100 + 37');
});

test('items older than the window are left alone, never called gone', async () => {
  reset();
  const who = person('Old Timer Otto');
  const oldDate = daysAgo(200);
  const entryId = db.addEntry(who, 2500, 'from long ago', sure.createdAtFor(oldDate));
  db.handle.prepare(`
    INSERT INTO sure_items (sure_id, status, date, amount_cents, fingerprint, added_fingerprint, entry_id)
    VALUES ('old-item-0000', 'added', ?, 2500, ?, ?, ?)
  `).run(oldDate, `2500|${oldDate}`, `2500|${oldDate}`, entryId);

  fake.txns = [];
  await sure.syncOnce();
  await sure.syncOnce();
  await sure.syncOnce();
  assert.equal(item('old-item-0000').gone_at, null, 'outside the window, absence means nothing');
});

test('only US dollars are imported', async () => {
  reset();
  const eur = txn({ date: daysAgo(1), cents: 5000, name: 'Paris', currency: 'EUR' });
  fake.txns = [eur];
  const r = await sure.syncOnce();
  assert.equal(item(eur.id), undefined);
  assert.equal(r.skipped['currency EUR'], 1);
});

test('text from Sure is escaped on the page', async () => {
  reset();
  const t = txn({
    date: daysAgo(1), cents: 100,
    name: '<img src=x onerror=alert(1)>', notes: '"><script>alert(2)</script>',
    merchant: '<b>Evil</b>',
  });
  fake.txns = [t];
  await sure.syncOnce();

  const html = await page('/sure');
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<b>Evil<\/b>/);
  assert.match(html, /&lt;img src=x/);
});

test('a suggestion is reconsidered while an item waits', async () => {
  reset();
  const t = txn({ date: daysAgo(2), cents: 400, name: 'Latecomer Lou' });
  fake.txns = [t];
  await sure.syncOnce();
  assert.equal(item(t.id).suggested_person_id, null, 'nobody by that name yet');

  const lou = person('Latecomer Lou');
  await sure.syncOnce();
  assert.equal(item(t.id).suggested_person_id, lou, 'matched once the person exists');
});

test('auto-add posts only confident matches and leaves guesses for review', async () => {
  reset();
  const pat = person('Automatic Pat');
  person('Quincy Unique');
  const confident = txn({ date: daysAgo(2), cents: 1100, name: 'Automatic Pat' });
  const guess = txn({ date: daysAgo(2), cents: 2200, name: 'Quincy' });
  fake.txns = [confident, guess];

  config.sureAutoAdd = true;
  try {
    await sure.syncOnce();
  } finally {
    config.sureAutoAdd = false;
  }

  assert.equal(item(confident.id).status, 'added');
  assert.equal(db.getBalance(pat), 1100);
  assert.equal(item(guess.id).status, 'pending', 'a first-name guess is never added on its own');
});

test('inbox actions need a login and refuse malformed ids', async () => {
  reset();
  const t = txn({ date: daysAgo(1), cents: 500, name: 'Gated' });
  fake.txns = [t];
  await sure.syncOnce();

  assert.equal((await req('POST', `/sure/items/${t.id}/add`, { body: { person_id: '1' }, auth: false })).status, 401);
  assert.equal((await req('POST', '/sure/sync', { auth: false })).status, 401);
  assert.equal(item(t.id).status, 'pending');

  const bad = await req('POST', `/sure/items/${encodeURIComponent("x' OR 1=1 --")}/dismiss`);
  assert.equal(bad.status, 303);
  assert.match(bad.headers.get('location'), /e=sure_unknown/);
});

test('a failed login logs the client address, never the username', async () => {
  const lines = [];
  const original = console.warn;
  console.warn = (...args) => { lines.push(args.join(' ')); };
  try {
    await fetch(`${base}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '198.51.100.77' },
      body: new URLSearchParams({ username: 'my-secret-password-oops', password: 'nope' }).toString(),
    });
  } finally {
    console.warn = original;
  }
  const line = lines.find((l) => l.includes('failed login'));
  assert.ok(line, 'a failed login is logged');
  assert.match(line, /198\.51\.100\.77/);
  assert.doesNotMatch(line, /my-secret-password-oops/);
});
