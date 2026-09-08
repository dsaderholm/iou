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
  sessionTtlSeconds: Number(process.env.SESSION_TTL_SECONDS || 60 * 60 * 24 * 365),
  cookieName: process.env.COOKIE_NAME || 'iou_session',
  siteTitle: process.env.SITE_TITLE || 'IOU',
  // Who the money is owed to. Shown on the share page next to the payment links.
  ownerName: process.env.OWNER_NAME || '',
  venmoHandle: cleanHandle(process.env.VENMO_HANDLE, 'venmo.com/', 'www.venmo.com/'),
  paypalMe: cleanHandle(process.env.PAYPAL_ME, 'paypal.me/', 'www.paypal.me/', 'paypal.com/paypalme/'),
  cashappHandle: cleanHandle(process.env.CASHAPP_HANDLE, 'cash.app/', 'cash.me/'),
};

module.exports = config;
