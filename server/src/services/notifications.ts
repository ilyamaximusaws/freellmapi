/**
 * Notifications [fork 9/10].
 *
 * Where a key went to `error` at 3am, the only sign used to be a failing request.
 * This module shouts instead — through a webhook or a Telegram bot — while being
 * careful not to shout the house down:
 *
 *   - DEDUP: every delivery is keyed by a `dedup_key`; the same key within the
 *     cooldown is suppressed (a re-raising action flag, a re-failing key). Events
 *     that must fire ONCE (`key_expiring`) use a key that includes the expiry
 *     date, so a reminder is sent exactly once per date.
 *   - COALESCING: the fleet sweep groups by event, so 20 keys going to `error`
 *     in one minute is ONE notification listing them, not twenty.
 *   - NON-BLOCKING: notify() only writes `notification_log` rows and returns. The
 *     sender (the scheduler's flush) performs the actual HTTP out of the request
 *     path, so a slow or dead webhook can never stall the router.
 *   - RETRY: a pending row whose next_attempt_ms has passed is redelivered with
 *     exponential backoff (5s * 2^attempt), up to a cap, then marked failed.
 *     Rows live in the DB, so a restart does not drop undelivered alerts.
 *
 * Channels and per-event toggles live in `notification_channels` and the settings
 * table, so what is loud is configuration, not code.
 */
import { getDb, getSetting, setSetting } from '../db/index.js';
import { upstreamIdentityOfKey } from '../lib/endpoint-scope.js';

export const NOTIFY_EVENTS = [
  'key_error',
  'cap_soft',
  'cap_hard',
  'provider_no_keys',
  'ready_upstreams_low',
  'action_needed',
  'key_expiring',
] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

export interface NotificationChannel {
  id: number;
  kind: 'webhook' | 'telegram';
  name: string;
  url: string | null;
  botToken: string | null;
  chatId: string | null;
  events: Record<string, boolean>;
  enabled: boolean;
}

export interface NotificationSettings {
  /** Which events are on globally (per-channel overrides in channel.events). */
  events: Record<string, boolean>;
  /** A webhook is allowed this long before it is considered failed. */
  webhookTimeoutMs: number;
  /** Suppress a duplicate within this window. */
  cooldownMs: number;
  /** Max delivery attempts before `failed`. */
  maxAttempts: number;
  /** Base backoff between attempts; doubles each retry. */
  backoffBaseMs: number;
  /** Sweep: shout when ready upstreams fall below this (0 = off). */
  readyUpstreamsMin: number;
}

const SETTINGS_KEY = 'notification_settings';
const DEFAULT_COOLDOWN_MS = 30 * 60_000;
const DEFAULT_ATTEMPTS = 3;

export const DEFAULT_EVENTS: Record<string, boolean> = Object.fromEntries(NOTIFY_EVENTS.map(event => [event, true]));

function defaults(): NotificationSettings {
  return {
    events: { ...DEFAULT_EVENTS },
    webhookTimeoutMs: 10_000,
    cooldownMs: DEFAULT_COOLDOWN_MS,
    maxAttempts: DEFAULT_ATTEMPTS,
    backoffBaseMs: 5_000,
    readyUpstreamsMin: 0,
  };
}

export function getNotificationSettings(): NotificationSettings {
  const base = defaults();
  try {
    const raw = getSetting(SETTINGS_KEY);
    if (raw && raw.trim()) {
      const parsed = JSON.parse(raw) as Partial<NotificationSettings>;
      return {
        ...base,
        ...parsed,
        events: { ...base.events, ...(parsed.events ?? {}) },
      };
    }
  } catch {
    /* corrupted JSON -> defaults */
  }
  return base;
}

function saveSettings(settings: NotificationSettings): void {
  setSetting(SETTINGS_KEY, JSON.stringify(settings));
}

// ── Channels ────────────────────────────────────────────────────────────────

function channelFromRow(row: any): NotificationChannel {
  let events: Record<string, boolean> = {};
  try { events = row.events ? JSON.parse(row.events) : {}; } catch { /* ignore */ }
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    url: row.url ?? null,
    botToken: row.bot_token ?? null,
    chatId: row.chat_id ?? null,
    events,
    enabled: row.enabled === 1,
  };
}

