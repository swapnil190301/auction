'use strict';

/**
 * Turns a "create room" form submission into the pieces auctionLogic needs
 * to build a fresh auction state, and into a normalized `setup` snapshot that
 * gets stored with the room so "Reset auction" can rebuild the exact same
 * starting position later (no re-upload needed).
 */

const path = require('path');
const { tiers } = require('./auctionConfig');
const {
  parseCsvText,
  buildPlayersAndTeamRosters,
  buildAuctionRowsFromNames,
} = require('./playersFromCsv');

const IMAGES_DIR = path.join(__dirname, '..', 'images');

function sanitizeTeamNames(rawNames) {
  const names = Array.isArray(rawNames) ? rawNames.map((n) => String(n || '').trim()).filter(Boolean) : [];
  if (names.length < 2) {
    throw new Error('A room needs at least 2 teams.');
  }
  if (names.length > 24) {
    throw new Error('A room supports at most 24 teams.');
  }
  return names;
}

function sanitizeTierMap(raw, fallback) {
  const out = { ...fallback };
  if (raw && typeof raw === 'object') {
    for (const t of tiers) {
      const v = Number(raw[t]);
      if (Number.isFinite(v) && v >= 0) out[t] = v;
    }
  }
  return out;
}

function sanitizeConfig(input, defaults) {
  const purse = Number(input.purse);
  const teamSize = Number(input.teamSize);
  return {
    purse: Number.isFinite(purse) && purse > 0 ? purse : defaults.purse,
    basePrices: sanitizeTierMap(input.basePrices, defaults.basePrices),
    increments: sanitizeTierMap(input.increments, defaults.increments),
    teamSize: Number.isFinite(teamSize) && teamSize > 0 ? teamSize : defaults.teamSize,
  };
}

/**
 * @param {object} input
 * @param {string} input.name
 * @param {string[]} input.teamNames
 * @param {object} [input.purse|basePrices|increments|teamSize]
 * @param {{owner:number, captain:number, icon:number}} [input.roleCuts]
 * @param {'csv'|'list'|'none'} input.playersMode
 * @param {string} [input.csvText]
 * @param {string[]} [input.listNames]
 * @param {object} defaultsFromConfig - auctionConfig.defaultConfig / ROLE_PURSE_CUT
 * @returns {{ setup: object, built: { players, queue, teamsRosterTemplate, teamPurses } }}
 */
function normalizeSetup(input, defaultsFromConfig) {
  const name = String(input.name || '').trim() || 'Untitled auction';
  const teamNames = sanitizeTeamNames(input.teamNames);
  const config = sanitizeConfig(input, defaultsFromConfig.defaultConfig);
  const roleCuts = {
    owner: Number.isFinite(Number(input.roleCuts && input.roleCuts.owner)) ? Number(input.roleCuts.owner) : defaultsFromConfig.ROLE_PURSE_CUT.owner,
    captain: Number.isFinite(Number(input.roleCuts && input.roleCuts.captain)) ? Number(input.roleCuts.captain) : defaultsFromConfig.ROLE_PURSE_CUT.captain,
    icon: Number.isFinite(Number(input.roleCuts && input.roleCuts.icon)) ? Number(input.roleCuts.icon) : defaultsFromConfig.ROLE_PURSE_CUT.icon,
  };
  // Also folded into config itself so state.config.roleCuts is always available to
  // auctionLogic's retainPlayer action, which only ever sees `state`, never `setup`.
  config.roleCuts = roleCuts;

  const playersMode = ['csv', 'list', 'none'].includes(input.playersMode) ? input.playersMode : 'none';
  const csvText = playersMode === 'csv' ? String(input.csvText || '') : '';
  const listNames = playersMode === 'list'
    ? (Array.isArray(input.listNames) ? input.listNames.map((n) => String(n || '').trim()).filter(Boolean) : [])
    : [];

  const setup = { name, teamNames, config, roleCuts, playersMode, csvText, listNames };
  const built = buildFromSetup(setup);
  return { setup, built };
}

function buildFromSetup(setup) {
  let parsed;
  if (setup.playersMode === 'csv') {
    if (!setup.csvText.trim()) throw new Error('Player CSV is empty.');
    parsed = parseCsvText(setup.csvText, setup.teamNames);
  } else if (setup.playersMode === 'list') {
    if (!setup.listNames.length) throw new Error('Add at least one player name.');
    parsed = { auctionRows: buildAuctionRowsFromNames(setup.listNames), retained: [], owners: [] };
  } else {
    parsed = { auctionRows: [], retained: [], owners: [] };
  }
  return buildPlayersAndTeamRosters(parsed, setup.teamNames, setup.config, setup.roleCuts, IMAGES_DIR);
}

module.exports = {
  normalizeSetup,
  buildFromSetup,
};
