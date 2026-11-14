import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some(candidate => candidate.name === column);
}

/**
 * Key weight and rotation order [fork 6/10].
 *
 * Until now a key was either in the pool or out of it (`enabled`) — there was no
 * way to say "prefer this one but keep the other as backup", so the only knob was
 * disabling a working credential. Two columns:
 *
 *   - `weight`   (default 1): relative share WITHIN an order group. A key with
 *                weight 2 gets roughly twice the requests of a weight-1 sibling.
 *   - `key_order` (default 0): rotation group. Keys of the lowest group are
 *                tried first; a later group only sees traffic when every key of
 *                the earlier one is unusable (cap, cooldown, no slots, error).
 *
 * Both are read fresh on every routing decision, so a change applies to the next
 * request with no restart. `key_order` is named with the prefix because ORDER is
 * a SQL keyword.
 *
 * DOWN: reversible (drops both columns).
 */
export function up(db: Db): void {
  if (!hasColumn(db, 'api_keys', 'weight')) {
    db.prepare('ALTER TABLE api_keys ADD COLUMN weight INTEGER NOT NULL DEFAULT 1').run();
  }
  if (!hasColumn(db, 'api_keys', 'key_order')) {
    db.prepare('ALTER TABLE api_keys ADD COLUMN key_order INTEGER NOT NULL DEFAULT 0').run();
  }
  db.prepare('CREATE INDEX IF NOT EXISTS idx_api_keys_weight_order ON api_keys(platform, key_order)').run();
}

export function down(db: Db): void {
  db.prepare('DROP INDEX IF EXISTS idx_api_keys_weight_order').run();
  for (const column of ['weight', 'key_order']) {
    if (hasColumn(db, 'api_keys', column)) {
      db.prepare(`ALTER TABLE api_keys DROP COLUMN ${column}`).run();
    }
  }
}