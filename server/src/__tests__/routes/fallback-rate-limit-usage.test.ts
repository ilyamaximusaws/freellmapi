// GET /api/fallback/rate-limit-usage (#876) must answer "how close is this model
// to being unroutable", which means following the key the ROUTER would pick next
// — not the busiest key on the account. Reporting the busiest one paints a red
// badge over a model that has an idle key sitting right there, and counting a
// key the router would never touch (scoped away, disabled, unhealthy) is wrong
// in both directions.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { mintDashboardToken } from '../helpers/auth.js';

const PLATFORM = 'groq';
const MODEL_ID = 'rate-usage-probe';
const RPM_LIMIT = 30;

let dashToken = '';

async function get(app: Express, path: string) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    headers: { Authorization: `Bearer ${dashToken}` },
  });
  const body = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body };
}

function addKey(label: string, opts: {
  enabled?: number;
  status?: string;
  scope?: string[] | null;
  rpm?: number;
  tpm?: number;
  rpd?: number;
} = {}): number {
  const db = getDb();
  const secret = encrypt(`secret-${label}`);
  const info = db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, model_scope_json,
                          rpm_limit, tpm_limit, rpd_limit)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    PLATFORM, label, secret.encrypted, secret.iv, secret.authTag,
    opts.status ?? 'healthy',
    opts.enabled ?? 1,
    opts.scope ? JSON.stringify(opts.scope) : null,
    opts.rpm ?? null,
    opts.tpm ?? null,
    opts.rpd ?? null,
  );
  return Number(info.lastInsertRowid);
}

/** N recorded requests for (model, key) inside the current minute. */
function burnRequests(keyId: number, count: number) {
  const db = getDb();
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO rate_limit_usage (platform, model_id, key_id, kind, tokens, created_at_ms)
    VALUES (?, ?, ?, 'request', 0, ?)
  `);
  for (let i = 0; i < count; i++) stmt.run(PLATFORM, MODEL_ID, keyId, now - i);
}

async function probeRow(app: Express) {
  const { status, body } = await get(app, '/api/fallback/rate-limit-usage');
  expect(status).toBe(200);
  return body.rows.find((r: any) => r.modelId === MODEL_ID);
}

describe('GET /api/fallback/rate-limit-usage', () => {
  let app: Express;
  let modelDbId: number;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
    const db = getDb();
    const info = db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank,
                          monthly_token_budget, rpm_limit, enabled)
      VALUES (?, ?, 'Rate Usage Probe', 1, 1, 'unlimited', ?, 1)
    `).run(PLATFORM, MODEL_ID, RPM_LIMIT);
    modelDbId = Number(info.lastInsertRowid);
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM rate_limit_usage').run();
    db.prepare('DELETE FROM api_keys WHERE platform = ?').run(PLATFORM);
  });

  it('reports the key with the most headroom, not the busiest one', async () => {
    const exhausted = addKey('exhausted');
    addKey('idle');
    burnRequests(exhausted, RPM_LIMIT);

    const row = await probeRow(app);
    // The idle key can serve the next request, so the badge must stay low.
    expect(row.rpm).toEqual({ used: 0, limit: RPM_LIMIT });
  });

  it('goes to the ceiling only when every routable key is exhausted', async () => {
    const a = addKey('a');
    const b = addKey('b');
    burnRequests(a, RPM_LIMIT);
    burnRequests(b, RPM_LIMIT);

    const row = await probeRow(app);
    expect(row.rpm).toEqual({ used: RPM_LIMIT, limit: RPM_LIMIT });
  });

  it('ignores a key whose model scope excludes this model (#657)', async () => {
    // The free key is scoped to a different model, so the router can never reach
    // it; the only key that can serve this model is spent. Counting the scoped
    // key would report a comfortable 0/30 for a model that cannot be served.
    addKey('scoped-elsewhere', { scope: ['some-other-model'] });
    const usable = addKey('usable');
    burnRequests(usable, RPM_LIMIT);

    const row = await probeRow(app);
    expect(row.rpm).toEqual({ used: RPM_LIMIT, limit: RPM_LIMIT });
  });

  it('counts a scoped key that DOES list this model', async () => {
    const scopedIn = addKey('scoped-in', { scope: [MODEL_ID] });
    const other = addKey('other');
    burnRequests(other, RPM_LIMIT);
    burnRequests(scopedIn, 3);

    const row = await probeRow(app);
    expect(row.rpm).toEqual({ used: 3, limit: RPM_LIMIT });
  });

  it('ignores disabled and unhealthy keys', async () => {
    addKey('disabled', { enabled: 0 });
    addKey('errored', { status: 'error' });
    const usable = addKey('usable');
    burnRequests(usable, 9);

    const row = await probeRow(app);
    expect(row.rpm).toEqual({ used: 9, limit: RPM_LIMIT });
  });

  it('reports no windows when the platform has no routable key at all', async () => {
    const row = await probeRow(app);
    expect(row.rpm).toBeNull();
    expect(row.rpd).toBeNull();
    expect(row.tpm).toBeNull();
  });

  it('omits windows the model has no limit for', async () => {
    addKey('solo');
    const row = await probeRow(app);
    expect(row.modelDbId).toBe(modelDbId);
    expect(row.platform).toBe(PLATFORM);
    expect(row.rpd).toBeNull();
    expect(row.tpm).toBeNull();
  });

  describe('monthly capacity [fork 7/10 follow-up]', () => {
    it('is null when no key sets any RPM/TPM/RPD limit', async () => {
      addKey('unlimited');
      const row = await probeRow(app);
      expect(row.monthly).toBeNull();
    });

    it('converts each key window to a month and sums the pool', async () => {
      // 30 req/min over 30 days, on two keys that can both serve.
      addKey('a', { rpm: 30 });
      addKey('b', { rpm: 30 });
      const row = await probeRow(app);
      expect(row.monthly).toEqual({ requests: 2 * 30 * 60 * 24 * 30, tokens: null });
    });

    it('lets the tighter of RPM and RPD bound a key\u2019s monthly requests', async () => {
      // rpm would allow 2.59M/month, rpd only 30k — rpd is the binding window.
      addKey('a', { rpm: 60, rpd: 1000 });
      const row = await probeRow(app);
      expect(row.monthly).toEqual({ requests: 1000 * 30, tokens: null });
    });

    it('converts TPM to monthly tokens', async () => {
      addKey('a', { tpm: 1000 });
      const row = await probeRow(app);
      expect(row.monthly).toEqual({ requests: null, tokens: 1000 * 60 * 24 * 30 });
    });

    it('ignores keys the router cannot reach', async () => {
      addKey('disabled', { enabled: 0, rpm: 30 });
      addKey('errored', { status: 'error', rpm: 30 });
      addKey('scoped-elsewhere', { scope: ['some-other-model'], rpm: 30 });
      addKey('usable', { rpm: 30 });
      const row = await probeRow(app);
      expect(row.monthly).toEqual({ requests: 30 * 60 * 24 * 30, tokens: null });
    });
  });
});
