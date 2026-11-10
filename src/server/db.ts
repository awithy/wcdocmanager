import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export type DB = Database.Database;

// Append-only: each entry migrates user_version N -> N+1.
const migrations: string[] = [
  `
  CREATE TABLE categories (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    created_at TEXT NOT NULL
  );
  CREATE TABLE documents (
    id INTEGER PRIMARY KEY,
    category_id INTEGER NOT NULL REFERENCES categories(id),
    title TEXT NOT NULL,
    doc_date TEXT NOT NULL,
    rel_path TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    filed_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX documents_sha256 ON documents(sha256);
  CREATE INDEX documents_category_title ON documents(category_id, title COLLATE NOCASE);
  CREATE TABLE tags (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
  );
  CREATE TABLE document_tags (
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id),
    PRIMARY KEY (document_id, tag_id)
  );
  CREATE TABLE discards (
    id INTEGER PRIMARY KEY,
    original_name TEXT NOT NULL,
    rel_path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL,
    discarded_at TEXT NOT NULL
  );
  CREATE INDEX discards_sha256 ON discards(sha256);
  `,
];

export function openDatabase(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db: DB) {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < migrations.length; v++) {
    db.transaction(() => {
      db.exec(migrations[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}
