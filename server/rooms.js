'use strict';

/**
 * In-memory room registry, backed by auctionPersistence for durability.
 *
 * A "room" bundles:
 *  - access: { hostPin, hostPinVersion, teamPins: {...}, playerPin, playerPinVersion }
 *  - settings: { playerRegistrationMode: 'approval' | 'auto' }
 *  - setup:  the normalized create-room submission (teamNames/config/CSV or list) —
 *            kept so "reset" can rebuild the exact same starting position later.
 *  - state:  the live auctionLogic state (players, teams, bids, phase...)
 *  - history: undo stack for auctionLogic.processAction
 *  - pendingPlayers: [{ id, accountId, name, age, role, photo, submittedAt }] —
 *            self-registrations awaiting host approval (only used when
 *            playerRegistrationMode is 'approval'). Deliberately kept OUTSIDE
 *            `state` so it is never sent to spectators/teams via publicState().
 *  - rejectedAccountIds: string[] — accounts the host declined, so a fresh
 *            registration attempt can be told why instead of silently vanishing.
 *
 * Nothing about a room's teams, players, purse, or PINs is hardcoded anywhere
 * in this module — every field above comes from whatever was submitted to
 * createRoom(), generated randomly (PINs, room id), or produced deterministically
 * by auctionLogic/roomSetup from that submission, or (for self-registered
 * players) copied from the registering player's own account profile.
 */

const { defaultConfig, ROLE_PURSE_CUT, tiers } = require('./auctionConfig');
const { normalizeSetup, buildFromSetup } = require('./roomSetup');
const { makeInitialState, processAction } = require('./auctionLogic');
const { generateRoomId, generatePin, uid } = require('./idgen');
const { loadAllRooms, saveRoom } = require('./auctionPersistence');

const REGISTRATION_MODES = ['approval', 'auto'];
const DEFAULT_SELF_REGISTER_TIER = 'C';

/** @type {Map<string, object>} roomId -> room record */
const rooms = new Map();

function loadFromDisk() {
  const saved = loadAllRooms();
  for (const [roomId, record] of Object.entries(saved)) {
    rooms.set(roomId, record);
  }
}
loadFromDisk();

/** Persists only the one room that changed — a single SQLite row upsert, not a full rewrite. */
function persist(roomId) {
  const room = rooms.get(roomId);
  if (room) saveRoom(roomId, room);
}

function roomExists(roomId) {
  return rooms.has(String(roomId || ''));
}

function getRoom(roomId) {
  return rooms.get(String(roomId || '')) || null;
}

function newRoomId() {
  let id = generateRoomId();
  let guard = 0;
  while (rooms.has(id) && guard < 20) {
    id = generateRoomId();
    guard++;
  }
  return id;
}

/**
 * @param {object} input - see roomSetup.normalizeSetup for shape
 * @param {{ hostPin?: string, teamPins?: string[] }} [access]
 * @returns {{ roomId: string, room: object }}
 */
function createRoom(input, access = {}) {
  const { setup, built } = normalizeSetup(input, { defaultConfig, ROLE_PURSE_CUT });
  const state = makeInitialState(setup.config, setup.teamNames, built);

  const roomId = newRoomId();
  const hostPin = String(access.hostPin || generatePin()).slice(0, 12);
  const teamPins = {};
  state.teams.forEach((team, idx) => {
    const supplied = Array.isArray(access.teamPins) ? access.teamPins[idx] : null;
    teamPins[team.id] = { pin: String(supplied || generatePin()).slice(0, 12), pinVersion: 1 };
  });
  const playerPin = String(access.playerPin || generatePin()).slice(0, 12);
  const playerRegistrationMode = REGISTRATION_MODES.includes(input.playerRegistrationMode)
    ? input.playerRegistrationMode
    : 'approval';

  const room = {
    roomId,
    name: setup.name,
    createdAt: Date.now(),
    access: { hostPin, hostPinVersion: 1, teamPins, playerPin, playerPinVersion: 1 },
    settings: { playerRegistrationMode },
    setup,
    state,
    history: [],
    pendingPlayers: [],
    rejectedAccountIds: [],
  };
  rooms.set(roomId, room);
  persist(roomId);
  return { roomId, room };
}

/**
 * Note: the player PIN is deliberately NOT checked here — it doesn't grant a
 * host/team session, it only unlocks the self-registration endpoint (see
 * registerPlayer below), which is a materially different, more limited action.
 * @returns {null | { role: 'host' } | { role: 'team', teamId: string, teamName: string }}
 */
