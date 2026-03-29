'use strict';

/**
 * One-shot: rename files in ../images to match CSV player names (cleaned).
 * Uses the same pairing as assignPlayerImages (first matching player wins).
 * Run: node server/renameImagesToPlayerNames.js
 */

const fs = require('fs');
const path = require('path');
const { tryLoadInitialPlayers } = require('./playersFromCsv');
const { namesMatch, pickBestFile } = require('./playerImages');

const IMAGES_DIR = path.join(__dirname, '..', 'images');

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
  const { players } = tryLoadInitialPlayers();
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
