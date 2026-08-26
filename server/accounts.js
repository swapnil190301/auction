'use strict';

/**
 * Player accounts — a lightweight, self-service identity so a player fills in
 * their profile (name, age, playing role, photo) once and it's reused every
 * time they register for an auction, on any device, by logging back in.
 *
 * This is intentionally minimal: username + password, hashed with scrypt
 * (Node's built-in crypto, no extra dependency). It is not meant to defend
 * against a determined attacker, only to give each player a durable identity
 * across rooms — the same trust level as the room PINs elsewhere in this app.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { uid } = require('./idgen');
const { db, withTransaction } = require('./db');

/** Old whole-file store from before the SQLite migration — only ever read once,
 * to import any accounts it holds into the `accounts` table on first boot. */
const LEGACY_ACCOUNTS_FILE = path.join(__dirname, '..', 'data', 'accounts.json');
const MAX_PHOTO_BYTES = 1_500_000; // ~1.5MB of base64, generous for a downscaled profile photo

/** @type {Map<string, object>} accountId -> account record (includes passwordHash/salt) */
const accounts = new Map();
/** @type {Map<string, string>} lowercase username -> accountId, for fast/legible lookups */
const usernameIndex = new Map();

const selectAllAccounts = db.prepare('SELECT id, data FROM accounts');
const upsertAccount = db.prepare(`
  INSERT INTO accounts (id, username, data, updated_at) VALUES (@id, @username, @data, @updatedAt)
  ON CONFLICT(id) DO UPDATE SET username = excluded.username, data = excluded.data, updated_at = excluded.updated_at
`);
const countAccounts = db.prepare('SELECT COUNT(*) AS n FROM accounts');

/** One-time import from the pre-SQLite accounts.json, same pattern as room snapshots (see auctionPersistence.js). */
function importLegacyAccountsIfNeeded() {
  if (countAccounts.get().n > 0) return;
  let raw;
  try {
    raw = fs.readFileSync(LEGACY_ACCOUNTS_FILE, 'utf8');
  } catch {
    return;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    console.warn('[accounts] Legacy accounts.json is not valid JSON — skipping import.');
    return;
  }
  if (!data || !Array.isArray(data.accounts)) return;
  const valid = data.accounts.filter((a) => a && a.id && a.username);
  if (!valid.length) return;
  const now = Date.now();
  withTransaction(() => {
    for (const acct of valid) {
      upsertAccount.run({ id: acct.id, username: acct.username.toLowerCase(), data: JSON.stringify(acct), updatedAt: now });
    }
  });
  console.log(`[accounts] Imported ${valid.length} account(s) from the old accounts.json into SQLite.`);
}

function loadFromDisk() {
  importLegacyAccountsIfNeeded();
  for (const row of selectAllAccounts.all()) {
    let acct;
    try {
      acct = JSON.parse(row.data);
    } catch {
      continue;
    }
    if (!acct || !acct.id || !acct.username) continue;
    accounts.set(acct.id, acct);
    usernameIndex.set(acct.username.toLowerCase(), acct.id);
  }
}
loadFromDisk();

/** Upserts a single account — the normal path, called whenever one account changes. */
function persist(account) {
  upsertAccount.run({
    id: account.id,
    username: account.username.toLowerCase(),
    data: JSON.stringify(account),
    updatedAt: Date.now(),
  });
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const check = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const a = Buffer.from(check, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function validateUsername(username) {
  const u = String(username || '').trim();
  if (u.length < 3 || u.length > 40) return 'Username must be 3-40 characters.';
  if (!/^[a-zA-Z0-9_.-]+$/.test(u)) return 'Username can only contain letters, numbers, "_", "-", ".".';
  return null;
}

function validatePhoto(photo) {
  if (!photo) return null;
  if (typeof photo !== 'string' || !photo.startsWith('data:image/')) return 'Photo must be an image.';
  if (photo.length > MAX_PHOTO_BYTES) return 'Photo is too large — please use a smaller image.';
  return null;
}

/** Strips secrets before anything ever goes to the client. */
function sanitize(account) {
  if (!account) return null;
  const { passwordHash, passwordSalt, ...safe } = account;
  return safe;
}

/**
 * @param {{username, password, name, age, role, photo}} input
 * @returns {object} sanitized account
 */
function createAccount(input) {
  const username = String(input.username || '').trim();
  const usernameError = validateUsername(username);
  if (usernameError) throw new Error(usernameError);
  if (usernameIndex.has(username.toLowerCase())) throw new Error('That username is already taken.');

  const password = String(input.password || '');
  if (password.length < 4) throw new Error('Password must be at least 4 characters.');

  const name = String(input.name || '').trim();
  if (!name) throw new Error('Name is required.');

  const photoError = validatePhoto(input.photo);
  if (photoError) throw new Error(photoError);

  const age = Number(input.age);
  const { salt, hash } = hashPassword(password);

  const account = {
    id: uid('acct'),
    username,
    passwordSalt: salt,
    passwordHash: hash,
    profile: {
      name,
      age: Number.isFinite(age) && age > 0 ? age : null,
      role: ['Batter', 'Bowler', 'All-rounder'].includes(input.role) ? input.role : '',
      photo: input.photo || '',
    },
    createdAt: Date.now(),
  };
  accounts.set(account.id, account);
  usernameIndex.set(username.toLowerCase(), account.id);
  persist(account);
  return sanitize(account);
}

/**
 * @returns {object|null} sanitized account, or null if credentials are wrong
 */
function login(username, password) {
  const id = usernameIndex.get(String(username || '').trim().toLowerCase());
  if (!id) return null;
  const account = accounts.get(id);
  if (!account) return null;
  if (!verifyPassword(password, account.passwordSalt, account.passwordHash)) return null;
  return sanitize(account);
}

function getAccount(accountId) {
  return sanitize(accounts.get(accountId));
}

module.exports = {
  createAccount,
  login,
  getAccount,
};
