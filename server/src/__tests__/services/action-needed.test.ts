import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import {
  raiseAction, getAction, clearAction, snoozeAction, listActions, actionSummary,
  excludedKeyIds, isKeyExcluded, nextDueAt, matchActionRule, detectAction, noteKeySuccess,
  raiseDueActions, listActionRules, createActionRule, updateActionRule, deleteActionRule,
  DEFAULT_SNOOZE_HOURS,
} from '../../services/action-needed.js';

/**
 * [fork 5/10] Action-needed flags: a valid key that a human must unlock on the
 * provider's site. Sync because the fixed clock makes recurrence deterministic.
 */

const T0 = Date.UTC(2026, 10, 14, 12, 0, 0);

function insertKey(label = 'k'): number {
  const { encrypted, iv, authTag } = encrypt('gsk_action_test');
  const info = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES ('groq', ?, ?, ?, ?, 'healthy', 1)
  `).run(label, encrypted, iv, authTag);
  return Number(info.lastInsertRowid);
}

describe('action needed ([fork 5/10])', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    getDb().exec('DELETE FROM key_action_needed');
    getDb().exec('DELETE FROM api_keys');
    getDb().exec('DELETE FROM action_rules');
    // Re-seed the default rules the migration installs.
    const insert = getDb().prepare(`
      INSERT INTO action_rules (name, reason, statuses, pattern, url, policy)
      VALUES (?, ?, ?, ?, NULL, ?)
    `);
    insert.run('Out of credits / balance', 'add_card', '401,402,403', 'insufficient (balance|credit|quota)|out of credit|payment required|billing', 'exclude_from_rotation');
    insert.run('Phone verification', 'verify_phone', '401,402,403', 'verify your (phone|number)|phone verification', 'exclude_from_rotation');
    insert.run('Terms of service', 'accept_tos', '401,402,403', 'accept (the )?(new )?terms|terms of (service|use)', 'exclude_from_rotation');
    insert.run('Daily check-in', 'daily_claim', '402', 'daily check-?in', 'exclude_from_rotation');
    insert.run('Key revoked', 'rotate_key', '401,403', 'invalid api key|api key (revoked|deleted)', 'inform_only');
  });

  it('raises a flag that excludes the key from rotation', () => {
    const keyId = insertKey();
    const flag = raiseAction({ keyId, reason: 'verify_phone', url: 'https://example.com/verify' });
    expect(flag.reason).toBe('verify_phone');
    expect(flag.policy).toBe('exclude_from_rotation');
    expect(isKeyExcluded(keyId)).toBe(true);
    expect([...excludedKeyIds()]).toContain(keyId);
    expect(actionSummary().total).toBe(1);
    expect(actionSummary().byReason.verify_phone).toBe(1);
  });

  it('an inform_only flag never excludes the key', () => {
    const keyId = insertKey();
    raiseAction({ keyId, reason: 'rotate_key', policy: 'inform_only' });
    expect(isKeyExcluded(keyId)).toBe(false);
    expect(excludedKeyIds().size).toBe(0);
    // The operator is still told about it.
    expect(actionSummary().total).toBe(1);
    expect(actionSummary().excluded).toBe(0);
  });

  it('re-raising updates the single active flag instead of stacking rows', () => {
    const keyId = insertKey();
    raiseAction({ keyId, reason: 'verify_phone', note: 'operator note' });
    raiseAction({ keyId, reason: 'accept_tos', note: 'ignored second note' });
    const rows = getDb().prepare('SELECT COUNT(*) AS n FROM key_action_needed WHERE key_id = ?').get(keyId) as { n: number };
    expect(rows.n).toBe(1);
    const flag = getAction(keyId);
    expect(flag?.reason).toBe('accept_tos');
  });

  it('detects a fixable condition from a 402 body', () => {
    const keyId = insertKey();
    const flag = detectAction(keyId, 402, 'Insufficient balance. Please add credit to continue.');
    expect(flag?.reason).toBe('add_card');
    expect(flag?.source).toBe('auto');
    expect(isKeyExcluded(keyId)).toBe(true);
  });

  it('detects the daily check-in from a 402 on the claim platform', () => {
    const keyId = insertKey();
    const flag = detectAction(keyId, 402, 'Daily check-in required to keep your free credits.');
    expect(flag?.reason).toBe('daily_claim');
  });

  it('ignores transient failures', () => {
    const keyId = insertKey();
    // 429 is "come back later", not "go do something".
    expect(detectAction(keyId, 429, 'insufficient balance')).toBeNull();
    expect(getAction(keyId)).toBeNull();
    // A message no rule describes stays unflagged.
    expect(detectAction(keyId, 401, 'upstream disconnected')).toBeNull();

    // A revoked key IS an action (rotate it), but an informational one: the
    // credential is useless, so there is nothing the router could do with it
    // that would work, and excluding it would only hide the reason.
    const revoked = detectAction(keyId, 401, 'Invalid API key');
    expect(revoked?.reason).toBe('rotate_key');
    expect(revoked?.policy).toBe('inform_only');
    expect(isKeyExcluded(keyId)).toBe(false);
  });

  it('does not overwrite a manual flag reason with an auto-detected one', () => {
    const keyId = insertKey();
    raiseAction({ keyId, reason: 'captcha', source: 'manual' });
    detectAction(keyId, 402, 'insufficient balance');
    expect(getAction(keyId)?.reason).toBe('captcha');
    expect(getAction(keyId)?.source).toBe('manual');
  });

  it('clears on done and shows nothing afterwards', () => {
    const keyId = insertKey();
    raiseAction({ keyId, reason: 'accept_tos' });
    expect(clearAction(keyId)).toBe(true);
    expect(getAction(keyId)).toBeNull();
    expect(isKeyExcluded(keyId)).toBe(false);
    expect(actionSummary().total).toBe(0);
    // Clearing twice is a no-op, not an error.
    expect(clearAction(keyId)).toBe(false);
  });

  it('clears automatically once the key serves a request again', () => {
    const keyId = insertKey();
    raiseAction({ keyId, reason: 'accept_tos' });
    expect(noteKeySuccess(keyId)).toBe(true);
    expect(getAction(keyId)).toBeNull();
  });

  it('keeps a recurring flag scheduled when the key serves a request', () => {
    const keyId = insertKey();
    raiseAction({ keyId, reason: 'daily_claim', recurrenceKind: 'interval', recurrenceHours: 24 });
    // A successful request must NOT un-schedule the daily claim.
    expect(noteKeySuccess(keyId)).toBe(false);
    expect(getAction(keyId)?.reason).toBe('daily_claim');
  });

  it('re-raises a recurring flag when its interval has elapsed', () => {
    const keyId = insertKey();
    raiseAction({ keyId, reason: 'daily_claim', recurrenceKind: 'interval', recurrenceHours: 12 });
    clearAction(keyId, { now: T0 });
    const row = getDb().prepare('SELECT next_due_ms FROM key_action_needed WHERE key_id = ?').get(keyId) as { next_due_ms: number };
    expect(row.next_due_ms).toBe(T0 + 12 * 3_600_000);

    // Not yet due.
    expect(raiseDueActions(T0 + 11 * 3_600_000)).toEqual([]);
    expect(getAction(keyId)).toBeNull();
    // Due.
    expect(raiseDueActions(T0 + 12 * 3_600_000)).toEqual([keyId]);
    expect(getAction(keyId)?.reason).toBe('daily_claim');
    // And re-armed for the next cycle.
    const next = getDb().prepare('SELECT next_due_ms FROM key_action_needed WHERE key_id = ?').get(keyId) as { next_due_ms: number };
    expect(next.next_due_ms).toBe(T0 + 24 * 3_600_000);
  });

  it('computes a daily recurrence in the flag timezone', () => {
    // 09:00 in Tokyo = 00:00Z, so the next 09:00 Tokyo after 12:00Z is tomorrow.
    const due = nextDueAt('daily', { hour: 9, timezone: 'Asia/Tokyo' }, T0);
    expect(due).toBe(Date.UTC(2026, 10, 15, 0, 0, 0));

    // The same wall-clock hour in UTC lands today at 09:00Z — already past at
    // 12:00Z, so tomorrow.
    const utcDue = nextDueAt('daily', { hour: 9, timezone: 'UTC' }, T0);
    expect(utcDue).toBe(Date.UTC(2026, 10, 15, 9, 0, 0));

    // A hour still ahead today stays today.
    const later = nextDueAt('daily', { hour: 20, timezone: 'UTC' }, T0);
    expect(later).toBe(Date.UTC(2026, 10, 14, 20, 0, 0));
  });

  it('snoozes without losing the flag, and hides it while snoozed', () => {
    const keyId = insertKey();
    raiseAction({ keyId, reason: 'captcha' });
    const flag = snoozeAction(keyId, DEFAULT_SNOOZE_HOURS, T0);
    expect(flag?.snoozedUntilMs).toBe(T0 + DEFAULT_SNOOZE_HOURS * 3_600_000);

    // Hidden from the default view and from the badge…
    expect(listActions({ now: T0 })).toHaveLength(0);
    expect(actionSummary(T0).total).toBe(0);
    // …but still there, and still excluding.
    expect(listActions({ includeSnoozed: true, now: T0 })).toHaveLength(1);
    expect(isKeyExcluded(keyId)).toBe(true);

    // Once it wakes it is visible again.
    expect(listActions({ now: T0 + DEFAULT_SNOOZE_HOURS * 3_600_000 + 1 })).toHaveLength(1);
  });

  it('matches rules by status and text', () => {
    const rules = listActionRules();
    expect(matchActionRule(402, 'insufficient balance')?.reason).toBe('add_card');
    expect(matchActionRule(401, 'Please verify your phone number')?.reason).toBe('verify_phone');
    // The daily-claim rule only fires on 402.
    expect(matchActionRule(403, 'daily check-in required')).toBeNull();
    expect(matchActionRule(200, 'insufficient balance')).toBeNull();
    expect(matchActionRule(402, 'everything is fine')).toBeNull();
    expect(rules.length).toBeGreaterThan(0);
  });

  it('manages rules: create, update, disable, delete', () => {
    const rule = createActionRule({
      name: 'Custom', reason: 'other', statuses: [403], pattern: 'contact support',
    });
    expect(matchActionRule(403, 'Please contact support')?.reason).toBe('other');

    const disabled = updateActionRule(rule.id, { enabled: false });
    expect(disabled?.enabled).toBe(false);
    expect(matchActionRule(403, 'Please contact support')).toBeNull();

    expect(deleteActionRule(rule.id)).toBe(true);
    expect(deleteActionRule(rule.id)).toBe(false);
  });

  it('rejects an invalid rule and an invalid URL', () => {
    expect(() => createActionRule({ name: '', reason: 'other', pattern: 'x' })).toThrow(/name/);
    expect(() => createActionRule({ name: 'bad', reason: 'other', pattern: '(' })).toThrow(/invalid pattern/);
    const keyId = insertKey();
    expect(() => raiseAction({ keyId, reason: 'other', url: 'javascript:alert(1)' })).toThrow(/http/);
    expect(() => raiseAction({ keyId, reason: 'verify_phone', recurrenceKind: 'interval', recurrenceHours: 0 })).toThrow(/recurrenceHours/);
    expect(() => raiseAction({ keyId, reason: 'verify_phone', recurrenceKind: 'daily', recurrenceHour: 30 })).toThrow(/recurrenceHour/);
  });
});