function verifyPin(roomId, pin) {
  const room = getRoom(roomId);
  if (!room) return null;
  const p = String(pin || '');
  if (p && room.access.hostPin === p) {
    return { role: 'host', pinVersion: room.access.hostPinVersion };
  }
  for (const team of room.state.teams) {
    const entry = room.access.teamPins[team.id];
    if (entry && p && entry.pin === p) {
      return { role: 'team', teamId: team.id, teamName: team.name, pinVersion: entry.pinVersion };
    }
  }
  return null;
}

function currentPinVersion(room, role, teamId) {
  if (role === 'host') return room.access.hostPinVersion;
  const entry = room.access.teamPins[teamId];
  return entry ? entry.pinVersion : -1;
}

/** @param {'host'|'player'|string} target - 'host', 'player', or a teamId */
function regeneratePin(roomId, target) {
  const room = getRoom(roomId);
  if (!room) return null;
  if (target === 'host') {
    room.access.hostPin = generatePin();
    room.access.hostPinVersion += 1;
    persist(roomId);
    return { pin: room.access.hostPin };
  }
  if (target === 'player') {
    room.access.playerPin = generatePin();
    room.access.playerPinVersion += 1;
    persist(roomId);
    return { pin: room.access.playerPin };
  }
  const entry = room.access.teamPins[target];
  if (!entry) return null;
  entry.pin = generatePin();
  entry.pinVersion += 1;
  persist(roomId);
  return { pin: entry.pin };
}

function hostPinInfo(roomId) {
  const room = getRoom(roomId);
  if (!room) return null;
  return {
    hostPin: room.access.hostPin,
    playerPin: room.access.playerPin,
    settings: room.settings,
    teams: room.state.teams.map((t) => ({
      teamId: t.id,
      name: t.name,
      pin: room.access.teamPins[t.id] ? room.access.teamPins[t.id].pin : '',
    })),
  };
}

function setRegistrationMode(roomId, mode) {
  const room = getRoom(roomId);
  if (!room) return null;
  if (!REGISTRATION_MODES.includes(mode)) return null;
  room.settings.playerRegistrationMode = mode;
  persist(roomId);
  return room.settings;
}

function pendingPlayers(roomId) {
  const room = getRoom(roomId);
  return room ? room.pendingPlayers : null;
}

/**
 * A player who has already registered for this room, given their account —
 * checks both the live queue/roster and the pending list, so the join/registration
 * screen can say "you're already in" instead of letting them submit twice.
 */
function findExistingRegistration(room, accountId) {
  const inState = room.state.players.find((p) => p.accountId === accountId);
  if (inState) return { where: 'state', player: inState };
  const inPending = room.pendingPlayers.find((p) => p.accountId === accountId);
  if (inPending) return { where: 'pending', entry: inPending };
  return null;
}

/**
 * Self-registration entry point: a logged-in player submitting their PIN.
 * Auction-specific values (tier, base price, and ultimately team + sale price)
 * are never set by the player — only by the host, either now (auto mode, a
 * safe default tier) or later via approvePlayer (approval mode).
 *
 * A player's *account* profile (name/age/photo/default role) is a durable,
 * cross-tournament identity — but the playing role itself is allowed to vary
 * per room (a bowler in one tournament might register as an all-rounder in
 * another), so `overrides.role`/`overrides.age` can adjust just this room's
 * entry without touching the saved account.
 * @param {string} roomId
 * @param {string} pin
 * @param {{id:string, profile:{name,age,role,photo}}} account
 * @param {{ role?: string, age?: number }} [overrides]
 */
function registerPlayer(roomId, pin, account, overrides = {}) {
  const room = getRoom(roomId);
  if (!room) return { ok: false, error: 'Room not found.' };
  if (String(pin || '') !== room.access.playerPin) return { ok: false, error: 'Incorrect player PIN.' };

  const existing = findExistingRegistration(room, account.id);
  if (existing) {
    return existing.where === 'pending'
      ? { ok: true, status: 'pending' }
      : { ok: true, status: 'registered', playerId: existing.player.id };
  }

  // A previous rejection doesn't lock someone out forever — a fresh attempt clears it.
  room.rejectedAccountIds = room.rejectedAccountIds.filter((id) => id !== account.id);

  const { name, photo } = account.profile || {};
  const role = ['Batter', 'Bowler', 'All-rounder'].includes(overrides.role) ? overrides.role : account.profile.role;
  const overrideAge = Number(overrides.age);
  const age = Number.isFinite(overrideAge) && overrideAge > 0 ? overrideAge : account.profile.age;

  if (room.settings.playerRegistrationMode === 'auto') {
    const result = processAction(room.state, room.history, 'addPlayer', {
      name,
      role,
      tier: DEFAULT_SELF_REGISTER_TIER,
      image: photo || '',
      age,
      accountId: account.id,
    });
    if (!result.ok) return result;
    room.state = result.state;
    room.history = result.history;
    persist(roomId);
    const added = room.state.players[room.state.players.length - 1];
    return { ok: true, status: 'registered', state: room.state, playerId: added.id };
  }

  room.pendingPlayers.push({
    id: uid('reg'),
    accountId: account.id,
    name,
    age: age || null,
    role: role || '',
    photo: photo || '',
    submittedAt: Date.now(),
  });
  persist(roomId);
  return { ok: true, status: 'pending' };
}

