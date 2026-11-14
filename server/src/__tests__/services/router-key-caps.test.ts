import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { routeRequest, refreshStatsCache } from '../../services/router.js';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { addToActiveChain } from '../helpers/chain.js';
import { createCap, setKeyAccount, resetCapReservations, capWindowSpan } from '../../services/key-caps.js';

vi.mock('../../services/ratelimit.js', async () => {
  const actual = await vi.importActual('../../services/ratelimit.js');
  return {
    ...actual,
    canMakeRequest: vi.fn(() => true),
    canUseTokens: vi.fn(() => true),
    isOnCooldown: vi.fn(() => false),
  };
});

vi.mock('../../lib/crypto.js', async () => {
  const actual = await vi.importActual('../../lib/crypto.js');
  return { ...actual, decrypt: vi.fn(() => 'mocked-api-key') };
});

const ORIGINAL_DEV_MODE = process.env.DEV_MODE;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

function insertKey(modelDbId: number, accountKey: string | null = null): number {
  const db = getDb();
  const { encrypted, iv, authTag } = encrypt(`gsk_${modelDbId}_${accountKey ?? 'none'}`);
  const info = db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, account_key)
    VALUES ('groq', ?, ?, ?, ?, 'healthy', 1, ?)
  `).run(`${modelDbId}`, encrypted, iv, authTag, accountKey);
  return Number(info.lastInsertRowid);
}

function addModel(modelId: string, keyCount = 1): { modelDbId: number; keyIds: number[] } {
  const db = getDb();
  db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, monthly_token_budget, enabled, supports_vision, supports_tools)
    VALUES ('groq', ?, ?, 3, 1, 'Large', '~50M', 1, 0, 1)
  `).run(modelId, modelId.toUpperCase());
  const modelDbId = (db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?')
    .get('groq', modelId) as { id: number }).id;
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(modelDbId, modelDbId);
  addToActiveChain(modelDbId, modelDbId);
  const keyIds = Array.from({ length: keyCount }, () => insertKey(modelDbId));
  return { modelDbId, keyIds };
}

/**
 * Record successful requests a minute ago. Every "spent" cap in these tests is
 * SLIDING, so a minute ago is always inside the window — a calendar cap would
 * make the fixture depend on the wall clock (a request a minute ago falls
 * outside the window in the first minute after a reset).
 */
function spendRecent(keyId: number, count: number, tokens = 0): void {
  const db = getDb();
  for (let i = 0; i < count; i++) {
    const stamp = new Date(Date.now() - 60_000 + i * 1000).toISOString().replace('T', ' ').slice(0, 19);
    db.prepare(`
      INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, created_at)
      VALUES ('groq', 'm', ?, 'success', ?, 0, 0, ?)
    `).run(keyId, tokens, stamp);
  }
}

function pick(): { modelId: string; keyId: number } {
  const result = routeRequest(100);
  result.release?.();
  return { modelId: result.modelId, keyId: result.keyId };
}

describe('router key caps ([fork 4/10])', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    process.env.DEV_MODE = 'true';
    process.env.NODE_ENV = 'test';
    initDb(':memory:');
    // Start from an empty install: the seeded catalog would otherwise win the
    // pick and drown the models under test.
    getDb().exec('DELETE FROM profile_models; DELETE FROM fallback_config; DELETE FROM models; DELETE FROM api_keys; DELETE FROM requests; DELETE FROM key_caps;');
    resetCapReservations();
  });

  afterEach(() => {
    if (ORIGINAL_DEV_MODE === undefined) delete process.env.DEV_MODE; else process.env.DEV_MODE = ORIGINAL_DEV_MODE;
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    resetCapReservations();
  });

  it('skips a key at its hard threshold and picks the other model', () => {
    const capped = addModel('capped-model');
    const free = addModel('free-model');
    const cap = createCap({ keyId: capped.keyIds[0], window: 'day', unit: 'requests', cap: 1, resetType: 'sliding' });
    spendRecent(capped.keyIds[0], 1);

    // The capped KEY must not be used. The model may still be served by the
    // sibling key (keys are platform-scoped, not model-scoped), so assert on
    // the key, not the model.
    expect(pick().keyId).toBe(free.keyIds[0]);
  });

  it('returns the key to rotation once the window has reset', () => {
    const capped = addModel('capped-model');
    const cap = createCap({ keyId: capped.keyIds[0], window: 'day', unit: 'requests', cap: 1 });
    // One minute before the current window began: outside it, so the counter is
    // empty again — this is what "after the reset" means without time travel.
    const { start } = capWindowSpan(cap);
    const db = getDb();
    const stamp = new Date(start - 60_000).toISOString().replace('T', ' ').slice(0, 19);
    db.prepare(`
      INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, created_at)
      VALUES ('groq', 'm', ?, 'success', 1, 0, 0, ?)
    `).run(capped.keyIds[0], stamp);

    expect(pick().modelId).toBe('capped-model');
  });

  it('shares one account budget between two keys', () => {
    const first = addModel('first-model');
    const second = addModel('second-model');
    setKeyAccount(first.keyIds[0], 'acct-shared');
    setKeyAccount(second.keyIds[0], 'acct-shared');
    const cap = createCap({ accountKey: 'acct-shared', window: 'day', unit: 'requests', cap: 1, resetType: 'sliding' });
    spendRecent(first.keyIds[0], 1);

    // Both keys draw from the same bucket: neither model can serve.
    expect(() => pick()).toThrow();
  });

  it('still serves a soft-pressured key when nothing cleaner is left', () => {
    const soft = addModel('soft-model');
    const cap = createCap({ keyId: soft.keyIds[0], window: 'day', unit: 'requests', cap: 10, softPercent: 80, resetType: 'sliding' });
    spendRecent(soft.keyIds[0], 8); // 8/10 = 80%

    // Only one key exists, so the soft key is used as a fallback.
    expect(pick().modelId).toBe('soft-model');
  });

  it('prefers a clean key over a soft-pressured sibling on the same model', () => {
    const model = addModel('two-key-model', 2);
    const [softKey, cleanKey] = model.keyIds;
    const cap = createCap({ keyId: softKey, window: 'day', unit: 'requests', cap: 10, softPercent: 80, resetType: 'sliding' });
    spendRecent(softKey, 8);

    // The model still serves, but through the clean key.
    expect(pick().keyId).toBe(cleanKey);

    // Once the clean key is hard-capped too, the soft key carries the request.
    const otherCap = createCap({ keyId: cleanKey, window: 'day', unit: 'requests', cap: 1, resetType: 'sliding' });
    spendRecent(cleanKey, 1);
    expect(pick().keyId).toBe(softKey);
  });

  it('clears the cap state when the db is rebuilt', () => {
    const key = addModel('cap-model');
    const cap = createCap({ keyId: key.keyIds[0], window: 'day', unit: 'requests', cap: 1, resetType: 'sliding' });
    spendRecent(key.keyIds[0], 1);
    expect(() => pick()).toThrow();

    getDb().exec('DELETE FROM requests');
    refreshStatsCache(getDb());
    expect(pick().modelId).toBe('cap-model');
  });

  it('groups keys by account_key set through the service', () => {
    const key = addModel('grouped-model');
    setKeyAccount(key.keyIds[0], 'acct-1');
    const cap = createCap({ accountKey: 'acct-1', window: 'week', unit: 'tokens', cap: 1, resetType: 'sliding' });
    spendRecent(key.keyIds[0], 1, 1);

    // 1 token spent against a 1-token cap: the next request is over the limit.
    expect(() => pick()).toThrow();
  });
});
