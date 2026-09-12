'use strict';

// Regression tests for the findings from the code and security review. Each
// test is named for the failure it guards against, and each was written to
// fail against the code as it stood before the fix.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'iou-review-'));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, 'iou.db');
process.env.SESSION_SECRET = 'review-secret-not-a-real-one';
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASSWORD_HASH = require('bcryptjs').hashSync('hunter2', 10);
process.env.BACKUP_KEEP = '3';
process.env.TZ = 'America/Denver';
delete process.env.TRUST_PROXY; // exercise the shipped default

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'src', 'server.js');

const { app } = require('../src/server');
const config = require('../src/config');
const db = require('../src/db');
const backup = require('../src/backup');
const views = require('../src/views');

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
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* windows lock */ }
});

function req(method, url, { body, cookie, headers = {} } = {}) {
  const init = { method, redirect: 'manual', headers: { ...headers } };
  if (cookie) init.headers.cookie = cookie;
  if (body) {
    init.headers['content-type'] = 'application/x-www-form-urlencoded';
    init.body = new URLSearchParams(body).toString();
  }
  return fetch(base + url, init);
}

async function login(headers = {}) {
  const res = await req('POST', '/login', {
    body: { username: 'admin', password: 'hunter2' }, headers,
  });
  assert.equal(res.status, 303, 'login should succeed');
  return res.headers.getSetCookie().find((c) => c.startsWith('iou_session=')).split(';')[0];
}

const isLoggedIn = async (cookie) => (await req('GET', '/', { cookie })).status === 200;

