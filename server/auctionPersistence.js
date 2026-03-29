'use strict';

const fs = require('fs');
const path = require('path');

const SNAPSHOT_FILE = path.join(__dirname, '..', 'data', 'auction-snapshot.json');

function isValidSnapshot(saved) {
  const s = saved && saved.state;
  if (!s || typeof s !== 'object') return false;
  if (!Array.isArray(s.players) || !Array.isArray(s.teams)) return false;
  if (!s.config || typeof s.config !== 'object') return false;
  return true;
}

/**
 * @param {string} roomId
 * @returns {{ state: object, history: object[] } | null}
 */
function loadRoom(roomId) {
  try {
    const raw = fs.readFileSync(SNAPSHOT_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (!data || !data.rooms || typeof data.rooms !== 'object') return null;
    const saved = data.rooms[roomId];
    if (!saved || !isValidSnapshot(saved)) return null;
    return {
      state: saved.state,
      history: Array.isArray(saved.history) ? saved.history : [],
    };
  } catch {
    return null;
  }
}

/**
 * Merge in-memory rooms with existing file so idle rooms are not dropped.
 * @param {Map<string, { state: object, history: object[] }>} roomsMap
 */
function persistAllRooms(roomsMap) {
  let existing = {};
  try {
    const raw = fs.readFileSync(SNAPSHOT_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data && data.rooms && typeof data.rooms === 'object') {
      existing = data.rooms;
    }
  } catch {
    // no file or invalid — start from empty merge
  }
  const merged = { ...existing };
  for (const [id, r] of roomsMap) {
    merged[id] = {
      state: r.state,
      history: r.history,
    };
  }
  fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true });
  const payload = JSON.stringify({ version: 1, rooms: merged }, null, 0);
  fs.writeFileSync(SNAPSHOT_FILE, payload, 'utf8');
}

module.exports = {
  SNAPSHOT_FILE,
  loadRoom,
  persistAllRooms,
};
