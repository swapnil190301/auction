'use strict';

const path = require('path');
const { roles, tiers, ROLE_PURSE_CUT } = require('./auctionConfig');
const { assignPlayerImages } = require('./playerImages');
const { uid } = require('./idgen');

const IMAGES_DIR = path.join(__dirname, '..', 'images');

const deepClone = (obj) => JSON.parse(JSON.stringify(obj));

function cleanName(s) {
  return String(s || '').replace(/^\s*\d+\s*[).:-]?\s*/, '').trim();
}

function inferTier(i) {
  return tiers[i % tiers.length];
}

function inferRole(i) {
  return roles[i % roles.length];
}

/** Reads base price for a tier from the *room's own* config, never a global default. */
function inferBase(tier, config) {
  return (config && config.basePrices && config.basePrices[tier]) || 0;
}

/** Reads bid increment for a tier from the *room's own* config, never a global default. */
function inferIncrement(tier, config) {
  return (config && config.increments && config.increments[tier]) || 0;
}

/**
 * Builds the `teams` array for a fresh room from its (already-validated) setup pieces.
 * Pure function of its arguments — no filesystem/config reads — so every room's
 * teams/purses/rosters come only from what was submitted when the room was created.
 * @param {string[]} teamNames
 * @param {number} defaultPurse
 * @param {Array[]} rostersPreset - per-team array of pre-retained players (owner/captain/icon), or null
 * @param {number[]} teamPurses - per-team starting purse after retained-role deductions, or null
 */
function makeTeamsFromSetup(teamNames, defaultPurse, rostersPreset = null, teamPurses = null) {
  return teamNames.map((name, idx) => ({
    id: `team-${idx + 1}`,
    name,
    purse: teamPurses && Number.isFinite(teamPurses[idx]) ? teamPurses[idx] : defaultPurse,
    roster: rostersPreset && rostersPreset[idx] ? rostersPreset[idx] : [],
  }));
}

/**
 * Assembles a full auction state from a room's config + team names + the
 * players/queue/rosters produced by roomSetup.buildFromSetup(). This is the
 * only place a room's state is created, whether at room creation or on
 * "Reset auction" — both call it with the room's own stored setup.
 * @param {object} config - { purse, basePrices, increments, teamSize }
 * @param {string[]} teamNames
 * @param {{ players, queue, teamsRosterTemplate, teamPurses }} built
 */
function makeInitialState(config, teamNames, built) {
  const { players, queue, teamsRosterTemplate, teamPurses } = built;
  const firstAuction = players.find((p) => p.status !== 'retained');
  return {
    config: deepClone(config),
    players,
    teams: makeTeamsFromSetup(teamNames, config.purse, teamsRosterTemplate, teamPurses),
    queue,
    unsoldQueue: [],
    currentPlayerId: queue[0] || '',
    highestBid: 0,
    highestTeamId: '',
    phase: 'setup',
    bidHistory: [],
    selectedPlayerId: firstAuction ? firstAuction.id : '',
    message: 'Ready to start the auction.',
    search: '',
  };
}

function currentPlayer(state) {
  return state.players.find((p) => p.id === state.currentPlayerId) || null;
}

function leadingTeam(state) {
  return state.teams.find((t) => t.id === state.highestTeamId) || null;
}

function nextBidAmount(state) {
  const p = currentPlayer(state);
  if (!p) return 0;
  return state.highestBid > 0 ? state.highestBid + inferIncrement(p.tier, state.config) : p.basePrice;
}

/**
 * After winning the current lot at some price, a team must still afford their remaining
 * squad slots at the cheapest possible future prices (sum of k smallest base prices among
 * players not yet sold, excluding the current lot — the bid pays for that player).
 */
function minPurseReserveForFutureSlots(state, team, currentPlayerId) {
  const teamSize = state.config.teamSize;
  const slotsAfterThisWin = team.roster.length + 1;
  const stillNeeded = teamSize - slotsAfterThisWin;
  if (stillNeeded <= 0) return 0;
  const candidates = state.players
    .filter(
      (pl) =>
        pl.status !== 'sold' &&
        pl.status !== 'retained' &&
        pl.id !== currentPlayerId
    )
    .map((pl) => pl.basePrice)
    .sort((a, b) => a - b);
  if (candidates.length < stillNeeded) {
    return Number.POSITIVE_INFINITY;
  }
  return candidates.slice(0, stillNeeded).reduce((s, x) => s + x, 0);
}