/** Run the real server in a child process until it listens or exits. */
function boot(env, { dir }) {
  const child = spawn(process.execPath, [SERVER], {
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      DATA_DIR: dir,
      PORT: String(3300 + Math.floor(Math.random() * 500)),
      ADMIN_USER: 'dj',
      ADMIN_PASSWORD: 'hunter2',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  return new Promise((resolve) => {
    const done = (code) => {
      try { child.kill(); } catch { /* gone */ }
      child.once('close', () => resolve({ code, out }));
      setTimeout(() => resolve({ code, out }), 1500);
    };
    child.on('close', (code) => resolve({ code, out }));
    const poll = setInterval(() => {
      if (out.includes('listening on')) { clearInterval(poll); done(null); }
    }, 50);
    setTimeout(() => { clearInterval(poll); done(null); }, 10000);
  });
}

/* ------------------------------------------ 1. spoofable client address */

test('trust proxy defaults to one hop, not "true"', () => {
  assert.equal(config.trustProxy, 1);
  assert.equal(config.parseTrustProxy('true'), true, 'still available, but only if asked for');
  assert.equal(config.parseTrustProxy('2'), 2, 'a numeric string is a hop count, not an address');
});

test('rotating the left-most X-Forwarded-For does not escape a lockout', async () => {
  // The address the nearest proxy appended stays the same; only the part the
  // client writes itself changes. Under "trust proxy: true" every one of these
  // was a different address with its own fresh allowance.
  const realAddress = '203.0.113.50';
  for (let i = 0; i < 10; i++) {
    await req('POST', '/login', {
      body: { username: 'admin', password: `guess-${i}` },
      headers: { 'x-forwarded-for': `10.0.${i}.${i}, ${realAddress}` },
    });
  }
  const blocked = await req('POST', '/login', {
    body: { username: 'admin', password: 'hunter2' },
    headers: { 'x-forwarded-for': `6.6.6.6, ${realAddress}` },
  });
  assert.equal(blocked.status, 429, 'a new left-most value must not reset the count');

  // Someone genuinely elsewhere is still let in.
  assert.equal((await req('POST', '/login', {
    body: { username: 'admin', password: 'hunter2' },
    headers: { 'x-forwarded-for': '198.51.100.20' },
  })).status, 303);
});

/* --------------------------------------- 2. timer delays and NaN settings */

test('unusable backup and session settings fall back instead of going NaN', () => {
  const read = (env) => {
    const r = spawnSync(process.execPath, ['-e', `
      process.env.DATA_DIR = ${JSON.stringify(path.join(TMP, 'cfg'))};
      const c = require(${JSON.stringify(path.join(ROOT, 'src', 'config.js'))});
      process.stdout.write(JSON.stringify({ h: c.backupIntervalHours, k: c.backupKeep, t: c.sessionTtlSeconds }));
    `], {
      // A fixed secret, so config does not log that it generated one and
      // interleave that line with the JSON on stdout.
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, SESSION_SECRET: 'x', ...env },
      encoding: 'utf8',
    });
    return { value: JSON.parse(r.stdout), warned: r.stderr };
  };

  // "720" is a plausible monthly setting; it overflows setInterval, which Node
  // then runs every millisecond. "24h" is NaN, which does the same.
  for (const hours of ['720', '24h', '0', '-5', '1.5']) {
    const { value, warned } = read({ BACKUP_INTERVAL_HOURS: hours });
    assert.equal(value.h, 24, `BACKUP_INTERVAL_HOURS=${hours} should fall back to 24`);
    assert.match(warned, /ignoring BACKUP_INTERVAL_HOURS/);
  }
  assert.equal(read({ BACKUP_INTERVAL_HOURS: '168' }).value.h, 168, 'a weekly value is honoured');
  assert.ok(config.MAX_TIMER_HOURS * 3600000 <= 2147483647, 'the cap really fits a timer');

  assert.equal(read({ BACKUP_KEEP: 'lots' }).value.k, 14);
  assert.equal(read({ SESSION_TTL_SECONDS: 'forever' }).value.t, 31536000);
});

/* ---------------------------------------- 3. backup before, not after, migrate */

test('the startup backup is taken before migrations run', async () => {
  const dir = path.join(TMP, 'upgrade');
  fs.mkdirSync(dir, { recursive: true });

  // A database in the original schema: no deleted_at, no archived_at, no
  // sessions table. Exactly what an instance from before those existed has.
  const Database = require('better-sqlite3');
  const old = new Database(path.join(dir, 'iou.db'));
  old.exec(`
    CREATE TABLE people (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      share_token TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE entries (id INTEGER PRIMARY KEY AUTOINCREMENT, person_id INTEGER NOT NULL,
      amount INTEGER NOT NULL, description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO people (name, share_token) VALUES ('Before Upgrade', 'tok-before-upgrade');
  `);
  old.close();

  const { out } = await boot({}, { dir });
  assert.match(out, /taken before migrations/);
  assert.doesNotMatch(out, /NEW, EMPTY database/, 'an existing database is not announced as new');

  const snap = fs.readdirSync(path.join(dir, 'backups')).find((f) => f.endsWith('-pre-upgrade.db'));
  assert.ok(snap, 'a pre-upgrade backup file should exist');

  const copy = new Database(path.join(dir, 'backups', snap), { readonly: true });
  const columns = copy.prepare('PRAGMA table_info(entries)').all().map((c) => c.name);
  const hasSessions = copy.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sessions'").get();
  const person = copy.prepare('SELECT name FROM people').get();
  copy.close();

  // The decisive part: the snapshot still has the OLD schema. Taken after
  // migrating, it would already contain these.
  assert.ok(!columns.includes('deleted_at'), 'snapshot must predate the deleted_at migration');
  assert.ok(!hasSessions, 'snapshot must predate the sessions table');
  assert.equal(person.name, 'Before Upgrade', 'and it holds the data');

  const live = new Database(path.join(dir, 'iou.db'), { readonly: true });
  const liveColumns = live.prepare('PRAGMA table_info(entries)').all().map((c) => c.name);
  live.close();
  assert.ok(liveColumns.includes('deleted_at'), 'while the live database did get migrated');
});

/* --------------------------------------------- 4. history ordered by date */

test('a backdated entry sorts by its date and the running balance follows', async () => {
  const cookie = await login();
  const res = await req('POST', '/people', { body: { name: 'Date Order' }, cookie });
  const id = Number(res.headers.get('location').match(/\/p\/(\d+)/)[1]);

  // Three entries recorded now, in this order.
  for (const [amount, description] of [['10', 'first'], ['20', 'second'], ['40', 'third']]) {
    await req('POST', `/p/${id}/entries`, { body: { kind: 'charge', amount, description }, cookie });
  }
  const third = db.listEntries(id).find((e) => e.description === 'third');

  // Move the last one recorded to well before the others.
  const todayLocal = views.localDateInputValue(third.created_at);
  const earlier = new Date(Date.parse(`${todayLocal}T00:00:00Z`) - 5 * 86400000)
    .toISOString().slice(0, 10);
  await req('POST', `/p/${id}/entries/${third.id}/edit`, {
    body: { kind: 'charge', amount: '40', description: 'third', date: earlier }, cookie,
  });

  const rows = db.listEntries(id);
  assert.deepEqual(rows.map((r) => r.description), ['third', 'first', 'second'],
    'history must be in date order, not the order entries were typed in');
  assert.deepEqual(rows.map((r) => r.running_balance), [4000, 5000, 7000],
    'and each running balance is the total as of that date');

  const activity = await (await req('GET', '/activity', { cookie })).text();
  assert.ok(activity.indexOf('second') < activity.indexOf('third'),
    'the cross-person view is date-ordered too');
});

/* ------------------------------------------------- 5. revocable sessions */

test('logging out ends a copied session, not just the local cookie', async () => {
  const phone = await login();
  const copied = phone; // the same token, exported to somewhere else
  assert.ok(await isLoggedIn(copied));

  await req('POST', '/logout', { cookie: phone });

  assert.equal(await isLoggedIn(copied), false,
    'a copy of the cookie must stop working once its session is logged out');
});

test('logging out one session leaves the others signed in', async () => {
  const laptop = await login();
  const phone = await login();
  await req('POST', '/logout', { cookie: laptop });
  assert.equal(await isLoggedIn(laptop), false);
  assert.ok(await isLoggedIn(phone), 'the phone was not the one that logged out');
});

test('log out of all devices ends every session', async () => {
  const a = await login();
  const b = await login();
  const c = await login();
  const res = await req('POST', '/logout-all', { cookie: a });
  assert.equal(res.status, 303);
  for (const cookie of [a, b, c]) assert.equal(await isLoggedIn(cookie), false);
});

test('a validly signed token with no session row is refused', async () => {
  // Exactly the shape of a cookie issued before sessions were tracked:
  // correctly signed, unexpired, right user, and impossible to revoke.
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(JSON.stringify({ u: 'admin', iat: now, exp: now + 3600 }))
    .toString('base64url');
  const mac = crypto.createHmac('sha256', config.sessionSecret).update(body).digest('base64url');
  const legacy = `${config.cookieName}=${body}.${mac}`;

  assert.equal(await isLoggedIn(legacy), false);
});

/* ------------------------------------------------ 6. retention by day */

test('a burst of restarts does not evict earlier days of backups', () => {
  fs.rmSync(backup.DIR, { recursive: true, force: true });
  fs.mkdirSync(backup.DIR, { recursive: true });
  const touch = (name) => fs.writeFileSync(path.join(backup.DIR, name), 'x');

  // One backup on each of four earlier days...
  for (const day of ['01', '02', '03', '04']) touch(`iou-2020-01-${day}T0300.db`);
  // ...then fourteen restarts in one afternoon, each taking its own.
  const burst = [];
  for (let i = 0; i < 14; i++) {
    const name = `iou-2020-01-05T${String(1200 + i).padStart(4, '0')}-pre-upgrade.db`;
    touch(name);
    burst.push(name);
  }

  backup.prune();
  const left = new Set(fs.readdirSync(backup.DIR));

  // BACKUP_KEEP is 3 here: the newest three DAYS survive, not the newest three
  // files. Under the old count-based rule these two days were deleted.
  assert.ok(left.has('iou-2020-01-04T0300.db'), 'the day before the burst survives');
  assert.ok(left.has('iou-2020-01-03T0300.db'), 'and the day before that');
  assert.ok(!left.has('iou-2020-01-01T0300.db'), 'while days past BACKUP_KEEP go');

  // The newest few files are kept whatever their day, which is what saves the
  // snapshot taken just before an upgrade from a later restart the same day.
  for (const name of burst.slice(-backup.RECENT_ALWAYS_KEPT)) {
    assert.ok(left.has(name), `${name} is among the newest and must be kept`);
  }
  assert.ok(!left.has(burst[0]), 'but the burst does not keep all fourteen');
});

/* ------------------------------------------ 7. the new-database warning */

test('a newly created database is announced, since a missing volume looks the same', async () => {
  const dir = path.join(TMP, 'fresh');
  fs.mkdirSync(dir, { recursive: true });
  const { out } = await boot({}, { dir });
  assert.match(out, /NEW, EMPTY database/);
  assert.match(out, /volume is not mounted/);
  assert.doesNotMatch(out, /pre-upgrade/, 'nothing to back up on a first install');
});


/* -------------------------------------- 8. inherited flash message keys */

test('flash lookups ignore inherited properties', async () => {
  const cookie = await login();
  for (const [key, value] of [['m', 'constructor'], ['m', 'toString'], ['e', '__proto__'], ['e', 'hasOwnProperty']]) {
    const body = await (await req('GET', `/?${key}=${value}`, { cookie })).text();
    assert.doesNotMatch(body, /native code|\[object Object\]|function /,
      `?${key}=${value} must not render a prototype member`);
    assert.doesNotMatch(body, /class="flash/, `?${key}=${value} should show no notice at all`);
  }
  // Real keys still work.
  assert.match(await (await req('GET', '/?m=settled', { cookie })).text(), /Settled up\./);
});

/* ------------------------------------------------------ 9. date validation */

test('impossible and future dates are refused', async () => {
  const cookie = await login();
  const res = await req('POST', '/people', { body: { name: 'Calendar' }, cookie });
  const id = Number(res.headers.get('location').match(/\/p\/(\d+)/)[1]);
  await req('POST', `/p/${id}/entries`, { body: { kind: 'charge', amount: '5' }, cookie });
  const entry = db.listEntries(id)[0];

  const todayLocal = views.localDateInputValue(new Date().toISOString().replace('T', ' ').slice(0, 19));
  const tomorrow = new Date(Date.parse(`${todayLocal}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);

  // 2026-02-30 used to be accepted and silently become March 2. Tomorrow used
  // to be accepted thanks to a 36-hour allowance.
  for (const date of ['2026-02-30', '2025-02-29', '2026-04-31', tomorrow]) {
    const r = await req('POST', `/p/${id}/entries/${entry.id}/edit`, {
      body: { kind: 'charge', amount: '5', date }, cookie,
    });
    assert.match(r.headers.get('location'), /e=bad_date/, `${date} should be refused`);
    assert.equal(db.listEntries(id)[0].created_at, entry.created_at, `${date} changed nothing`);
  }

  // A real leap day and today itself are fine.
  const ok = await req('POST', `/p/${id}/entries/${entry.id}/edit`, {
    body: { kind: 'charge', amount: '5', date: '2024-02-29' }, cookie,
  });
  assert.doesNotMatch(ok.headers.get('location'), /bad_date/, '2024-02-29 is a real date');
});

/* ------------------------------------------------- bodyless form posts */

test('a POST with no body at all gets a normal answer, not a 500', async () => {
  // Express 5 leaves req.body undefined without a form body, and every handler
  // read fields off it: a bare POST /login used to throw and return 500.
  const bare = (url, cookie) => fetch(base + url, {
    method: 'POST', redirect: 'manual', headers: cookie ? { cookie } : {},
  });

  assert.equal((await bare('/login')).status, 401, 'no credentials is a failed login');

  const cookie = await login();
  const person = await bare('/people', cookie);
  assert.equal(person.status, 303);
  assert.match(person.headers.get('location'), /e=name_required/);
});
