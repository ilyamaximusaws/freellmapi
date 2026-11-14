import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { mintDashboardToken } from '../helpers/auth.js';

/**
 * [fork 4/10] Windowed caps over the API: create/list/update/delete a cap on a
 * key, and tag a key with an account so several keys share one budget.
 */

let app: Express;
let dashToken = '';

async function request(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string } = {},
) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: {
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const body = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body };
}

function insertKey(): number {
  const { encrypted, iv, authTag } = encrypt('gsk_route_caps');
  const info = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES ('groq', 'caps', ?, ?, ?, 'healthy', 1)
  `).run(encrypted, iv, authTag);
  return Number(info.lastInsertRowid);
}

describe('windowed caps over the API ([fork 4/10])', () => {
  let keyId: number;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken('key-caps@example.com');
  });

  beforeEach(() => {
    getDb().exec('DELETE FROM key_caps; DELETE FROM api_keys; DELETE FROM requests;');
    keyId = insertKey();
  });

  it('creates, lists, updates and deletes a cap', async () => {
    const created = await request('POST', `/api/keys/${keyId}/caps`, {
      token: dashToken,
      body: { window: 'day', unit: 'requests', cap: 5, resetType: 'sliding', softPercent: 80 },
    });
    expect(created.status).toBe(201);
    const capId = (created.body as { cap: { id: number } }).cap.id;
    expect((created.body as { cap: { window: string } }).cap.window).toBe('day');

    const listed = await request('GET', `/api/keys/${keyId}/caps`, { token: dashToken });
    expect(listed.status).toBe(200);
    expect((listed.body as { caps: unknown[] }).caps).toHaveLength(1);

    const patched = await request('PATCH', `/api/keys/${keyId}/caps/${capId}`, {
      token: dashToken,
      body: { cap: 10 },
    });
    expect(patched.status).toBe(200);
    expect((patched.body as { cap: { cap: number } }).cap.cap).toBe(10);

    const removed = await request('DELETE', `/api/keys/${keyId}/caps/${capId}`, { token: dashToken });
    expect(removed.status).toBe(200);
    const after = await request('GET', `/api/keys/${keyId}/caps`, { token: dashToken });
    expect((after.body as { caps: unknown[] }).caps).toHaveLength(0);
  });

  it('rejects an invalid cap', async () => {
    const zero = await request('POST', `/api/keys/${keyId}/caps`, {
      token: dashToken,
      body: { window: 'day', unit: 'requests', cap: 0 },
    });
    expect(zero.status).toBe(400);

    const badWindow = await request('POST', `/api/keys/${keyId}/caps`, {
      token: dashToken,
      body: { window: 'decade', unit: 'requests', cap: 5 },
    });
    expect(badWindow.status).toBe(400);
  });

  it('tags a key with an account and clears it', async () => {
    const tagged = await request('PUT', `/api/keys/${keyId}/account`, {
      token: dashToken,
      body: { accountKey: 'acct-1' },
    });
    expect(tagged.status).toBe(200);
    expect((tagged.body as { accountKey: string }).accountKey).toBe('acct-1');

    // An account cap is now visible on the key.
    await request('POST', `/api/keys/${keyId}/caps`, {
      token: dashToken,
      body: { window: 'week', unit: 'tokens', cap: 100, accountKey: 'acct-1' },
    });
    const listed = await request('GET', `/api/keys/${keyId}/caps`, { token: dashToken });
    expect((listed.body as { accountKey: string | null }).accountKey).toBe('acct-1');
    expect((listed.body as { caps: unknown[] }).caps).toHaveLength(1);

    const cleared = await request('PUT', `/api/keys/${keyId}/account`, {
      token: dashToken,
      body: { accountKey: null },
    });
    expect((cleared.body as { accountKey: string | null }).accountKey).toBeNull();
  });

  it('requires the dashboard token', async () => {
    const res = await request('GET', `/api/keys/${keyId}/caps`);
    expect(res.status).toBe(401);
  });
});