function maxAffordableBid(state, team) {
  const p = currentPlayer(state);
  if (!p) return 0;
  const reserve = minPurseReserveForFutureSlots(state, team, p.id);
  if (!Number.isFinite(reserve)) return 0;
  return Math.max(0, team.purse - reserve);
}

function advanceAfterCurrent(prev, nextPlayerPatch, addToUnsold = false) {
  const currentId = prev.currentPlayerId;
  let players = prev.players.map((p) => (p.id === currentId ? nextPlayerPatch : p));
  let queue = prev.queue.filter((id) => id !== currentId);
  let unsoldQueue = [...prev.unsoldQueue];
  if (addToUnsold) {
    unsoldQueue = [...unsoldQueue.filter((id) => id !== currentId), currentId];
  }
  let currentPlayerId = '';
  let phase = prev.phase;
  if (queue.length > 0) {
    currentPlayerId = queue[0];
  } else if (unsoldQueue.length > 0) {
    queue = [...unsoldQueue];
    unsoldQueue = [];
    currentPlayerId = queue[0] || '';
    phase = 'running';
  } else {
    phase = 'complete';
    currentPlayerId = '';
  }
  return {
    ...prev,
    players,
    queue,
    unsoldQueue,
    currentPlayerId,
    highestBid: 0,
    highestTeamId: '',
    bidHistory: [],
    phase,
  };
}

/**
 * @returns {{ ok: true, state: object, history: object[] } | { ok: false, error: string }}
 */
