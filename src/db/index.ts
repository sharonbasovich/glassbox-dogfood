import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Db = DatabaseSync;
export type Row = Record<string, string | number | null>;
type Param = string | number | null;

const MIGRATIONS_DIR = dirname(fileURLToPath(import.meta.url));

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

/** Applies every NNN_*.sql file in this directory exactly once, in order. */
export function migrate(db: Db): string[] {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(all<{ name: string }>(db, 'SELECT name FROM schema_migrations').map((r) => r.name));
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    tx(db, () => {
      db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
      run(db, 'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)', file, new Date().toISOString());
    });
    ran.push(file);
  }
  return ran;
}

let depth = 0;
/** Runs fn in a transaction; nested calls join the outer transaction. */
export function tx<T>(db: Db, fn: () => T): T {
  if (depth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  depth++;
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    depth--;
  }
}

export function all<T = Row>(db: Db, sql: string, ...params: Param[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function get<T = Row>(db: Db, sql: string, ...params: Param[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function run(db: Db, sql: string, ...params: Param[]): number {
  return Number(db.prepare(sql).run(...params).changes);
}
