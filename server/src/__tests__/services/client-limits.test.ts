import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import {
  admitClient, getClientLimits, resetClientLimitState, getClientUsageSnapshot, activeSlots,
} from '../../services/client-limits.js';

// Unit coverage for [fork 1/10] per-client admission: concurrency queueing,
// sliding RPM/TPM windows, daily/monthly caps, request-shape limits and the
// isolation guarantee between two clients.

function insertProfile(name: string, limits: Record<string, number> = {}): number {
  const cols = Object.keys(limits);
  const info = getDb().prepare(`
    INSERT INTO client_profiles (name, token_hash, encrypted_key, iv, auth_tag${cols.length ? ', ' + cols.join(', ') : ''})
    VALUES (?, ?, 'x', 'y', 'z'${cols.length ? ', ' + cols.map(() => '?').join(', ') : ''})
  `).run(name, `hash-${name}`, ...cols.map(c => limits[c]));
  return Number(info.lastInsertRowid);
}

const noSleep = async () => { /* don't actually wait in tests */ };

describe('client limits ([fork 1/10])', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    getDb().exec('DELETE FROM client_profiles; DELETE FROM client_usage;');
    resetClientLimitState();
  });

  it('treats the unified key (null client) as unlimited', async () => {
    const res = await admitClient(null, { estimatedTokens: 1e9, requestedMaxTokens: 1e9, requestBytes: 1e9 });
    expect(res.ok).toBe(true);
  });

  it('reads limits back from the profile row', () => {
    const id = insertProfile('a', { max_concurrent: 2, rpm: 10, tpm: 100 });
    expect(getClientLimits(id)).toMatchObject({ maxConcurrent: 2, rpm: 10, tpm: 100 });
  });

  it('holds a concurrency slot and rejects the next request after the queue timeout', async () => {
    const id = insertProfile('conc', { max_concurrent: 1 });
    const first = await admitClient(id, { sleep: noSleep });
    expect(first.ok).toBe(true);

    const second = await admitClient(id, { sleep: noSleep, queueTimeoutMs: 0 });
    expect(second).toMatchObject({ ok: false, status: 429 });

    first.ok && first.release();
    expect(activeSlots(id)).toBe(0);
    const third = await admitClient(id, { sleep: noSleep, queueTimeoutMs: 0 });
    expect(third.ok).toBe(true);
  });

  it('does not leak a slot when release is called twice', async () => {
    const id = insertProfile('conc2', { max_concurrent: 1 });
    const a = await admitClient(id, { sleep: noSleep });
    expect(a.ok).toBe(true);
    a.ok && a.release();
    a.ok && a.release();
    expect(activeSlots(id)).toBe(0);
  });

  it('enforces the RPM sliding window', async () => {
    const id = insertProfile('rpm', { rpm: 2 });
    expect((await admitClient(id, { sleep: noSleep })).ok).toBe(true);
    expect((await admitClient(id, { sleep: noSleep })).ok).toBe(true);
    const third = await admitClient(id, { sleep: noSleep });
    expect(third).toMatchObject({ ok: false, status: 429 });
    if (!third.ok) expect(third.retryAfterSec).toBeGreaterThan(0);
  });

  it('enforces the TPM sliding window against the estimate', async () => {
    const id = insertProfile('tpm', { tpm: 100 });
    expect((await admitClient(id, { sleep: noSleep, estimatedTokens: 60 })).ok).toBe(true);
    const second = await admitClient(id, { sleep: noSleep, estimatedTokens: 60 });
    expect(second).toMatchObject({ ok: false, status: 429 });
    // A small request still fits.
    expect((await admitClient(id, { sleep: noSleep, estimatedTokens: 30 })).ok).toBe(true);
  });

  it('enforces daily and monthly caps from the settled usage ledger', async () => {
    const id = insertProfile('caps', { daily_request_cap: 1, monthly_token_cap: 100 });
    const now = Date.now();
    const iso = new Date(now).toISOString();
    getDb().prepare('INSERT INTO client_usage (client_id, window, requests, tokens) VALUES (?, ?, 1, 5)')
      .run(id, iso.slice(0, 10));
    const daily = await admitClient(id, { sleep: noSleep, now });
    expect(daily).toMatchObject({ ok: false, status: 429 });

    // A different client is unaffected (isolation).
    const other = insertProfile('other', { daily_request_cap: 1 });
    expect((await admitClient(other, { sleep: noSleep, now })).ok).toBe(true);
  });

  it('rejects request-shape violations before taking a slot', async () => {
    const id = insertProfile('shape', { max_tokens_per_request: 100, max_request_bytes: 1000, max_concurrent: 1 });
    const big = await admitClient(id, { sleep: noSleep, requestedMaxTokens: 101 });
    expect(big).toMatchObject({ ok: false, status: 400 });
    const huge = await admitClient(id, { sleep: noSleep, requestBytes: 1001 });
    expect(huge).toMatchObject({ ok: false, status: 413 });
    // Neither rejection held a slot.
    expect(activeSlots(id)).toBe(0);
  });

  it('counts settled usage windows from the requests ledger trigger', () => {
    const id = insertProfile('ledger');
    const now = Date.now();
    getDb().prepare(`
      INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, client_id, created_at)
      VALUES ('fake', 'fake-model', NULL, 'success', 10, 20, 5, ?, ?)
    `).run(id, new Date(now).toISOString().slice(0, 19).replace('T', ' '));
    const snap = getClientUsageSnapshot(id, now);
    expect(snap.day.requests).toBe(1);
    expect(snap.day.tokens).toBe(30);
    expect(snap.month.requests).toBe(1);
  });

  it('keeps limits per client — one client at cap does not affect another', async () => {
    const a = insertProfile('iso-a', { rpm: 1 });
    const b = insertProfile('iso-b', { rpm: 1 });
    expect((await admitClient(a, { sleep: noSleep })).ok).toBe(true);
    expect(await admitClient(a, { sleep: noSleep })).toMatchObject({ ok: false, status: 429 });
    expect((await admitClient(b, { sleep: noSleep })).ok).toBe(true);
  });
});