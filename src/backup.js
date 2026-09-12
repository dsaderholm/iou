'use strict';

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const db = require('./db');

const DIR = path.join(config.dataDir, 'backups');

/**
 * The newest few backups are always kept, whatever day they are from. That is
 * what keeps the snapshot from just before an upgrade alive when the container
 * restarts a few more times the same day.
 */
const RECENT_ALWAYS_KEPT = 3;

const NAME = /^iou-(\d{4}-\d{2}-\d{2})T\d{4}(?:-[a-z-]+)?\.db$/;

/** Local calendar time, so a backup is named for the day it was actually taken. */
function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/**
 * Write a consistent copy of the database into DATA_DIR/backups.
 *
 * Goes through SQLite's backup API rather than copying the file: with WAL on,
 * the .db alone is missing whatever is still in the write-ahead log, so a plain
 * copy can restore to short of where you were.
 *
 * @param {string} [label]  appended to the file name, e.g. "pre-upgrade"
 */
async function runOnce(label = '') {
  fs.mkdirSync(DIR, { recursive: true });
  const suffix = label ? `-${label}` : '';
  const file = path.join(DIR, `iou-${stamp()}${suffix}.db`);
  await db.backupTo(file);
  const kept = prune();
  return { file, kept };
}

/**
 * Retention by day, not by count.
 *
 * Keeping the newest N files let restarts evict history: every start writes a
 * backup, so a dozen restarts in one afternoon pushed out every earlier day.
 * Now each calendar day keeps only its newest file and the newest BACKUP_KEEP
 * days survive, so a burst of restarts collapses into one day's slot. The
 * newest few files are also kept regardless, so a pre-upgrade snapshot is not
 * lost to a later restart on the same day.
 */
function prune() {
  let names;
  try {
    names = fs.readdirSync(DIR).filter((f) => NAME.test(f)).sort();
  } catch {
    return 0;
  }

  const keep = new Set(names.slice(-RECENT_ALWAYS_KEPT));

  // Newest file per day, walking from newest to oldest.
  const newestPerDay = new Map();
  for (const name of [...names].reverse()) {
    const day = name.match(NAME)[1];
    if (!newestPerDay.has(day)) newestPerDay.set(day, name);
  }
  for (const name of [...newestPerDay.values()].slice(0, config.backupKeep)) keep.add(name);

  for (const name of names) {
    if (keep.has(name)) continue;
    try { fs.rmSync(path.join(DIR, name), { force: true }); } catch { /* next time */ }
  }
  return keep.size;
}

/**
 * Start the backup schedule. The first scheduled run comes after one interval;
 * startup takes its own snapshot separately, before migrations, because that
 * one has to happen before the new code changes anything. Returns a stop
 * function.
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

  const timer = setInterval(attempt, config.backupIntervalHours * 60 * 60 * 1000);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { start, runOnce, prune, DIR, RECENT_ALWAYS_KEPT };
