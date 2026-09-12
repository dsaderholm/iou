'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || '/data';
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'iou.db');

let db;

/**
 * Open the database file without touching its schema. Split from ensureSchema
 * so startup can take a backup in between: a snapshot meant to survive a bad
 * upgrade has to be taken before the new code's migrations run, not after.
 */
function open() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

/** Create any missing tables and apply migrations. Safe to run on every boot. */
function ensureSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS people (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      share_token TEXT    NOT NULL UNIQUE,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS entries (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id   INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      amount      INTEGER NOT NULL,
      description TEXT    NOT NULL DEFAULT '',
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_entries_person ON entries(person_id, id);

    -- One row per login, so a session can be revoked. The cookie on its own is
    -- a signed bearer token, and a signature cannot be un-signed: without this
    -- table, "Log out" only forgets the cookie in one browser while any copy of
    -- it keeps working until it expires.
    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT    PRIMARY KEY,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      expires_at  INTEGER NOT NULL,
      revoked_at  TEXT
    );

    -- Transactions seen in Sure's "Owed to me" category.
    --
    -- pending    waiting in the review inbox; touches no balance
    -- added      posted to a tab as entry_id
    -- dismissed  turned down; remembered so it never comes back
    -- detached   was added, then went away in Sure and was kept anyway
    --
    -- amount_cents is already signed the way entries are: positive is a charge
    -- (money spent on their behalf), negative a payment (money they sent).
    -- fingerprint is the amount and date as Sure last reported them;
    -- added_fingerprint is what they were when posted, so a later edit in Sure
    -- can be flagged instead of silently rewriting a balance.
    CREATE TABLE IF NOT EXISTS sure_items (
      sure_id               TEXT    PRIMARY KEY,
      status                TEXT    NOT NULL DEFAULT 'pending',
      date                  TEXT    NOT NULL,
      amount_cents          INTEGER NOT NULL,
      name                  TEXT    NOT NULL DEFAULT '',
      notes                 TEXT    NOT NULL DEFAULT '',
      merchant              TEXT    NOT NULL DEFAULT '',
      account               TEXT    NOT NULL DEFAULT '',
      suggested_person_id   INTEGER REFERENCES people(id) ON DELETE SET NULL,
      suggestion_confident  INTEGER NOT NULL DEFAULT 0,
      entry_id              INTEGER REFERENCES entries(id) ON DELETE SET NULL,
      fingerprint           TEXT    NOT NULL,
      added_fingerprint     TEXT,
      missed_polls          INTEGER NOT NULL DEFAULT 0,
      gone_at               TEXT,
      first_seen_at         TEXT    NOT NULL DEFAULT (datetime('now')),
      last_seen_at          TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_sure_items_status ON sure_items(status, date);
  `);
  migrate();
}

/** Open and prepare in one step, for tests and scripts that need no backup. */
function init() {
  open();
  ensureSchema();
  return db;
}

/** Add a column only if it is missing, so this is safe to run on every boot. */
function addColumnIfMissing(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((c) => c.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

function migrate() {
  // Soft delete: a removed entry is hidden everywhere but stays on disk, which
  // is what makes Undo possible after a mis-tap.
  addColumnIfMissing('entries', 'deleted_at', 'TEXT');
  // Archive: tidies someone off the list without destroying their history.
  addColumnIfMissing('people', 'archived_at', 'TEXT');
  // History is ordered by date now that an entry's date can be edited.
  db.exec('CREATE INDEX IF NOT EXISTS idx_entries_person_date ON entries(person_id, created_at, id)');
}

/** A 16-character URL-safe token. 12 random bytes -> exactly 16 base64url chars. */
function newShareToken() {
  return crypto.randomBytes(12).toString('base64url');
}

/** Insert a person, retrying on the (vanishingly unlikely) token collision. */
function createPerson(name) {
  const stmt = db.prepare('INSERT INTO people (name, share_token) VALUES (?, ?)');
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const info = stmt.run(name, newShareToken());
      return Number(info.lastInsertRowid);
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' && attempt < 4) continue;
      throw err;
    }
  }
}

/* ------------------------------------------------------------------- people */

/**
 * Active people with their current balance, biggest debtor first.
 *
 * The deleted_at test belongs in the JOIN, not a WHERE: moving it would turn
 * this into an inner join and drop everyone whose only entries were deleted.
 */
function listPeopleWithBalances() {
  return db.prepare(`
    SELECT p.id, p.name, p.share_token, p.created_at,
           COALESCE(SUM(e.amount), 0) AS balance,
           COUNT(e.id)                AS entry_count
    FROM people p
    LEFT JOIN entries e ON e.person_id = p.id AND e.deleted_at IS NULL
    WHERE p.archived_at IS NULL
    GROUP BY p.id
    ORDER BY balance DESC, p.name COLLATE NOCASE ASC
  `).all();
}

function listArchivedPeople() {
  return db.prepare(`
    SELECT p.id, p.name, p.share_token, p.created_at, p.archived_at,
           COALESCE(SUM(e.amount), 0) AS balance,
           COUNT(e.id)                AS entry_count
    FROM people p
    LEFT JOIN entries e ON e.person_id = p.id AND e.deleted_at IS NULL
    WHERE p.archived_at IS NOT NULL
    GROUP BY p.id
    ORDER BY p.name COLLATE NOCASE ASC
  `).all();
}

/**
 * How many people are archived and how much of what they owe is sitting out
 * of sight. The home page's "Owed to you" leaves archived people out, so that
 * money has to be visible somewhere or archiving quietly shrinks the number.
 */
function archivedSummary() {
  return db.prepare(`
    SELECT COUNT(*) AS count,
           COALESCE(SUM(CASE WHEN balance > 0 THEN balance ELSE 0 END), 0) AS owed
    FROM (
      SELECT COALESCE(SUM(e.amount), 0) AS balance
      FROM people p
      LEFT JOIN entries e ON e.person_id = p.id AND e.deleted_at IS NULL
      WHERE p.archived_at IS NOT NULL
      GROUP BY p.id
    )
  `).get();
}

function getPerson(id) {
  return db.prepare('SELECT * FROM people WHERE id = ?').get(id);
}

/** Archived people keep working share links; archiving is tidying, not revocation. */
function getPersonByToken(token) {
  return db.prepare('SELECT * FROM people WHERE share_token = ?').get(token);
}

function renamePerson(id, name) {
  return db.prepare('UPDATE people SET name = ? WHERE id = ?').run(name, id).changes;
}

function setArchived(id, archived) {
  return db.prepare(
    `UPDATE people SET archived_at = ${archived ? "datetime('now')" : 'NULL'} WHERE id = ?`
  ).run(id).changes;
}

function deletePerson(id) {
  return db.prepare('DELETE FROM people WHERE id = ?').run(id).changes;
}

function regenerateToken(id) {
  const stmt = db.prepare('UPDATE people SET share_token = ? WHERE id = ?');
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = newShareToken();
    try {
      if (stmt.run(token, id).changes === 0) return null;
      return token;
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' && attempt < 4) continue;
      throw err;
    }
  }
}

/* ------------------------------------------------------------------ entries */

function getBalance(personId) {
  return db.prepare(
    'SELECT COALESCE(SUM(amount), 0) AS balance FROM entries WHERE person_id = ? AND deleted_at IS NULL'
  ).get(personId).balance;
}

/**
 * Live entries for one person, oldest first, each carrying the running balance
 * as of that entry. Callers wanting newest-first reverse the result; the
 * running total has to accumulate in chronological order either way.
 *
 * Ordered by date, then id to break ties within one second. Ordering by id
 * alone was only right while dates could not change: once an entry can move to
 * an earlier day, insertion order and date order disagree, the history reads
 * out of order, and each row's running balance stops describing the date
 * printed beside it.
 */
function listEntries(personId) {
  const rows = db.prepare(`
    SELECT id, amount, description, created_at
    FROM entries
    WHERE person_id = ? AND deleted_at IS NULL
    ORDER BY created_at ASC, id ASC
  `).all(personId);
  let running = 0;
  for (const row of rows) {
    running += row.amount;
    row.running_balance = running;
  }
  return rows;
}

function getEntry(personId, entryId) {
  return db.prepare(
    'SELECT * FROM entries WHERE id = ? AND person_id = ? AND deleted_at IS NULL'
  ).get(entryId, personId);
}

/**
 * @param {string|null} createdAt  "YYYY-MM-DD HH:MM:SS" UTC, or null for now.
 */
function addEntry(personId, amountCents, description, createdAt = null) {
  if (createdAt) {
    return Number(db.prepare(
      'INSERT INTO entries (person_id, amount, description, created_at) VALUES (?, ?, ?, ?)'
    ).run(personId, amountCents, description, createdAt).lastInsertRowid);
  }
  return Number(db.prepare(
    'INSERT INTO entries (person_id, amount, description) VALUES (?, ?, ?)'
  ).run(personId, amountCents, description).lastInsertRowid);
}

/**
 * @param {string|null} createdAt  "YYYY-MM-DD HH:MM:SS" in UTC, or null to
 *                                 leave the original timestamp alone.
 */
function updateEntry(personId, entryId, amountCents, description, createdAt = null) {
  if (createdAt) {
    return db.prepare(`
      UPDATE entries SET amount = ?, description = ?, created_at = ?
      WHERE id = ? AND person_id = ? AND deleted_at IS NULL
    `).run(amountCents, description, createdAt, entryId, personId).changes;
  }
  return db.prepare(`
    UPDATE entries SET amount = ?, description = ?
    WHERE id = ? AND person_id = ? AND deleted_at IS NULL
  `).run(amountCents, description, entryId, personId).changes;
}

/** Hide an entry. The row stays so it can be brought straight back. */
function softDeleteEntry(personId, entryId) {
  return db.prepare(`
    UPDATE entries SET deleted_at = datetime('now')
    WHERE id = ? AND person_id = ? AND deleted_at IS NULL
  `).run(entryId, personId).changes;
}

function restoreEntry(personId, entryId) {
  return db.prepare(`
    UPDATE entries SET deleted_at = NULL
    WHERE id = ? AND person_id = ? AND deleted_at IS NOT NULL
  `).run(entryId, personId).changes;
}

/**
 * Descriptions this person has had before, newest first, for the entry form's
 * autocomplete. Charges and payments are kept apart so a payment note never
 * suggests itself on a charge.
 */
function recentDescriptions(personId, negative, limit = 8) {
  return db.prepare(`
    SELECT description, MAX(id) AS last_id
    FROM entries
    WHERE person_id = ?
      AND deleted_at IS NULL
      AND description <> ''
      AND amount ${negative ? '<' : '>='} 0
    GROUP BY description COLLATE NOCASE
    ORDER BY last_id DESC
    LIMIT ?
  `).all(personId, limit).map((r) => r.description);
}

/**
 * The most recent entries across everyone, newest first. This is the only view
 * that can catch a charge landing on the wrong person: per-person history
 * cannot show you a mistake you do not already suspect.
 */
function recentActivity(limit = 100) {
  return db.prepare(`
    SELECT e.id, e.amount, e.description, e.created_at,
           p.id AS person_id, p.name AS person_name, p.archived_at
    FROM entries e
    JOIN people p ON p.id = e.person_id
    WHERE e.deleted_at IS NULL
    ORDER BY e.created_at DESC, e.id DESC
    LIMIT ?
  `).all(limit);
}

/**
 * Liveness probe. Reads the schema table, so it touches a real page of the file
 * rather than evaluating a constant. It cannot tell a missing volume from a
 * first install -- both are an empty directory -- which is why startup
 * announces a newly created database rather than this pretending to know.
 */
function ping() {
  return db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get().n > 0;
}

/* ----------------------------------------------------------------- sessions */

function createSession(id, expiresAt) {
  // Housekeeping on the way in: nothing ever reads an expired row again.
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Math.floor(Date.now() / 1000));
  db.prepare('INSERT INTO sessions (id, expires_at) VALUES (?, ?)').run(id, expiresAt);
}

function sessionIsActive(id) {
  return Boolean(db.prepare(`
    SELECT 1 FROM sessions
    WHERE id = ? AND revoked_at IS NULL AND expires_at > ?
  `).get(id, Math.floor(Date.now() / 1000)));
}

function revokeSession(id) {
  return db.prepare(
    "UPDATE sessions SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL"
  ).run(id).changes;
}

function revokeAllSessions() {
  return db.prepare(
    "UPDATE sessions SET revoked_at = datetime('now') WHERE revoked_at IS NULL"
  ).run().changes;
}

/** Every live entry, joined to its person, for CSV export. */
function allEntriesForExport() {
  return db.prepare(`
    SELECT p.name AS person_name, p.id AS person_id,
           e.id, e.amount, e.description, e.created_at
    FROM entries e
    JOIN people p ON p.id = e.person_id
    WHERE e.deleted_at IS NULL
    ORDER BY p.name COLLATE NOCASE ASC, e.created_at ASC, e.id ASC
  `).all();
}

/* --------------------------------------------------------------------- sure */

/** Every person, archived included: money owed by an archived person is real. */
function listPeopleForMatching() {
  return db.prepare('SELECT id, name, archived_at FROM people ORDER BY name COLLATE NOCASE').all();
}

/**
 * Fold one complete, successful read of Sure into sure_items.
 *
 * Only ever called with the full result of every page. Anything that did not
 * come back is treated as possibly gone -- which is only safe if "did not come
 * back" can never mean "the request failed" or "that page was never fetched".
 *
 * Something is only counted missing if it falls inside the window that was
 * asked for, and only acted on after two reads in a row: paging through a list
 * that is changing underneath can skip a row once, and a skipped row must not
 * look like a deleted one.
 *
 * @param {object[]} items       normalised transactions from this read
 * @param {string}   windowStart YYYY-MM-DD, the earliest date requested
 * @param {Function} suggest     item -> { personId, confident }
 */
function applySureSync({ items, windowStart, suggest }) {
  const run = db.transaction(() => {
    const counts = { new: 0, updated: 0, returned: 0, gonePending: 0, goneAdded: 0 };
    const find = db.prepare('SELECT * FROM sure_items WHERE sure_id = ?');
    const insert = db.prepare(`
      INSERT INTO sure_items
        (sure_id, status, date, amount_cents, name, notes, merchant, account,
         suggested_person_id, suggestion_confident, fingerprint)
      VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const refresh = db.prepare(`
      UPDATE sure_items
      SET date = ?, amount_cents = ?, name = ?, notes = ?, merchant = ?, account = ?,
          suggested_person_id = ?, suggestion_confident = ?, fingerprint = ?,
          missed_polls = 0, gone_at = NULL, last_seen_at = datetime('now')
      WHERE sure_id = ?
    `);

    for (const it of items) {
      const fp = `${it.amount}|${it.date}`;
      const row = find.get(it.id);
      if (!row) {
        const s = suggest(it);
        insert.run(it.id, it.date, it.amount, it.name, it.notes, it.merchant, it.account,
          s.personId, s.confident ? 1 : 0, fp);
        counts.new += 1;
        continue;
      }
      // Suggestions are only recomputed while a decision is still open. Once
      // added, dismissed or detached, what Sure calls it no longer matters.
      let personId = row.suggested_person_id;
      let confident = row.suggestion_confident;
      if (row.status === 'pending') {
        const s = suggest(it);
        personId = s.personId;
        confident = s.confident ? 1 : 0;
      }
      refresh.run(it.date, it.amount, it.name, it.notes, it.merchant, it.account,
        personId, confident, fp, it.id);
      if (row.gone_at) counts.returned += 1;
      else counts.updated += 1;
    }

    const seen = new Set(items.map((i) => i.id));
    const open = db.prepare(`
      SELECT sure_id, status, missed_polls, gone_at FROM sure_items
      WHERE status IN ('pending', 'added') AND date >= ?
    `).all(windowStart);

    for (const row of open) {
      if (seen.has(row.sure_id)) continue;
      const missed = row.missed_polls + 1;
      if (missed < 2) {
        db.prepare('UPDATE sure_items SET missed_polls = ? WHERE sure_id = ?').run(missed, row.sure_id);
      } else if (row.status === 'pending') {
        // Never posted, so nothing to undo: it simply leaves the inbox. This is
        // what happens to the old parts when a split is edited in Sure.
        db.prepare('DELETE FROM sure_items WHERE sure_id = ?').run(row.sure_id);
        counts.gonePending += 1;
      } else {
        db.prepare(`
          UPDATE sure_items SET missed_polls = ?, gone_at = COALESCE(gone_at, datetime('now'))
          WHERE sure_id = ?
        `).run(missed, row.sure_id);
        if (!row.gone_at) counts.goneAdded += 1;
      }
    }
    return counts;
  });
  return run();
}