function processAction(state, history, action, payload = {}) {
  const pushHistory = (snap) => {
    history.push(deepClone(snap));
  };

  switch (action) {
    case 'bid': {
      const { teamId, customAmount = null } = payload;
      const p = currentPlayer(state);
      if (!p || p.status === 'retained' || state.phase !== 'running') {
        return { ok: false, error: 'Auction is not running or no current player.' };
      }
      const team = state.teams.find((t) => t.id === teamId);
      if (!team) return { ok: false, error: 'Invalid team.' };
      if (team.roster.length >= state.config.teamSize) {
        return { ok: false, error: `${team.name} already has ${state.config.teamSize} players.` };
      }
      if (state.highestBid > 0 && teamId === state.highestTeamId) {
        return { ok: false, error: `${team.name} cannot bid twice in a row — another team must bid first.` };
      }
      const amount = customAmount == null ? nextBidAmount(state) : Number(customAmount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return { ok: false, error: 'Invalid bid amount.' };
      }
      const minAllowed = nextBidAmount(state);
      if (amount < minAllowed) {
        return { ok: false, error: `Bid must be at least ${minAllowed}.` };
      }
      if (team.purse < amount) {
        return { ok: false, error: `${team.name} does not have enough purse.` };
      }
      const reserve = minPurseReserveForFutureSlots(state, team, p.id);
      if (!Number.isFinite(reserve)) {
        return {
          ok: false,
          error: `${team.name} cannot bid: not enough unsold players left in the pool to fill your remaining squad slots.`,
        };
      }
      const cap = team.purse - reserve;
      if (amount > cap) {
        const n = state.config.teamSize - team.roster.length - 1;
        const slotWord = n === 1 ? 'slot' : 'slots';
        return {
          ok: false,
          error: `${team.name} must reserve ${reserve} to fill the remaining ${n} ${slotWord}; max bid ${cap} (purse ${team.purse}).`,
        };
      }
      pushHistory(state);
      const nextState = {
        ...state,
        highestBid: amount,
        highestTeamId: teamId,
        bidHistory: [
          {
            id: uid('bid'),
            playerId: p.id,
            playerName: p.name,
            teamId,
            teamName: team.name,
            amount,
            time: Date.now(),
          },
          ...state.bidHistory,
        ],
        phase: 'running',
        message: `${team.name} bid ${amount} for ${p.name}`,
      };
      return { ok: true, state: nextState, history };
    }

    case 'sell': {
      const p = currentPlayer(state);
      const team = leadingTeam(state);
      if (!p || p.status === 'retained' || !team || !state.highestBid) {
        return { ok: false, error: 'Nothing to sell.' };
      }
      const sold = { ...p, status: 'sold', soldTo: team.name, soldPrice: state.highestBid };
      const teams = state.teams.map((t) =>
        t.id === team.id
          ? { ...t, purse: t.purse - state.highestBid, roster: [...t.roster, sold] }
          : t
      );
      const withTeams = { ...state, teams };
      const nextState = advanceAfterCurrent(withTeams, sold, false);
      return {
        ok: true,
        state: { ...nextState, message: `${p.name} sold to ${team.name} for ${state.highestBid}` },
        history,
      };
    }

    case 'markUnsold':
    case 'skip': {
      const p = currentPlayer(state);
      if (!p || p.status === 'retained') return { ok: false, error: 'No current player.' };
      const reason = action === 'skip' ? 'Skipped' : (payload.reason || '');
      pushHistory(state);
      const unsold = { ...p, status: 'unsold', soldTo: '', soldPrice: 0 };
      const nextState = advanceAfterCurrent(state, unsold, true);
      return {
        ok: true,
        state: {
          ...nextState,
          message: `${p.name} moved to unsold pool${reason ? ` (${reason})` : ''}`,
        },
        history,
      };
    }

    case 'startAuction': {
      let currentPlayerId = state.currentPlayerId;
      if (!currentPlayerId) {
        currentPlayerId = state.queue[0] || state.unsoldQueue[0] || '';
      }
      return {
        ok: true,
        state: {
          ...state,
          currentPlayerId,
          phase: 'running',
          message: 'Auction started',
        },
        history,
      };
    }

    case 'pauseResume': {
      const nextPhase = state.phase === 'paused' ? 'running' : 'paused';
      return {
        ok: true,
        state: {
          ...state,
          phase: nextPhase,
          message: nextPhase === 'paused' ? 'Auction paused' : 'Auction resumed',
        },
        history,
      };
    }

    case 'undo': {
      const prev = history.pop();
      if (!prev) return { ok: false, error: 'Nothing to undo.' };
      return {
        ok: true,
        state: { ...prev, message: 'Undid last action' },
        history,
      };
    }

    case 'reset': {
      // Rebuilding from a room's original setup (CSV/list + config) needs data this
      // module never sees. The server layer (rooms.js) intercepts 'reset' before it
      // reaches here and calls makeInitialState() again with the room's stored setup.
      return { ok: false, error: 'Reset must be handled by the room layer.' };
    }

    case 'importRows': {
      const rows = payload.rows;
      if (!Array.isArray(rows)) return { ok: false, error: 'Invalid rows.' };
      const names = rows.map(cleanName).filter(Boolean);
      const players = names.map((name, i) => {
        const tier = inferTier(i);
        return {
          id: uid('p'),
          name,
          role: inferRole(i),
          tier,
          basePrice: inferBase(tier, state.config),
          image: '',
          status: 'pending',
          soldTo: '',
          soldPrice: 0,
        };
      });
      if (!players.length) return { ok: false, error: 'No player names found.' };
      assignPlayerImages(players, IMAGES_DIR);
      const nextState = {
        ...state,
        players,
        queue: players.map((p) => p.id),
        unsoldQueue: [],
        currentPlayerId: players[0].id,
        highestBid: 0,
        highestTeamId: '',
        phase: 'setup',
        bidHistory: [],
        selectedPlayerId: players[0].id,
        message: `Imported ${players.length} players.`,
      };
      nextState.teams = nextState.teams.map((t) => ({ ...t, purse: state.config.purse, roster: [] }));
      return { ok: true, state: nextState, history: [] };
    }

    case 'saveConfig': {
      const purse = Number(payload.purse);
      if (!Number.isFinite(purse)) return { ok: false, error: 'Invalid purse.' };
      const next = {
        ...state,
        config: { ...state.config, purse },
        teams: state.teams.map((t) => ({ ...t, purse })),
      };
      next.players = next.players.map((p) => ({
        ...p,
        basePrice: next.config.basePrices[p.tier],
      }));
      return { ok: true, state: { ...next, message: 'Settings saved' }, history };
    }

    case 'setTeamName': {
      const { teamId, name } = payload;
      const teams = state.teams.map((t) => (t.id === teamId ? { ...t, name: String(name || '') } : t));
      return {
        ok: true,
        state: { ...state, teams, message: 'Team name updated' },
        history,
      };
    }

    case 'setTeamPurse': {
      const { teamId, purse } = payload;
      const p = Number(purse);
      if (!Number.isFinite(p)) return { ok: false, error: 'Invalid purse.' };
      const teams = state.teams.map((t) => (t.id === teamId ? { ...t, purse: p } : t));
      return { ok: true, state: { ...state, teams, message: 'Purse updated' }, history };
    }

    case 'setBaseTier': {
      const { tier, value } = payload;
      if (!tiers.includes(tier)) return { ok: false, error: 'Invalid tier.' };
      const v = Number(value);
      if (!Number.isFinite(v)) return { ok: false, error: 'Invalid value.' };
      const config = {
        ...state.config,
        basePrices: { ...state.config.basePrices, [tier]: v },
      };
      let players = state.players.map((p) =>
        p.tier === tier ? { ...p, basePrice: v } : p
      );
      return {
        ok: true,
        state: { ...state, config, players, message: 'Base price updated' },
        history,
      };
    }

    case 'setIncTier': {
      const { tier, value } = payload;
      if (!tiers.includes(tier)) return { ok: false, error: 'Invalid tier.' };
      const v = Number(value);
      if (!Number.isFinite(v)) return { ok: false, error: 'Invalid value.' };
      const config = {
        ...state.config,
        increments: { ...state.config.increments, [tier]: v },
      };
      return { ok: true, state: { ...state, config, message: 'Increment updated' }, history };
    }

    case 'updatePlayer': {
      const { playerId, patch } = payload;
      if (!playerId || !patch || typeof patch !== 'object') {
        return { ok: false, error: 'Invalid update.' };
      }
      const players = state.players.map((p) =>
        p.id === playerId ? { ...p, ...patch } : p
      );
      return {
        ok: true,
        state: { ...state, players, message: 'Player updated' },
        history,
      };
    }

    case 'addPlayer': {
      const { name, role: r, tier: tr, image, age, accountId } = payload;
      if (!name || !String(name).trim()) return { ok: false, error: 'Name required.' };
      const validTier = tiers.includes(tr) ? tr : 'C';
      const validRole = roles.includes(r) ? r : 'Batter';
      const validAge = Number(age);
      const player = {
        id: uid('p'),
        name: String(name).trim(),
        role: validRole,
        tier: validTier,
        basePrice: inferBase(validTier, state.config),
        image: typeof image === 'string' ? image : '',
        status: 'pending',
        soldTo: '',
        soldPrice: 0,
        ...(Number.isFinite(validAge) && validAge > 0 ? { age: validAge } : {}),
        ...(accountId ? { accountId: String(accountId) } : {}),
      };
      const players = [...state.players, player];
      assignPlayerImages(players, IMAGES_DIR);
      const queue = [...state.queue, player.id];
      let currentPlayerId = state.currentPlayerId || player.id;
      return {
        ok: true,
        state: {
          ...state,
          players,
          queue,
          currentPlayerId,
          selectedPlayerId: state.selectedPlayerId || player.id,
          message: `Added ${player.name}`,
        },
        history,
      };
    }

    case 'selectPlayer': {
      const { playerId } = payload;
      if (!playerId) return { ok: false, error: 'playerId required.' };
      const pl = state.players.find((x) => x.id === playerId);
      if (pl && pl.status === 'retained') {
        return { ok: false, error: 'Pre-assigned captain/icon is not in the auction pool.' };
      }
      if (playerId === state.currentPlayerId) {
        return {
          ok: true,
          state: { ...state, selectedPlayerId: playerId, message: 'Player selected' },
          history,
        };
      }
      return {
        ok: true,
        state: {
          ...state,
          currentPlayerId: playerId,
          selectedPlayerId: playerId,
          bidHistory: [],
          highestBid: 0,
          highestTeamId: '',
          message: 'Player selected',
        },
        history,
      };
    }

    case 'setTeamSize': {
      const size = Number(payload.teamSize);
      if (!Number.isFinite(size) || size <= 0) return { ok: false, error: 'Invalid squad size.' };
      return {
        ok: true,
        state: { ...state, config: { ...state.config, teamSize: size }, message: 'Squad size updated' },
        history,
      };
    }

    case 'updateConfigPurse': {
      const purse = Number(payload.purse);
      if (!Number.isFinite(purse)) return { ok: false, error: 'Invalid purse.' };
      return {
        ok: true,
        state: {
          ...state,
          config: { ...state.config, purse },
          teams: state.teams.map((t) => ({ ...t, purse })),
          message: 'Configuration updated',
        },
        history,
      };
    }

    case 'reorderQueue': {
      const nextQueue = payload.queue;
      if (!Array.isArray(nextQueue) || !nextQueue.length) return { ok: false, error: 'Invalid order.' };
      const current = new Set(state.queue);
      if (nextQueue.length !== state.queue.length || !nextQueue.every((id) => current.has(id))) {
        return { ok: false, error: 'That order no longer matches the pool — refresh and try again.' };
      }
      const nextState = { ...state, queue: nextQueue };
      // Only jump the "on the block" player to match the new order before the
      // auction has actually started; once running, reordering the upcoming
      // pool shouldn't disturb whoever is currently up for bids.
      if (state.phase === 'setup') {
        nextState.currentPlayerId = nextQueue[0];
        nextState.selectedPlayerId = nextQueue[0];
      }
      return { ok: true, state: { ...nextState, message: 'Player sequence updated' }, history };
    }

    case 'retainPlayer': {
      const { playerId, teamId, role: r } = payload;
      const retainRole = ['Owner', 'Captain', 'Icon'].includes(r) ? r : null;
      if (!retainRole) return { ok: false, error: 'Role must be Owner, Captain, or Icon.' };
      const player = state.players.find((p) => p.id === playerId);
      if (!player || player.status !== 'pending') {
        return { ok: false, error: 'Only a player still in the pool can be pre-assigned to a team.' };
      }
      const team = state.teams.find((t) => t.id === teamId);
      if (!team) return { ok: false, error: 'Invalid team.' };
      const already = team.roster.find((p) => p.status === 'retained' && p.role === retainRole);
      if (already) {
        return { ok: false, error: `${team.name} already has ${already.name} as ${retainRole.toLowerCase()}.` };
      }
      const cuts = state.config.roleCuts || ROLE_PURSE_CUT;
      const cut = cuts[retainRole.toLowerCase()] || 0;
      const retained = {
        ...player,
        role: retainRole,
        tier: '',
        basePrice: 0,
        status: 'retained',
        soldTo: team.name,
        soldPrice: cut,
      };
      const players = state.players.map((p) => (p.id === playerId ? retained : p));
      const teams = state.teams.map((t) =>
        t.id === teamId ? { ...t, purse: Math.max(0, t.purse - cut), roster: [...t.roster, retained] } : t
      );
      let queue = state.queue.filter((id) => id !== playerId);
      let unsoldQueue = state.unsoldQueue.filter((id) => id !== playerId);
      let currentPlayerId = state.currentPlayerId;
      let selectedPlayerId = state.selectedPlayerId;
      if (currentPlayerId === playerId) currentPlayerId = queue[0] || unsoldQueue[0] || '';
      if (selectedPlayerId === playerId) selectedPlayerId = currentPlayerId;
      return {
        ok: true,
        state: {
          ...state,
          players,
          teams,
          queue,
          unsoldQueue,
          currentPlayerId,
          selectedPlayerId,
          message: `${player.name} pre-assigned to ${team.name} as ${retainRole}`,
        },
        history,
      };
    }

    case 'unretainPlayer': {
      const { playerId } = payload;
      const player = state.players.find((p) => p.id === playerId);
      if (!player || player.status !== 'retained') {
        return { ok: false, error: 'That player is not pre-assigned to a team.' };
      }
      const team = state.teams.find((t) => t.roster.some((p) => p.id === playerId));
      const fallbackTier = tiers[0];
      const restored = {
        ...player,
        role: roles[0],
        tier: fallbackTier,
        basePrice: inferBase(fallbackTier, state.config),
        status: 'pending',
        soldTo: '',
        soldPrice: 0,
      };
      const players = state.players.map((p) => (p.id === playerId ? restored : p));
      const teams = state.teams.map((t) =>
        t.id === (team && team.id)
          ? { ...t, purse: t.purse + (player.soldPrice || 0), roster: t.roster.filter((p) => p.id !== playerId) }
          : t
      );
      const queue = [...state.queue, playerId];
      let currentPlayerId = state.currentPlayerId || playerId;
      return {
        ok: true,
        state: {
          ...state,
          players,
          teams,
          queue,
          currentPlayerId,
          message: `${player.name} moved back into the auction pool — double-check their role, tier and base price.`,
        },
        history,
      };
    }

    default:
      return { ok: false, error: `Unknown action: ${action}` };
  }
}

module.exports = {
  makeInitialState,
  makeTeamsFromSetup,
  processAction,
  inferIncrement,
  inferBase,
  nextBidAmount,
  minPurseReserveForFutureSlots,
  maxAffordableBid,
  roles,
  tiers,
};
