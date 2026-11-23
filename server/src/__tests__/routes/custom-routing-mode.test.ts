import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';

// Custom routing is the named-chain feature. This suite pins its lifecycle:
// turning the mode off clears the active chain so the router falls back to the
// built-in global table, turning it back on restores the chain that was active
// before, and both round-trip through the same PUT /api/fallback/routing that
// the dashboard's strategy form already uses.
let app: Express;
let dashToken = '';

async function get(path: string) {
  return request('GET', path);
}
async function put(path: string, body: unknown) {
  return request('PUT', path, body);
}
async function request(method: string, path: string, body?: unknown) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: { Authorization: dashToken, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: parsed };
}

describe('custom routing mode is on when a chain is active and off when it is not', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(() => {
    getDb().prepare("DELETE FROM settings WHERE key = 'custom_routing_enabled'").run();
    getDb().prepare("DELETE FROM settings WHERE key = 'custom_routing_last_profile_id'").run();
  });

  function firstProfileId(): number {
    return (getDb().prepare('SELECT id FROM profiles ORDER BY id LIMIT 1').get() as { id: number }).id;
  }

  it('reports enabled when an active chain exists (unset derives from the pointer)', async () => {
    const pid = firstProfileId();
    getDb().prepare("INSERT INTO settings (key, value) VALUES ('active_profile_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(pid));
    const res = await get('/api/fallback/routing');
    expect(res.body.customRoutingEnabled).toBe(true);
  });

  it('reports disabled on a fresh install with no active chain', async () => {
    getDb().prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
    const res = await get('/api/fallback/routing');
    expect(res.body.customRoutingEnabled).toBe(false);
  });

  it('PUT false clears the active chain and remembers it', async () => {
    const pid = firstProfileId();
    getDb().prepare("INSERT INTO settings (key, value) VALUES ('active_profile_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(pid));

    const res = await put('/api/fallback/routing', { strategy: 'smartest', customRoutingEnabled: false });
    expect(res.status).toBe(200);
    expect(res.body.customRoutingEnabled).toBe(false);

    const active = getDb().prepare("SELECT value FROM settings WHERE key = 'active_profile_id'").get() as { value: string } | undefined;
    expect(active).toBeUndefined();
    const remembered = getDb().prepare("SELECT value FROM settings WHERE key = 'custom_routing_last_profile_id'").get() as { value: string } | undefined;
    expect(remembered!.value).toBe(String(pid));

    const reread = await get('/api/fallback/routing');
    expect(reread.body.customRoutingEnabled).toBe(false);
  });

  it('PUT true restores the chain that was active before it was turned off', async () => {
    const pid = firstProfileId();
    getDb().prepare("INSERT INTO settings (key, value) VALUES ('custom_routing_last_profile_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(pid));

    const res = await put('/api/fallback/routing', { strategy: 'smartest', customRoutingEnabled: true });
    expect(res.status).toBe(200);
    expect(res.body.customRoutingEnabled).toBe(true);

    const active = getDb().prepare("SELECT value FROM settings WHERE key = 'active_profile_id'").get() as { value: string };
    expect(active.value).toBe(String(pid));
  });

  it('clearing the chain through /api/profiles/active also switches the mode off', async () => {
    const pid = firstProfileId();
    getDb().prepare("INSERT INTO settings (key, value) VALUES ('active_profile_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(pid));

    const res = await request('POST', '/api/profiles/active', { profileId: null });
    expect(res.status).toBe(200);
    expect(res.body.customRoutingEnabled).toBe(false);
  });

  it('activating a chain through /api/profiles/active switches the mode on and reports it back', async () => {
    const pid = firstProfileId();
    getDb().prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();

    const res = await request('POST', '/api/profiles/active', { profileId: pid });
    expect(res.status).toBe(200);
    expect(res.body.customRoutingEnabled).toBe(true);
  });
});