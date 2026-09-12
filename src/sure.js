'use strict';

// Review inbox fed by Sure (github.com/we-promise/sure).
//
// Transactions you put in Sure's "Owed to me" category show up here, already
// filled in, and wait for one tap before they touch any balance. Review-first
// is deliberate, not a missing feature: Sure's API does not say whether a
// transaction is pending, excluded, or part of a split, and editing a split
// recreates its parts under new ids. Anything posted without looking could
// count the same money twice on a page someone else can see.
//
// Response shapes here come from Sure's own source, not its prose docs:
//   app/views/api/v1/transactions/_transaction.json.jbuilder
//   app/views/api/v1/categories/index.json.jbuilder
// In particular `amount` is a localized display string and is never read;
// `amount_cents` is an integer magnitude and `classification` gives direction.

const config = require('./config');
const db = require('./db');
const { parseAmount } = require('./money');

/** Sure ids are UUIDs. Anything else is refused before it reaches a URL or the database. */
const SURE_ID = /^[A-Za-z0-9-]{1,64}$/;

const PER_PAGE = 100;       // Sure's cap
const MAX_PAGES = 200;      // 20,000 rows; past this, refuse rather than guess
const TIMEOUT_MS = 15000;

/** Last outcome, for the inbox page. Kept in memory; the first poll runs at boot. */
const status = {
  lastSuccessAt: null,
  lastErrorAt: null,
  lastError: null,
  lastCounts: null,
  running: false,
};

class SureError extends Error {}

/* ---------------------------------------------------------------- transport */

/**
 * One GET against Sure. Redirects are not followed: a redirect from an API
 * endpoint is a login page or a proxy challenge, not data, and following it
 * could carry the key to whatever host it points at.
 */
