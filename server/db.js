'use strict';

/**
 * Single shared SQLite connection for the whole app (rooms + player accounts).
 *
 * Uses Node's own built-in `node:sqlite` (no npm dependency, no native addon
 * to compile or download a prebuilt binary for) instead of a third-party
 * driver — one less thing that can fail to install on a host with a locked-down
 * network or no C++ build toolchain, which matters a lot more for "deploy this
 * somewhere" than the small maturity gap of a still-experimental core module.
 * It replaces the old whole-file JSON snapshots: every write is now a single
 * row upsert instead of re-serializing every room/account on disk on every
 * bid, and a crash mid-write can't corrupt unrelated rooms' data the way
 * overwriting one big JSON file could.
 *
 * Each row still stores its record as a JSON blob in a `data` column rather
 * than being split into normalized columns — the shape of a room/account is
 * still owned by rooms.js/accounts.js/auctionLogic.js, not by this file, so
 * nothing about the app's data model has to change for the migration.
 *
 * Requires Node 22.5+ (this repo pins Node 22 via .node-version / package.json
 * "engines"). node:sqlite prints a one-line "experimental feature" warning on
 * boot — harmless; the API this file uses (exec/prepare/run/get/all) has been
 * stable since it landed.
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'app.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    room_id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

/**
 * node:sqlite has no built-in `db.transaction(fn)` helper (unlike better-sqlite3),
 * so multi-statement writes wrap themselves in an explicit BEGIN/COMMIT here.
 * @param {() => void} fn
 */
function withTransaction(fn) {
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { db, withTransaction, DATA_DIR, DB_FILE };