/**
 * @returns {{ status: 'not_registered'|'pending'|'rejected'|'in_pool', player?: object }}
 */
function myRegistrationStatus(roomId, accountId) {
  const room = getRoom(roomId);
  if (!room) return { status: 'not_registered' };
  const inState = room.state.players.find((p) => p.accountId === accountId);
  if (inState) return { status: 'in_pool', player: inState };
  const inPending = room.pendingPlayers.find((p) => p.accountId === accountId);
  if (inPending) return { status: 'pending' };
  if (room.rejectedAccountIds.includes(accountId)) return { status: 'rejected' };
  return { status: 'not_registered' };
}

/**
 * @param {string} tier - one of auctionConfig.tiers; the host picks this, never the player.
 */
function approvePendingPlayer(roomId, pendingId, tier) {
  const room = getRoom(roomId);
  if (!room) return { ok: false, error: 'Room not found.' };
  const idx = room.pendingPlayers.findIndex((p) => p.id === pendingId);
  if (idx < 0) return { ok: false, error: 'That registration is no longer pending.' };
  const entry = room.pendingPlayers[idx];
  const chosenTier = tiers.includes(tier) ? tier : DEFAULT_SELF_REGISTER_TIER;

  const result = processAction(room.state, room.history, 'addPlayer', {
    name: entry.name,
    role: entry.role,
    tier: chosenTier,
    image: entry.photo || '',
    age: entry.age,
    accountId: entry.accountId,
  });
  if (!result.ok) return result;
  room.state = result.state;
  room.history = result.history;
  room.pendingPlayers.splice(idx, 1);
  persist(roomId);
  return { ok: true, state: room.state };
}

function rejectPendingPlayer(roomId, pendingId) {
  const room = getRoom(roomId);
  if (!room) return { ok: false, error: 'Room not found.' };
  const idx = room.pendingPlayers.findIndex((p) => p.id === pendingId);
  if (idx < 0) return { ok: false, error: 'That registration is no longer pending.' };
  const [entry] = room.pendingPlayers.splice(idx, 1);
  if (!room.rejectedAccountIds.includes(entry.accountId)) {
    room.rejectedAccountIds.push(entry.accountId);
  }
  persist(roomId);
  return { ok: true };
}

/** Sanitized state for anyone (spectators included) — never carries PINs. */
function publicState(roomId) {
  const room = getRoom(roomId);
  return room ? room.state : null;
}

function publicRoomInfo(roomId) {
  const room = getRoom(roomId);
  if (!room) return null;
  return {
    roomId: room.roomId,
    name: room.name,
    phase: room.state.phase,
    teamCount: room.state.teams.length,
  };
}

/**
 * Runs a room action. 'reset' is special-cased here because rebuilding a room
 * requires its stored setup, which auctionLogic.processAction never sees.
 */
function runAction(roomId, action, payload) {
  const room = getRoom(roomId);
  if (!room) return { ok: false, error: 'Room not found.' };

  if (action === 'reset') {
    try {
      const built = buildFromSetup(room.setup);
      room.state = makeInitialState(room.setup.config, room.setup.teamNames, built);
      room.history = [];
    } catch (err) {
      return { ok: false, error: `Could not reset room: ${err.message}` };
    }
    room.state.message = 'Auction reset';
    persist(roomId);
    return { ok: true, state: room.state };
  }

  const result = processAction(room.state, room.history, action, payload || {});
  if (!result.ok) return result;
  room.state = result.state;
  room.history = result.history;
  persist(roomId);
  return { ok: true, state: room.state };
}

module.exports = {
  createRoom,
  roomExists,
  getRoom,
  verifyPin,
  currentPinVersion,
  regeneratePin,
  hostPinInfo,
  setRegistrationMode,
  pendingPlayers,
  registerPlayer,
  myRegistrationStatus,
  approvePendingPlayer,
  rejectPendingPlayer,
  publicState,
  publicRoomInfo,
  runAction,
};
