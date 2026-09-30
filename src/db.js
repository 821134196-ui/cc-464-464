'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.TD_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.TD_DB_PATH || path.join(DATA_DIR, 'testdrive.db');
const PHOTO_DIR = process.env.TD_PHOTO_DIR || path.join(DATA_DIR, 'photos');

let db = null;

function open(dbPath = DB_PATH) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.mkdirSync(PHOTO_DIR, { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  return db;
}

function get() {
  if (!db) open();
  return db;
}

function tx(fn) {
  const d = get();
  d.exec('BEGIN IMMEDIATE');
  try {
    const out = fn(d);
    d.exec('COMMIT');
    return out;
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

function close() {
  if (db) { db.close(); db = null; }
}

module.exports = { open, get, tx, close, DATA_DIR, DB_PATH, PHOTO_DIR };
