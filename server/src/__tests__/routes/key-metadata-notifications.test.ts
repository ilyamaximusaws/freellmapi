import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { mintDashboardToken } from '../helpers/auth.js';

/**
 * [fork 9/10] Key metadata + notification channels over the API.
 */

let app: Express;
let dashToken = '';

async function request(method: string, path: string, opts: { body?: unknown; token?: string } = {}) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: {
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const body = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body };
}

function insertKey(label = 'meta-key'): number {
  const { encrypted, iv, authTag } = encrypt('gsk_meta_test');
  const info = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES ('groq', ?, ?, ?, ?, 'healthy', 1)
  `).run(label, encrypted, iv, authTag);
  return Number(info.lastInsertRowid);
}

describe('key metadata API ([fork 9/10])', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken('meta@example.com');
  });

  beforeEach(() => {
    getDb().exec('DELETE FROM api_keys;');
  });

  it('patches metadata and returns it on the key row', async () => {
    const keyId = insertKey();
    const patch = await request('PATCH', `/api/keys/${keyId}`, {
      token: dashToken,
      body: { owner: 'alice@example.com', tags: ['trial', 'west'], keyType: 'credits', creditsRemaining: 4.5, expiresAt: '2027-01-01T00:00:00Z', expireReminderDays: 7 },
    });
    expect(patch.status).toBe(200);
    expect((patch.body as { metadata: { owner: string; tags: string[] } }).metadata.owner).toBe('alice@example.com');
    expect((patch.body as { metadata: { tags: string[] } }).metadata.tags).toEqual(['trial', 'west']);

    const list = await request('GET', '/api/keys', { token: dashToken });
    const row = (list.body as Array<{ id: number; metadata: { keyType: string; creditsRemaining: number } }>).find(k => k.id === keyId);
    expect(row?.metadata.keyType).toBe('credits');
    expect(row?.metadata.creditsRemaining).toBe(4.5);
  });

  it('serializes tags to a JSON array and dedupes', async () => {
    const keyId = insertKey();
    await request('PATCH', `/api/keys/${keyId}`, { token: dashToken, body: { tags: 'trial, TRIAL,  prod ' } });
    const list = await request('GET', '/api/keys', { token: dashToken });
    const row = (list.body as Array<{ id: number; metadata: { tags: string[] } }>).find(k => k.id === keyId);
    expect(row?.metadata.tags).toEqual(['trial', 'prod']);
  });

  it('clears a field with null without touching the rest', async () => {
    const keyId = insertKey();
    await request('PATCH', `/api/keys/${keyId}`, { token: dashToken, body: { owner: 'bob', note: 'keep' } });
    const cleared = await request('PATCH', `/api/keys/${keyId}`, { token: dashToken, body: { owner: null } });
    expect((cleared.body as { metadata: { owner: string | null; note: string } }).metadata.owner).toBeNull();
    expect((cleared.body as { metadata: { note: string } }).metadata.note).toBe('keep');
  });

  it('lists tags and bulk-toggles by tag', async () => {
    const a = insertKey('a');
    const b = insertKey('b');
    await request('PATCH', `/api/keys/${a}`, { token: dashToken, body: { tags: ['trial'] } });
    await request('PATCH', `/api/keys/${b}`, { token: dashToken, body: { tags: ['trial'] } });

    const tags = await request('GET', '/api/keys/tags', { token: dashToken });
    expect((tags.body as { tags: Array<{ tag: string; keys: number }> }).tags).toEqual([{ tag: 'trial', keys: 2 }]);

    const bulk = await request('PATCH', '/api/keys/bulk/tags', { token: dashToken, body: { tag: 'trial', enabled: false } });
    expect((bulk.body as { updated: number }).updated).toBe(2);

    const list = await request('GET', '/api/keys', { token: dashToken });
    const disabled = (list.body as Array<{ enabled: boolean }>).filter(k => !k.enabled);
    expect(disabled).toHaveLength(2);
  });
});

describe('notifications config API ([fork 9/10])', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken('notifications@example.com');
  });

  beforeEach(() => {
    getDb().exec('DELETE FROM notification_channels; DELETE FROM notification_log;');
  });

  it('creates, lists, updates and deletes a webhook channel', async () => {
    const created = await request('POST', '/api/notifications/channels', {
      token: dashToken, body: { kind: 'webhook', name: 'ops', url: 'https://example.invalid/hook', events: { key_error: false } },
    });
    expect(created.status).toBe(201);
    const id = (created.body as { channel: { id: number } }).channel.id;

    const listed = await request('GET', '/api/notifications/channels', { token: dashToken });
    expect((listed.body as { channels: unknown[] }).channels).toHaveLength(1);

    const updated = await request('PATCH', `/api/notifications/channels/${id}`, { token: dashToken, body: { name: 'ops-v2' } });
    expect((updated.body as { channel: { name: string } }).channel.name).toBe('ops-v2');

    const deleted = await request('DELETE', `/api/notifications/channels/${id}`, { token: dashToken });
    expect((deleted.body as { deleted: boolean }).deleted).toBe(true);
  });

  it('rejects a webhook without a url and a telegram without credentials', async () => {
    const noUrl = await request('POST', '/api/notifications/channels', { token: dashToken, body: { kind: 'webhook', name: 'x' } });
    expect(noUrl.status).toBe(400);
    const noChat = await request('POST', '/api/notifications/channels', { token: dashToken, body: { kind: 'telegram', name: 'x', botToken: 'b' } });
    expect(noChat.status).toBe(400);
  });

  it('updates settings and merges the events map', async () => {
    const set = await request('PUT', '/api/notifications/settings', {
      token: dashToken, body: { events: { key_error: false }, readyUpstreamsMin: 2, cooldownMs: 60_000 },
    });
    expect(set.status).toBe(200);
    const body = set.body as { events: Record<string, boolean>; readyUpstreamsMin: number };
    expect(body.events.key_error).toBe(false);
    expect(body.events.key_expiring).toBe(true); // merged, not replaced
    expect(body.readyUpstreamsMin).toBe(2);

    const read = await request('GET', '/api/notifications/settings', { token: dashToken });
    expect((read.body as { readyUpstreamsMin: number }).readyUpstreamsMin).toBe(2);
  });

  it('requires the dashboard token', async () => {
    const res = await request('GET', '/api/notifications/settings');
    expect(res.status).toBe(401);
  });
});