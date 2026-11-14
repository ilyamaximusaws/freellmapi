import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some(candidate => candidate.name === column);
}

function hasTable(db: Db, table: string): boolean {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table) !== undefined;
}

/**
 * Key metadata + notifications [fork 9/10].
 *
 * A key row used to be credentials and nothing else: no way to say who owns the
 * account, when the trial dies, how much credit is left, or which console to open
 * when the dashboard flags it. And nothing ever TOLD the operator — a key went to
 * `error` at 3am and the first sign was a request failing.
 *
 *   - `api_keys.owner` / `console_url` / `note`: who it belongs to, where to fix
 *     it, free-form context.
 *   - `api_keys.key_type` ('free' | 'credits' | 'paid') + `credits_remaining`:
 *     what kind of budget the credential is, and how much is left when it is a
 *     credit balance rather than a rate limit.
 *   - `api_keys.expires_at` + `expire_reminder_days`: an end date (trial over,
 *     credits expire) and how many days ahead to shout about it.
 *   - `api_keys.tags`: JSON array of operator labels for bulk operations by group.
 *   - `notification_channels`: where to shout — a webhook URL or a Telegram bot
 *     token + chat id — with a per-event enable map, so tuning what is loud is
 *     config, not code.
 *   - `notification_log`: one row per (event, channel) delivery, holding the
 *     dedup key, attempt count and last error. It is also the retry queue: the
 *     sender picks up anything still pending, so a transient webhook failure is
 *     retried without the request path waiting on it.
 *
 * DOWN: reversible (drops the columns and both tables).
 */
export function up(db: Db): void {
  const columns: Array<[string, string]> = [
    ['owner', 'TEXT'],
    ['console_url', 'TEXT'],
    ['note', 'TEXT'],
    ['tags', 'TEXT'],
    ['key_type', "TEXT DEFAULT 'free'"],
    ['credits_remaining', 'REAL'],
    ['expires_at', 'TEXT'],
    ['expire_reminder_days', 'INTEGER NOT NULL DEFAULT 3'],
  ];
  for (const [column, type] of columns) {
    if (!hasColumn(db, 'api_keys', column)) {
      db.prepare(`ALTER TABLE api_keys ADD COLUMN ${column} ${type}`).run();
    }
  }

  if (!hasTable(db, 'notification_channels')) {
    db.exec(`
      CREATE TABLE notification_channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL CHECK (kind IN ('webhook', 'telegram')),
        name TEXT NOT NULL,
        url TEXT,
        bot_token TEXT,
        chat_id TEXT,
        events TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  if (!hasTable(db, 'notification_log')) {
    db.exec(`
      CREATE TABLE notification_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event TEXT NOT NULL,
        dedup_key TEXT NOT NULL,
        channel_id INTEGER,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'suppressed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        next_attempt_ms INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        sent_at_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_notification_log_dedup ON notification_log(dedup_key, created_at_ms);
      CREATE INDEX IF NOT EXISTS idx_notification_log_pending ON notification_log(status, next_attempt_ms);
    `);
  }
}

export function down(db: Db): void {
  db.exec('DROP TABLE IF EXISTS notification_log;');
  db.exec('DROP TABLE IF EXISTS notification_channels;');
  for (const column of ['owner', 'console_url', 'note', 'tags', 'key_type', 'credits_remaining', 'expires_at', 'expire_reminder_days']) {
    if (hasColumn(db, 'api_keys', column)) {
      db.prepare(`ALTER TABLE api_keys DROP COLUMN ${column}`).run();
    }
  }
}