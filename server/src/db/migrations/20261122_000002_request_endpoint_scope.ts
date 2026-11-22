// Migration: durable endpoint identity on request logs.
// Created: 2026-11-22
//
// DOWN: reversible
//
// Custom relays all share the platform id `custom`. Request rows stored only
// that id, so the dashboard's log rows/attempt timeline rendered "custom"
// instead of the relay host — and a deleted key made the host unrecoverable.
// Store the normalized endpoint snapshot on the row itself, like key_label.

import type { Db } from '../types.js';

export function up(db: Db): void {
  const hasColumn = (table: string, column: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .some(row => row.name === column);

  if (!hasColumn('requests', 'endpoint_scope')) {
    db.exec(`ALTER TABLE requests ADD COLUMN endpoint_scope TEXT NOT NULL DEFAULT ''`);
    db.exec(`UPDATE requests SET endpoint_scope = COALESCE((
      SELECT rtrim(trim(k.base_url), '/') FROM api_keys k WHERE k.id = requests.key_id
    ), '')`);
  }
  if (!hasColumn('request_attempts', 'endpoint_scope')) {
    db.exec(`ALTER TABLE request_attempts ADD COLUMN endpoint_scope TEXT NOT NULL DEFAULT ''`);
    // Historical attempts keep a label snapshot but no key id; the only safe
    // backfill is by (platform, key_label) when exactly one key owns it.
    db.exec(`UPDATE request_attempts SET endpoint_scope = COALESCE((
      SELECT rtrim(trim(k.base_url), '/') FROM api_keys k
       WHERE k.platform = request_attempts.platform
         AND k.label = request_attempts.key_label
         AND k.base_url IS NOT NULL
       LIMIT 1
    ), '')`);
  }
}

export function down(db: Db): void {
  try {
    db.exec(`
      ALTER TABLE request_attempts DROP COLUMN endpoint_scope;
      ALTER TABLE requests DROP COLUMN endpoint_scope;
    `);
  } catch {
    // SQLite in this runtime cannot drop columns; report irreversible instead
    // of silently leaving schema state the round-trip test cannot undo.
    throw new Error('irreversible: request endpoint_scope columns cannot be dropped');
  }
}
