import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { routeRequestWaitingForSlot } from '../../services/router.js';
import {
  acquireLease, releaseLease, resetLeases,
  keyConcurrencySnapshot, keyQueueWaitStats, resetKeyQueueWaitStats,
} from '../../services/ratelimit.js';

/**
 * [fork 2/10] The per-key concurrency queue: when every candidate key is at its
 * in-flight cap, the request waits briefly for a slot instead of failing, and
 * the wait is attributed to the saturated keys. A genuine (non-concurrency)
 * exhaustion still fails immediately — the wait must never mask an outage.
 *
 * Time is injected (deterministic): the fake clock advances inside the injected
 * sleep, so no real timers run.
 */

let modelId = '';

function insertGroqKey(maxConcurrent: number | null): number {
  const { encrypted, iv, authTag } = encrypt('gsk_concurrency_test');
  const info = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, max_concurrent)
    VALUES ('groq', 'conc', ?, ?, ?, 'healthy', 1, ?)
  `).run(encrypted, iv, authTag, maxConcurrent);
  return Number(info.lastInsertRowid);
}

describe('per-key concurrency queue ([fork 2/10])', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    // Any enabled groq model from the seeded catalog will do.
    modelId = (getDb().prepare(`
      SELECT m.model_id FROM models m
      JOIN fallback_config fc ON fc.model_db_id = m.id
      WHERE m.platform = 'groq' AND m.enabled = 1
      ORDER BY fc.priority LIMIT 1
    `).get() as { model_id: string }).model_id;
  });

  beforeEach(() => {
    getDb().exec('DELETE FROM api_keys');
    resetLeases();
    resetKeyQueueWaitStats();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.MAX_CONCURRENT_REQUESTS_PER_KEY;
    delete process.env.MAX_CONCURRENT_REQUESTS_PER_KEY_GROQ;
  });

  it('queues until a slot frees, then routes to the freed key', async () => {
    const keyId = insertGroqKey(1);
    const lease = acquireLease('groq', modelId, keyId, 100);

    let clock = 1_000_000;
    let released = false;
    const sleep = async (ms: number) => {
      clock += ms;
      if (!released) { released = true; releaseLease(lease); }
    };

    const route = await routeRequestWaitingForSlot(100, undefined, undefined, false, false, undefined, undefined, false, undefined, 0, undefined, undefined, {
      queueTimeoutMs: 500,
      sleep,
      now: () => clock,
    });

    expect(route.keyId).toBe(keyId);
    // The wait happened and was attributed to the saturated key.
    const stats = keyQueueWaitStats();
    const key = `${route.platform}:${keyId}`;
    expect(stats[key]?.waits ?? 0).toBeGreaterThan(0);
  });

  it('gives up with the original exhaustion once the queue timeout expires', async () => {
    const keyId = insertGroqKey(1);
    acquireLease('groq', modelId, keyId, 100); // never released

    let clock = 2_000_000;
    const sleep = async (ms: number) => { clock += ms; };

    await expect(routeRequestWaitingForSlot(100, undefined, undefined, false, false, undefined, undefined, false, undefined, 0, undefined, undefined, {
      queueTimeoutMs: 300,
      sleep,
      now: () => clock,
    })).rejects.toThrow();

    const stats = keyQueueWaitStats();
    expect(stats[`groq:${keyId}`]?.waits ?? 0).toBeGreaterThan(0);
  });

  it('does not wait when the concurrency cap is 0 (unlimited)', async () => {
    insertGroqKey(0); // unlimited
    const sleep = vi.fn(async () => {});
    const route = await routeRequestWaitingForSlot(100, undefined, undefined, false, false, undefined, undefined, false, undefined, 0, undefined, undefined, {
      queueTimeoutMs: 500,
      sleep,
      now: () => Date.now(),
    });
    expect(route).toBeTruthy();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not wait for a non-concurrency exhaustion (no key at all)', async () => {
    // No keys for groq, and every groq model is unusable → immediate failure,
    // never a queue wait: the wait only applies to saturated key pools.
    getDb().exec('DELETE FROM api_keys');
    const sleep = vi.fn(async () => {});
    await expect(routeRequestWaitingForSlot(100, undefined, undefined, false, false, undefined, undefined, false, undefined, 0, undefined, undefined, {
      queueTimeoutMs: 500,
      sleep,
      now: () => Date.now(),
    })).rejects.toThrow();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('reports occupied slots and the cap per busy key for analytics', () => {
    const keyId = insertGroqKey(2);
    acquireLease('groq', modelId, keyId, 100);
    acquireLease('groq', modelId, keyId, 100);

    const snapshot = keyConcurrencySnapshot();
    const row = snapshot.find(r => r.platform === 'groq' && r.keyId === keyId);
    expect(row).toMatchObject({ inFlight: 2, limit: 2 });
  });
});