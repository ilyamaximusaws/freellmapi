import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some((candidate) => candidate.name === column);
}

/**
 * Per-key concurrency [fork 2/10].
 *
 * `api_keys.max_concurrent` overrides how many requests may be in flight
 * against one credential at once. Resolution order (services/ratelimit.ts):
 *
 *   1. this column (NULL = inherit, 0 = unlimited)
 *   2. MAX_CONCURRENT_REQUESTS_PER_KEY_<PLATFORM> (env)
 *   3. MAX_CONCURRENT_REQUESTS_PER_KEY (env)
 *   4. the runtime setting `key_max_concurrent_default` (default 3)
 *
 * Previously the limit was env-only and unset by default, so parallel streams
 * all piled onto the same credential and 429'd each other.
 *
 * DOWN: reversible.
 */
export function up(db: Db): void {
  if (!hasColumn(db, 'api_keys', 'max_concurrent')) {
    db.prepare('ALTER TABLE api_keys ADD COLUMN max_concurrent INTEGER').run();
  }
}

export function down(db: Db): void {
  if (hasColumn(db, 'api_keys', 'max_concurrent')) {
    db.prepare('ALTER TABLE api_keys DROP COLUMN max_concurrent').run();
  }
}