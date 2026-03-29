'use strict';

const fs = require('fs');
const path = require('path');

const {
  roles,
  tiers,
  teamNames,
  defaultConfig,
  ROLE_PURSE_CUT,
  sampleNamesFallback,
  PLAYERS_CSV_FILE,
} = require('./auctionConfig');
const { assignPlayerImages } = require('./playerImages');

function uid(prefix = 'id') {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

function cleanCell(s) {
  return String(s || '')
    .replace(/^\uFEFF/, '')
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
    .replace(/^\uFEFF/, '')
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

function inferBase(tier) {
  return defaultConfig.basePrices[tier] || defaultConfig.basePrices.C;
}

function teamLetterToIndex(letter) {
  const L = String(letter || '')
    .trim()
    .toUpperCase();
  if (L.length !== 1 || L < 'A' || L > 'Z') return -1;
  return L.charCodeAt(0) - 65;
}

function teamRefToIndex(teamRef) {
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
 * Reads tournament CSV: name,role,tier,team
 * Captains / icons / owners can use team letter (A–F) or team name in "team" column.
 * @returns {{ auctionRows: { name: string, role: string, tier: string }[], retained: { name: string, role: 'Captain'|'Icon', teamIndex: number }[], owners: { name: string, teamIndex: number }[] }}
 */
function parseTournamentCsvRows(rows) {
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
      const teamIndex = teamRefToIndex(teamRaw);
      if (teamIndex < 0 || teamIndex >= teamNames.length) {
        throw new Error(
          `Invalid team "${teamRaw}" for Owner "${name}" (use A–${String.fromCharCode(65 + teamNames.length - 1)} or one of: ${teamNames.join(', ')}).`
        );
      }
      owners.push({ name, teamIndex });
      continue;
    }
    if (r === 'Captain' || r === 'Icon') {
      const teamIndex = teamRefToIndex(teamRaw);
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

function loadTournamentCsv(filePath) {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(__dirname, '..', filePath);
  const text = fs.readFileSync(abs, 'utf8');
  const rows = parseCsv(text);
  return parseTournamentCsvRows(rows);
}

function makeAuctionPlayer(row) {
  const tier = tiers.includes(row.tier) ? row.tier : 'C';
  const role = roles.includes(row.role) ? row.role : 'Batter';
  return {
    id: uid('p'),
    name: row.name,
    role,
    tier,
    basePrice: inferBase(tier),
    image: '',
    status: 'pending',
    soldTo: '',
    soldPrice: 0,
  };
}

function makeRetainedPlayer(entry, teamNameStr) {
  const roleCut =
    entry && entry.role === 'Owner'
      ? ROLE_PURSE_CUT.owner
      : entry && entry.role === 'Captain'
        ? ROLE_PURSE_CUT.captain
        : entry && entry.role === 'Icon'
          ? ROLE_PURSE_CUT.icon
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
 * Build players list and team rosters from CSV parse result.
 */
function buildPlayersAndTeamRosters(parsed) {
  const { auctionRows, retained, owners = [] } = parsed;
  const auctionPlayers = auctionRows.map(makeAuctionPlayer);

  const ownerByTeam = new Map();
  for (const o of owners) {
    if (ownerByTeam.has(o.teamIndex)) {
      throw new Error(`More than one owner for team ${String.fromCharCode(65 + o.teamIndex)}`);
    }
    ownerByTeam.set(o.teamIndex, o.name);
  }

  const basePurse = defaultConfig.purse;
  const teamPurses = teamNames.map((_, idx) => {
    let p = basePurse;
    if (ownerByTeam.has(idx)) p -= ROLE_PURSE_CUT.owner;
    if (retained.some((x) => x.role === 'Captain' && x.teamIndex === idx)) p -= ROLE_PURSE_CUT.captain;
    if (retained.some((x) => x.role === 'Icon' && x.teamIndex === idx)) p -= ROLE_PURSE_CUT.icon;
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
    if (ownerName) roster.push(makeRetainedPlayer({ name: ownerName, role: 'Owner' }, tname));
    if (caps[0]) roster.push(makeRetainedPlayer(caps[0], tname));
    if (icons[0]) roster.push(makeRetainedPlayer(icons[0], tname));
    return roster;
  });

  const retainedPlayers = teamsRosterTemplate.flatMap((r) => r);

  const players = [...auctionPlayers, ...retainedPlayers];
  const queue = auctionPlayers.map((p) => p.id);

  assignPlayerImages(players, path.join(__dirname, '..', 'images'));

  return { players, queue, teamsRosterTemplate, teamPurses };
}

function loadStateFromCsvFile(csvRelativePath) {
  const parsed = loadTournamentCsv(csvRelativePath);
  return buildPlayersAndTeamRosters(parsed);
}

function loadStateFromFallbackNames(names) {
  const auctionRows = names.map((name, i) => ({
    name: String(name).trim(),
    role: roles[i % roles.length],
    tier: tiers[i % tiers.length],
  }));
  return buildPlayersAndTeamRosters({ auctionRows, retained: [], owners: [] });
}

function tryLoadInitialPlayers() {
  if (!PLAYERS_CSV_FILE) {
    return loadStateFromFallbackNames(sampleNamesFallback);
  }
  const csvPath = path.join(__dirname, '..', PLAYERS_CSV_FILE);
  if (!fs.existsSync(csvPath)) {
    console.warn(`[auction] CSV not found: ${PLAYERS_CSV_FILE} — using fallback names from auctionConfig.js`);
    return loadStateFromFallbackNames(sampleNamesFallback);
  }
  try {
    return loadStateFromCsvFile(PLAYERS_CSV_FILE);
  } catch (err) {
    console.error('[auction] Failed to parse CSV:', err.message);
    console.warn('[auction] Using fallback names from auctionConfig.js');
    return loadStateFromFallbackNames(sampleNamesFallback);
  }
}

module.exports = {
  parseCsv,
  parseTournamentCsvRows,
  loadTournamentCsv,
  buildPlayersAndTeamRosters,
  tryLoadInitialPlayers,
  uid,
};
