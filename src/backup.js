'use strict';

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const db = require('./db');

const DIR = path.join(config.dataDir, 'backups');

/** Local calendar date, so a backup is named the day it was actually taken. */
function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/**
 * Write a consistent copy of the database into DATA_DIR/backups.
 *
 * Goes through SQLite's backup API rather than copying the file: with WAL on,
 * the .db alone is missing whatever is still in the write-ahead log, so a
 * plain copy can restore to short of where you were.
 */
async function runOnce() {
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, `iou-${stamp()}.db`);
  await db.backupTo(file);
  const kept = prune();
  return { file, kept };
}

/** Keep the newest N backups and delete the rest. */
function prune() {
  let entries;
  try {
    entries = fs.readdirSync(DIR).filter((f) => /^iou-.*\.db$/.test(f)).sort();
  } catch {
    return 0;
  }
  const doomed = entries.slice(0, Math.max(0, entries.length - config.backupKeep));
  for (const name of doomed) {
    try { fs.rmSync(path.join(DIR, name), { force: true }); } catch { /* next time */ }
  }
  return entries.length - doomed.length;
}

/**
 * Start the backup loop. One runs immediately, which means every restart --
 * and so every image upgrade -- takes a snapshot before the new code touches
 * anything. Returns a stop function.
 */
function start() {
  if (!config.backupEnabled) {
    console.log('[iou] automatic backups are off (BACKUP_ENABLED=false)');
    return () => {};
  }

  const attempt = () => {
    runOnce()
      .then(({ file, kept }) => {
        console.log(`[iou] backup ${path.basename(file)} (keeping ${kept})`);
      })
      .catch((err) => {
        // A failed backup must never take the app down with it.
        console.error(`[iou] backup failed: ${err.message}`);
      });
  };

  attempt();
  const timer = setInterval(attempt, config.backupIntervalHours * 60 * 60 * 1000);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { start, runOnce, prune, DIR };
