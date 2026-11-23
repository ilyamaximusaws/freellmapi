import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { mintDashboardToken } from '../helpers/auth.js';

// The chain listing and the Models page must answer "how many models can this
// install route" with the same number. They used to disagree by an order of
// magnitude: /api/profiles counted profile_models ROWS that were enabled in the
// catalog and in the chain, ignoring whether any credential existed for the
// platform — so a chain over a 700-row catalog advertised "427 routable" while
// the catalog itself could serve 15.
let app: Express;
let dashToken = '';

async function get(path: string) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    headers: { Authorization: `Bearer ${dashToken}` },
  });
  const body = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body };
}

describe('chain counts and the model projection agree', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();

    // Exactly one connected provider. The seeded catalog carries rows for a few
    // dozen platforms; only this one has a credential here.
    const db = getDb();
    const key = encrypt('parity-key');
    db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('groq','parity',?,?,?,'healthy',1)")
      .run(key.encrypted, key.iv, key.authTag);
  });

  it('reports the same routable set as GET /api/models', async () => {
    const models = (await get('/api/models')).body as Array<{ modelId: string; routable: boolean; configured: boolean }>;
    const profiles = (await get('/api/profiles')).body as Array<{ id: number; isActive: boolean; modelCount: number; enabledCount: number }>;
    const active = profiles.find(profile => profile.isActive);
    expect(active).toBeDefined();

    // One logical model id counts once, however many providers offer it.
    const routableIds = new Set(models.filter(model => model.routable).map(model => model.modelId));
    const servableIds = new Set(models.filter(model => model.configured).map(model => model.modelId));

    expect(routableIds.size).toBeGreaterThan(0);
    expect(active!.enabledCount).toBe(routableIds.size);
    expect(active!.modelCount).toBe(servableIds.size);
  });

  it('never counts rows for a provider this install has no credential for', async () => {
    const db = getDb();
    const profiles = (await get('/api/profiles')).body as Array<{ isActive: boolean; modelCount: number }>;
    const active = profiles.find(profile => profile.isActive)!;

    // The regression guard: the old definition counted chain rows enabled in the
    // catalog, which includes every unconnected platform in the seeded catalog.
    const naive = (db.prepare(`
      SELECT COUNT(*) AS n FROM profile_models pm JOIN models m ON m.id = pm.model_db_id
       WHERE pm.profile_id = (SELECT value FROM settings WHERE key = 'active_profile_id')
         AND pm.enabled = 1 AND m.enabled = 1
    `).get() as { n: number }).n;
    expect(naive).toBeGreaterThan(active.modelCount);

    // And every platform behind the count is one we actually hold a key for.
    const strayPlatforms = db.prepare(`
      SELECT DISTINCT m.platform FROM profile_models pm JOIN models m ON m.id = pm.model_db_id
       WHERE m.platform NOT IN (SELECT platform FROM api_keys)
    `).all() as Array<{ platform: string }>;
    expect(strayPlatforms.length).toBeGreaterThan(0);
  });

  it('honours a key whose model scope excludes the model', async () => {
    const db = getDb();
    const before = (await get('/api/profiles')).body as Array<{ isActive: boolean; enabledCount: number }>;
    const baseline = before.find(profile => profile.isActive)!.enabledCount;

    // The key serves one model group only; everything else on groq drops out of
    // routing capacity even though the row is still enabled in catalog + chain.
    const scoped = db.prepare("SELECT model_id FROM models WHERE platform = 'groq' ORDER BY id LIMIT 1").get() as { model_id: string };
    db.prepare("UPDATE api_keys SET model_scope_json = ? WHERE platform = 'groq'").run(JSON.stringify([scoped.model_id]));

    const after = (await get('/api/profiles')).body as Array<{ isActive: boolean; enabledCount: number }>;
    const scopedCount = after.find(profile => profile.isActive)!.enabledCount;
    const models = (await get('/api/models')).body as Array<{ modelId: string; routable: boolean }>;
    const routableIds = new Set(models.filter(model => model.routable).map(model => model.modelId));

    expect(scopedCount).toBeLessThan(baseline);
    expect(scopedCount).toBe(routableIds.size);
    expect(routableIds.has(scoped.model_id)).toBe(true);
  });

  it('counts an empty chain as nothing in both units', async () => {
    const db = getDb();
    const chain = db.prepare("INSERT INTO profiles (name, type, sort_order) VALUES ('parity-empty','custom',99)").run();
    db.prepare("INSERT INTO settings (key, value) VALUES ('active_profile_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(String(chain.lastInsertRowid));

    const profiles = (await get('/api/profiles')).body as Array<{ isActive: boolean; modelCount: number; enabledCount: number }>;
    const active = profiles.find(profile => profile.isActive)!;
    expect(active).toMatchObject({ modelCount: 0, enabledCount: 0 });
  });
});
