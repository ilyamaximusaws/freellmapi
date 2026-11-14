import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb, setSetting } from '../../db/index.js';
import {
  notify, flushNotifications, runNotificationSweep, getNotificationSettings,
  listChannels, createChannel,
} from '../../services/notifications.js';
import { setKeyMetadata } from '../../services/key-metadata.js';

/**
 * [fork 9/10] Notification dedup, coalescing, retry and expiry-once behaviour.
 * Delivery goes through global fetch, which these tests drive with a mock.
 */

const T0 = Date.UTC(2026, 10, 14, 12, 0, 0);

function insertKey(over: { status?: string; label?: string; platform?: string; id?: number } = {}): number {
  const info = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, 'x', 'x', 'x', ?, 1)
  `).run(over.platform ?? 'groq', over.label ?? 'key', over.status ?? 'healthy');
  return Number(info.lastInsertRowid);
}

function pendingRows(): Array<{ status: string; event: string; attempts: number; channel_id: number | null }> {
  return getDb().prepare('SELECT status, event, attempts, channel_id FROM notification_log ORDER BY id').all() as any[];
}

describe('notification dedup and coalescing ([fork 9/10])', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    getDb().exec('DELETE FROM notification_log; DELETE FROM notification_channels; DELETE FROM api_keys; DELETE FROM settings;');
  });

  afterEach(() => vi.unstubAllGlobals());

  it('deduplicates the same key within the cooldown', () => {
    createChannel({ kind: 'webhook', name: 'w', url: 'http://example.invalid/hook' });
    const first = notify('key_error', { title: 'k1 broke', dedupKey: 'key_error:1' }, T0);
    const second = notify('key_error', { title: 'k1 broke', dedupKey: 'key_error:1' }, T0 + 1000);
    expect(first.queued).toBe(1);
    expect(second.suppressed).toBe(1);
    expect(getDb().prepare("SELECT COUNT(*) AS c FROM notification_log WHERE status = 'suppressed'").get().c).toBe(1);
  });

  it('coalesces a mass failure into one summary notification', async () => {
    createChannel({ kind: 'webhook', name: 'w', url: 'http://example.invalid/hook' });
    for (let i = 0; i < 20; i++) insertKey({ status: 'error', label: `dead-${i}` });

    const results = await runNotificationSweep(T0);
    const queued = results.reduce((sum, result) => sum + result.queued, 0);
    // One coalesced summary per EVENT, not per key: key_error (20 keys, one row)
    // plus the distinct provider_no_keys fact (this platform now has zero live
    // keys). Twenty keys must never mean twenty messages.
    expect(queued).toBe(2);
    const rows = pendingRows();
    const byEvent = Object.fromEntries(rows.map(row => [row.event, row]));
    expect(rows).toHaveLength(2);
    expect(byEvent.key_error).toBeTruthy();
    const body = getDb().prepare("SELECT body FROM notification_log WHERE event = 'key_error'").get() as { body: string };
    expect(body.body).toContain('dead-0');
    expect(body.body).toContain('dead-19');
  });

  it('suppresses entirely when a channel disables the event', () => {
    createChannel({ kind: 'webhook', name: 'w', url: 'http://example.invalid/hook', events: { key_error: false } });
    const result = notify('key_error', { title: 'quiet', dedupKey: 'q1' }, T0);
    expect(result.queued).toBe(0);
    expect(result.suppressed).toBe(0);
  });

  it('sends an expiry reminder exactly once', async () => {
    createChannel({ kind: 'webhook', name: 'w', url: 'http://example.invalid/hook' });
    const keyId = insertKey({ label: 'trial' });
    setKeyMetadata(keyId, { expiresAt: new Date(T0 + 2 * 86_400_000).toISOString(), expireReminderDays: 3 });

    const first = await runNotificationSweep(T0);
    expect(first.reduce((s, r) => s + r.queued, 0)).toBe(1);

    // In-memory nothing changes; a second sweep must add nothing new.
    getDb().exec("UPDATE notification_log SET status = 'sent' WHERE event = 'key_expiring'");
    const second = await runNotificationSweep(T0 + 1000);
    expect(second.reduce((s, r) => s + r.queued, 0)).toBe(0);
  });
});

describe('notification delivery and retry ([fork 9/10])', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    getDb().exec('DELETE FROM notification_log; DELETE FROM notification_channels; DELETE FROM api_keys; DELETE FROM settings;');
  });

  afterEach(() => vi.unstubAllGlobals());

  it('delivers a webhook and marks it sent', async () => {
    createChannel({ kind: 'webhook', name: 'w', url: 'http://example.invalid/hook' });
    notify('key_error', { title: 'hello', dedupKey: 'd1' }, T0);

    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const attempted = await flushNotifications(T0);

    expect(attempted).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const row = getDb().prepare('SELECT status, attempts FROM notification_log').get() as { status: string; attempts: number };
    expect(row.status).toBe('sent');
    expect(row.attempts).toBe(1);
  });

  it('retries a transient failure with backoff, then gives up', async () => {
    createChannel({ kind: 'webhook', name: 'w', url: 'http://example.invalid/hook' });
    notify('key_error', { title: 'retry me', dedupKey: 'd2' }, T0);

    const fetchMock = vi.fn().mockRejectedValue(new Error('connection refused'));
    vi.stubGlobal('fetch', fetchMock);

    // Attempt 1 fails.
    await flushNotifications(T0);
    let row = getDb().prepare('SELECT status, attempts FROM notification_log').get() as { status: string; attempts: number };
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);

    // Not due yet (backoff), so nothing happens.
    await flushNotifications(T0 + 1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Due again → attempt 2.
    await flushNotifications(T0 + 6000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Attempt 3 (max = 3) → failed.
    await flushNotifications(T0 + 20_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    row = getDb().prepare('SELECT status, attempts FROM notification_log').get() as { status: string; attempts: number };
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(3);
  });

  it('never blocks the caller: notify returns before any HTTP', async () => {
    createChannel({ kind: 'webhook', name: 'w', url: 'http://example.invalid/hook' });
    const fetchMock = vi.fn(() => new Promise(resolve => setTimeout(() => resolve({ ok: true }), 5000)));
    vi.stubGlobal('fetch', fetchMock);

    const start = Date.now();
    const result = notify('key_error', { title: 'slow', dedupKey: 'd3' }, T0);
    expect(Date.now() - start).toBeLessThan(100); // queue only
    expect(result.queued).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('notification channel management ([fork 9/10])', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    getDb().exec('DELETE FROM notification_log; DELETE FROM notification_channels;');
  });

  it('requires the right credential per channel kind', () => {
    expect(() => createChannel({ kind: 'webhook', name: 'w' })).toThrow(/url/);
    expect(() => createChannel({ kind: 'telegram', name: 't', botToken: 'b', chatId: '' })).toThrow(/chatId/);
    const created = createChannel({ kind: 'webhook', name: 'w', url: 'http://x.invalid/hook' });
    expect(listChannels()).toHaveLength(1);
    expect(created.kind).toBe('webhook');
  });

  it('reads default settings with every event on', () => {
    const settings = getNotificationSettings();
    expect(Object.keys(settings.events).length).toBe(7);
    expect(Object.values(settings.events).every(Boolean)).toBe(true);
  });
});