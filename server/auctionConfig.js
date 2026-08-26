'use strict';

/**
 * Defaults offered when someone fills in the "Create room" form.
 * Nothing here is loaded automatically at server start any more — every room
 * is created explicitly through the UI (or POST /api/rooms) with its own
 * name, teams, purse, tiers and player list. Editing this file only changes
 * the *suggested* starting values shown on the create-room form.
 */

/** Max players per team (squad size cap) suggested by default. */
const TEAM_SIZE = 10;

/** Starting purse for each team, suggested by default. */
const DEFAULT_PURSE = 10000;

/** Deducted from team purse when the role is filled (see CSV OWNER / CAPTAIN / ICON rows). */
const ROLE_PURSE_CUT = { owner: 500, captain: 1000, icon: 1000 };

const defaultConfig = {
  purse: DEFAULT_PURSE,
  basePrices: { A: 500, B: 400, C: 300 },
  increments: { A: 50, B: 50, C: 50 },
  teamSize: TEAM_SIZE,
};

/** Suggested team names shown when someone starts a new room; fully editable in the create-room form. */
const suggestedTeamNames = ['Team 1', 'Team 2', 'Team 3', 'Team 4', 'Team 5', 'Team 6'];

const roles = ['Batter', 'Bowler', 'All-rounder'];
const tiers = ['A', 'B', 'C'];

/** Used only for the optional "quick list" player-entry mode (plain names, no CSV). */
const sampleNamesFallback = [
  'Player 1', 'Player 2', 'Player 3', 'Player 4', 'Player 5', 'Player 6',
];

module.exports = {
  TEAM_SIZE,
  DEFAULT_PURSE,
  ROLE_PURSE_CUT,
  defaultConfig,
  suggestedTeamNames,
  roles,
  tiers,
  sampleNamesFallback,
};
