'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = process.env.DATA_DIR || '/data';

/**
 * Resolve the session secret. Prefer the env var; otherwise persist a random
 * one under DATA_DIR so sessions survive a container restart. Written 0600 and
 * created exclusively, so a concurrent first boot can not clobber it.
 */
function resolveSessionSecret() {
  const fromEnv = (process.env.SESSION_SECRET || '').trim();
  if (fromEnv) return fromEnv;

  const secretPath = path.join(DATA_DIR, 'session_secret');
  try {
    const existing = fs.readFileSync(secretPath, 'utf8').trim();
    if (existing) return existing;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const generated = crypto.randomBytes(32).toString('base64url');
  try {
    fs.writeFileSync(secretPath, generated + '\n', { mode: 0o600, flag: 'wx' });
    console.log('[iou] generated a new SESSION_SECRET at ' + secretPath);
    return generated;
  } catch (err) {
    if (err.code === 'EEXIST') return fs.readFileSync(secretPath, 'utf8').trim();
    throw err;
  }
}

/**
 * setInterval stores its delay as a signed 32-bit millisecond count. Anything
 * longer -- or NaN -- is silently replaced with 1 ms, which would turn a
 * scheduled backup into a full database copy every millisecond. 596 hours is
 * the longest interval that fits.
 */
const MAX_TIMER_HOURS = Math.floor(2147483647 / (60 * 60 * 1000));

/**
 * Read a whole-number setting. A value that is not a whole number in range is
 * reported and replaced with the default, rather than passed through as NaN:
 * Math.max(1, NaN) is NaN, so a clamp alone does not protect anything.
 */
function envInteger(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n) || n < min || n > max) {
    console.warn(`[iou] ignoring ${name}=${JSON.stringify(raw)}: expected a whole number`
      + ` from ${min} to ${max}. Using ${fallback}.`);
    return fallback;
  }
  return n;
}

/**
 * How many reverse proxies sit in front of the app. Express takes the client
 * address from X-Forwarded-For, and "true" means trusting every entry in it --
 * including the left-most, which the client writes itself. That let anyone
 * choose their own IP, walk straight past the per-IP login limit, and exhaust
 * the global one to lock the owner out. A hop count takes the address the
 * nearest trusted proxy appended, which a client cannot forge.
 */
function parseTrustProxy(raw) {
  const v = raw === undefined ? '' : String(raw).trim();
  if (v === '') return 1;
  if (v === 'false') return false;
  if (v === 'true') return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v; // an address, a subnet list, or an Express keyword like "loopback"
}

/** Strip a handle down to the bare username the payment URLs expect. */
function cleanHandle(raw, ...stripPrefixes) {
  let v = (raw || '').trim();
  if (!v) return null;
  v = v.replace(/^https?:\/\//i, '');
  for (const prefix of stripPrefixes) {
    if (v.toLowerCase().startsWith(prefix)) v = v.slice(prefix.length);
  }
  v = v.replace(/^[@$]/, '').replace(/\/+$/, '').trim();
  return v || null;
}

const config = {
  port: Number(process.env.PORT || 3000),
  dataDir: DATA_DIR,
  adminUser: process.env.ADMIN_USER || '',
  adminPasswordHash: process.env.ADMIN_PASSWORD_HASH || '',
  // Convenience for pasted compose stacks: a plaintext password that gets
  // hashed once at boot. ADMIN_PASSWORD_HASH wins when both are present.
  adminPassword: process.env.ADMIN_PASSWORD || '',
  sessionSecret: resolveSessionSecret(),
  // A year. The threat this cookie defends against is someone holding your
  // unlocked phone, which a shorter window does not change; all a 30 day
  // window bought was a long password typed on a phone keyboard every month.
  sessionTtlSeconds: envInteger('SESSION_TTL_SECONDS', 60 * 60 * 24 * 365, 60, 60 * 60 * 24 * 3650),
  cookieName: process.env.COOKIE_NAME || 'iou_session',
  siteTitle: process.env.SITE_TITLE || 'IOU',
  // Who the money is owed to. Shown on the share page next to the payment links.
  ownerName: process.env.OWNER_NAME || '',
  // Read-only JSON for dashboards and finance tools. Unset disables the route
  // entirely rather than leaving it open.
  apiToken: (process.env.API_TOKEN || '').trim(),

  // Automatic backups into DATA_DIR/backups. One runs at boot, which makes
  // every container restart -- and so every upgrade -- take a snapshot first.
  backupEnabled: (process.env.BACKUP_ENABLED || 'true') !== 'false',
  backupKeep: envInteger('BACKUP_KEEP', 14, 1, 3650),
  backupIntervalHours: envInteger('BACKUP_INTERVAL_HOURS', 24, 1, MAX_TIMER_HOURS),

  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),

  venmoHandle: cleanHandle(process.env.VENMO_HANDLE, 'venmo.com/', 'www.venmo.com/'),
  paypalMe: cleanHandle(process.env.PAYPAL_ME, 'paypal.me/', 'www.paypal.me/', 'paypal.com/paypalme/'),
  cashappHandle: cleanHandle(process.env.CASHAPP_HANDLE, 'cash.app/', 'cash.me/'),
};

module.exports = config;
module.exports.parseTrustProxy = parseTrustProxy;
module.exports.MAX_TIMER_HOURS = MAX_TIMER_HOURS;
