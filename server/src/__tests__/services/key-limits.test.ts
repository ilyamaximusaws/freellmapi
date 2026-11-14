import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import {
  parseRateLimitHeaders, snapshotIsExhausted, type RateLimitSnapshot,
} from '../../lib/rate-limit-headers.js';
import {
  checkKeyRateLimits, keyWindowUsage, recordKeyHeaders, getKeyRateState,
  setKeyCooldown, clearKeyCooldown, getKeyCooldown, listKeyCooldowns,
  retryAfterCooldown, isSnapshotFresh,
} from '../../services/key-limits.js';
import { routeRequest } from '../../services/router.js';
import { addToActiveChain } from '../helpers/chain.js';

/**
 * [fork 7/10] Per-key RPM/TPM + provider header parsing + key cooldowns.
 */

const T0 = Date.UTC(2026, 10, 14, 12, 0, 0);

function insertKey(opts: { rpm?: number; tpm?: number; rpd?: number; label?: string } = {}): number {
  const { encrypted, iv, authTag } = encrypt('gsk_ratelimit_test');
  const info = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, rpm_limit, tpm_limit, rpd_limit)
    VALUES ('groq', ?, ?, ?, ?, 'healthy', 1, ?, ?, ?)
  `).run(opts.label ?? 'rl', encrypted, iv, authTag, opts.rpm ?? null, opts.tpm ?? null, opts.rpd ?? null);
  return Number(info.lastInsertRowid);
}

function insertUsage(keyId: number, kind: 'request' | 'tokens', tokens: number, createdAtMs: number): void {
  getDb().prepare(`
    INSERT INTO rate_limit_usage (platform, model_id, key_id, kind, tokens, created_at_ms)
    VALUES ('groq', 'm', ?, ?, ?, ?)
  `).run(keyId, kind, tokens, createdAtMs);
}

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
  return modelDbId;
}

describe('rate-limit header parsing ([fork 7/10])', () => {
  it('parses OpenAI-style request headers', () => {
    const snap = parseRateLimitHeaders({
      'x-ratelimit-remaining-requests': '3',
      'x-ratelimit-limit-requests': '50',
      'x-ratelimit-reset-requests': '5s',
    }, T0);
    expect(snap.requests?.remaining).toBe(3);
    expect(snap.requests?.limit).toBe(50);
    expect(snap.requests?.resetMs).toBe(T0 + 5000);
  });

  it('parses GitHub-style generic headers with epoch reset', () => {
    const snap = parseRateLimitHeaders({
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': '1760000000',
    }, T0);
    expect(snap.requests?.remaining).toBe(0);
    expect(snap.requests?.resetMs).toBe(1_760_000_000 * 1000);
  });

  it('parses token headers and Go-style duration resets', () => {
    const snap = parseRateLimitHeaders({
      'x-ratelimit-remaining-tokens': '1200',
      'x-ratelimit-limit-tokens': '6000',
      'x-ratelimit-reset-tokens': '6m0.512s',
    }, T0);
    expect(snap.tokens?.remaining).toBe(1200);
    expect(snap.tokens?.resetMs).toBe(T0 + (6 * 60 + 0.512) * 1000);
  });

  it('skips malformed values instead of treating them as zero', () => {
    const snap = parseRateLimitHeaders({ 'x-ratelimit-remaining-requests': 'lots' }, T0);
    expect(snap.requests).toBeUndefined();
    expect(snap.creditsRemaining).toBeUndefined();
  });

  it('reads OpenRouter credit style', () => {
    const snap = parseRateLimitHeaders({ 'x-ratelimit-remaining-credits': '12.5' }, T0);
    expect(snap.creditsRemaining).toBe(12.5);
  });

  it('flags an exhausted snapshot', () => {
    expect(snapshotIsExhausted({ observedAtMs: T0, requests: { remaining: 0, limit: 50, resetMs: null } })).toBe(true);
    expect(snapshotIsExhausted({ observedAtMs: T0 })).toBe(false);
    expect(snapshotIsExhausted({ observedAtMs: T0, creditsRemaining: 0 })).toBe(true);
    expect(snapshotIsExhausted({ observedAtMs: T0, requests: { remaining: 1, limit: 50, resetMs: null } })).toBe(false);
  });
});

describe('per-key rate limits ([fork 7/10])', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    getDb().exec('DELETE FROM requests; DELETE FROM key_caps; DELETE FROM rate_limit_usage; DELETE FROM key_rate_state; DELETE FROM key_cooldowns; DELETE FROM profile_models; DELETE FROM fallback_config; DELETE FROM models; DELETE FROM api_keys');
  });

  it('counts a sliding window across all of a key\'s models', () => {
    const keyId = insertKey();
    insertUsage(keyId, 'request', 0, T0 - 1000);
    insertUsage(keyId, 'tokens', 500, T0 - 2000);
    insertUsage(keyId, 'tokens', 300, T0 - 90_000); // outside the minute window
    const minute = keyWindowUsage(keyId, 60_000, T0);
    expect(minute.requests).toBe(1);
    expect(minute.tokens).toBe(500);
  });

  it('refuses the 11th request in a minute when rpm=10', () => {
    const keyId = insertKey({ rpm: 10, label: 'rpm10' });
    addModel('rpm-model');
    // Anchor to the wall clock. `routeRequest` reads Date.now() internally, and
    // the window query counts rows with created_at_ms > now - 60s, so a fixed
    // T0 ages out of the window as real time passes and the route-level
    // assertion would silently stop exercising anything.
    const now = Date.now();
    for (let i = 0; i < 10; i++) insertUsage(keyId, 'request', 0, now - (10 - i) * 1000);
    expect(checkKeyRateLimits(keyId, now).allowed).toBe(false);

    // Route-level: the exhausted key is skipped (only model, so the request fails).
    expect(() => routeRequest(100)).toThrow();
  });

  it('does not block the 10th of 10', () => {
    const keyId = insertKey({ rpm: 10 });
    for (let i = 0; i < 9; i++) insertUsage(keyId, 'request', 0, T0 - (9 - i) * 1000);
    expect(checkKeyRateLimits(keyId, T0).allowed).toBe(true);
  });

  it('blocks on tpm once the token window is spent', () => {
    const keyId = insertKey({ tpm: 1000 });
    insertUsage(keyId, 'tokens', 1000, T0 - 1000);
    expect(checkKeyRateLimits(keyId, T0)).toMatchObject({ allowed: false, reason: 'key_tpm' });
    // Under the cap still fine.
    const other = insertKey({ tpm: 1000 });
    insertUsage(other, 'tokens', 999, T0 - 1000);
    expect(checkKeyRateLimits(other, T0).allowed).toBe(true);
  });

  it('a fresh provider snapshot of zero remaining outranks the local counter', () => {
    const keyId = insertKey(); // no local cap at all
    recordKeyHeaders(keyId, {
      'x-ratelimit-remaining-requests': '0',
      'x-ratelimit-reset-requests': '10s',
    }, T0);
    const verdict = checkKeyRateLimits(keyId, T0);
    expect(verdict).toMatchObject({ allowed: false, reason: 'provider_exhausted' });
    expect(getKeyRateState(keyId).requestsRemaining).toBe(0);
  });

  it('an old snapshot no longer suppresses the key', () => {
    const keyId = insertKey();
    recordKeyHeaders(keyId, { 'x-ratelimit-remaining-requests': '0' }, T0);
    expect(isSnapshotFresh(T0, T0 + 16 * 60_000)).toBe(false);
    expect(checkKeyRateLimits(keyId, T0 + 16 * 60_000).allowed).toBe(true);
  });

  it('a manual cooldown excludes the key and expires by itself', () => {
    const keyId = insertKey();
    setKeyCooldown(keyId, { reason: 'migrating balance', expiresAtMs: T0 + 60_000 }, T0);
    expect(getKeyCooldown(keyId, T0)?.reason).toBe('migrating balance');
    expect(checkKeyRateLimits(keyId, T0)).toMatchObject({ allowed: false, reason: 'cooldown' });
    // Expired: the router forgets, clear does not error, list drops it.
    expect(getKeyCooldown(keyId, T0 + 60_001)).toBeNull();
    expect(checkKeyRateLimits(keyId, T0 + 60_001).allowed).toBe(true);
    expect(listKeyCooldowns(T0 + 60_001)).toHaveLength(0);
  });

  it('retry-after from a 429 sets an expiring key cooldown', () => {
    const keyId = insertKey();
    expect(retryAfterCooldown(keyId, 45_000, T0)).toBe(true);
    expect(getKeyCooldown(keyId, T0)?.source).toBe('retry_after');
    expect(getKeyCooldown(keyId, T0 + 45_001)).toBeNull();
    // A missing/zero Retry-After does not hold the key.
    expect(retryAfterCooldown(insertKey(), undefined, T0)).toBe(false);
  });

  it('clears a manual cooldown explicitly', () => {
    const keyId = insertKey();
    setKeyCooldown(keyId, { reason: 'wait', expiresAtMs: T0 + 3_600_000 }, T0);
    expect(clearKeyCooldown(keyId)).toBe(true);
    expect(clearKeyCooldown(keyId)).toBe(false);
    expect(getKeyCooldown(keyId, T0)).toBeNull();
  });
});