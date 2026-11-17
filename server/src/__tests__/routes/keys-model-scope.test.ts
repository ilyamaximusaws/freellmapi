import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

// PATCH /api/keys/:id modelScope handling (#657).
describe('Keys API — model scope', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM api_keys').run();
  });

  function insertKey(): number {
    const { encrypted, iv, authTag } = encrypt('sk-test');
    const result = getDb().prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'test', ?, ?, ?, 'healthy', 1)
    `).run(encrypted, iv, authTag);
    return Number(result.lastInsertRowid);
  }

  it('sets a scope and surfaces it on the key list', async () => {
    const id = insertKey();
    const patch = await request(app, 'PATCH', `/api/keys/${id}`, { modelScope: ['llama-3.3-70b', 'qwen-2.5'] });
    expect(patch.status).toBe(200);
    expect(patch.body.modelScope).toEqual(['llama-3.3-70b', 'qwen-2.5']);

    const list = await request(app, 'GET', '/api/keys');
    expect(list.status).toBe(200);
    expect(list.body.find((k: any) => k.id === id).modelScope).toEqual(['llama-3.3-70b', 'qwen-2.5']);
  });

  it('dedupes repeated ids', async () => {
    const id = insertKey();
    const patch = await request(app, 'PATCH', `/api/keys/${id}`, { modelScope: ['m1', 'm1', 'm2'] });
    expect(patch.status).toBe(200);
    expect(patch.body.modelScope).toEqual(['m1', 'm2']);
  });

  it('null clears the scope', async () => {
    const id = insertKey();
    await request(app, 'PATCH', `/api/keys/${id}`, { modelScope: ['m1'] });
    const patch = await request(app, 'PATCH', `/api/keys/${id}`, { modelScope: null });
    expect(patch.status).toBe(200);
    expect(patch.body.modelScope).toBeNull();

    const row = getDb().prepare('SELECT model_scope_json FROM api_keys WHERE id = ?').get(id) as any;
    expect(row.model_scope_json).toBeNull();

    const list = await request(app, 'GET', '/api/keys');
    expect(list.body.find((k: any) => k.id === id).modelScope).toBeNull();
  });

  it('an empty array clears the scope too', async () => {
    const id = insertKey();
    await request(app, 'PATCH', `/api/keys/${id}`, { modelScope: ['m1'] });
    const patch = await request(app, 'PATCH', `/api/keys/${id}`, { modelScope: [] });
    expect(patch.status).toBe(200);
    expect(patch.body.modelScope).toBeNull();
    const row = getDb().prepare('SELECT model_scope_json FROM api_keys WHERE id = ?').get(id) as any;
    expect(row.model_scope_json).toBeNull();
  });

  it('leaves the scope alone when only other fields are patched', async () => {
    const id = insertKey();
    await request(app, 'PATCH', `/api/keys/${id}`, { modelScope: ['m1'] });
    await request(app, 'PATCH', `/api/keys/${id}`, { label: 'renamed' });
    const list = await request(app, 'GET', '/api/keys');
    expect(list.body.find((k: any) => k.id === id).modelScope).toEqual(['m1']);
  });

  it('rejects malformed payloads', async () => {
    const id = insertKey();
    for (const modelScope of ['not-an-array', [''], [42], [{ id: 'x' }], ['x'.repeat(201)], Array.from({ length: 101 }, (_, i) => `m${i}`)]) {
      const patch = await request(app, 'PATCH', `/api/keys/${id}`, { modelScope });
      expect(patch.status, JSON.stringify(modelScope).slice(0, 60)).toBe(400);
    }
    // A body naming none of the updatable fields is still rejected.
    const empty = await request(app, 'PATCH', `/api/keys/${id}`, {});
    expect(empty.status).toBe(400);
  });

  it('404s on a missing key', async () => {
    const patch = await request(app, 'PATCH', '/api/keys/999999', { modelScope: ['m1'] });
    expect(patch.status).toBe(404);
  });

  // The provider's "edit models" checkboxes write `modelScope` and nothing else.
  // Unticked models used to keep `enabled = 1` and stayed in the chain, so the
  // dashboard showed them as live entries the router refuses to route.
  describe('scope drives the models bound to the key', () => {
    function bindModel(keyId: number, modelId: string, priority: number, opts: { enabled?: number; disabledBy?: string | null } = {}) {
      const db = getDb();
      const inserted = db.prepare(`
        INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
          monthly_token_budget, context_window, enabled, supports_vision, supports_tools, key_id, disabled_by)
        VALUES ('custom', ?, ?, ?, ?, 'Small', '~1M', 128000, ?, 0, 1, ?, ?)
      `).run(modelId, modelId, priority, priority, opts.enabled ?? 1, keyId, opts.disabledBy ?? null);
      const modelDbId = Number(inserted.lastInsertRowid);
      db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(modelDbId, priority);
      return modelDbId;
    }

    const modelRow = (modelDbId: number) =>
      getDb().prepare('SELECT enabled, disabled_by FROM models WHERE id = ?').get(modelDbId) as { enabled: number; disabled_by: string | null };
    const chainRow = (modelDbId: number) =>
      getDb().prepare('SELECT enabled FROM fallback_config WHERE model_db_id = ?').get(modelDbId) as { enabled: number };

    it('disables out-of-scope models, drops them from the chain, and restores them when the scope widens', async () => {
      const id = insertKey();
      const keep = bindModel(id, 'keep-me', 1);
      const drop = bindModel(id, 'drop-me', 2);

      const patch = await request(app, 'PATCH', `/api/keys/${id}`, { modelScope: ['keep-me'] });
      expect(patch.status).toBe(200);
      expect(patch.body.scopeSync).toEqual({ disabled: 1, restored: 0 });

      expect(modelRow(keep)).toEqual({ enabled: 1, disabled_by: null });
      expect(modelRow(drop)).toEqual({ enabled: 0, disabled_by: 'scope' });
      expect(chainRow(drop).enabled).toBe(0);

      // The chain the dashboard renders only lists enabled models.
      const chainView = await request(app, 'GET', '/api/fallback');
      expect(chainView.status).toBe(200);
      expect(JSON.stringify(chainView.body)).toContain('keep-me');
      expect(JSON.stringify(chainView.body)).not.toContain('drop-me');

      // Clearing the scope restores what the scope itself switched off.
      const cleared = await request(app, 'PATCH', `/api/keys/${id}`, { modelScope: null });
      expect(cleared.body.scopeSync).toEqual({ disabled: 0, restored: 1 });
      expect(modelRow(drop)).toEqual({ enabled: 1, disabled_by: null });
      expect(chainRow(drop).enabled).toBe(1);
    });

    it('leaves a model the user switched off by hand alone', async () => {
      const id = insertKey();
      const manual = bindModel(id, 'manual-off', 1, { enabled: 0, disabledBy: 'user' });

      const patch = await request(app, 'PATCH', `/api/keys/${id}`, { modelScope: ['manual-off'] });
      expect(patch.status).toBe(200);
      expect(patch.body.scopeSync).toEqual({ disabled: 0, restored: 0 });
      expect(modelRow(manual)).toEqual({ enabled: 0, disabled_by: 'user' });
    });

    it('touches no model that is not bound to the key', async () => {
      const id = insertKey();
      const other = insertKey();
      const shared = bindModel(other, 'shared-model', 1);

      const patch = await request(app, 'PATCH', `/api/keys/${id}`, { modelScope: ['something-else'] });
      expect(patch.status).toBe(200);
      expect(patch.body.scopeSync).toEqual({ disabled: 0, restored: 0 });
      expect(modelRow(shared)).toEqual({ enabled: 1, disabled_by: null });
    });
  });
});
