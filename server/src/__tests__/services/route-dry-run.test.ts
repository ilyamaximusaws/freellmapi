import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { explainRouteForModel } from '../../services/router.js';
import { setKeyMetadata } from '../../services/key-metadata.js';
import { addToActiveChain } from '../helpers/chain.js';

/**
 * [fork 10/10] Dry-run: the key walk explained, side-effect free.
 */

function insertKey(label: string, platform = 'groq'): number {
  const { encrypted, iv, authTag } = encrypt(`gsk_${label}`);
  const info = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, ?, ?, 'healthy', 1)
  `).run(platform, label, encrypted, iv, authTag);
  return Number(info.lastInsertRowid);
}

function addModel(modelId: string, platform = 'groq'): number {
  const db = getDb();
  db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, monthly_token_budget, enabled, supports_vision, supports_tools)
    VALUES (?, ?, ?, 3, 1, 'Large', '~50M', 1, 0, 1)
  `).run(platform, modelId, modelId.toUpperCase());
  const modelDbId = (db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?').get(platform, modelId) as { id: number }).id;
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(modelDbId, modelDbId);
  addToActiveChain(modelDbId, modelDbId);
  return modelDbId;
}

describe('dry-run router ([fork 10/10])', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    getDb().exec('DELETE FROM profile_models; DELETE FROM fallback_config; DELETE FROM models; DELETE FROM api_keys; DELETE FROM requests;');
  });

  it('reports the chosen key and the reason every other key was skipped', () => {
    addModel('explain-model');
    const keyA = insertKey('healthy-a');
    const keyB = insertKey('scoped-b');
    // Scope keyB to a different model so it is dropped pre-walk with 'model-scope'.
    getDb().prepare('UPDATE api_keys SET model_scope_json = ? WHERE id = ?')
      .run(JSON.stringify(['some-other-model']), keyB);
    setKeyMetadata(keyA, { tags: ['trial'] });

    const result = explainRouteForModel('explain-model');
    expect(result.chosenKeyId).toBe(keyA);
    expect(result.modelId).toBe('explain-model');

    const decisionFor = (id: number) => result.candidates.find(candidate => candidate.keyId === id)!;
    expect(decisionFor(keyA).chosen).toBe(true);
    expect(decisionFor(keyB).reasons).toContain('model-scope');
  });

  it('lists the gate for a cooldowned key', () => {
    addModel('explain-cooldown');
    const keyA = insertKey('cooldowned');
    // Force a cooldown for this (platform, model, key) triple.
    getDb().prepare(`
      INSERT INTO rate_limit_cooldowns (platform, model_id, key_id, expires_at_ms)
      VALUES ('groq', 'explain-cooldown', ?, ?)
    `).run(keyA, Date.now() + 60_000);
    const result = explainRouteForModel('explain-cooldown');
    expect(result.chosenKeyId).toBeNull();
    expect(result.candidates.find(candidate => candidate.keyId === keyA)?.reasons).toContain('cooldown');
  });
});