function getSureItem(sureId) {
  return db.prepare('SELECT * FROM sure_items WHERE sure_id = ?').get(sureId);
}

function setSureItem(sureId, fields) {
  const keys = Object.keys(fields);
  const allowed = ['status', 'entry_id', 'added_fingerprint'];
  for (const k of keys) {
    if (!allowed.includes(k)) throw new Error(`setSureItem: ${k} is not settable`);
  }
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  return db.prepare(`UPDATE sure_items SET ${sets} WHERE sure_id = ?`)
    .run(...keys.map((k) => fields[k]), sureId).changes;
}

function listSurePending() {
  return db.prepare(`
    SELECT s.*, p.name AS suggested_name
    FROM sure_items s
    LEFT JOIN people p ON p.id = s.suggested_person_id
    WHERE s.status = 'pending'
    ORDER BY s.date DESC, s.first_seen_at DESC
  `).all();
}

/**
 * Added items that Sure has since changed. Only live entries count: if the
 * entry was deleted here, there is nothing on a tab left to be wrong.
 */
function listSureChanged() {
  return db.prepare(`
    SELECT s.*, e.amount AS entry_amount, e.created_at AS entry_created_at,
           e.description AS entry_description, p.id AS person_id, p.name AS person_name
    FROM sure_items s
    JOIN entries e ON e.id = s.entry_id AND e.deleted_at IS NULL
    JOIN people p ON p.id = e.person_id
    WHERE s.status = 'added' AND s.gone_at IS NULL
      AND s.added_fingerprint IS NOT NULL AND s.fingerprint <> s.added_fingerprint
    ORDER BY s.date DESC
  `).all();
}

