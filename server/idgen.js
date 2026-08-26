'use strict';

const crypto = require('crypto');

/** Characters chosen to avoid visual ambiguity (no 0/O, 1/I/L). */
const ROOM_ID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomFrom(alphabet, length) {
  let out = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

/** Short, shareable room code, e.g. "K3F9QZ". */
function generateRoomId(length = 6) {
  return randomFrom(ROOM_ID_ALPHABET, length);
}

/** Numeric PIN, e.g. "4821". Kept as a string (may have leading digits that look odd as a Number, but never leading zero issues since we compare as strings). */
function generatePin(length = 4) {
  const digits = '0123456789';
  return randomFrom(digits, length);
}

function uid(prefix = 'id') {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

module.exports = {
  generateRoomId,
  generatePin,
  uid,
};
