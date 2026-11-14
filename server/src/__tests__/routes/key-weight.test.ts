import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { mintDashboardToken } from '../helpers/auth.js';

/**
 * [fork 6/10] Weight and order over the API: per-key PATCH and the bulk editor
 * the Keys page uses ("these three are primaries, the rest are backups").
 */

let app: Express;
let dashToken = '';

async function request(method: string, path: string, opts: { body?: unknown; token?: string } = {}) {
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

function insertKey(label: string): number {
  const { encrypted, iv, authTag } = encrypt(`gsk_${label}`);
  const info = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES ('groq', ?, ?, ?, ?, 'healthy', 1)
  `).run(label, encrypted, iv, authTag);
  return Number(info.lastInsertRowid);
}

describe('key weight and order over the API ([fork 6/10])', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken('weight@example.com');
  });

  beforeEach(() => {
    getDb().exec('DELETE FROM api_keys');
  });

  it('defaults weight to 1 and order to 0 on a fresh key', async () => {
    const keyId = insertKey('fresh');
    const listed = await request('GET', '/api/keys', { token: dashToken });
    const row = (listed.body as Array<{ id: number; weight: number; order: number }>).find(k => k.id === keyId);
    expect(row?.weight).toBe(1);
    expect(row?.order).toBe(0);
  });

  it('patches weight and order on one key', async () => {
    const keyId = insertKey('single');
    const patched = await request('PATCH', `/api/keys/${keyId}`, {
      token: dashToken,
      body: { weight: 5, order: 2 },
    });
    expect(patched.status).toBe(200);
    expect((patched.body as { weight: number; order: number }).weight).toBe(5);
    expect((patched.body as { order: number }).order).toBe(2);

    const stored = getDb().prepare('SELECT weight, key_order FROM api_keys WHERE id = ?')
      .get(keyId) as { weight: number; key_order: number };
    expect(stored).toEqual({ weight: 5, key_order: 2 });
  });

  it('rejects a negative weight and a non-integer order', async () => {
    const keyId = insertKey('bad');
    const negative = await request('PATCH', `/api/keys/${keyId}`, { token: dashToken, body: { weight: -1 } });
    expect(negative.status).toBe(400);
    const fractional = await request('PATCH', `/api/keys/${keyId}`, { token: dashToken, body: { order: 1.5 } });
    expect(fractional.status).toBe(400);
    // An empty body is still an error (nothing to change).
    const empty = await request('PATCH', `/api/keys/${keyId}`, { token: dashToken, body: {} });
    expect(empty.status).toBe(400);
  });

  it('bulk-sets weight and order for a selection', async () => {
    const primaries = [insertKey('p1'), insertKey('p2')];
    const backups = [insertKey('b1'), insertKey('b2')];
    const first = await request('PATCH', '/api/keys/bulk/rotation', {
      token: dashToken, body: { ids: primaries, weight: 3, order: 0 },
    });
    expect(first.status).toBe(200);
    expect((first.body as { updated: number }).updated).toBe(2);

    const second = await request('PATCH', '/api/keys/bulk/rotation', {
      token: dashToken, body: { ids: backups, weight: 1, order: 1 },
    });
    expect((second.body as { updated: number }).updated).toBe(2);

    const listed = await request('GET', '/api/keys', { token: dashToken });
    const rows = listed.body as Array<{ id: number; weight: number; order: number }>;
    for (const id of primaries) {
      const row = rows.find(r => r.id === id);
      expect(row?.weight).toBe(3);
      expect(row?.order).toBe(0);
    }
    for (const id of backups) {
      const row = rows.find(r => r.id === id);
      expect(row?.weight).toBe(1);
      expect(row?.order).toBe(1);
    }
  });

  it('rejects a bulk update with nothing to change or no ids', async () => {
    const keyId = insertKey('bulk-bad');
    const nothing = await request('PATCH', '/api/keys/bulk/rotation', {
      token: dashToken, body: { ids: [keyId] },
    });
    expect(nothing.status).toBe(400);
    const noIds = await request('PATCH', '/api/keys/bulk/rotation', {
      token: dashToken, body: { ids: [], weight: 2 },
    });
    expect(noIds.status).toBe(400);
  });

  it('requires the dashboard token', async () => {
    const res = await request('PATCH', '/api/keys/bulk/rotation', { body: { ids: [1], weight: 2 } });
    expect(res.status).toBe(401);
  });
});
