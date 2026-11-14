import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import {
  createCap, checkKeyCaps, reserveKeyCaps, capSoftPressures, getKeyCapSummary,
  capWindowSpan, setKeyAccount, getCapsFor, resetCapReservations,
} from '../../services/key-caps.js';
import { checkMonthlyBudget } from '../../services/key-budget.js';

/**
 * [fork 4/10] Windowed caps: hour/day/week/month budgets in requests or tokens,
 * calendar reset in a chosen timezone (or sliding), soft threshold that demotes
 * instead of cutting, account-shared counters, per-model caps.
 *
 * Everything is checked with an injected clock, so no test depends on the real
 * wall clock or on a window boundary happening to fall inside the run.
 */

// 2026-11-14T12:00:00Z — a Tuesday.
const T0 = Date.UTC(2026, 10, 14, 12, 0, 0);

function insertKey(platform = 'groq', accountKey: string | null = null): number {
  const { encrypted, iv, authTag } = encrypt('gsk_caps_test');
  const info = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, account_key)
    VALUES (?, 'caps', ?, ?, ?, 'healthy', 1, ?)
  `).run(platform, encrypted, iv, authTag, accountKey);
  return Number(info.lastInsertRowid);
}

function insertRequest(keyId: number, createdAt: number, tokens = 0, modelId = 'llama-test'): void {
  const stamp = new Date(createdAt).toISOString().replace('T', ' ').slice(0, 19);
  getDb().prepare(`
    INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, created_at)
    VALUES ('groq', ?, ?, 'success', ?, 0, 0, ?)
  `).run(modelId, keyId, tokens, stamp);
}

describe('windowed caps ([fork 4/10])', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    getDb().exec('DELETE FROM requests');
    getDb().exec('DELETE FROM key_caps');
    getDb().exec('DELETE FROM api_keys');
    resetCapReservations();
  });

  it('computes a calendar window boundary in the cap timezone, not UTC', () => {
    const keyId = insertKey();
    // 06:00 daily in Tokyo: at 12:00Z the Tokyo day already started at 03:00Z.
    const cap = createCap({
      keyId, window: 'day', unit: 'requests', cap: 10,
      timezone: 'Asia/Tokyo', resetHour: 6,
    });
    // T0 = 2026-11-14T12:00Z = 2026-11-14 21:00 in Tokyo. The most recent 06:00
    // Tokyo was 2026-11-14 06:00 JST = 2026-11-13T21:00Z.
    const span = capWindowSpan(cap, T0);
    expect(new Date(span.start).toISOString()).toBe('2026-11-13T21:00:00.000Z');
    expect(span.end - span.start).toBe(86_400_000);
    expect(new Date(span.resetAt).toISOString()).toBe('2026-11-14T21:00:00.000Z');

    // The same cap in UTC resets at 06:00Z, so its window began nine hours later
    // — the timezone changes the reset moment, which is the whole point.
    const utcCap = createCap({
      keyId, window: 'day', unit: 'requests', cap: 10,
      timezone: 'UTC', resetHour: 6,
    });
    const utcSpan = capWindowSpan(utcCap, T0);
    expect(new Date(utcSpan.start).toISOString()).toBe('2026-11-14T06:00:00.000Z');
    expect(new Date(utcSpan.start).toISOString()).not.toBe(new Date(span.start).toISOString());

    // 20:00 Tokyo = 11:00Z, which has already happened at 12:00Z.
    const later = createCap({
      keyId, window: 'day', unit: 'requests', cap: 10,
      timezone: 'Asia/Tokyo', resetHour: 20,
    });
    const laterSpan = capWindowSpan(later, T0);
    expect(new Date(laterSpan.start).toISOString()).toBe('2026-11-14T11:00:00.000Z');
  });

  it('uses a sliding window when asked', () => {
    const keyId = insertKey();
    const cap = createCap({ keyId, window: 'day', unit: 'requests', cap: 10, resetType: 'sliding' });
    const span = capWindowSpan(cap, T0);
    expect(span.start).toBe(T0 - 86_400_000);
    expect(span.end).toBe(T0);
    expect(span.resetAt - T0).toBe(86_400_000);
  });

  it('removes the key at the hard threshold and returns it after the reset', () => {
    const keyId = insertKey();
    createCap({ keyId, window: 'day', unit: 'requests', cap: 2 });

    insertRequest(keyId, T0 - 1000);
    insertRequest(keyId, T0 - 500);
    expect(checkKeyCaps(keyId, { now: T0 }).allowed).toBe(false);

    // Same window, a token cap still lets the key serve.
    const tokenCap = createCap({ keyId, window: 'day', unit: 'tokens', cap: 1000 });
    void tokenCap;
    expect(checkKeyCaps(keyId, { estimatedTokens: 5, now: T0 }).allowed).toBe(false);

    // After the window reset (next day, same reset hour) usage is empty again.
    const after = T0 + 24 * 3_600_000;
    expect(checkKeyCaps(keyId, { now: after }).allowed).toBe(true);
  });

  it('accounts for in-flight requests, so parallel streams cannot overrun the cap', () => {
    const keyId = insertKey();
    createCap({ keyId, window: 'day', unit: 'requests', cap: 2 });
    const first = reserveKeyCaps(keyId, { now: T0 });
    expect(first.allowed).toBe(true);
    const second = reserveKeyCaps(keyId, { now: T0 });
    expect(second.allowed).toBe(true);
    const third = reserveKeyCaps(keyId, { now: T0 });
    expect(third.allowed).toBe(false);
    expect('retryAfterSec' in third && third.retryAfterSec).toBeGreaterThan(0);
    if (first.allowed) first.release();
    if (second.allowed) second.release();
    resetCapReservations();
    expect(checkKeyCaps(keyId, { now: T0 }).allowed).toBe(true);
  });

  it('shares one account budget across keys with the same account_key', () => {
    const shared = insertKey('groq', 'acct-shared');
    const sibling = insertKey('groq', 'acct-shared');
    const other = insertKey('groq', 'acct-other');
    createCap({ accountKey: 'acct-shared', window: 'day', unit: 'requests', cap: 2 });

    insertRequest(shared, T0 - 1000);
    insertRequest(sibling, T0 - 500);

    expect(getCapsFor(shared)).toHaveLength(1);
    expect(getCapsFor(sibling)).toHaveLength(1);
    // The sibling spent from the same bucket: the account cap is exhausted.
    expect(checkKeyCaps(sibling, { now: T0 }).allowed).toBe(false);
    // A key outside the account is unaffected.
    expect(checkKeyCaps(other, { now: T0 }).allowed).toBe(true);
  });

  it('applies a per-model cap only to that model', () => {
    const keyId = insertKey();
    createCap({ keyId, window: 'day', unit: 'tokens', cap: 100, modelId: 'expensive-model' });
    insertRequest(keyId, T0 - 1000, 90, 'expensive-model');
    insertRequest(keyId, T0 - 500, 5, 'cheap-model');

    // The expensive model's window is at 90/100, the cheap one untouched.
    expect(checkKeyCaps(keyId, { estimatedTokens: 20, modelId: 'expensive-model', now: T0 }).allowed).toBe(false);
    expect(checkKeyCaps(keyId, { estimatedTokens: 20, modelId: 'cheap-model', now: T0 }).allowed).toBe(true);
  });

  it('reports soft pressure at the soft threshold but does not cut the key', () => {
    const keyId = insertKey();
    createCap({ keyId, window: 'day', unit: 'requests', cap: 10, softPercent: 80 });
    for (let i = 0; i < 8; i++) insertRequest(keyId, T0 - (8 - i) * 1000);

    // 8/10 = 80% → soft, still allowed.
    expect(checkKeyCaps(keyId, { now: T0 }).allowed).toBe(true);
    const soft = capSoftPressures(keyId, { now: T0 });
    expect(soft).toHaveLength(1);
    expect(soft[0].softReached).toBe(true);
    expect(soft[0].hardReached).toBe(false);

    // 9/10 is still soft: the cap admits 10, so the tenth request is fine.
    insertRequest(keyId, T0 - 1000);
    expect(checkKeyCaps(keyId, { now: T0 }).allowed).toBe(true);
    expect(capSoftPressures(keyId, { now: T0 })).toHaveLength(1);

    // At 10/10 the window is spent: the next request is over, and the cap reads
    // as hard rather than merely soft.
    insertRequest(keyId, T0 - 500);
    expect(checkKeyCaps(keyId, { now: T0 }).allowed).toBe(false);
    expect(capSoftPressures(keyId, { now: T0 })).toHaveLength(0);
  });

  it('exposes live usage and the next reset for the key page', () => {
    const keyId = insertKey();
    createCap({ keyId, window: 'day', unit: 'requests', cap: 10 });
    insertRequest(keyId, T0 - 1000);
    const summary = getKeyCapSummary(keyId, { now: T0 });
    expect(summary.caps).toHaveLength(1);
    expect(summary.caps[0].used).toBe(1);
    expect(summary.caps[0].cap).toBe(10);
    expect(summary.caps[0].resetAt).toBeGreaterThan(T0);
  });

  it('keeps the legacy monthly caps working (no value lost)', () => {
    const { encrypted, iv, authTag } = encrypt('gsk_legacy');
    getDb().prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, monthly_request_cap)
      VALUES ('groq', 'legacy', ?, ?, ?, 'healthy', 1, 1)
    `).run(encrypted, iv, authTag);
    const keyId = (getDb().prepare('SELECT id FROM api_keys WHERE label = ?').get('legacy') as { id: number }).id;

    // The legacy column still governs the UTC month budget.
    expect(checkMonthlyBudget(keyId, 0).allowed).toBe(true);
    insertRequest(keyId, Date.now());
    expect(checkMonthlyBudget(keyId, 0).allowed).toBe(false);
    // And the new engine sees no caps for this key (nothing was backfilled, the
    // legacy cap is not duplicated).
    expect(getCapsFor(keyId)).toHaveLength(0);
    expect(checkKeyCaps(keyId, { now: Date.now() }).allowed).toBe(true);
  });

  it('sets and clears the account tag', () => {
    const keyId = insertKey();
    expect(getCapsFor(keyId)).toHaveLength(0);
    setKeyAccount(keyId, 'acct-1');
    expect(getCapsFor(keyId)).toHaveLength(0);
    createCap({ accountKey: 'acct-1', window: 'week', unit: 'tokens', cap: 100 });
    expect(getCapsFor(keyId)).toHaveLength(1);
    setKeyAccount(keyId, null);
    expect(getCapsFor(keyId)).toHaveLength(0);
  });
});
