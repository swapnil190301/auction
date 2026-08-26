'use strict';

const fs = require('fs');
const path = require('path');
const { roles, tiers, defaultConfig, ROLE_PURSE_CUT } = require('./auctionConfig');
const { assignPlayerImages } = require('./playerImages');
const { uid } = require('./idgen');

function cleanCell(s) {
  return String(s || '')
    .replace(/^﻿/, '')
    .trim();
}

/** Minimal CSV row split (handles "quoted, commas"). */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let i = 0;
  let inQ = false;
  while (i < line.length) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 2;
          continue;
        }
        inQ = false;
        i++;
        continue;
      }
      cur += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQ = true;
      i++;
      continue;
    }
    if (c === ',') {
      out.push(cur);
      cur = '';
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  out.push(cur);
  return out;
}

function parseCsv(text) {
  const lines = String(text || '')
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .filter((ln) => ln.trim() !== '');
  return lines.map(parseCsvLine);
}

function normalizeRole(raw) {
  const u = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  if (u === 'all rounder' || u === 'all-rounder') return 'All-rounder';
  if (u === 'batter') return 'Batter';
  if (u === 'bowler') return 'Bowler';
  if (u === 'captain') return 'Captain';
  if (u === 'icon') return 'Icon';
  if (u === 'owner') return 'Owner';
  return '';
}

function inferBase(tier, basePrices) {
  const prices = basePrices || defaultConfig.basePrices;
  return prices[tier] || prices.C;
}

function teamLetterToIndex(letter) {
  const L = String(letter || '')
    .trim()
    .toUpperCase();
  if (L.length !== 1 || L < 'A' || L > 'Z') return -1;
  return L.charCodeAt(0) - 65;
}

function teamRefToIndex(teamRef, teamNames) {
  const raw = String(teamRef || '').trim();
  if (!raw) return -1;

  const byLetter = teamLetterToIndex(raw);
  if (byLetter >= 0 && byLetter < teamNames.length) {
    return byLetter;
  }

  const normalized = raw.toLowerCase().replace(/\s+/g, ' ');
  const byName = teamNames.findIndex(
    (name) => String(name || '').trim().toLowerCase().replace(/\s+/g, ' ') === normalized
  );
  return byName;
}

/**
 * Reads a tournament CSV: name,role,tier,team[,wallet]
 * Captains / icons / owners can use team letter (A–F...) or team name in the "team" column.
 * @param {string[][]} rows
 * @param {string[]} teamNames
 * @returns {{ auctionRows: { name: string, role: string, tier: string }[], retained: { name: string, role: 'Captain'|'Icon', teamIndex: number }[], owners: { name: string, teamIndex: number }[] }}
 */
function parseTournamentCsvRows(rows, teamNames) {
  if (!rows.length) {
    return { auctionRows: [], retained: [], owners: [] };
  }
  const firstCell = cleanCell(rows[0][0]).toLowerCase();
  const hasHeader = firstCell === 'name';
  const data = hasHeader ? rows.slice(1) : rows;

  const auctionRows = [];
  const retained = [];
  const owners = [];

  for (const cells of data) {
    const name = cleanCell(cells[0]);
    if (!name) continue;
    const roleRaw = cleanCell(cells[1]);
    const tierRaw = cleanCell(cells[2]);
    const teamRaw = cleanCell(cells[3] || '');

    const r = normalizeRole(roleRaw);
    if (r === 'Owner') {
      const teamIndex = teamRefToIndex(teamRaw, teamNames);
      if (teamIndex < 0 || teamIndex >= teamNames.length) {
        throw new Error(
          `Invalid team "${teamRaw}" for Owner "${name}" (use A–${String.fromCharCode(65 + teamNames.length - 1)} or one of: ${teamNames.join(', ')}).`
        );
      }
      owners.push({ name, teamIndex });
      continue;
    }
    if (r === 'Captain' || r === 'Icon') {
      const teamIndex = teamRefToIndex(teamRaw, teamNames);
      if (teamIndex < 0 || teamIndex >= teamNames.length) {
        throw new Error(
          `Invalid team "${teamRaw}" for ${r} "${name}" (use A–${String.fromCharCode(65 + teamNames.length - 1)} or one of: ${teamNames.join(', ')}).`
        );
      }
      retained.push({ name, role: r, teamIndex });
      continue;
    }

    let tier = String(tierRaw || '')
      .trim()
      .toUpperCase();
    if (!tier || !tiers.includes(tier)) {
      tier = 'C';
    }
    let role = r;
    if (!role || !roles.includes(role)) {
      role = 'Batter';
    }
    auctionRows.push({ name, role, tier });
  }

  return { auctionRows, retained, owners };
}

