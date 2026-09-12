'use strict';

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const config = require('./config');
const db = require('./db');

const COOKIE = config.cookieName;

/* ------------------------------------------------------------------ cookies */

/** Minimal Cookie header parser. Only the session cookie is ever read. */
function parseCookies(header) {
  const out = Object.create(null);
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ signing */

function sign(payloadB64) {
  return crypto.createHmac('sha256', config.sessionSecret)
    .update(payloadB64).digest('base64url');
}

/**
 * Issue a session. The token is still a signed cookie, but it now names a row
 * in the sessions table, which is what lets logging out actually end it.
 */
function makeToken(username) {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + config.sessionTtlSeconds;
  const sid = crypto.randomBytes(18).toString('base64url');
  db.createSession(sid, exp);
  const payload = { u: username, sid, iat: now, exp };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return body + '.' + sign(body);
}

/** Verify a session token. Returns the payload, or null for anything suspect. */
function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);

  const given = Buffer.from(mac, 'utf8');
  const want = Buffer.from(sign(body), 'utf8');
  if (given.length !== want.length) return null;
  if (!crypto.timingSafeEqual(given, want)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload.u !== 'string') return null;
  if (typeof payload.exp !== 'number') return null;
  if (payload.exp <= Math.floor(Date.now() / 1000)) return null;
  // A session is only valid for the currently configured admin, so rotating
  // ADMIN_USER invalidates every outstanding cookie.
  if (payload.u !== config.adminUser) return null;

  // The signature proves the cookie was issued here; only the table says it has
  // not been revoked since. Checked last, so a forged or expired cookie never
  // costs a query. Tokens from before sessions were tracked carry no sid and
  // are refused, which logs everyone in once more rather than honouring a
  // cookie nothing can revoke.
  if (typeof payload.sid !== 'string' || !payload.sid) return null;
  try {
    if (!db.sessionIsActive(payload.sid)) return null;
  } catch {
    return null; // an unreadable database is not a reason to trust a cookie
  }
  return payload;
}

/* ----------------------------------------------------------------- password */

/**
 * Check submitted credentials. Always runs a bcrypt comparison so a wrong
 * username costs the same time as a wrong password.
 */
async function checkCredentials(username, password) {
  const userOk = safeEqual(String(username == null ? '' : username), config.adminUser);
  let passOk = false;
  try {
    passOk = await bcrypt.compare(String(password == null ? '' : password), config.adminPasswordHash);
  } catch {
    passOk = false; // missing or malformed hash
  }
  return userOk && passOk;
}

/**
 * Whether a string is a well-formed bcrypt hash: "$2<variant>$<cost>$" then 53
 * characters of salt and digest.
 *
 * Worth checking at boot because the usual way to get this wrong is invisible.
 * Compose reads a single "$" as the start of a variable reference, so a hash
 * pasted into a compose file without doubling the dollar signs arrives quietly
 * mangled, and the only symptom is that the correct password stops working.
 */
function looksLikeBcryptHash(value) {
  return /^\$2[abxy]?\$\d{2}\$[./A-Za-z0-9]{53}$/.test(String(value || ''));
}

function safeEqual(a, b) {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  if (ba.length === 0) return true;
  return crypto.timingSafeEqual(ba, bb);
}

/* --------------------------------------------------------------- middleware */

/**
 * Whether this response's cookie should carry Secure. Behind a reverse proxy
 * this reflects X-Forwarded-Proto via Express trust proxy -- that header picks
 * the transport flag only, and never decides who the user is.
 */
function isSecureRequest(req) {
  return req.protocol === 'https';
}

function cookieOptions(req) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureRequest(req),
    path: '/',
  };
}

function setSessionCookie(req, res, username) {
  res.cookie(COOKIE, makeToken(username), {
    ...cookieOptions(req),
    maxAge: config.sessionTtlSeconds * 1000,
  });
}

function clearSessionCookie(req, res) {
  res.clearCookie(COOKIE, cookieOptions(req));
}

/** Populates req.session on every request. Blocks nothing on its own. */
function attachSession(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  req.session = verifyToken(cookies[COOKIE]);
  next();
}

/** Gate for everything except /t/:token, /login and /robots.txt. */
function requireAuth(req, res, next) {
  if (req.session) return next();
  if (req.method === 'GET') {
    const target = typeof req.originalUrl === 'string' && req.originalUrl.startsWith('/')
      ? req.originalUrl
      : '/';
    return res.redirect(303, '/login?next=' + encodeURIComponent(target));
  }
  return res.status(401).type('text/plain').send('Unauthorized');
}

module.exports = {
  parseCookies,
  looksLikeBcryptHash,
  makeToken,
  verifyToken,
  checkCredentials,
  setSessionCookie,
  clearSessionCookie,
  attachSession,
  requireAuth,
  isSecureRequest,
};
