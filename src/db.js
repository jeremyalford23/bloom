import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { PLANNING_GROUPS, SEED_CATEGORIES } from "./domain/taxonomy.js";

const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS planning_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  description TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  planning_group_id TEXT NOT NULL REFERENCES planning_groups(id),
  cadence TEXT NOT NULL DEFAULT 'monthly',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  institution TEXT,
  last_four TEXT,
  type TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'unassigned',
  currency TEXT NOT NULL DEFAULT 'USD',
  balance_minor INTEGER,
  balance_as_of TEXT,
  csv_layout_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS csv_layouts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  mapping_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS import_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  file_count INTEGER NOT NULL DEFAULT 0,
  rows_read INTEGER NOT NULL DEFAULT 0,
  new_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  exception_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  committed_at TEXT
);
CREATE TABLE IF NOT EXISTS import_files (
  id TEXT PRIMARY KEY,
  import_run_id TEXT NOT NULL REFERENCES import_runs(id),
  account_id TEXT REFERENCES accounts(id),
  file_name TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  mapping_json TEXT NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS raw_import_records (
  id TEXT PRIMARY KEY,
  import_run_id TEXT NOT NULL REFERENCES import_runs(id),
  import_file_id TEXT NOT NULL REFERENCES import_files(id),
  account_id TEXT REFERENCES accounts(id),
  row_number INTEGER NOT NULL,
  raw_json TEXT NOT NULL,
  posted_date TEXT,
  description TEXT,
  amount_minor INTEGER,
  fingerprint TEXT,
  disposition TEXT NOT NULL,
  exception TEXT,
  normalized_transaction_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS merchants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  raw_import_record_id TEXT REFERENCES raw_import_records(id),
  posted_date TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  original_description TEXT NOT NULL,
  merchant_id TEXT REFERENCES merchants(id),
  category_id TEXT REFERENCES categories(id),
  notes TEXT,
  is_transfer INTEGER NOT NULL DEFAULT 0,
  excluded INTEGER NOT NULL DEFAULT 0,
  flagged INTEGER NOT NULL DEFAULT 0,
  transfer_pair_id TEXT,
  fingerprint TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transaction_splits (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES categories(id),
  amount_minor INTEGER NOT NULL,
  notes TEXT
);
CREATE TABLE IF NOT EXISTS classification_rules (
  id TEXT PRIMARY KEY,
  priority INTEGER NOT NULL,
  match_type TEXT NOT NULL,
  match_text TEXT NOT NULL,
  account_id TEXT REFERENCES accounts(id),
  merchant_name TEXT,
  category_id TEXT REFERENCES categories(id),
  mark_transfer INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  match_count INTEGER NOT NULL DEFAULT 0,
  last_hit_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transactions_posted ON transactions(posted_date DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(category_id);
CREATE INDEX IF NOT EXISTS idx_raw_import_run ON raw_import_records(import_run_id);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_events(entity_type, entity_id, created_at);
`;

export function openDatabase(path = process.env.BLOOM_DB_PATH ?? "data/bloom.db") {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.transaction = (work) => (...args) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work(...args);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  db.exec(SCHEMA);
  seedTaxonomy(db);
  return db;
}

function seedTaxonomy(db) {
  const now = new Date().toISOString();
  const groupStatement = db.prepare(
    "INSERT OR IGNORE INTO planning_groups (id, name, kind, description) VALUES (?, ?, ?, ?)"
  );
  for (const group of PLANNING_GROUPS) {
    groupStatement.run(group.id, group.name, group.kind, group.description);
  }
  const categoryStatement = db.prepare(
    "INSERT OR IGNORE INTO categories (id, name, planning_group_id, cadence, active, created_at) VALUES (?, ?, ?, ?, 1, ?)"
  );
  for (const category of SEED_CATEGORIES) {
    const cadence = category.planningGroupId === "irregular-expenses" ? "irregular" : "monthly";
    categoryStatement.run(category.id, category.name, category.planningGroupId, cadence, now);
  }
}

export function audit(db, entityType, entityId, action, detail = {}) {
  db.prepare(
    "INSERT INTO audit_events (id, entity_type, entity_id, action, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(randomUUID(), entityType, entityId, action, JSON.stringify(detail), new Date().toISOString());
}

export function rowToObject(row) {
  if (!row) return row;
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()),
    typeof value === "bigint" ? Number(value) : value
  ]));
}

export function rowsToObjects(rows) {
  return rows.map(rowToObject);
}
