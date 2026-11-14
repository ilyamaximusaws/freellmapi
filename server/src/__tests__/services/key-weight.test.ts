import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { createCap } from '../../services/key-caps.js';
import {
  keyWeight, keyOrder, usesWeighting, weightedShuffle, orderKeysByWeight,
  effectiveKeyWeight, SOFT_CAP_WEIGHT_FACTOR,
} from '../../services/key-weight.js';
import { routeRequest } from '../../services/router.js';
import { addToActiveChain } from '../helpers/chain.js';

/**
 * [fork 6/10] Weight and order. The acceptance criterion for weight is
 * statistical ("weight 2 takes about twice the traffic of weight 1"), so the
 * distribution test runs the real selection many times with a seeded RNG.
 */

/** Deterministic PRNG so a distribution test is reproducible. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function insertKey(platform: string, opts: { weight?: number; order?: number; label?: string } = {}): number {
  const { encrypted, iv, authTag } = encrypt('gsk_weight_test');
  const info = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, weight, key_order)
    VALUES (?, ?, ?, ?, ?, 'healthy', 1, ?, ?)
  `).run(platform, opts.label ?? 'w', encrypted, iv, authTag, opts.weight ?? 1, opts.order ?? 0);
  return Number(info.lastInsertRowid);
}

function addModel(modelId: string, platform = 'groq'): number {
  const db = getDb();
  db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, monthly_token_budget, enabled, supports_vision, supports_tools)
    VALUES (?, ?, ?, 3, 1, 'Large', '~50M', 1, 0, 1)
  `).run(platform, modelId, modelId.toUpperCase());
  const modelDbId = (db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?')
    .get(platform, modelId) as { id: number }).id;
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(modelDbId, modelDbId);
  addToActiveChain(modelDbId, modelDbId);
  return modelDbId;
}

describe('key weight and order ([fork 6/10])', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    getDb().exec('DELETE FROM requests; DELETE FROM key_caps; DELETE FROM profile_models; DELETE FROM fallback_config; DELETE FROM models; DELETE FROM api_keys');
  });

  it('defaults to weight 1 and order 0, so nothing changes for an untouched install', () => {
    expect(keyWeight({ id: 1 })).toBe(1);
    expect(keyOrder({ id: 1 })).toBe(0);
    expect(usesWeighting([{ id: 1 }, { id: 2 }])).toBe(false);
    expect(usesWeighting([{ id: 1 }, { id: 2, weight: 3 }])).toBe(true);
    expect(usesWeighting([{ id: 1 }, { id: 2, key_order: 1 }])).toBe(true);
    // 0 is a deliberate "never prefer", not garbage: it still lands in the
    // permutation as the fallback. Negative/garbage falls back to the default.
    expect(keyWeight({ id: 1, weight: 0 })).toBe(0);
    expect(keyWeight({ id: 1, weight: -5 })).toBe(1);
    expect(keyWeight({ id: 1, weight: Number.NaN })).toBe(1);
  });

  it('gives a weight-2 key about twice the first-pick share of a weight-1 key', () => {
    const keys = [{ id: 1, weight: 1 }, { id: 2, weight: 2 }];
    const random = makeRandom(42);
    const counts = { 1: 0, 2: 0 };
    const runs = 20_000;
    for (let i = 0; i < runs; i++) {
      const first = weightedShuffle(keys, { random })[0];
      counts[first.id as 1 | 2] += 1;
    }
    const ratio = counts[2] / counts[1];
    // Expected 2.0; a 20k-sample LCG lands well inside these bounds.
    expect(ratio).toBeGreaterThan(1.85);
    expect(ratio).toBeLessThan(2.15);
  });

  it('never prefers a zero-weight key while a positive one is available', () => {
    const keys = [{ id: 1, weight: 0 }, { id: 2, weight: 1 }];
    const random = makeRandom(7);
    let zeroFirst = 0;
    for (let i = 0; i < 5_000; i++) {
      const order = weightedShuffle(keys, { random });
      if (order[0].id === 1) zeroFirst += 1;
      // It stays in the permutation as the fallback.
      expect(order).toHaveLength(2);
    }
    expect(zeroFirst).toBe(0);
  });

  it('walks a higher order group only after the lower one is exhausted', () => {
    const primary = insertKey('groq', { order: 0, label: 'primary' });
    const backup = insertKey('groq', { order: 1, label: 'backup' });
    addModel('ordered-model');

    // The walk order puts every group-0 key before any group-1 key.
    const ordered = orderKeysByWeight([
      { id: backup, key_order: 1 },
      { id: primary, key_order: 0 },
    ]);
    expect(ordered.map(k => k.id)).toEqual([primary, backup]);

    // Group boundaries survive the real selection: the primary takes the traffic.
    const picks: number[] = [];
    for (let i = 0; i < 25; i++) {
      const route = routeRequest(100);
      picks.push(route.keyId);
      route.release?.();
    }
    expect(new Set(picks)).toEqual(new Set([primary]));
  });

  it('falls back to the later group when the earlier one is unusable', () => {
    const primary = insertKey('groq', { order: 0 });
    const backup = insertKey('groq', { order: 1 });
    addModel('fallback-order-model');
    // The primary is out of the pool (excluded), so the backup serves.
    getDb().prepare('UPDATE api_keys SET enabled = 0 WHERE id = ?').run(primary);

    const route = routeRequest(100);
    expect(route.keyId).toBe(backup);
    route.release?.();
  });

  it('spreads requests between two keys of the same group by weight', () => {
    const light = insertKey('groq', { weight: 1, order: 0 });
    const heavy = insertKey('groq', { weight: 3, order: 0 });
    addModel('weighted-model');

    const counts: Record<number, number> = { [light]: 0, [heavy]: 0 };
    const runs = 4_000;
    for (let i = 0; i < runs; i++) {
      const route = routeRequest(100);
      counts[route.keyId] = (counts[route.keyId] ?? 0) + 1;
      route.release?.();
    }
    // Both serve, and the heavy key clearly leads (3:1 expected).
    expect(counts[light]).toBeGreaterThan(0);
    expect(counts[heavy]).toBeGreaterThan(counts[light] * 2);
  });

  it('applies a weight change on the next request, without a restart', () => {
    const first = insertKey('groq', { weight: 0 });
    const second = insertKey('groq', { weight: 1 });
    addModel('live-weight-model');

    // weight 0 = never preferred while a positive sibling exists.
    let picks = new Set<number>();
    for (let i = 0; i < 10; i++) {
      const route = routeRequest(100);
      picks.add(route.keyId);
      route.release?.();
    }
    expect(picks).toEqual(new Set([second]));

    getDb().prepare('UPDATE api_keys SET weight = 1 WHERE id = ?').run(first);
    picks = new Set<number>();
    for (let i = 0; i < 60; i++) {
      const route = routeRequest(100);
      picks.add(route.keyId);
      route.release?.();
    }
    expect(picks.has(first)).toBe(true);
  });

  it('discounts the effective weight of a key past its soft cap threshold', () => {
    const soft = insertKey('groq', { weight: 4 });
    createCap({ keyId: soft, window: 'day', unit: 'requests', cap: 10, softPercent: 25, resetType: 'sliding' });
    // 30% spent: past the 25% soft threshold, under the hard limit.
    const stamp = (offsetMs: number) => new Date(Date.now() - offsetMs).toISOString().replace('T', ' ').slice(0, 19);
    for (let i = 0; i < 3; i++) {
      getDb().prepare(`
        INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, created_at)
        VALUES ('groq', 'm', ?, 'success', 1, 0, 0, ?)
      `).run(soft, stamp(60_000 + i * 1000));
    }
    expect(effectiveKeyWeight({ id: soft, weight: 4 })).toBeCloseTo(4 * SOFT_CAP_WEIGHT_FACTOR, 5);

    // An unpressured key keeps its full weight.
    const clean = insertKey('groq', { weight: 4 });
    expect(effectiveKeyWeight({ id: clean, weight: 4 })).toBe(4);
  });
});
