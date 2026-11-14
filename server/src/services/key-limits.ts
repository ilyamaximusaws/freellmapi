/**
 * Per-key rate limits and cooldowns [fork 7/10].
 *
 * Two independent signals tell the router a key has no budget left BEFORE the
 * request: the operator's own sliding-window caps (`rpm`/`tpm`/`rpd` on the key)
 * and the last snapshot the provider itself reported in response headers. A
 * provider snapshot outranks the local counter when it is fresh — the provider
 * knows about windows and quotas the gateway cannot see — and is also what the
 * dashboard shows ("12 remaining of 50, resets in 3s").
 *
 * A key-wide cooldown is the third knob: a manual park with a reason and a
 * duration, or one taken from a 429's Retry-After. Both live in `key_cooldowns`,
 * which the router checks before every key and the dashboard shows with the
 * reason, so "some keys are idling" is explainable instead of mysterious.
 */
import { getDb } from '../db/index.js';
import { parseRateLimitHeaders, type RateLimitSnapshot } from '../lib/rate-limit-headers.js';

export const KEY_LIMIT_WINDOW_MS = 60_000;   // rpm / tpm
export const KEY_DAY_WINDOW_MS = 86_400_000;  // rpd
/** How long a provider snapshot overrides the local counter. Providers reset on
 *  their own clock, but anything older than ~15 minutes is a guess, not a fact. */
export const SNAPSHOT_TTL_MS = 15 * 60_000;

export interface KeyRateLimits { rpm: number | null; tpm: number | null; rpd: number | null }

function keyLimits(keyId: number): KeyRateLimits {
  const row = getDb().prepare('SELECT rpm_limit, tpm_limit, rpd_limit FROM api_keys WHERE id = ?')
    .get(keyId) as { rpm_limit: number | null; tpm_limit: number | null; rpd_limit: number | null } | undefined;
  if (!row) return { rpm: null, tpm: null, rpd: null };
  const norm = (v: number | null) => (v != null && v > 0 ? v : null);
  return { rpm: norm(row.rpm_limit), tpm: norm(row.tpm_limit), rpd: norm(row.rpd_limit) };
}

export interface KeyWindowUsage { requests: number; tokens: number }

export function keyWindowUsage(keyId: number, windowMs: number, now = Date.now()): KeyWindowUsage {
  const row = getDb().prepare(`
    SELECT
      COUNT(*) FILTER (WHERE kind = 'request') AS requests,
      COALESCE(SUM(CASE WHEN kind = 'tokens' THEN tokens ELSE 0 END), 0) AS tokens
    FROM rate_limit_usage
    WHERE key_id = ? AND created_at_ms > ?
  `).get(keyId, now - windowMs) as { requests: number; tokens: number };
  return { requests: Number(row.requests), tokens: Number(row.tokens) };
}

export type KeyLimitVerdict =
  | { allowed: true }
  | { allowed: false; reason: 'key_rpm' | 'key_tpm' | 'key_rpd' | 'provider_exhausted' | 'cooldown'; retryAfterMs: number };

/** A provider snapshot is authoritative only while it is fresh: the header said
 *  "0 remaining" about the window that just elapsed, and the key may already have
 *  reset on the provider's clock. */
export function isSnapshotFresh(observedAtMs: number, now = Date.now()): boolean {
  return now - observedAtMs < SNAPSHOT_TTL_MS;
}

export function storeKeyRateSnapshot(keyId: number, snapshot: RateLimitSnapshot, now = Date.now()): void {
  getDb().prepare(`
    INSERT INTO key_rate_state
      (key_id, requests_limit, requests_remaining, requests_reset_ms,
       tokens_limit, tokens_remaining, tokens_reset_ms, source, observed_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'headers', ?)
    ON CONFLICT(key_id) DO UPDATE SET
      requests_limit = excluded.requests_limit,
      requests_remaining = excluded.requests_remaining,
      requests_reset_ms = excluded.requests_reset_ms,
      tokens_limit = excluded.tokens_limit,
      tokens_remaining = excluded.tokens_remaining,
      tokens_reset_ms = excluded.tokens_reset_ms,
      source = 'headers',
      observed_at_ms = excluded.observed_at_ms
  `).run(
    keyId,
    snapshot.requests?.limit ?? null,
    snapshot.requests?.remaining ?? null,
    snapshot.requests?.resetMs ?? null,
    snapshot.tokens?.limit ?? null,
    snapshot.tokens?.remaining ?? null,
    snapshot.tokens?.resetMs ?? null,
    snapshot.observedAtMs,
  );
}

