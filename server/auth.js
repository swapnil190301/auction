'use strict';

/**
 * Stateless session tokens for room access.
 *
 * A token is issued after a Room ID + PIN check succeeds (see rooms.js) and is
 * then sent back by the client on every action. It is signed with a server
 * secret (persisted in data/.session-secret, generated on first run) so it
 * cannot be forged, but the server itself never has to remember who is
 * "logged in" — the token carries the room, role, and (for teams) which team.
 *
 * Tokens also carry a `pinVersion`. When a host regenerates a PIN (see
 * rooms.regeneratePin), the stored pinVersion for that role is bumped, which
 * silently invalidates every token issued against the old PIN.
 *
 * The same signing scheme is reused for player *account* tokens (see
 * accounts.js) — those carry `{ kind: 'account', accountId }` instead of
 * `{ roomId, role }`. verifyToken() only checks the signature; each caller
 * validates the shape it expects (see index.js's authorize() vs
 * authorizeAccount()).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SECRET_FILE = path.join(__dirname, '..', 'data', '.session-secret');

function loadOrCreateSecret() {
  try {
    const existing = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // fall through to create
  }
  const secret = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
    fs.writeFileSync(SECRET_FILE, secret, 'utf8');
  } catch (err) {
    console.warn('[auth] Could not persist session secret; tokens will not survive a restart.', err.message);
  }
  return secret;
}

const SECRET = process.env.SESSION_SECRET || loadOrCreateSecret();

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function fromBase64url(input) {
  return Buffer.from(input, 'base64url').toString('utf8');
}

function hmac(body) {
  return crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
}

/**
 * @param {{ roomId: string, role: 'host'|'team', teamId?: string, pinVersion: number }} payload
 * @returns {string}
 */
function signToken(payload) {
  const body = base64url(JSON.stringify({ ...payload, iat: Date.now() }));
  const sig = hmac(body);
  return `${body}.${sig}`;
}

/**
 * Verifies signature + decodes payload. Does NOT assume any particular
 * shape — callers must check the fields they need (e.g. roomId+role for
 * room sessions, kind==='account'+accountId for player account sessions).
 * @param {string} token
 * @returns {null | object}
 */
function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  let expected;
  try {
    expected = hmac(body);
  } catch {
    return null;
  }
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(fromBase64url(body));
    if (!payload || typeof payload !== 'object') return null;
    return payload;
  } catch {
    return null;
  }
}

module.exports = {
  signToken,
  verifyToken,
};
