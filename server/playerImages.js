'use strict';

const fs = require('fs');
const path = require('path');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.bmp']);

function normalizeName(s) {
  return String(s || '')
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\.$/, '');
}

/** Prefer web-friendly formats when several files match the same player. */
function pickBestFile(matches) {
  if (!matches.length) return null;
  const rank = (ext) => {
    const e = ext.toLowerCase();
    if (e === '.jpg' || e === '.jpeg') return 5;
    if (e === '.png' || e === '.webp' || e === '.gif') return 4;
    if (e === '.bmp') return 3;
    if (e === '.heic') return 1;
    return 2;
  };
  return [...matches].sort((a, b) => {
    const dr = rank(path.extname(b)) - rank(path.extname(a));
    if (dr !== 0) return dr;
    return a.localeCompare(b, undefined, { sensitivity: 'base' });
  })[0];
}

/**
 * Most files use "…prefix… - Full Name.ext"; take the segment after the last " - ".
 */
function extractNameFromStem(stem) {
  const parts = stem.split(' - ');
  if (parts.length >= 2) {
    return parts[parts.length - 1].trim();
  }
  return stem.trim();
}

function namesMatch(playerName, fileStem) {
  const nP = normalizeName(playerName);
  if (!nP) return false;
  const extracted = extractNameFromStem(fileStem);
  const nE = normalizeName(extracted);
  const nFull = normalizeName(fileStem);
  if (!nE && !nFull) return false;

  if (nP === nE || nP === nFull) return true;

  const looseP = nP.replace(/\s/g, '');
  const looseE = nE.replace(/\s/g, '');
  const looseF = nFull.replace(/\s/g, '');
  if (looseP.length >= 3 && (looseP === looseE || looseP === looseF)) return true;

  if (nE.length >= nP.length && (nE.startsWith(nP + ' ') || nE.startsWith(nP + '.'))) return true;
  if (nFull.includes(nP) && nP.length >= 6) return true;

  const eWords = nE.split(/\s+/).filter(Boolean);
  const pWords = nP.split(/\s+/).filter(Boolean);
  if (pWords.length === 1 && eWords.length >= 2) {
    const first = eWords[0];
    if (first.startsWith(pWords[0]) && pWords[0].length >= 3) return true;
  }
  if (pWords.length >= 2 && eWords.length >= 2) {
    const lastEq = pWords[pWords.length - 1] === eWords[eWords.length - 1];
    const firstLoose =
      eWords[0].startsWith(pWords[0].slice(0, Math.min(4, pWords[0].length))) ||
      pWords[0].startsWith(eWords[0].slice(0, Math.min(4, eWords[0].length)));
    if (lastEq && firstLoose && pWords[pWords.length - 1].length >= 3) return true;
  }

  return false;
}

/**
 * Sets `player.image` to `/images/<url-encoded-filename>` for each player when a file in `imagesDir` matches the name.
 * Each image file is used at most once (first matching player wins).
 * @param {{ name: string, image?: string }[]} players
 * @param {string} imagesDir
 */
function assignPlayerImages(players, imagesDir) {
  if (!players || !players.length || !imagesDir) return;
  if (!fs.existsSync(imagesDir)) return;

  const files = fs
    .readdirSync(imagesDir)
    .filter((f) => {
      const ext = path.extname(f).toLowerCase();
      return IMAGE_EXT.has(ext) && fs.statSync(path.join(imagesDir, f)).isFile();
    });

  const used = new Set();

  for (const p of players) {
    const nP = normalizeName(p.name);
    const exactMatches = files.filter((f) => {
      if (used.has(f)) return false;
      const stem = path.basename(f, path.extname(f));
      return normalizeName(stem) === nP;
    });
    const exact = pickBestFile(exactMatches);
    if (exact) {
      used.add(exact);
      p.image = `/images/${encodeURIComponent(exact)}`;
      continue;
    }

    const matches = files.filter((f) => {
      if (used.has(f)) return false;
      const stem = path.basename(f, path.extname(f));
      return namesMatch(p.name, stem);
    });
    const best = pickBestFile(matches);
    if (best) {
      used.add(best);
      p.image = `/images/${encodeURIComponent(best)}`;
    }
  }
}

module.exports = {
  assignPlayerImages,
  namesMatch,
  extractNameFromStem,
  pickBestFile,
  normalizeName,
};
