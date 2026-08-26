'use strict';

const fs = require('fs');
const path = require('path');
const { generatePin } = require('./idgen');
const { db, withTransaction } = require('./db');

/** Old whole-file snapshot from before the SQLite migration — only ever read
 * once, to import any rooms it holds into the `rooms` table on first boot. */
const LEGACY_SNAPSHOT_FILE = path.join(__dirname, '..', 'data', 'auction-snapshot.json');

const selectAllRooms = db.prepare('SELECT room_id, data FROM rooms');
const upsertRoom = db.prepare(`
  INSERT INTO rooms (room_id, data, updated_at) VALUES (@roomId, @data, @updatedAt)
  ON CONFLICT(room_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
`);
const countRooms = db.prepare('SELECT COUNT(*) AS n FROM rooms');

function isValidRoomRecord(r) {
  if (!r || typeof r !== 'object') return false;
  if (!r.state || typeof r.state !== 'object') return false;
  if (!Array.isArray(r.state.players) || !Array.isArray(r.state.teams)) return false;
  if (!r.state.config || typeof r.state.config !== 'object') return false;
  return true;
}

/**
 * Upgrades a schema-v1 record ({state, history}, no room metadata/pins) into a
 * full v2 room record. v1 rooms predate multi-room access control, so they get
 * fresh random PINs and a best-effort `setup` reconstructed from their current
 * state (teams/config only — the original player CSV isn't recoverable, so
 * "Reset auction" on a migrated room will start from an empty player pool).
 */
function migrateLegacyRoom(roomId, legacy) {
  const state = legacy.state;
  const teamNames = state.teams.map((t) => t.name);
  const config = state.config;
  const teamPins = {};
  state.teams.forEach((t) => {
    teamPins[t.id] = { pin: generatePin(), pinVersion: 1 };
  });
  return {
    roomId,
    name: roomId === 'default' ? 'Migrated auction' : roomId,
    createdAt: Date.now(),
    access: { hostPin: generatePin(), hostPinVersion: 1, teamPins },
    setup: { name: roomId, teamNames, config, roleCuts: null, playersMode: 'none', csvText: '', listNames: [] },
    state,
    history: Array.isArray(legacy.history) ? legacy.history : [],
    migratedFromLegacy: true,
  };
}

/**
 * Fills in fields added by later versions of the app (player self-registration
 * support) on rooms that were created/persisted before those fields existed.
 * Safe to run on every load — a no-op for already-current records.
 */
function backfillRoomFields(record) {
  if (!record.access.playerPin) {
    record.access.playerPin = generatePin();
    record.access.playerPinVersion = 1;
  }
  if (!record.settings) {
    record.settings = { playerRegistrationMode: 'approval' };
  }
  if (!Array.isArray(record.pendingPlayers)) record.pendingPlayers = [];
  if (!Array.isArray(record.rejectedAccountIds)) record.rejectedAccountIds = [];
  return record;
}

/**
 * One-time import: if the `rooms` table is empty and the old single-file JSON
 * snapshot from a pre-SQLite install is still on disk, load every room it has
 * into SQLite so upgrading doesn't lose in-flight auctions. Runs at most once
 * per install — after this, the table is never empty again (even a room-less
 * install still has whatever rooms get created going forward), so the legacy
 * file is simply ignored on every later boot.
 */
function importLegacySnapshotIfNeeded() {
  if (countRooms.get().n > 0) return;
  let raw;
  try {
    raw = fs.readFileSync(LEGACY_SNAPSHOT_FILE, 'utf8');
  } catch {
    return;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    console.warn('[auction] Legacy snapshot file is not valid JSON — skipping import.');
    return;
  }
  if (!data || !data.rooms || typeof data.rooms !== 'object') return;

  const rows = [];
  for (const [roomId, record] of Object.entries(data.rooms)) {
    if (!record || typeof record !== 'object') continue;
    if (record.access && record.setup) {
      if (isValidRoomRecord(record)) rows.push([roomId, backfillRoomFields(record)]);
      continue;
    }
    if (isValidRoomRecord(record)) {
      rows.push([roomId, backfillRoomFields(migrateLegacyRoom(roomId, record))]);
    }
  }
  if (!rows.length) return;
  const now = Date.now();
  withTransaction(() => {
    for (const [roomId, record] of rows) {
      upsertRoom.run({ roomId, data: JSON.stringify(record), updatedAt: now });
    }
  });
  console.log(`[auction] Imported ${rows.length} room(s) from the old JSON snapshot into SQLite (${LEGACY_SNAPSHOT_FILE}).`);
}

/**
 * @returns {Object<string, object>} roomId -> full room record
 */
function loadAllRooms() {
  importLegacySnapshotIfNeeded();
  const out = {};
  for (const row of selectAllRooms.all()) {
    try {
      const record = JSON.parse(row.data);
      if (isValidRoomRecord(record)) out[row.room_id] = backfillRoomFields(record);
    } catch {
      console.warn(`[auction] Skipping unreadable room record for ${row.room_id}.`);
    }
  }
  return out;
}

/** Upserts a single room — the normal path, called after every action on that room. */
function saveRoom(roomId, room) {
  upsertRoom.run({ roomId, data: JSON.stringify(room), updatedAt: Date.now() });
}

/**
 * Back-compat bulk save (upserts every room in the map). Prefer saveRoom() for
 * a single changed room — this is only for callers that don't know which
 * room(s) changed.
 * @param {Map<string, object>} roomsMap
 */
function persistAllRooms(roomsMap) {
  const now = Date.now();
  withTransaction(() => {
    for (const [roomId, room] of roomsMap) {
      upsertRoom.run({ roomId, data: JSON.stringify(room), updatedAt: now });
    }
  });
}

module.exports = {
  loadAllRooms,
  saveRoom,
  persistAllRooms,
};