function listSureGone() {
  return db.prepare(`
    SELECT s.*, e.amount AS entry_amount, e.created_at AS entry_created_at,
           e.description AS entry_description, p.id AS person_id, p.name AS person_name
    FROM sure_items s
    JOIN entries e ON e.id = s.entry_id AND e.deleted_at IS NULL
    JOIN people p ON p.id = e.person_id
    WHERE s.status = 'added' AND s.gone_at IS NOT NULL
    ORDER BY s.date DESC
  `).all();
}

function sureAttentionCount() {
  return listSurePending().length + listSureChanged().length + listSureGone().length;
}

/** Entry ids on this person's tab that came from Sure, for a small badge. */
function sureEntryIds(personId) {
  return new Set(db.prepare(`
    SELECT s.entry_id FROM sure_items s
    JOIN entries e ON e.id = s.entry_id
    WHERE e.person_id = ? AND s.status = 'added'
  `).all(personId).map((r) => r.entry_id));
}

/** Run fn inside one SQLite transaction. */
function transaction(fn) {
  return db.transaction(fn)();
}

/**
 * Write a consistent copy of the database to `destination`. Uses SQLite's own
 * backup API rather than copying the file, which would miss whatever is
 * sitting in the write-ahead log.
 */
function backupTo(destination) {
  return db.backup(destination);
}

module.exports = {
  init,
  open,
  ensureSchema,
  migrate,
  get handle() { return db; },
  DB_PATH,
  DATA_DIR,
  newShareToken,
  createPerson,
  listPeopleWithBalances,
  listArchivedPeople,
  archivedSummary,
  getPerson,
  getPersonByToken,
  getBalance,
  listEntries,
  getEntry,
  addEntry,
  updateEntry,
  softDeleteEntry,
  restoreEntry,
  recentDescriptions,
  renamePerson,
  setArchived,
  deletePerson,
  regenerateToken,
  recentActivity,
  ping,
  createSession,
  sessionIsActive,
  revokeSession,
  revokeAllSessions,
  allEntriesForExport,
  listPeopleForMatching,
  applySureSync,
  getSureItem,
  setSureItem,
  listSurePending,
  listSureChanged,
  listSureGone,
  sureAttentionCount,
  sureEntryIds,
  transaction,
  backupTo,
};
