import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { mintDashboardToken } from '../helpers/auth.js';
import { recordKeyFailure, resetPenaltyState } from '../../services/key-failure-penalty.js';

/**
 * [fork 8/10] Penalty state over the API: read, clear, and the runtime knobs.
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

function insertKey(): number {
  const { encrypted, iv, authTag } = encrypt('gsk_penalty_route');
  const info = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES ('groq', 'penalty', ?, ?, ?, 'healthy', 1)
  `).run(encrypted, iv, authTag);
  return Number(info.lastInsertRowid);
}

function timeoutError(): Error {
  return new Error('stream stalled: no data for 90000ms (timeout)');
}

describe('penalty state over the API ([fork 8/10])', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken('penalty@example.com');
  });

  beforeEach(() => {
    resetPenaltyState();
    getDb().prepare("DELETE FROM settings WHERE key LIKE 'penalty_%'").run();
    getDb().exec('DELETE FROM api_keys');
  });

  it('reads and clears a penalty', async () => {
    const keyId = insertKey();
    recordKeyFailure(keyId, timeoutError(), Date.now());
    recordKeyFailure(keyId, timeoutError(), Date.now());
    recordKeyFailure(keyId, timeoutError(), Date.now());

    const list = await request('GET', '/api/keys/penalties', { token: dashToken });
    expect((list.body as { penalties: Array<{ keyId: number }> }).penalties).toHaveLength(1);

    const cleared = await request('DELETE', `/api/keys/${keyId}/penalty`, { token: dashToken });
    expect(cleared.status).toBe(200);
    const gone = await request('DELETE', `/api/keys/${keyId}/penalty`, { token: dashToken });
    expect(gone.status).toBe(404);
  });

  it('reads and writes the runtime penalty knobs', async () => {
    const set = await request('PUT', '/api/settings/penalty', {
      token: dashToken,
      body: { penalty_streak_threshold: 5, penalty_steps_ms: '1000,5000,20000', penalty_ceiling_ms: 20000 },
    });
    expect(set.status).toBe(200);
    expect((set.body as { penalty_streak_threshold: string }).penalty_streak_threshold).toBe('5');

    const read = await request('GET', '/api/settings/penalty', { token: dashToken });
    expect((read.body as { penalty_steps_ms: string }).penalty_steps_ms).toBe('1000,5000,20000');

    // null clears back to defaults.
    const clear = await request('PUT', '/api/settings/penalty', { token: dashToken, body: { penalty_streak_threshold: null } });
    expect(clear.status).toBe(200);
    expect((clear.body as { penalty_streak_threshold: string }).penalty_streak_threshold).toBe('');
  });

  it('rejects a bogus step list', async () => {
    const res = await request('PUT', '/api/settings/penalty', {
      token: dashToken, body: { penalty_streak_threshold: 0 },
    });
    expect(res.status).toBe(400);
  });

  it('exposes penalty on the key row', async () => {
    const keyId = insertKey();
    recordKeyFailure(keyId, timeoutError(), Date.now());
    recordKeyFailure(keyId, timeoutError(), Date.now());
    recordKeyFailure(keyId, timeoutError(), Date.now());
    const keys = await request('GET', '/api/keys', { token: dashToken });
    const row = (keys.body as Array<{ id: number; penalty: { penalizedUntilMs: number } | null }>).find(k => k.id === keyId);
    expect(row?.penalty?.penalizedUntilMs).toBeGreaterThan(Date.now());
  });

  it('requires the dashboard token', async () => {
    const res = await request('GET', '/api/keys/penalties');
    expect(res.status).toBe(401);
  });
});