import type { Db } from '../types.js';

function hasTable(db: Db, table: string): boolean {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table) !== undefined;
}

/**
 * Audit log [fork 10/10].
 *
 * When a weight or cap is tuned and the router starts misbehaving an hour later,
 * the operator needs the *history*: who changed what, from what to what. One
 * row per field change, so `field` + `old_value`/`new_value` let the dashboard
 * show a diff, and a generic "settings changed" row catches edits that never
 * got a bespoke hook.
 *
 * `entity_type`/`entity_id` name the thing (api_key/N, settings, client_profile),
 * `actor` is the dashboard email or 'system' for service-driven changes,
 * `action` is create/update/delete/set, and `field` is the specific column (or
 * '*' for a whole-row change). Secret values are never stored — callers redact
 * before writing (see audit-redact helper).
 *
 * DOWN: reversible (drops the table).
 */
export function up(db: Db): void {
  if (hasTable(db, 'audit_log')) return;
  db.exec(`
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT NOT NULL DEFAULT 'system',
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      action TEXT NOT NULL,
      field TEXT NOT NULL DEFAULT '*',
      old_value TEXT,
      new_value TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);
  `);
}

export function down(db: Db): void {
  db.exec('DROP TABLE IF EXISTS audit_log;');
}