export interface KeyRateState {
  requestsRemaining: number | null;
  requestsLimit: number | null;
  requestsResetMs: number | null;
  tokensRemaining: number | null;
  tokensLimit: number | null;
  tokensResetMs: number | null;
  observedAtMs: number | null;
}

export function getKeyRateState(keyId: number): KeyRateState {
  const row = getDb().prepare('SELECT * FROM key_rate_state WHERE key_id = ?').get(keyId) as {
    requests_limit: number | null; requests_remaining: number | null; requests_reset_ms: number | null;
    tokens_limit: number | null; tokens_remaining: number | null; tokens_reset_ms: number | null;
    observed_at_ms: number | null;
  } | undefined;
  return {
    requestsRemaining: row?.requests_remaining ?? null,
    requestsLimit: row?.requests_limit ?? null,
    requestsResetMs: row?.requests_reset_ms ?? null,
    tokensRemaining: row?.tokens_remaining ?? null,
    tokensLimit: row?.tokens_limit ?? null,
    tokensResetMs: row?.tokens_reset_ms ?? null,
    observedAtMs: row?.observed_at_ms ?? null,
  };
}

/** Parse and store response headers for a key. Cheap: a few header reads and one
 *  upsert, called from the capture hook after every upstream response. */
export function recordKeyHeaders(keyId: number, headers: Headers | Record<string, string>, now = Date.now()): void {
  const snapshot = parseRateLimitHeaders(headers, now);
  if (!snapshot.requests && !snapshot.tokens && snapshot.creditsRemaining == null) return;
  storeKeyRateSnapshot(keyId, snapshot, now);
}

export function checkKeyRateLimits(keyId: number, now = Date.now()): KeyLimitVerdict {
  // 1. Manual / Retry-After key cooldown: the strongest, most explicit signal.
  const cooldown = getKeyCooldown(keyId, now);
  if (cooldown) {
    return { allowed: false, reason: 'cooldown', retryAfterMs: cooldown.expiresAtMs - now };
  }

  // 2. A fresh provider snapshot: it outranks our counter because it knows the
  //    real window and quota. A remaining of 0 stops the key immediately.
  const state = getKeyRateState(keyId);
  if (state.observedAtMs != null && isSnapshotFresh(state.observedAtMs, now)) {
    if (state.requestsRemaining != null && state.requestsRemaining <= 0) {
      const reset = state.requestsResetMs ?? now + 60_000;
      return { allowed: false, reason: 'provider_exhausted', retryAfterMs: Math.max(1, reset - now) };
    }
    if (state.tokensRemaining != null && state.tokensRemaining <= 0) {
      const reset = state.tokensResetMs ?? now + 60_000;
      return { allowed: false, reason: 'provider_exhausted', retryAfterMs: Math.max(1, reset - now) };
    }
  }

  // 3. The operator's own sliding-window caps.
  const limits = keyLimits(keyId);
  if (limits.rpm != null) {
    const used = keyWindowUsage(keyId, KEY_LIMIT_WINDOW_MS, now).requests;
    if (used >= limits.rpm) {
      return { allowed: false, reason: 'key_rpm', retryAfterMs: KEY_LIMIT_WINDOW_MS };
    }
  }
  if (limits.tpm != null) {
    const used = keyWindowUsage(keyId, KEY_LIMIT_WINDOW_MS, now).tokens;
    if (used >= limits.tpm) {
      return { allowed: false, reason: 'key_tpm', retryAfterMs: KEY_LIMIT_WINDOW_MS };
    }
  }
  if (limits.rpd != null) {
    const used = keyWindowUsage(keyId, KEY_DAY_WINDOW_MS, now).requests;
    if (used >= limits.rpd) {
      return { allowed: false, reason: 'key_rpd', retryAfterMs: KEY_DAY_WINDOW_MS };
    }
  }

  return { allowed: true };
}

