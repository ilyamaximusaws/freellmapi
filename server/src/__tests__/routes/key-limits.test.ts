import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { mintDashboardToken } from '../helpers/auth.js';

/**
 * [fork 7/10] Per-key rate limits and manual cooldowns over the API.
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

describe('per-key rate limits over the API ([fork 7/10])', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken('ratelimits@example.com');
  });

  beforeEach(() => {
    getDb().exec('DELETE FROM api_keys; DELETE FROM key_cooldowns;');
  });

  it('patches rpm/tpm/rpd on a key', async () => {
    const keyId = insertKey('rl');
    const patched = await request('PATCH', `/api/keys/${keyId}`, {
      token: dashToken, body: { rpm: 10, tpm: 5000 },
    });
    expect(patched.status).toBe(200);

    const stored = getDb().prepare('SELECT rpm_limit, tpm_limit FROM api_keys WHERE id = ?')
      .get(keyId) as { rpm_limit: number; tpm_limit: number };
    expect(stored.rpm_limit).toBe(10);
    expect(stored.tpm_limit).toBe(5000);

    // Clearing with 0 stores NULL.
    const cleared = await request('PATCH', `/api/keys/${keyId}`, { token: dashToken, body: { rpm: 0 } });
    expect(cleared.status).toBe(200);
    const after = getDb().prepare('SELECT rpm_limit FROM api_keys WHERE id = ?').get(keyId) as { rpm_limit: number | null };
    expect(after.rpm_limit).toBeNull();
  });

  it('rejects a fractional rpm', async () => {
    const keyId = insertKey('bad-rl');
    const res = await request('PATCH', `/api/keys/${keyId}`, { token: dashToken, body: { rpm: 1.5 } });
    expect(res.status).toBe(400);
  });

  it('sets, lists and clears a manual cooldown', async () => {
    const keyId = insertKey('cooldown');
    const set = await request('POST', `/api/keys/${keyId}/cooldown`, {
      token: dashToken,
      body: { reason: 'migrating balance', note: 'moving to a second account', seconds: 3600 },
    });
    expect(set.status).toBe(201);
    expect((set.body as { cooldown: { reason: string } }).cooldown.reason).toBe('migrating balance');

    const listed = await request('GET', '/api/keys/cooldowns', { token: dashToken });
    expect((listed.body as { cooldowns: Array<{ keyId: number }> }).cooldowns).toHaveLength(1);

    const cleared = await request('DELETE', `/api/keys/${keyId}/cooldown`, { token: dashToken });
    expect(cleared.status).toBe(200);
    const gone = await request('DELETE', `/api/keys/${keyId}/cooldown`, { token: dashToken });
    expect(gone.status).toBe(404);
  });

  it('rejects a cooldown with neither seconds nor untilMs', async () => {
    const keyId = insertKey('no-duration');
    const res = await request('POST', `/api/keys/${keyId}/cooldown`, {
      token: dashToken, body: { reason: 'wait' },
    });
    expect(res.status).toBe(400);
  });

  it('exposes live rate state and usage on the key list', async () => {
    const keyId = insertKey('rate-visible');
    const keys = await request('GET', '/api/keys', { token: dashToken });
    const row = (keys.body as Array<{ id: number; rpm: number | null; rate: { limits: { rpm: number | null } } }>).find(k => k.id === keyId);
    expect(row?.rate.limits.rpm).toBeNull();
    // Flat alias of the same number, so the declared ApiKey type reads the caps.
    expect(row?.rpm).toBeNull();
  })

  it('mirrors a saved cap into the flat rpm/tpm/rpd alias', async () => {
    const keyId = insertKey('rate-alias');
    await request('PATCH', `/api/keys/${keyId}`, { token: dashToken, body: { rpm: 60, tpm: 1000, rpd: 5000 } });
    const keys = await request('GET', '/api/keys', { token: dashToken });
    const row = (keys.body as Array<{ id: number; rpm: number | null; tpm: number | null; rpd: number | null }>).find(k => k.id === keyId);
    expect(row).toMatchObject({ rpm: 60, tpm: 1000, rpd: 5000 });
  });

  it('requires the dashboard token', async () => {
    const res = await request('GET', '/api/keys/cooldowns');
    expect(res.status).toBe(401);
  });
});