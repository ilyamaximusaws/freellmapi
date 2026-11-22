import type { Db } from '../types.js';

/**
 * In-site notifications (#provider-audit).
 *
 * The existing `notification_log` targets external channels (webhook/Telegram)
 * and has no read state. Ember needs a feed of operational alerts that lives in
 * the control plane itself: "this provider is unstable, add more models" and
 * "this provider is fully down, attention needed". One row per provider keeps
 * the feed deduplicated — a later audit updates the same row instead of
 * stacking a new alert every ten minutes.
 *
 * `provider` is the upstream identity (platform, or platform@endpoint for a
 * custom relay). `metadata` carries the audit counts the UI shows.
 *
 * DOWN: reversible (drops the table).
 */
export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS site_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('provider_unstable', 'provider_down', 'provider_recovered')),
      severity TEXT NOT NULL CHECK (severity IN ('warning', 'critical', 'success', 'info')),
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      dedup_key TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      read_at_ms INTEGER,
      resolved_at_ms INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_site_notifications_dedup
      ON site_notifications(dedup_key);
    CREATE INDEX IF NOT EXISTS idx_site_notifications_feed
      ON site_notifications(created_at_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_site_notifications_unread
      ON site_notifications(read_at_ms, resolved_at_ms);
  `);
}

export function down(db: Db): void {
  db.exec('DROP TABLE IF EXISTS site_notifications;');
}