import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// Same approach as client-profiles.test.ts: mock only routeRequest so the
// proxy surface works without real provider keys.
const { mockRouteRequest } = vi.hoisted(() => ({ mockRouteRequest: vi.fn() }));
vi.mock('../../services/router.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/router.js')>();
  return { ...actual, routeRequest: mockRouteRequest };
});

import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getUnifiedApiKey, getDb } from '../../db/index.js';
import { resetClientLimitState } from '../../services/client-limits.js';
import { mintDashboardToken } from '../helpers/auth.js';

let dashToken = '';

async function request(
  app: Express,
  method: string,
  path: string,
  opts: { body?: unknown; token?: string } = {},
) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
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
  return { status: res.status, body, headers: res.headers };
}

function fakeRoute() {
  return {
    provider: {
      name: 'fake',
      async chatCompletion() {
        return {
          id: 'c', object: 'chat.completion', created: 0, model: 'fake-model',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        };
      },
    },
    modelId: 'fake-model', modelDbId: 9999, apiKey: 'k', keyId: 1, platform: 'fake', displayName: 'Fake Model',
  };
}

describe('per-client limits over the API ([fork 1/10])', () => {
  let app: Express;
  let unifiedKey: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    unifiedKey = getUnifiedApiKey();
    dashToken = mintDashboardToken('client-limits@example.com');
  });

  beforeEach(() => {
    mockRouteRequest.mockReset();
    mockRouteRequest.mockImplementation(() => fakeRoute());
    resetClientLimitState();
  });

  async function createClient(name: string, limits: Record<string, number> = {}) {
    const { status, body } = await request(app, 'POST', '/api/client-profiles', {
      token: dashToken, body: { name, limits },
    });
    expect(status).toBe(201);
    return body as { id: number; key: string; limits: Record<string, number>; usage: any };
  }

  function chat(key: string, extra: Record<string, unknown> = {}) {
    return request(app, 'POST', '/v1/chat/completions', {
      token: key, body: { messages: [{ role: 'user', content: 'hi' }], ...extra },
    });
  }

  it('returns limits and live usage on create/list', async () => {
    const created = await createClient('web-bot', { maxConcurrent: 1, rpm: 5 });
    expect(created.limits.maxConcurrent).toBe(1);
    expect(created.limits.rpm).toBe(5);
    expect(created.usage).toMatchObject({ day: { requests: 0, tokens: 0 }, month: { requests: 0, tokens: 0 } });

    const list = await request(app, 'GET', '/api/client-profiles', { token: dashToken });
    const row = list.body.find((p: any) => p.id === created.id);
    expect(row.limits.rpm).toBe(5);
  });

  it('keeps the token secret — limits never leak the key', async () => {
    const created = await createClient('secret-bot', { rpm: 3 });
    const list = await request(app, 'GET', '/api/client-profiles', { token: dashToken });
    expect(JSON.stringify(list.body)).not.toContain(created.key);
  });

  it('enforces RPM with 429 + Retry-After, and the unified key is unaffected', async () => {
    const created = await createClient('rpm-bot', { rpm: 1 });
    expect((await chat(created.key)).status).toBe(200);
    const limited = await chat(created.key);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    expect(limited.body.error.type).toBe('rate_limit_error');

    // The unified key is the implicit unlimited `default` client.
    expect((await chat(unifiedKey)).status).toBe(200);
    expect((await chat(unifiedKey)).status).toBe(200);
  });

  it('applies a limit change without a restart', async () => {
    const created = await createClient('live-bot', { rpm: 1 });
    expect((await chat(created.key)).status).toBe(200);
    expect((await chat(created.key)).status).toBe(429);

    const patched = await request(app, 'PATCH', `/api/client-profiles/${created.id}`, {
      token: dashToken, body: { limits: { rpm: 0 } },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.limits.rpm).toBe(0);
    // Unlimited again — no restart involved.
    expect((await chat(created.key)).status).toBe(200);
    expect((await chat(created.key)).status).toBe(200);
  });

  it('rejects max_tokens above the per-request cap with 400', async () => {
    const created = await createClient('cap-bot', { maxTokensPerRequest: 10 });
    const res = await chat(created.key, { max_tokens: 50 });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('exceeds');
  });

  it('does not count a rejected request against the daily cap', async () => {
    const created = await createClient('daily-bot', { dailyRequestCap: 2, rpm: 0 });
    expect((await chat(created.key)).status).toBe(200);
    const rows = getDb().prepare('SELECT requests FROM client_usage WHERE client_id = ?').all(created.id) as { requests: number }[];
    // Only the settled success lands in the ledger.
    expect(rows.every(r => r.requests === 1)).toBe(true);
  });

  it('splits analytics per authenticated client', async () => {
    const a = await createClient('analytics-a');
    const b = await createClient('analytics-b');
    expect((await chat(a.key)).status).toBe(200);
    expect((await chat(b.key)).status).toBe(200);
    expect((await chat(b.key)).status).toBe(200);

    const res = await request(app, 'GET', '/api/analytics/by-downstream-client?range=1d', { token: dashToken });
    expect(res.status).toBe(200);
    const aRow = res.body.find((r: any) => r.clientId === a.id);
    const bRow = res.body.find((r: any) => r.clientId === b.id);
    expect(aRow.clientName).toBe('analytics-a');
    expect(aRow.requests).toBe(1);
    expect(bRow.requests).toBe(2);
  });
});