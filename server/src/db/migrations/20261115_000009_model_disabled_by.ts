// Migration: who disabled a model — the provider's catalog or a local choice.
// Created: 2026-11-15
//
// DOWN: reversible (DROP COLUMN)
//
// `models.enabled` on its own cannot answer the one question the catalog sync
// has to ask: when the provider lists a model as enabled again, may we turn it
// back on? Two very different situations both land on `enabled = 0`:
//
//   * the catalog said `enabled: false` — the provider withdrew the model, and
//     listing it again is newer evidence that it is back, so it belongs in
//     rotation again;
//   * a user (or the admin API) turned it off — a deliberate choice that a
//     catalog refresh must never silently undo. See
//     docs/en/architecture/05-catalog-sync.md: "enabled: true | Never
//     re-enables a model the user turned off".
//
// Before this column the sync kept the stored `row.enabled` whenever the
// catalog said enabled, so a model the provider had withdrawn stayed out of
// rotation forever — the disable round-tripped, the re-enable did not.
//
// NULL means "disabled before this column existed" and is treated as a local
// disable: the conservative reading, and the one that preserves the behaviour
// of every existing install.
//
// Guarded like every other column add: catalog-sync re-runs migrations over a
// live schema, so ALTERs must be idempotent.

import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some(col => col.name === column);
}

export function up(db: Db): void {
  if (!hasColumn(db, 'models', 'disabled_by')) {
    db.prepare("ALTER TABLE models ADD COLUMN disabled_by TEXT").run();
  }
}

export function down(db: Db): void {
  if (hasColumn(db, 'models', 'disabled_by')) {
    db.prepare('ALTER TABLE models DROP COLUMN disabled_by').run();
  }
}
