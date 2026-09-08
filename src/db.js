'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || '/data';
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'iou.db');

let db;

function init() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
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
  `);
  migrate();
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
 */
function listEntries(personId) {
  const rows = db.prepare(`
    SELECT id, amount, description, created_at
    FROM entries
    WHERE person_id = ? AND deleted_at IS NULL
    ORDER BY id ASC
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

function addEntry(personId, amountCents, description) {
  return Number(db.prepare(
    'INSERT INTO entries (person_id, amount, description) VALUES (?, ?, ?)'
  ).run(personId, amountCents, description).lastInsertRowid);
}

function updateEntry(personId, entryId, amountCents, description) {
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

/** Every live entry, joined to its person, for CSV export. */
function allEntriesForExport() {
  return db.prepare(`
    SELECT p.name AS person_name, p.id AS person_id,
           e.id, e.amount, e.description, e.created_at
    FROM entries e
    JOIN people p ON p.id = e.person_id
    WHERE e.deleted_at IS NULL
    ORDER BY p.name COLLATE NOCASE ASC, e.id ASC
  `).all();
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
  allEntriesForExport,
  backupTo,
};
