import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { mintDashboardToken } from '../helpers/auth.js';

/**
 * [fork 5/10] The action-needed API: raise / done / snooze on a key, the badge
 * summary, and the editable auto-detection rules.
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
  const { encrypted, iv, authTag } = encrypt('gsk_action_route');
  const info = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES ('groq', 'action-key', ?, ?, ?, 'healthy', 1)
  `).run(encrypted, iv, authTag);
  return Number(info.lastInsertRowid);
}

describe('action needed over the API ([fork 5/10])', () => {
  let keyId: number;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken('action@example.com');
  });

  beforeEach(() => {
    getDb().exec('DELETE FROM key_action_needed; DELETE FROM api_keys;');
    keyId = insertKey();
  });

  it('raises, lists, snoozes and completes a flag', async () => {
    const raised = await request('POST', `/api/keys/${keyId}/action`, {
      token: dashToken,
      body: { reason: 'verify_phone', url: 'https://provider.example/verify', note: 'SMS code' },
    });
    expect(raised.status).toBe(201);
    expect((raised.body as { action: { reason: string } }).action.reason).toBe('verify_phone');

    const listed = await request('GET', '/api/keys/action-needed', { token: dashToken });
    expect(listed.status).toBe(200);
    const list = listed.body as { summary: { total: number }; actions: Array<{ keyId: number; label: string }> };
    expect(list.summary.total).toBe(1);
    expect(list.actions[0].keyId).toBe(keyId);
    expect(list.actions[0].label).toBe('action-key');

    // The flag rides on the key row itself.
    const keys = await request('GET', '/api/keys', { token: dashToken });
    // GET /api/keys answers with the array itself.
    const rows = keys.body as Array<{ id: number; actionNeeded: { reason: string } | null }>;
    const row = rows.find(k => k.id === keyId);
    expect(row?.actionNeeded?.reason).toBe('verify_phone');

    const snoozed = await request('POST', `/api/keys/${keyId}/action/snooze`, {
      token: dashToken, body: { hours: 3 },
    });
    expect(snoozed.status).toBe(200);

    // Snoozed: hidden from the badge list, still on the row as snoozed.
    const afterSnooze = await request('GET', '/api/keys/action-needed', { token: dashToken });
    expect((afterSnooze.body as { summary: { total: number } }).summary.total).toBe(0);
    const included = await request('GET', '/api/keys/action-needed?includeSnoozed=1', { token: dashToken });
    // The row list can include snoozed flags on request; the badge summary
    // stays "needs attention now", so it is still 0.
    const includedBody = included.body as { summary: { total: number }; actions: Array<{ snoozed: boolean }> };
    expect(includedBody.actions).toHaveLength(1);
    expect(includedBody.actions[0].snoozed).toBe(true);
    expect(includedBody.summary.total).toBe(0);

    const done = await request('POST', `/api/keys/${keyId}/action/done`, { token: dashToken });
    expect(done.status).toBe(200);
    const empty = await request('GET', '/api/keys/action-needed', { token: dashToken });
    expect((empty.body as { summary: { total: number } }).summary.total).toBe(0);
  });

  it('rejects a bad flag and a missing key', async () => {
    const badReason = await request('POST', `/api/keys/${keyId}/action`, {
      token: dashToken, body: { reason: 'nonsense' },
    });
    expect(badReason.status).toBe(400);

    const badUrl = await request('POST', `/api/keys/${keyId}/action`, {
      token: dashToken, body: { reason: 'other', url: 'javascript:alert(1)' },
    });
    expect(badUrl.status).toBe(400);

    // Nothing to complete on a clean key.
    const done = await request('POST', `/api/keys/${keyId}/action/done`, { token: dashToken });
    expect(done.status).toBe(404);
  });

  it('manages the auto-detection rules', async () => {
    const created = await request('POST', '/api/keys/action-rules', {
      token: dashToken,
      body: { name: 'Support contact', reason: 'other', statuses: [403], pattern: 'contact support', policy: 'inform_only' },
    });
    expect(created.status).toBe(201);
    const ruleId = (created.body as { rule: { id: number } }).rule.id;

    const listed = await request('GET', '/api/keys/action-rules', { token: dashToken });
    expect((listed.body as { rules: unknown[] }).rules.length).toBeGreaterThan(1);

    const patched = await request('PATCH', `/api/keys/action-rules/${ruleId}`, {
      token: dashToken, body: { enabled: false },
    });
    expect((patched.body as { rule: { enabled: boolean } }).rule.enabled).toBe(false);

    const removed = await request('DELETE', `/api/keys/action-rules/${ruleId}`, { token: dashToken });
    expect(removed.status).toBe(200);
    const gone = await request('DELETE', `/api/keys/action-rules/${ruleId}`, { token: dashToken });
    expect(gone.status).toBe(404);
  });

  it('requires the dashboard token', async () => {
    const res = await request('GET', '/api/keys/action-needed');
    expect(res.status).toBe(401);
  });
});