export function listChannels(): NotificationChannel[] {
  return (getDb().prepare('SELECT * FROM notification_channels ORDER BY id').all() as any[]).map(channelFromRow);
}

export function createChannel(input: {
  kind: 'webhook' | 'telegram';
  name: string;
  url?: string | null;
  botToken?: string | null;
  chatId?: string | null;
  events?: Record<string, boolean>;
}): NotificationChannel {
  if (input.kind === 'webhook' && !input.url) throw new Error('webhook url is required');
  if (input.kind === 'telegram' && (!input.botToken || !input.chatId)) throw new Error('telegram botToken and chatId are required');
  const info = getDb().prepare(`
    INSERT INTO notification_channels (kind, name, url, bot_token, chat_id, events)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    input.kind, input.name.trim(), input.url ?? null, input.botToken ?? null, input.chatId ?? null,
    JSON.stringify(input.events ?? {}),
  );
  return channelFromRow(getDb().prepare('SELECT * FROM notification_channels WHERE id = ?').get(Number(info.lastInsertRowid)));
}

export function updateChannel(id: number, input: Partial<Omit<NotificationChannel, 'id'>>): NotificationChannel | null {
  const existing = getDb().prepare('SELECT * FROM notification_channels WHERE id = ?').get(id) as any;
  if (!existing) return null;
  const kind = input.kind ?? existing.kind;
  const next = {
    kind,
    name: input.name ?? existing.name,
    url: input.url !== undefined ? input.url : existing.url,
    bot_token: input.botToken !== undefined ? input.botToken : existing.bot_token,
    chat_id: input.chatId !== undefined ? input.chatId : existing.chat_id,
    events: input.events !== undefined ? JSON.stringify(input.events) : existing.events,
    enabled: input.enabled !== undefined ? (input.enabled ? 1 : 0) : existing.enabled,
  };
  if (kind === 'webhook' && !next.url) throw new Error('webhook url is required');
  if (kind === 'telegram' && (!next.bot_token || !next.chat_id)) throw new Error('telegram botToken and chatId are required');
  getDb().prepare(`
    UPDATE notification_channels
       SET kind = ?, name = ?, url = ?, bot_token = ?, chat_id = ?, events = ?, enabled = ?, updated_at = datetime('now')
     WHERE id = ?
  `).run(next.kind, next.name, next.url, next.bot_token, next.chat_id, next.events, next.enabled, id);
  return channelFromRow(getDb().prepare('SELECT * FROM notification_channels WHERE id = ?').get(id));
}

export function deleteChannel(id: number): boolean {
  return getDb().prepare('DELETE FROM notification_channels WHERE id = ?').run(id).changes > 0;
}

// ── Delivery queue ──────────────────────────────────────────────────────────

function channelsForEvent(event: NotifyEvent): NotificationChannel[] {
  const settings = getNotificationSettings();
  if (!settings.events[event]) return [];
  // Channels live in their own table (the config JSON only holds toggles), so a
  // webhook/Telegram list is always read fresh from the DB, never from settings.
  return listChannels().filter(channel => {
    if (!channel.enabled) return false;
    // A channel's own map overrides the global toggle when it pinpoints the event.
    if (event in channel.events) return channel.events[event];
    return true;
  });
}

/** Once-only events (expiry reminders) bypass the cooldown via a perpetual key. */
function eventCooldownMs(event: NotifyEvent, settings: NotificationSettings): number {
  if (event === 'key_expiring') return Number.MAX_SAFE_INTEGER;
  return settings.cooldownMs;
}

/** Is there already a delivery for this dedup key inside the cooldown window? */
function wasRecentlySent(dedupKey: string, cooldownMs: number, now: number): boolean {
  const row = getDb().prepare(`
    SELECT created_at_ms FROM notification_log
     WHERE dedup_key = ? AND status IN ('pending', 'sent')
  ORDER BY created_at_ms DESC LIMIT 1
  `).get(dedupKey) as { created_at_ms: number } | undefined;
  if (!row) return false;
  return now - row.created_at_ms < cooldownMs;
}

export interface NotifyResult {
  queued: number;
  suppressed: number;
  dedupKey: string;
}

export function notify(event: NotifyEvent, payload: { title: string; body?: string; dedupKey?: string }, now = Date.now()): NotifyResult {
  const body = payload.body ?? '';
  const channels = channelsForEvent(event);
  const dedupKey = payload.dedupKey ?? `${event}:${payload.title}`;
  if (channels.length === 0) return { queued: 0, suppressed: 0, dedupKey };

  const settings = getNotificationSettings();
  const cooldownMs = eventCooldownMs(event, settings);
  // key_expiring uses an infinite cooldown: once sent for a given (key, date),
  // never again. Everything else dedups within cooldownMs.
  if (wasRecentlySent(dedupKey, cooldownMs, now)) {
    getDb().prepare(`
      INSERT INTO notification_log (event, dedup_key, channel_id, kind, title, body, status, attempts, next_attempt_ms, created_at_ms)
      VALUES (?, ?, NULL, 'none', ?, ?, 'suppressed', 0, 0, ?)
    `).run(event, dedupKey, payload.title, body, now);
    return { queued: 0, suppressed: 1, dedupKey };
  }

  const insert = getDb().prepare(`
    INSERT INTO notification_log (event, dedup_key, channel_id, kind, title, body, status, attempts, next_attempt_ms, created_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
  `);
  for (const channel of channels) {
    insert.run(event, dedupKey, channel.id, channel.kind, payload.title, body, now, now);
  }
  return { queued: channels.length, suppressed: 0, dedupKey };
}

// ── Sending ────────────────────────────────────────────────────────────────

async function deliverWebhook(url: string, text: string, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`webhook ${res.status}`);
  } finally {
    clearTimeout(timer);
  }
}

async function deliverTelegram(botToken: string, chatId: string, text: string, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `https://api.telegram.org/bot${encodeURIComponent(botToken)}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`telegram ${res.status}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Deliver everything that is due. Returns the number of rows attempted. */
export async function flushNotifications(now = Date.now()): Promise<number> {
  const settings = getNotificationSettings();
  const due = getDb().prepare(`
    SELECT * FROM notification_log
     WHERE status = 'pending' AND next_attempt_ms <= ?
  ORDER BY id
  `).all(now) as any[];

  const update = getDb().prepare(`
    UPDATE notification_log
       SET status = ?, attempts = ?, last_error = ?, next_attempt_ms = ?, sent_at_ms = ?
     WHERE id = ?
  `);

  for (const row of due) {
    const channel = row.channel_id
      ? (getDb().prepare('SELECT * FROM notification_channels WHERE id = ?').get(row.channel_id) as any)
      : null;
    const text = `${row.title}\n\n${row.body}`;
    try {
      if (row.kind === 'webhook') {
        if (!channel?.url) throw new Error('webhook channel missing url');
        await deliverWebhook(channel.url, text, settings.webhookTimeoutMs);
      } else if (row.kind === 'telegram') {
        if (!channel?.bot_token || !channel?.chat_id) throw new Error('telegram channel missing credentials');
        await deliverTelegram(channel.bot_token, channel.chat_id, text, settings.webhookTimeoutMs);
      } else {
        throw new Error(`unknown kind ${row.kind}`);
      }
      update.run('sent', row.attempts + 1, null, 0, now, row.id);
    } catch (err) {
      const attempts = row.attempts + 1;
      const nextAttempt = now + settings.backoffBaseMs * 2 ** row.attempts;
      const failed = attempts >= settings.maxAttempts;
      update.run(failed ? 'failed' : 'pending', attempts, String((err as Error)?.message ?? err), failed ? 0 : nextAttempt, null, row.id);
    }
  }
  return due.length;
}

// ── Fleet sweep ─────────────────────────────────────────────────────────────

/**
 * The scheduler's periodic scan: produces ONE coalesced notification per event
 * rather than one per key, so a fleet-wide failure is a summary, not a storm.
 */
export async function runNotificationSweep(now = Date.now()): Promise<NotifyResult[]> {
  const results: NotifyResult[] = [];
  const db = getDb();

  const erroredKeys = (db.prepare(`
    SELECT id, label, platform FROM api_keys WHERE enabled = 1 AND status = 'error'
  `).all() as Array<{ id: number; label: string | null; platform: string }>);
  if (erroredKeys.length > 0) {
    results.push(notify('key_error', {
      title: `${erroredKeys.length} key(s) in error`,
      body: erroredKeys.map(key => `- ${key.label ?? `#${key.id}`} (${key.platform})`).join('\n'),
      dedupKey: `key_error:${erroredKeys.map(key => key.id).sort().join(',')}`,
    }, now));
  }

  // ready_upstreams below the configured minimum.
  const settings = getNotificationSettings();
  if (settings.readyUpstreamsMin > 0) {
    // Same upstream identity as /readyz: relays are independent upstreams, so a
    // three-relay pool must not read as one 'custom' provider and trip a minimum
    // the operator set for three.
    const rows = db.prepare('SELECT platform, base_url, status FROM api_keys WHERE enabled = 1')
      .all() as { platform: string; base_url: string | null; status: string }[];
    const present = new Set<string>();
    const live = new Set<string>();
    for (const row of rows) {
      const upstream = upstreamIdentityOfKey(row.platform, row.base_url);
      present.add(upstream);
      if (row.status === 'healthy' || row.status === 'unknown') live.add(upstream);
    }
    const upstreams = [...present].sort();
    const ready = live.size;
    if (ready < settings.readyUpstreamsMin) {
      results.push(notify('ready_upstreams_low', {
        title: `${ready}/${upstreams.length} upstreams ready (below ${settings.readyUpstreamsMin})`,
        body: upstreams.join(', ') || '(none configured)',
        dedupKey: `ready_upstreams_low:${ready}`,
      }, now));
    }
  } else if (listChannels().length > 0) {
    // provider_no_keys: a platform with zero live keys at all.
    const emptyPlatforms = (db.prepare(`
      SELECT platform FROM api_keys WHERE enabled = 1
      GROUP BY platform
      HAVING SUM(CASE WHEN status IN ('healthy', 'unknown') THEN 1 ELSE 0 END) = 0
        AND SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) > 0
    `).all() as Array<{ platform: string }>).map(row => row.platform);
    if (emptyPlatforms.length > 0) {
      results.push(notify('provider_no_keys', {
        title: `Provider(s) with no live key: ${emptyPlatforms.join(', ')}`,
        body: 'Every enabled key is in error. Requests to these providers will fail unless another platform serves the model.',
        dedupKey: `provider_no_keys:${emptyPlatforms.sort().join(',')}`,
      }, now));
    }
  }

  // action_needed flags (active).
  const actions = (db.prepare(`
    SELECT key_id, reason FROM key_action_needed WHERE active = 1
  `).all() as Array<{ key_id: number; reason: string }>);
  if (actions.length > 0) {
    results.push(notify('action_needed', {
      title: `${actions.length} key(s) need action`,
      body: actions.map(action => `- #${action.key_id}: ${action.reason}`).join('\n'),
      dedupKey: `action_needed:${actions.map(action => `${action.key_id}:${action.reason}`).sort().join(',')}`,
    }, now));
  }

  // Expiry reminders (once per key per expiry date).
  const { expiringKeys } = await import('./key-metadata.js');
  for (const expiring of expiringKeys(now)) {
    results.push(notify('key_expiring', {
      title: `Key ${expiring.label} expires in ${expiring.daysLeft.toFixed(1)} day(s)`,
      body: `${expiring.platform} key #${expiring.keyId} expires ${expiring.expiresAt}.`,
      dedupKey: `key_expiring:${expiring.keyId}:${expiring.expiresAt}`,
    }, now));
  }

  return results;
}

// ── Scheduler ──────────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;
export const NOTIFICATION_TICK_MS = 60_000;

export function startNotificationScheduler(flush = flushNotifications, sweep = runNotificationSweep): void {
  if (timer) return;
  timer = setInterval(() => {
    sweep().catch(err => console.warn('[notify] sweep failed', err));
    flush().catch(err => console.warn('[notify] flush failed', err));
  }, NOTIFICATION_TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

export function stopNotificationScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}