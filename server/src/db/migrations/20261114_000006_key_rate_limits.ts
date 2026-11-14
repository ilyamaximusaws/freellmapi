import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some(candidate => candidate.name === column);
}

function hasTable(db: Db, table: string): boolean {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table) !== undefined;
}

/**
 * Per-key rate limits [fork 7/10].
 *
 * Until now rpm/rpd/tpm/tpd existed only on MODELS, so a provider that meters per
 * credential (most free tiers do) was learned about only by collecting 429s: the
 * gateway spent a request to discover it had no budget left.
 *
 *   - `api_keys.rpm_limit` / `tpm_limit` / `rpd_limit`: the operator's own caps
 *     for this credential. Counted on a sliding window over `rate_limit_usage`,
 *     which already records one row per served request/token bundle per key.
 *   - `key_rate_state`: the LAST rate-limit snapshot the provider reported in its
 *     response headers. A provider that states its own remaining outranks our
 *     count — it knows about windows and quotas we cannot see — so it both
 *     suppresses a key with nothing left and lets ours be corrected rather than
 *     double-counted.
 *   - `key_cooldowns`: a key-wide hold with a reason, either manual (the operator
 *     parks a key) or taken from a 429's Retry-After. Distinct from
 *     `rate_limit_cooldowns`, which is per (platform, model, key).
 *
 * DOWN: reversible (drops the columns and both tables).
 */
export function up(db: Db): void {
  for (const column of ['rpm_limit', 'tpm_limit', 'rpd_limit']) {
    if (!hasColumn(db, 'api_keys', column)) {
      db.prepare(`ALTER TABLE api_keys ADD COLUMN ${column} INTEGER`).run();
    }
  }
  // Key-level aggregation counts across every model of a key, which the existing
  // (platform, model_id, key_id, …) index cannot serve.
  db.prepare('CREATE INDEX IF NOT EXISTS idx_rate_limit_usage_key ON rate_limit_usage(key_id, kind, created_at_ms)').run();

  if (!hasTable(db, 'key_rate_state')) {
    db.exec(`
      CREATE TABLE key_rate_state (
        key_id INTEGER PRIMARY KEY,
        requests_limit INTEGER,
        requests_remaining INTEGER,
        requests_reset_ms INTEGER,
        tokens_limit INTEGER,
        tokens_remaining INTEGER,
        tokens_reset_ms INTEGER,
        source TEXT NOT NULL DEFAULT 'headers',
        observed_at_ms INTEGER NOT NULL
      );
    `);
  }

  if (!hasTable(db, 'key_cooldowns')) {
    db.exec(`
      CREATE TABLE key_cooldowns (
        key_id INTEGER PRIMARY KEY,
        reason TEXT NOT NULL,
        note TEXT,
        source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'retry_after')),
        expires_at_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }
}

export function down(db: Db): void {
  db.exec('DROP TABLE IF EXISTS key_cooldowns;');
  db.exec('DROP TABLE IF EXISTS key_rate_state;');
  db.prepare('DROP INDEX IF EXISTS idx_rate_limit_usage_key').run();
  for (const column of ['rpm_limit', 'tpm_limit', 'rpd_limit']) {
    if (hasColumn(db, 'api_keys', column)) {
      db.prepare(`ALTER TABLE api_keys DROP COLUMN ${column}`).run();
    }
  }
}