'use strict';

/**
 * One-shot: rename files in ../images to match names from a player CSV (cleaned).
 * Uses the same pairing as assignPlayerImages (first matching player wins).
 * Run: node server/renameImagesToPlayerNames.js [path/to/players.csv]
 * Defaults to cricket-players-my-tournament-2026-03-23.csv in the project root if present.
 * This is a standalone dev utility — it does not read or write any room's live state.
 */

const fs = require('fs');
const path = require('path');
const { parseCsvText } = require('./playersFromCsv');
const { namesMatch, pickBestFile } = require('./playerImages');

const IMAGES_DIR = path.join(__dirname, '..', 'images');
const DEFAULT_CSV = path.join(__dirname, '..', 'cricket-players-my-tournament-2026-03-23.csv');
// A generous placeholder team list so any team letter referenced by OWNER/CAPTAIN/ICON rows
// in the CSV resolves without error — this script only needs player *names*, not real teams.
const PLACEHOLDER_TEAM_NAMES = Array.from({ length: 26 }, (_, i) => `Team ${String.fromCharCode(65 + i)}`);

function loadPlayersFromCsvFile(csvPath) {
  const text = fs.readFileSync(csvPath, 'utf8');
  const parsed = parseCsvText(text, PLACEHOLDER_TEAM_NAMES);
  const auctionPlayers = parsed.auctionRows.map((r) => ({ name: r.name }));
  const retainedPlayers = [...parsed.retained, ...parsed.owners].map((r) => ({ name: r.name }));
  return [...auctionPlayers, ...retainedPlayers];
}

function safeWinFileName(name) {
  let t = String(name)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\.+$/, '')
    .trim();
  if (!t) t = 'player';
  if (t.length > 120) t = t.slice(0, 120);
  return t;
}

function listImageFiles() {
  if (!fs.existsSync(IMAGES_DIR)) return [];
  return fs.readdirSync(IMAGES_DIR).filter((f) => {
    const ext = path.extname(f).toLowerCase();
    if (!['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.bmp'].includes(ext)) return false;
    return fs.statSync(path.join(IMAGES_DIR, f)).isFile();
  });
}

function main() {
  const csvPath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_CSV;
  if (!fs.existsSync(csvPath)) {
    console.error(`CSV not found: ${csvPath}\nUsage: node server/renameImagesToPlayerNames.js [path/to/players.csv]`);
    process.exit(1);
  }
  const players = loadPlayersFromCsvFile(csvPath);
  const files = listImageFiles();
  const used = new Set();
  const reservedTargets = new Set();
  const plan = [];

  for (const p of players) {
    const matches = files.filter((f) => {
      if (used.has(f)) return false;
      const stem = path.basename(f, path.extname(f));
      return namesMatch(p.name, stem);
    });
    const best = pickBestFile(matches);
    if (!best) continue;

    const ext = path.extname(best);
    let candidate = safeWinFileName(p.name) + ext;
    let n = 2;
    while (
      reservedTargets.has(candidate) ||
      (fs.existsSync(path.join(IMAGES_DIR, candidate)) && candidate !== best)
    ) {
      candidate = `${safeWinFileName(p.name)} (${n})${ext}`;
      n++;
    }

    used.add(best);
    reservedTargets.add(candidate);
    if (candidate !== best) {
      plan.push({ from: best, to: candidate });
    }
  }

  if (!plan.length) {
    console.log('No renames needed (already aligned or no matches).');
    return;
  }

  const tmp = '__renaming_tmp__';
  plan.forEach((step, i) => {
    const fromPath = path.join(IMAGES_DIR, step.from);
    const tmpPath = path.join(IMAGES_DIR, `${tmp}${i}${path.extname(step.from)}`);
    fs.renameSync(fromPath, tmpPath);
    step.tmpPath = tmpPath;
  });

  plan.forEach((step) => {
    const toPath = path.join(IMAGES_DIR, step.to);
    fs.renameSync(step.tmpPath, toPath);
  });

  console.log(`Renamed ${plan.length} file(s) to CSV player names:`);
  plan.forEach((s) => console.log(`  ${s.from} -> ${s.to}`));
}

main();
