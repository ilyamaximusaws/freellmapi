// site-notifications — the in-site alert feed for Ember.
//
// External webhooks answer "tell me on Telegram". This table answers "tell me
// in the control plane": an operator looking at Ember should see that a
// provider's model pool was found unstable (some models answer, some do not)
// or fully down (nothing answers), without waiting for an outbound channel to
// be configured. One row per provider means a repeated audit updates the
// existing alert instead of stacking duplicates; a recovered audit resolves it.

import { getDb } from '../db/index.js';

export type SiteNotificationKind = 'provider_unstable' | 'provider_down' | 'provider_recovered';
export type SiteNotificationSeverity = 'warning' | 'critical' | 'success' | 'info';

export interface SiteNotification {
  id: number;
  provider: string;
  kind: SiteNotificationKind;
  severity: SiteNotificationSeverity;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
  createdAtMs: number;
  updatedAtMs: number;
  readAtMs: number | null;
  resolvedAtMs: number | null;
}

interface SiteNotificationRow {
  id: number;
  provider: string;
  kind: SiteNotificationKind;
  severity: SiteNotificationSeverity;
  title: string;
  body: string;
  metadata: string;
  created_at_ms: number;
  updated_at_ms: number;
  read_at_ms: number | null;
  resolved_at_ms: number | null;
}

function fromRow(row: SiteNotificationRow): SiteNotification {
  let metadata: Record<string, unknown> = {};
  try { metadata = row.metadata ? JSON.parse(row.metadata) : {}; } catch { /* keep {} */ }
  return {
    id: row.id,
    provider: row.provider,
    kind: row.kind,
    severity: row.severity,
    title: row.title,
    body: row.body,
    metadata,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    readAtMs: row.read_at_ms,
    resolvedAtMs: row.resolved_at_ms,
  };
}

export interface UpsertSiteNotificationInput {
  provider: string;
  kind: SiteNotificationKind;
  severity: SiteNotificationSeverity;
  title: string;
  body: string;
  metadata?: Record<string, unknown>;
  now?: number;
}

/**
 * Create or refresh one provider's alert. A different kind (unstable → down,
 * or any → recovered) is a new state and becomes unread again; the same kind
 * keeps its read flag so a 10-minute re-audit does not resurrect a dismissed
 * banner. `resolved_at_ms` is set for the recovered kind only.
 */
export function upsertSiteNotification(input: UpsertSiteNotificationInput): SiteNotification {
  const now = input.now ?? Date.now();
  const dedupKey = `provider:${input.provider}`;
  const resolvedAt = input.kind === 'provider_recovered' ? now : null;
  getDb().prepare(`
    INSERT INTO site_notifications
      (provider, kind, severity, title, body, metadata, dedup_key, created_at_ms, updated_at_ms, read_at_ms, resolved_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    ON CONFLICT(dedup_key) DO UPDATE SET
      provider = excluded.provider,
      kind = excluded.kind,
      severity = excluded.severity,
      title = excluded.title,
      body = excluded.body,
      metadata = excluded.metadata,
      updated_at_ms = excluded.updated_at_ms,
      read_at_ms = CASE
        WHEN site_notifications.kind <> excluded.kind OR site_notifications.resolved_at_ms IS NOT NULL
        THEN NULL ELSE site_notifications.read_at_ms END,
      resolved_at_ms = excluded.resolved_at_ms
  `).run(
    input.provider, input.kind, input.severity, input.title, input.body,
    JSON.stringify(input.metadata ?? {}), dedupKey, now, now, resolvedAt,
  );
  return fromRow(getDb().prepare('SELECT * FROM site_notifications WHERE dedup_key = ?').get(dedupKey) as SiteNotificationRow);
}

export interface SiteNotificationFeed {
  notifications: SiteNotification[];
  unread: number;
}

export function listSiteNotifications(limit = 30, includeResolved = false): SiteNotificationFeed {
  const capped = Math.max(1, Math.min(100, Math.trunc(limit)));
  const rows = getDb().prepare(`
    SELECT * FROM site_notifications
     WHERE (? = 1 OR resolved_at_ms IS NULL)
  ORDER BY updated_at_ms DESC
     LIMIT ?
  `).all(includeResolved ? 1 : 0, capped) as SiteNotificationRow[];
  const unread = (getDb().prepare(`
    SELECT COUNT(*) AS n FROM site_notifications
     WHERE read_at_ms IS NULL AND resolved_at_ms IS NULL
  `).get() as { n: number }).n;
  return { notifications: rows.map(fromRow), unread: Number(unread) };
}

/** Mark one alert read. Returns false when the id does not exist. */
export function markSiteNotificationRead(id: number, now = Date.now()): boolean {
  return getDb().prepare('UPDATE site_notifications SET read_at_ms = ? WHERE id = ? AND read_at_ms IS NULL')
    .run(now, id).changes > 0
    || getDb().prepare('SELECT 1 FROM site_notifications WHERE id = ?').get(id) !== undefined;
}

export function markAllSiteNotificationsRead(now = Date.now()): number {
  return getDb().prepare('UPDATE site_notifications SET read_at_ms = ? WHERE read_at_ms IS NULL')
    .run(now).changes;
}

/** Resolve one provider's active alert without creating a recovered banner. */
export function resolveProviderNotification(provider: string, now = Date.now()): void {
  getDb().prepare(`
    UPDATE site_notifications
       SET resolved_at_ms = ?, updated_at_ms = ?, read_at_ms = COALESCE(read_at_ms, ?)
     WHERE dedup_key = ? AND resolved_at_ms IS NULL
  `).run(now, now, now, `provider:${provider}`);
}

/** Test hook. */
export function resetSiteNotifications(): void {
  getDb().prepare('DELETE FROM site_notifications').run();
}