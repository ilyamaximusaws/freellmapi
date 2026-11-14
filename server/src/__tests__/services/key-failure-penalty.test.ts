import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb, setSetting } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import {
  isStreakFailure, recordKeyFailure, recordKeySuccess, isKeyPenalized,
  penaltyLapseMs, penaltySnapshot, clearKeyPenalty, resetPenaltyState, allPenaltySnapshots,
  DEFAULT_STREAK_THRESHOLD, DEFAULT_STEPS_MS,
} from '../../services/key-failure-penalty.js';
import { routeRequest } from '../../services/router.js';
import { addToActiveChain } from '../helpers/chain.js';

/**
 * [fork 8/10] Penalty cooldown with exponential growth. Time is injected so the
 * step progression is deterministic.
 */

const T0 = Date.UTC(2026, 10, 14, 12, 0, 0);

function timeoutError(): Error {
  const err = new Error('The operation was aborted (groq, chat, 10s) — timeout');
  return err;
}
function rateLimitError(): Error {
  return Object.assign(new Error('429 rate limit'), { status: 429 });
}
function transportError(): Error {
  return Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } });
}
function streamStallError(): Error {
  return new Error('groq stream stalled: no data for 90000ms (timeout)');
}
function benignError(): Error {
  return Object.assign(new Error('model not found'), { status: 404 });
}

function insertKey(): number {
  const { encrypted, iv, authTag } = encrypt('gsk_penalty_test');
  const info = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES ('groq', 'penalty', ?, ?, ?, 'healthy', 1)
  `).run(encrypted, iv, authTag);
  return Number(info.lastInsertRowid);
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

describe('penalty failure classification ([fork 8/10])', () => {
  it('counts timeout, stall and transport as failures', () => {
    expect(isStreakFailure(timeoutError())).toBe(true);
    expect(isStreakFailure(streamStallError())).toBe(true);
    expect(isStreakFailure(transportError())).toBe(true);
  });

  it('never counts a 429, a client abort, or a benign error', () => {
    expect(isStreakFailure(rateLimitError())).toBe(false);
    expect(isStreakFailure({ message: 'client disconnected' })).toBe(false);
    expect(isStreakFailure(benignError())).toBe(false);
    // A 429 wording with no status also stays out.
    expect(isStreakFailure(new Error('429 too many requests'))).toBe(false);
  });
});

describe('penalty cooldown ([fork 8/10])', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    resetPenaltyState();
    getDb().prepare("DELETE FROM settings WHERE key LIKE 'penalty_%'").run();
    getDb().exec('DELETE FROM profile_models; DELETE FROM fallback_config; DELETE FROM models; DELETE FROM api_keys; DELETE FROM requests;');
  });

  it('does not penalize before the threshold', () => {
    const keyId = insertKey();
    recordKeyFailure(keyId, timeoutError(), T0);
    recordKeyFailure(keyId, timeoutError(), T0 + 1);
    expect(isKeyPenalized(keyId, T0 + 2)).toBe(false);
    expect(penaltySnapshot(keyId, T0 + 2)?.streak).toBe(2);
  });

  it('penalizes on the threshold and grows exponentially on re-trip', () => {
    const keyId = insertKey();
    // 3 failures → step 1 = DEFAULT_STEPS_MS[0].
    recordKeyFailure(keyId, timeoutError(), T0);
    recordKeyFailure(keyId, timeoutError(), T0 + 1);
    expect(recordKeyFailure(keyId, timeoutError(), T0 + 2)).toBe(true);
    expect(isKeyPenalized(keyId, T0 + 2)).toBe(true);
    expect(penaltyLapseMs(keyId, T0 + 2)).toBe(T0 + 2 + DEFAULT_STEPS_MS[0]);

    // The penalty lapses; the trial request fails. The streak is still 3 (a
    // lapse is not a success), so one more failure re-trips at the next step.
    const lapseAt = T0 + 2 + DEFAULT_STEPS_MS[0] + 1;
    expect(isKeyPenalized(keyId, lapseAt)).toBe(false);
    expect(recordKeyFailure(keyId, timeoutError(), lapseAt)).toBe(true);
    expect(isKeyPenalized(keyId, lapseAt)).toBe(true);
    expect(penaltyLapseMs(keyId, lapseAt)).toBe(lapseAt + DEFAULT_STEPS_MS[1]);
  });

  it('a success resets both the streak and the growth step', () => {
    const keyId = insertKey();
    recordKeyFailure(keyId, timeoutError(), T0);
    recordKeyFailure(keyId, timeoutError(), T0 + 1);
    recordKeyFailure(keyId, timeoutError(), T0 + 2);
    recordKeySuccess(keyId, T0 + 3);
    expect(isKeyPenalized(keyId, T0 + 3)).toBe(false);
    expect(penaltySnapshot(keyId, T0 + 3)).toBeNull();

    // Next failure starts at step 1 again, not the grown step.
    recordKeyFailure(keyId, timeoutError(), T0 + 4);
    recordKeyFailure(keyId, timeoutError(), T0 + 5);
    recordKeyFailure(keyId, timeoutError(), T0 + 6);
    expect(penaltyLapseMs(keyId, T0 + 6)).toBe(T0 + 6 + DEFAULT_STEPS_MS[0]);
  });

  it('respects a runtime-configured smaller step list and threshold', () => {
    setSetting('penalty_streak_threshold', '2');
    setSetting('penalty_steps_ms', '1000,5000');
    setSetting('penalty_ceiling_ms', '5000');
    const keyId = insertKey();
    expect(recordKeyFailure(keyId, timeoutError(), T0)).toBe(false);
    expect(recordKeyFailure(keyId, timeoutError(), T0 + 1)).toBe(true);
    expect(penaltyLapseMs(keyId, T0 + 1)).toBe(T0 + 1 + 1000);
    // Re-trip climbs to the second (and capped) step.
    recordKeyFailure(keyId, timeoutError(), T0 + 1 + 1000 + 1);
    expect(recordKeyFailure(keyId, timeoutError(), T0 + 1 + 1000 + 2)).toBe(true);
    expect(penaltyLapseMs(keyId, T0 + 1 + 1000 + 2)).toBe(T0 + 1 + 1000 + 2 + 5000);
  });

  it('exposes the penalty in the snapshot list and clears early', () => {
    const keyId = insertKey();
    recordKeyFailure(keyId, timeoutError(), T0);
    recordKeyFailure(keyId, timeoutError(), T0 + 1);
    recordKeyFailure(keyId, timeoutError(), T0 + 2);
    expect(allPenaltySnapshots(T0 + 2)).toHaveLength(1);
    expect(clearKeyPenalty(keyId)).toBe(true);
    expect(isKeyPenalized(keyId, T0 + 2)).toBe(false);
    expect(clearKeyPenalty(keyId)).toBe(false);
  });

  it('routes to a penalized key only after the penalty lapses', () => {
    const keyId = insertKey();
    addModel('penalty-model');
    for (let i = 0; i < DEFAULT_STREAK_THRESHOLD; i++) recordKeyFailure(keyId, timeoutError(), Date.now());
    // Penalized right now: the router skips it, so request fails.
    expect(() => routeRequest(100)).toThrow(/penalty/);
    // Clear early → it is routable again.
    clearKeyPenalty(keyId);
    const route = routeRequest(100);
    expect(route.keyId).toBe(keyId);
    route.release?.();
  });
});