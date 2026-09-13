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

class SureError extends Error {
  constructor(message, { status = null, json = false } = {}) {
    super(message);
    this.status = status;
    this.json = json;
  }
}

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
  if (!res.ok) throw new SureError(`Sure returned HTTP ${res.status} for ${path}`, { status: res.status, json: true });

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
 * Confident means the evidence could only have been put there on purpose:
 *   - a field that is exactly their name ("Jordan" as a split part's name),
 *   - their name anywhere in the notes, which you type yourself, or
 *   - a name of two or more words anywhere at all.
 *
 * A one-word name inside a longer `name` is only a guess. For a whole
 * transaction that field is the bank's description, and descriptions are full
 * of words that are also names: "JORDAN'S FURNITURE #12" is not about Jordan.
 * A guess is preselected for review but never added on its own.
 *
 * @param {string[]} fields  [name, notes]
 */
function suggestPerson(fields, people) {
  const nameWords = words(fields[0]);
  const notesWords = words(fields[1]);
  if (!nameWords.length && !notesWords.length) return { personId: null, confident: false };

  const same = (a, b) => a.length === b.length && a.every((w, i) => w === b[i]);
  const matches = [];
  for (const p of people) {
    const n = words(p.name);
    if (!n.length) continue;
    const wholeField = same(nameWords, n) || same(notesWords, n);
    const inNotes = containsRun(notesWords, n);
    const inName = containsRun(nameWords, n);
    if (!wholeField && !inNotes && !inName) continue;
    matches.push({ id: p.id, length: n.length, strong: wholeField || inNotes || n.length >= 2 });
  }

  if (matches.length) {
    // "Marcus" and "Marcus Webb" both match "Marcus Webb": the longer name is
    // the more specific claim. A tie between equally long names is ambiguous.
    const longest = Math.max(...matches.map((m) => m.length));
    const best = matches.filter((m) => m.length === longest);
    return best.length === 1
      ? { personId: best[0].id, confident: best[0].strong }
      : { personId: null, confident: false };
  }

  const texts = [nameWords, notesWords].filter((w) => w.length);
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

/** Names compared the way matching compares them: case, accents and punctuation ignored. */
function sameName(a, b) {
  const x = words(a);
  const y = words(b);
  return x.length > 0 && x.length === y.length && x.every((w, i) => w === y[i]);
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

/** The read in progress, shared by everyone who asks while it runs. */
let inFlight = null;

/**
 * Read Sure once and fold the result in.
 *
 * A second caller while a read is running gets that same read's outcome, not a
 * refusal: "Check Sure now" tapped during a background read then reports what
 * the read actually found, instead of claiming a check that never happened.
 */
function syncOnce() {
  if (!config.sureEnabled) return Promise.resolve({ skipped: 'not configured' });
  if (inFlight) return inFlight;
  inFlight = runSync().finally(() => { inFlight = null; });
  return inFlight;
}

async function runSync() {
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
    const { candidates, ...counts } = db.applySureSync({
      items: [...items.values()],
      windowStart,
      suggest: (it) => suggestPerson([it.name, it.notes], people),
    });

    Object.assign(counts, await confirmMissing(candidates, categoryIds));

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
    status.lastCounts = { ...counts, autoAdded, skipped, seen: items.size, fetched: raw.length };
    if (raw.length > 0 && items.size === 0) {
      // A successful read in which nothing was usable looks, from the inbox,
      // exactly like having nothing to review. Say so where it will be seen.
      console.warn(`[iou] Sure returned ${raw.length} transaction(s) but none were usable: `
        + Object.entries(skipped).map(([why, n]) => `${n} ${why}`).join(', '));
    }
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

/**
 * Ask Sure about each transaction that has been missing from two reads in a
 * row, before treating it as gone.
 *
 * Absence from the list is not evidence of deletion. The list only covers the
 * lookback window, so a transaction whose date was moved earlier in Sure simply
 * stops being listed while still existing -- and treating that as gone offered
 * to take real money off a tab. Only Sure saying the transaction does not
 * exist, or that it has left the category, counts.
 *
 * A failure here never flags anything: the counter stays, and the next read
 * asks again.
 */
async function confirmMissing(candidates, categoryIds) {
  const counts = { gonePending: 0, goneAdded: 0, stillThere: 0 };
  for (const { sure_id: id } of candidates) {
    let body;
    try {
      body = await request(`/api/v1/transactions/${encodeURIComponent(id)}`, []);
    } catch (err) {
      if (err instanceof SureError && err.status === 404 && err.json) {
        const outcome = db.confirmSureGone(id);
        if (outcome === 'deleted') counts.gonePending += 1;
        if (outcome === 'flagged') counts.goneAdded += 1;
        continue;
      }
      console.warn(`[iou] could not confirm whether Sure transaction ${id} still exists: ${err.message}`);
      break;
    }

    const stillOwed = body && body.category && categoryIds.includes(String(body.category.id));
    if (!stillOwed) {
      const outcome = db.confirmSureGone(id);
      if (outcome === 'deleted') counts.gonePending += 1;
      if (outcome === 'flagged') counts.goneAdded += 1;
      continue;
    }

    const n = normalize(body);
    // Still in the category but unreadable: not enough to call it gone.
    db.confirmSurePresent(id, n.skip ? null : n);
    counts.stillThere += 1;
  }
  return counts;
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
      // "Or someone new" is where a name gets typed when the suggestion missed,
      // so the name is often someone already here. Creating a second person of
      // the same name would put the money on a tab nobody's link shows, and
      // leave every later match for that name ambiguous.
      const everyone = db.listPeopleForMatching().filter((p) => sameName(p.name, newName));
      const existing = everyone.find((p) => !p.archived_at) || everyone[0];
      person = existing ? db.getPerson(existing.id) : db.getPerson(db.createPerson(newName));
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
      // A share: its size is kept, never replaced by a total. Its direction
      // follows Sure, which may have reclassified the money as spent or received.
      cents = Math.sign(item.amount_cents) * Math.abs(entry.amount);
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

/**
 * Gone from Sure: take it off the tab. The entry is soft-deleted and the
 * result carries an undo, which the inbox offers straight away.
 */
function removeGone(sureId) {
  return db.transaction(() => {
    const item = SURE_ID.test(String(sureId)) && db.getSureItem(sureId);
    if (!item || item.status !== 'added' || !item.gone_at || !item.entry_id) {
      return { ok: false, code: 'sure_unknown' };
    }
    const entry = db.handle.prepare('SELECT * FROM entries WHERE id = ?').get(item.entry_id);
    if (entry) db.softDeleteEntry(entry.person_id, entry.id);
    db.setSureItem(sureId, { status: 'detached' });
    return { ok: true, personId: entry && entry.person_id, entryId: entry && entry.id, undo: sureId };
  });
}

/** Undo a Remove: put the entry back and show the item as gone again. */
function undoRemove(sureId) {
  return db.transaction(() => {
    const item = SURE_ID.test(String(sureId)) && db.getSureItem(sureId);
    if (!item || item.status !== 'detached' || !item.entry_id) return { ok: false, code: 'sure_unknown' };
    const entry = db.handle.prepare('SELECT * FROM entries WHERE id = ?').get(item.entry_id);
    // Only a removal is undone. "Keep it" also detaches, but leaves the entry in
    // place, and must not be turned back into an open flag.
    if (!entry || !entry.deleted_at) return { ok: false, code: 'sure_unknown' };
    db.restoreEntry(entry.person_id, entry.id);
    db.setSureItem(sureId, { status: 'added' });
    return { ok: true, personId: entry.person_id };
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
  undoRemove,
  keepGone,
  // exported for tests
  sameName,
  fingerprintAmount,
  normalize,
  suggestPerson,
  suggestedDescription,
  createdAtFor,
};