async function request(path, params) {
  const url = new URL(config.sureUrl + path);
  for (const [k, v] of params) url.searchParams.append(k, v);

  let res;
  try {
    res = await fetch(url, {
      headers: {
        'X-Api-Key': config.sureApiKey,
        Accept: 'application/json',
        'User-Agent': 'iou-sure-sync',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const why = (err.cause && err.cause.code) || err.name || err.message;
    throw new SureError(`could not reach Sure at ${config.sureUrl} (${why})`);
  }

  // Content type first. A Cloudflare challenge is typically a 403 carrying an
  // HTML page; checking the status first would report it as a rejected API key
  // and send you off to replace a key that was fine. Only JSON is Sure talking.
  const type = res.headers.get('content-type') || '';
  if (!type.includes('application/json')) {
    throw new SureError(`Sure answered ${path} with ${type || 'no content type'} (HTTP ${res.status}) `
      + 'instead of JSON. Something in front of Sure -- a login page, a redirect, or a '
      + 'Cloudflare challenge -- is intercepting API calls.');
  }
  if (res.status === 401 || res.status === 403) {
    throw new SureError(`Sure refused the API key (HTTP ${res.status}). `
      + 'Check SURE_API_KEY, and that the key has not been revoked.');
  }
  if (!res.ok) throw new SureError(`Sure returned HTTP ${res.status} for ${path}`);

  try {
    return await res.json();
  } catch {
    throw new SureError(`Sure sent malformed JSON for ${path}`);
  }
}

/**
 * Every page of a paginated list, or an error. Never a partial list: callers
 * treat anything absent as possibly deleted, so a list that silently stopped
 * short would look like a mass deletion.
 */
async function fetchAll(path, key, params) {
  const rows = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = await request(path, [...params, ['per_page', String(PER_PAGE)], ['page', String(page)]]);
    const batch = body && Array.isArray(body[key]) ? body[key] : null;
    if (!batch) throw new SureError(`Sure's ${path} response has no "${key}" list`);
    rows.push(...batch);

    const totalPages = Number(body.pagination && body.pagination.total_pages);
    if (Number.isInteger(totalPages)) {
      if (page >= totalPages) return rows;
    } else if (batch.length < PER_PAGE) {
      return rows; // no page count, but a short page is unambiguously the last
    } else {
      throw new SureError(`Sure's ${path} gave a full page with no page count; cannot tell whether the list is complete`);
    }
  }
  throw new SureError(`Sure's ${path} ran past ${MAX_PAGES} pages; refusing to act on a list that may be incomplete`);
}

/* ------------------------------------------------------------ interpretation */

const text = (v) => (typeof v === 'string' ? v.trim() : '');

/** Local calendar date in the server's zone, YYYY-MM-DD. */
function localDate(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Sure's date becomes local noon that day, stored as UTC. Noon rather than
 * midnight so no time zone offset can push it onto a neighbouring day.
 */
function createdAtFor(date) {
  return new Date(`${date}T12:00:00`).toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * One transaction from Sure, reduced to what the inbox needs, or a reason to
 * skip it. Direction comes from `classification`, never from parsing `amount`:
 * an expense is money spent that someone owes back (a charge); income is money
 * received from them (a payment).
 */
function normalize(t) {
  if (!t || typeof t !== 'object') return { skip: 'not an object' };
  const id = String(t.id || '');
  if (!SURE_ID.test(id)) return { skip: 'unexpected id' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(t.date))) return { skip: 'unexpected date' };

  const cents = Number(t.amount_cents);
  if (!Number.isSafeInteger(cents) || cents <= 0) return { skip: 'zero or unreadable amount' };
  if (text(t.currency).toUpperCase() !== 'USD') return { skip: `currency ${text(t.currency) || 'missing'}` };
  if (t.classification !== 'expense' && t.classification !== 'income') {
    return { skip: 'unknown direction' };
  }

  return {
    id,
    date: t.date,
    amount: t.classification === 'income' ? -cents : cents,
    name: text(t.name).slice(0, 200),
    notes: text(t.notes).slice(0, 500),
    merchant: text(t.merchant && t.merchant.name).slice(0, 200),
    account: text(t.account && t.account.name).slice(0, 200),
  };
}

function words(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

function containsRun(hay, needle) {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Who a transaction is probably about, from its name (where a split part's
 * person goes) and its notes (where a whole transaction's person goes).
 *
 * Confident means exactly one person's full name appears as whole words. A
 * first name alone is offered as a guess only when nobody else shares it, and
 * is never confident enough to add on its own.
 */
function suggestPerson(fields, people) {
  const texts = fields.map(words).filter((w) => w.length);
  if (!texts.length) return { personId: null, confident: false };

  const full = people
    .map((p) => ({ id: p.id, name: words(p.name) }))
    .filter((p) => p.name.length && texts.some((t) => containsRun(t, p.name)));

  if (full.length) {
    // "Marcus" and "Marcus Webb" both match "Marcus Webb": the longer name is
    // the more specific claim. A tie between equally long names is ambiguous.
    const longest = Math.max(...full.map((p) => p.name.length));
    const best = full.filter((p) => p.name.length === longest);
    return best.length === 1
      ? { personId: best[0].id, confident: true }
      : { personId: null, confident: false };
  }

  const byFirst = new Map();
  for (const p of people) {
    const first = words(p.name)[0];
    if (!first) continue;
    byFirst.set(first, [...(byFirst.get(first) || []), p.id]);
  }
  const hits = new Set();
  for (const [first, ids] of byFirst) {
    if (ids.length === 1 && texts.some((t) => t.includes(first))) hits.add(ids[0]);
  }
  return hits.size === 1
    ? { personId: [...hits][0], confident: false }
    : { personId: null, confident: false };
}

/** A sensible description to pre-fill: the merchant, else Sure's name. */
function suggestedDescription(item) {
  return (item.merchant || item.name || 'From Sure').slice(0, 200);
}

/* --------------------------------------------------------------------- sync */

async function findCategoryIds() {
  const categories = await fetchAll('/api/v1/categories', 'categories', []);
  const wanted = config.sureCategory.toLowerCase();
  const ids = categories
    .filter((c) => c && text(c.name).toLowerCase() === wanted && SURE_ID.test(String(c.id)))
    .map((c) => String(c.id));
  if (!ids.length) {
    // Must be an error, not an empty result. An empty list would make every
    // item look deleted -- which is exactly what renaming the category would
    // otherwise do.
    throw new SureError(`Sure has no category named "${config.sureCategory}". `
      + 'Create it, or set SURE_CATEGORY to the name you use.');
  }
  return ids;
}

/**
 * Read Sure once and fold the result in. Safe to call at any time; overlapping
 * calls are refused rather than run twice.
 */
async function syncOnce() {
  if (!config.sureEnabled) return { skipped: 'not configured' };
  if (status.running) return { skipped: 'already running' };
  status.running = true;

  try {
    const categoryIds = await findCategoryIds();
    const windowStart = localDate(Date.now() - config.sureLookbackDays * 86400000);
    const raw = await fetchAll('/api/v1/transactions', 'transactions', [
      ...categoryIds.map((id) => ['category_ids[]', id]),
      ['start_date', windowStart],
    ]);

    const items = new Map();
    const skipped = {};
    for (const t of raw) {
      const n = normalize(t);
      if (n.skip) {
        skipped[n.skip] = (skipped[n.skip] || 0) + 1;
        continue;
      }
      items.set(n.id, n);
    }

    const people = db.listPeopleForMatching();
    const counts = db.applySureSync({
      items: [...items.values()],
      windowStart,
      suggest: (it) => suggestPerson([it.name, it.notes], people),
    });

    let autoAdded = 0;
    if (config.sureAutoAdd) {
      for (const item of db.listSurePending()) {
        if (!item.suggestion_confident || !item.suggested_person_id) continue;
        const outcome = addItem(item.sure_id, { personId: item.suggested_person_id });
        if (outcome.ok) autoAdded += 1;
      }
    }

    status.lastSuccessAt = new Date();
    status.lastError = null;
    status.lastCounts = { ...counts, autoAdded, skipped, seen: items.size };
    return status.lastCounts;
  } catch (err) {
    status.lastError = err instanceof SureError ? err.message : `unexpected error: ${err.message}`;
    status.lastErrorAt = new Date();
    console.error(`[iou] Sure sync failed: ${status.lastError}`);
    return { error: status.lastError };
  } finally {
    status.running = false;
  }
}

/* ------------------------------------------------------------------ actions */

/**
 * Post a pending item to a tab.
 *
 * @param {string} sureId
 * @param {object} opts
 * @param {number} [opts.personId]       an existing person
 * @param {string} [opts.newPersonName]  create this person instead
 * @param {string} [opts.amount]         typed dollars; the item's direction is kept
 * @param {string} [opts.description]
 */
function addItem(sureId, { personId, newPersonName, amount, description } = {}) {
  if (!SURE_ID.test(String(sureId))) return { ok: false, code: 'sure_unknown' };

  return db.transaction(() => {
    const item = db.getSureItem(sureId);
    if (!item) return { ok: false, code: 'sure_unknown' };
    // Checked inside the transaction, so a double tap cannot post it twice.
    if (item.status !== 'pending') return { ok: false, code: 'sure_not_pending' };

    let cents = item.amount_cents;
    if (amount !== undefined && String(amount).trim() !== '') {
      const parsed = parseAmount(String(amount));
      if (!parsed.ok) return { ok: false, code: parsed.code };
      cents = item.amount_cents < 0 ? -parsed.cents : parsed.cents;
    }

    let person = null;
    const newName = String(newPersonName || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (newName) {
      person = db.getPerson(db.createPerson(newName));
    } else if (personId) {
      person = db.getPerson(Number(personId));
    }
    if (!person) return { ok: false, code: 'sure_person_required' };

    const desc = String(description == null ? suggestedDescription(item) : description)
      .trim().slice(0, 200);
    const entryId = db.addEntry(person.id, cents, desc, createdAtFor(item.date));
    db.setSureItem(sureId, { status: 'added', entry_id: entryId, added_fingerprint: item.fingerprint });
    return { ok: true, personId: person.id, entryId };
  });
}

function dismissItem(sureId) {
  const item = SURE_ID.test(String(sureId)) && db.getSureItem(sureId);
  if (!item || item.status !== 'pending') return { ok: false, code: 'sure_not_pending' };
  db.setSureItem(sureId, { status: 'dismissed' });
  return { ok: true };
}

/** Sure changed an added item: take Sure's amount and date onto the tab. */
/** The amount Sure reported, from a stored "amount|date" fingerprint. */
function fingerprintAmount(fp) {
  return Number(String(fp || '').split('|')[0]);
}

/**
 * Sure changed an added item: bring the tab in line.
 *
 * The date always follows Sure. The amount only follows Sure if the whole
 * amount was added in the first place. Sure knows a transaction's total, never
 * the share you typed for one person: add $30 of a $90 dinner, edit that
 * dinner in Sure, and taking Sure's figure would silently charge them $90.
 * So a share is kept unless a new one is typed.
 *
 * @param {string} sureId
 * @param {object} [opts]
 * @param {string} [opts.amount]  a new share, typed in dollars
 */
function acceptChange(sureId, { amount } = {}) {
  return db.transaction(() => {
    const item = SURE_ID.test(String(sureId)) && db.getSureItem(sureId);
    if (!item || item.status !== 'added' || !item.entry_id) return { ok: false, code: 'sure_unknown' };
    const entry = db.handle.prepare('SELECT * FROM entries WHERE id = ? AND deleted_at IS NULL').get(item.entry_id);
    if (!entry) return { ok: false, code: 'sure_unknown' };

    let cents;
    if (amount !== undefined && String(amount).trim() !== '') {
      const parsed = parseAmount(String(amount));
      if (!parsed.ok) return { ok: false, code: parsed.code };
      cents = item.amount_cents < 0 ? -parsed.cents : parsed.cents;
    } else if (entry.amount === fingerprintAmount(item.added_fingerprint)) {
      cents = item.amount_cents; // the whole thing was added, so the whole thing follows Sure
    } else {
      cents = entry.amount; // a share: never replaced by a total
    }

    db.updateEntry(entry.person_id, entry.id, cents, entry.description, createdAtFor(item.date));
    db.setSureItem(sureId, { added_fingerprint: item.fingerprint });
    return { ok: true, personId: entry.person_id };
  });
}

/** Sure changed an added item, and the tab is right: stop flagging it. */
function keepTabValue(sureId) {
  const item = SURE_ID.test(String(sureId)) && db.getSureItem(sureId);
  if (!item || item.status !== 'added') return { ok: false, code: 'sure_unknown' };
  db.setSureItem(sureId, { added_fingerprint: item.fingerprint });
  return { ok: true };
}

/** Gone from Sure: take it off the tab. A soft delete, so Undo still works. */
function removeGone(sureId) {
  return db.transaction(() => {
    const item = SURE_ID.test(String(sureId)) && db.getSureItem(sureId);
    if (!item || item.status !== 'added' || !item.gone_at || !item.entry_id) {
      return { ok: false, code: 'sure_unknown' };
    }
    const entry = db.handle.prepare('SELECT * FROM entries WHERE id = ?').get(item.entry_id);
    if (entry) db.softDeleteEntry(entry.person_id, entry.id);
    db.setSureItem(sureId, { status: 'detached' });
    return { ok: true, personId: entry && entry.person_id, entryId: entry && entry.id };
  });
}

/** Gone from Sure, but the money is still owed: keep it and stop tracking it. */
function keepGone(sureId) {
  const item = SURE_ID.test(String(sureId)) && db.getSureItem(sureId);
  if (!item || item.status !== 'added' || !item.gone_at) return { ok: false, code: 'sure_unknown' };
  db.setSureItem(sureId, { status: 'detached' });
  return { ok: true };
}

/* ------------------------------------------------------------------ polling */

/** Poll on a timer. The first read comes shortly after boot. Returns a stop function. */
function start() {
  if (!config.sureEnabled) return () => {};
  const run = () => { syncOnce().catch(() => { /* recorded in status */ }); };
  const first = setTimeout(run, 5000);
  const timer = setInterval(run, config.surePollMinutes * 60 * 1000);
  first.unref();
  timer.unref();
  console.log(`[iou] Sure sync on: ${config.sureUrl}, category "${config.sureCategory}", `
    + `every ${config.surePollMinutes} min${config.sureAutoAdd ? ', auto-add on' : ''}`);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

module.exports = {
  SURE_ID,
  status,
  start,
  syncOnce,
  addItem,
  dismissItem,
  acceptChange,
  keepTabValue,
  removeGone,
  keepGone,
  // exported for tests
  fingerprintAmount,
  normalize,
  suggestPerson,
  suggestedDescription,
  createdAtFor,
};