function parseCsvText(text, teamNames) {
  const rows = parseCsv(text);
  return parseTournamentCsvRows(rows, teamNames);
}

function makeAuctionPlayer(row, basePrices) {
  const tier = tiers.includes(row.tier) ? row.tier : 'C';
  const role = roles.includes(row.role) ? row.role : 'Batter';
  return {
    id: uid('p'),
    name: row.name,
    role,
    tier,
    basePrice: inferBase(tier, basePrices),
    image: '',
    status: 'pending',
    soldTo: '',
    soldPrice: 0,
  };
}

function makeRetainedPlayer(entry, teamNameStr, roleCuts) {
  const cuts = roleCuts || ROLE_PURSE_CUT;
  const roleCut =
    entry && entry.role === 'Owner'
      ? cuts.owner
      : entry && entry.role === 'Captain'
        ? cuts.captain
        : entry && entry.role === 'Icon'
          ? cuts.icon
          : 0;
  return {
    id: uid('p'),
    name: entry.name,
    role: entry.role,
    tier: '',
    basePrice: 0,
    image: '',
    status: 'retained',
    soldTo: teamNameStr,
    // Retained players are pre-assigned; show their wallet deduction as their "value" on the roster UI.
    soldPrice: roleCut,
  };
}

/**
 * Build players list and team rosters from a CSV parse result.
 * @param {{auctionRows, retained, owners}} parsed
 * @param {string[]} teamNames
 * @param {{ purse:number, basePrices:object }} config
 * @param {{owner:number, captain:number, icon:number}} roleCuts
 * @param {string} imagesDir
 */
function buildPlayersAndTeamRosters(parsed, teamNames, config, roleCuts, imagesDir) {
  const { auctionRows, retained, owners = [] } = parsed;
  const cfg = config || defaultConfig;
  const cuts = roleCuts || ROLE_PURSE_CUT;
  const auctionPlayers = auctionRows.map((row) => makeAuctionPlayer(row, cfg.basePrices));

  const ownerByTeam = new Map();
  for (const o of owners) {
    if (ownerByTeam.has(o.teamIndex)) {
      throw new Error(`More than one owner for team ${String.fromCharCode(65 + o.teamIndex)}`);
    }
    ownerByTeam.set(o.teamIndex, o.name);
  }

  const basePurse = cfg.purse;
  const teamPurses = teamNames.map((_, idx) => {
    let p = basePurse;
    if (ownerByTeam.has(idx)) p -= cuts.owner;
    if (retained.some((x) => x.role === 'Captain' && x.teamIndex === idx)) p -= cuts.captain;
    if (retained.some((x) => x.role === 'Icon' && x.teamIndex === idx)) p -= cuts.icon;
    return Math.max(0, p);
  });

  const teamsRosterTemplate = teamNames.map((_, idx) => {
    const letter = String.fromCharCode(65 + idx);
    const caps = retained.filter((x) => x.role === 'Captain' && x.teamIndex === idx);
    const icons = retained.filter((x) => x.role === 'Icon' && x.teamIndex === idx);
    if (caps.length > 1) {
      throw new Error(`More than one captain for team ${letter}`);
    }
    if (icons.length > 1) {
      throw new Error(`More than one icon for team ${letter}`);
    }
    const roster = [];
    const tname = teamNames[idx];
    const ownerName = ownerByTeam.get(idx);
    if (ownerName) roster.push(makeRetainedPlayer({ name: ownerName, role: 'Owner' }, tname, cuts));
    if (caps[0]) roster.push(makeRetainedPlayer(caps[0], tname, cuts));
    if (icons[0]) roster.push(makeRetainedPlayer(icons[0], tname, cuts));
    return roster;
  });

  const retainedPlayers = teamsRosterTemplate.flatMap((r) => r);

  const players = [...auctionPlayers, ...retainedPlayers];
  const queue = auctionPlayers.map((p) => p.id);

  if (imagesDir) assignPlayerImages(players, imagesDir);

  return { players, queue, teamsRosterTemplate, teamPurses };
}

function loadTournamentCsvFile(filePath, teamNames) {
  const text = fs.readFileSync(filePath, 'utf8');
  return parseCsvText(text, teamNames);
}

/** Quick-list mode: one name per line, tier/role assigned round-robin (A/B/C, Batter/Bowler/All-rounder). */
function buildAuctionRowsFromNames(names) {
  return names
    .map((n) => String(n || '').trim())
    .filter(Boolean)
    .map((name, i) => ({
      name,
      role: roles[i % roles.length],
      tier: tiers[i % tiers.length],
    }));
}

module.exports = {
  parseCsv,
  parseCsvText,
  parseTournamentCsvRows,
  loadTournamentCsvFile,
  buildPlayersAndTeamRosters,
  buildAuctionRowsFromNames,
  path,
};
