import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some((candidate) => candidate.name === column);
}

/**
 * Windowed per-key caps [fork 4/10].
 *
 * `key_caps` is a generalised cap ledger: hour / day / week / month windows,
 * request or token unit, calendar (with a timezone and, for month, an optional
 * custom billing day) or sliding reset, a soft-threshold percent (default 80: a
 * key stays eligible but deprioritised until 100), and an optional `model_id`
 * to cap a single model on a key or account.
 *
 * A cap may be key-scoped (`key_id` set) or account-scoped (`account_key` set),
 * where several api_keys rows sharing `account_key` draw from ONE budget — the
 * analogue of OpenRouter's per-account limits. `api_keys.account_key` holds the
 * group tag.
 *
 * The legacy `monthly_request_cap` / `monthly_token_cap` columns are LEFT in
 * place: they are the UTC-calendar-month caps and keep working exactly as
 * before (enforced by services/key-budget.ts), so no existing value is lost or
 * re-interpreted. The new table adds every other window and the shared/soft/
 * per-model capabilities alongside them.
 *
 * DOWN: reversible (drops the table and the account_key column).
 */
export function up(db: Db): void {
  if (!hasColumn(db, 'api_keys', 'account_key')) {
    db.prepare('ALTER TABLE api_keys ADD COLUMN account_key TEXT').run();
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS key_caps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_id INTEGER,
      account_key TEXT,
      model_id TEXT,
      window TEXT NOT NULL CHECK (window IN ('hour', 'day', 'week', 'month')),
      unit TEXT NOT NULL CHECK (unit IN ('requests', 'tokens')),
      cap INTEGER NOT NULL,
      reset_type TEXT NOT NULL DEFAULT 'calendar' CHECK (reset_type IN ('calendar', 'sliding')),
      timezone TEXT NOT NULL DEFAULT 'UTC',
      reset_hour INTEGER NOT NULL DEFAULT 0,
      reset_day_of_month INTEGER,
      soft_percent INTEGER NOT NULL DEFAULT 80,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (key_id IS NOT NULL OR account_key IS NOT NULL),
      CHECK (soft_percent BETWEEN 0 AND 100)
    );
    CREATE INDEX IF NOT EXISTS idx_key_caps_key ON key_caps(key_id);
    CREATE INDEX IF NOT EXISTS idx_key_caps_account ON key_caps(account_key);
  `);
}

export function down(db: Db): void {
  db.exec('DROP TABLE IF EXISTS key_caps;');
  if (hasColumn(db, 'api_keys', 'account_key')) {
    db.prepare('ALTER TABLE api_keys DROP COLUMN account_key').run();
  }
}