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
  return db;
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

/** All people with their current balance, biggest debtor first. */
function listPeopleWithBalances() {
  return db.prepare(`
    SELECT p.id, p.name, p.share_token, p.created_at,
           COALESCE(SUM(e.amount), 0) AS balance,
           COUNT(e.id)                AS entry_count
    FROM people p
    LEFT JOIN entries e ON e.person_id = p.id
    GROUP BY p.id
    ORDER BY balance DESC, p.name COLLATE NOCASE ASC
  `).all();
}

function getPerson(id) {
  return db.prepare('SELECT * FROM people WHERE id = ?').get(id);
}

function getPersonByToken(token) {
  return db.prepare('SELECT * FROM people WHERE share_token = ?').get(token);
}

function getBalance(personId) {
  const row = db.prepare(
    'SELECT COALESCE(SUM(amount), 0) AS balance FROM entries WHERE person_id = ?'
  ).get(personId);
  return row.balance;
}

/**
 * Entries for one person, oldest first, each carrying the running balance as of
 * that entry. Callers that want newest-first reverse the result; the running
 * balance has to be accumulated in chronological order either way.
 */
function listEntries(personId) {
  const rows = db.prepare(`
    SELECT id, amount, description, created_at
    FROM entries
    WHERE person_id = ?
    ORDER BY id ASC
  `).all(personId);
  let running = 0;
  for (const row of rows) {
    running += row.amount;
    row.running_balance = running;
  }
  return rows;
}

function addEntry(personId, amountCents, description) {
  const info = db.prepare(
    'INSERT INTO entries (person_id, amount, description) VALUES (?, ?, ?)'
  ).run(personId, amountCents, description);
  return Number(info.lastInsertRowid);
}

function deleteEntry(personId, entryId) {
  return db.prepare('DELETE FROM entries WHERE id = ? AND person_id = ?')
    .run(entryId, personId).changes;
}

function renamePerson(id, name) {
  return db.prepare('UPDATE people SET name = ? WHERE id = ?').run(name, id).changes;
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

/** Every entry in the database, joined to its person, for CSV export. */
function allEntriesForExport() {
  return db.prepare(`
    SELECT p.name AS person_name, p.id AS person_id,
           e.id, e.amount, e.description, e.created_at
    FROM entries e
    JOIN people p ON p.id = e.person_id
    ORDER BY p.name COLLATE NOCASE ASC, e.id ASC
  `).all();
}

module.exports = {
  init,
  get handle() { return db; },
  DB_PATH,
  DATA_DIR,
  newShareToken,
  createPerson,
  listPeopleWithBalances,
  getPerson,
  getPersonByToken,
  getBalance,
  listEntries,
  addEntry,
  deleteEntry,
  renamePerson,
  deletePerson,
  regenerateToken,
  allEntriesForExport,
};