/** The dashboard view: own usage against the caps PLUS the provider's last word. */
export function keyRateSummary(keyId: number, now = Date.now()) {
  const limits = keyLimits(keyId);
  const minute = keyWindowUsage(keyId, KEY_LIMIT_WINDOW_MS, now);
  const day = keyWindowUsage(keyId, KEY_DAY_WINDOW_MS, now);
  const provider = getKeyRateState(keyId);
  return {
    limits,
    usage: { minute, day },
    provider: provider.observedAtMs == null ? null : {
      ...provider,
      fresh: isSnapshotFresh(provider.observedAtMs, now),
    },
  };
}

// ── Key-wide cooldowns (manual + Retry-After) ───────────────────────────────

export type KeyCooldownSource = 'manual' | 'retry_after';

export interface KeyCooldown {
  keyId: number;
  reason: string;
  note: string | null;
  source: KeyCooldownSource;
  expiresAtMs: number;
  createdAt: string;
}

function cooldownFromRow(row: {
  key_id: number; reason: string; note: string | null; source: KeyCooldownSource;
  expires_at_ms: number; created_at: string;
}): KeyCooldown {
  return {
    keyId: row.key_id,
    reason: row.reason,
    note: row.note,
    source: row.source,
    expiresAtMs: row.expires_at_ms,
    createdAt: row.created_at,
  };
}

export function setKeyCooldown(
  keyId: number,
  inputs: { reason: string; note?: string | null; source?: KeyCooldownSource; expiresAtMs: number },
  now = Date.now(),
): KeyCooldown {
  const expiresAt = Number.isFinite(inputs.expiresAtMs) ? Math.max(now + 1000, inputs.expiresAtMs) : now + 3_600_000;
  const reason = (inputs.reason ?? 'manual').slice(0, 200);
  getDb().prepare(`
    INSERT INTO key_cooldowns (key_id, reason, note, source, expires_at_ms, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(key_id) DO UPDATE SET
      reason = excluded.reason, note = excluded.note, source = excluded.source,
      expires_at_ms = excluded.expires_at_ms, created_at = excluded.created_at
  `).run(keyId, reason, inputs.note ?? null, inputs.source ?? 'manual', expiresAt);
  return getKeyCooldown(keyId, now)!;
}

export function clearKeyCooldown(keyId: number): boolean {
  return getDb().prepare('DELETE FROM key_cooldowns WHERE key_id = ?').run(keyId).changes > 0;
}

export function getKeyCooldown(keyId: number, now = Date.now()): KeyCooldown | null {
  const row = getDb().prepare('SELECT * FROM key_cooldowns WHERE key_id = ?').get(keyId) as
    Parameters<typeof cooldownFromRow>[0] | undefined;
  if (!row) return null;
  // Expired holds are visible to "list" but not to the router: report null when
  // asked for the ACTIVE cooldown, so the logic doesn't have to remember to
  // compare timestamps anywhere else.
  if (row.expires_at_ms <= now) return null;
  return cooldownFromRow(row);
}

export function listKeyCooldowns(now = Date.now()): Array<KeyCooldown & { active: boolean }> {
  const rows = getDb().prepare('SELECT * FROM key_cooldowns ORDER BY expires_at_ms DESC').all() as
    Parameters<typeof cooldownFromRow>[0][];
  // Clean up expired rows lazily: they are cheap to drop and the list is the
  // only place they would collect.
  const expired = rows.filter(r => r.expires_at_ms <= now);
  for (const row of expired) getDb().prepare('DELETE FROM key_cooldowns WHERE key_id = ?').run(row.key_id);
  return rows
    .filter(r => r.expires_at_ms > now)
    .map(row => ({ ...cooldownFromRow(row), active: true }));
}

/** A 429 with a Retry-After is the provider promising the reset time; trust it
 *  as the cooldown's expiry and remember why, so the dashboard can show it. */
export function retryAfterCooldown(keyId: number, retryAfterMs: number | null | undefined, now = Date.now()): boolean {
  const ms = Number(retryAfterMs);
  if (!Number.isFinite(ms) || ms <= 0) return false;
  setKeyCooldown(
    keyId,
    { reason: 'rate_limited', note: '429 with Retry-After', source: 'retry_after', expiresAtMs: now + ms },
    now,
  );
  return true;
}

/** Test hook. */
export function resetKeyLimitState(): void {
  // State is all in the DB; the in-memory TTLs are read fresh each call.
}