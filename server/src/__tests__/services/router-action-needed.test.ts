import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { routeRequest } from '../../services/router.js';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { addToActiveChain } from '../helpers/chain.js';
import { raiseAction, clearAction, snoozeAction } from '../../services/action-needed.js';

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

function addModel(modelId: string): number {
  const db = getDb();
  db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, monthly_token_budget, enabled, supports_vision, supports_tools)
    VALUES ('groq', ?, ?, 3, 1, 'Large', '~50M', 1, 0, 1)
  `).run(modelId, modelId.toUpperCase());
  const modelDbId = (db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?')
    .get('groq', modelId) as { id: number }).id;
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(modelDbId, modelDbId);
  addToActiveChain(modelDbId, modelDbId);
  const { encrypted, iv, authTag } = encrypt(`gsk_${modelId}`);
  const info = db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES ('groq', ?, ?, ?, ?, 'healthy', 1)
  `).run(modelId, encrypted, iv, authTag);
  return Number(info.lastInsertRowid);
}

describe('router honours the action-needed flag ([fork 5/10])', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    process.env.DEV_MODE = 'true';
    process.env.NODE_ENV = 'test';
    initDb(':memory:');
    getDb().exec('DELETE FROM profile_models; DELETE FROM fallback_config; DELETE FROM models; DELETE FROM api_keys; DELETE FROM requests; DELETE FROM key_action_needed;');
  });

  afterEach(() => {
    delete process.env.DEV_MODE;
    delete process.env.NODE_ENV;
  });

  it('will not route to a key flagged exclude_from_rotation', () => {
    const keyId = addModel('flagged-model');
    raiseAction({ keyId, reason: 'verify_phone', policy: 'exclude_from_rotation' });
    expect(() => routeRequest(100)).toThrow(/key needs action on the provider site/);
  });

  it('routes to the key again once the flag is cleared', () => {
    const keyId = addModel('flagged-model');
    raiseAction({ keyId, reason: 'verify_phone' });
    expect(() => routeRequest(100)).toThrow();
    clearAction(keyId);
    const route = routeRequest(100);
    expect(route.modelId).toBe('flagged-model');
    route.release?.();
  });

  it('keeps routing to an inform_only flagged key', () => {
    const keyId = addModel('info-model');
    raiseAction({ keyId, reason: 'rotate_key', policy: 'inform_only' });
    const route = routeRequest(100);
    expect(route.modelId).toBe('info-model');
    route.release?.();
  });

  it('still excludes a snoozed flag: snooze defers the reminder, not the key', () => {
    const keyId = addModel('snoozed-model');
    raiseAction({ keyId, reason: 'captcha' });
    snoozeAction(keyId, 4);
    expect(() => routeRequest(100)).toThrow();
  });
});
