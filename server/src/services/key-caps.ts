/*!
 * Windowed caps [fork 4/10].
 *
 * Generalises the legacy UTC-month budget (services/key-budget.ts) to any window:
 * hour / day / week / month, in requests or tokens, with a calendar reset (in a
 * chosen timezone, optionally on a custom billing day/hour) or a sliding window,
 * a soft threshold that demotes instead of cutting the key, and an optional
 * model filter. A cap can be key-scoped or account-scoped, where several keys
 * sharing `api_keys.account_key` draw from ONE budget — the OpenRouter-style
 * per-account limit.
 *
 * Usage is read from `requests` (status='success') inside the cap's current
 * window. A SQLite trigger is not possible here: the window a request belongs to
 * depends on the cap's reset type, timezone and billing day, which are data, not
 * schema. In-flight requests are accounted through the same reservation pattern
 * key-budget uses, so admission decisions cannot be raced by parallel streams.
 *
 * Legacy monthly caps (`monthly_request_cap` / `monthly_token_cap`) are untouched:
 * they stay the UTC-calendar-month caps and keep working as before.
 */
import { getDb } from '../db/index.js';

export type CapWindow = 'hour' | 'day' | 'week' | 'month';
export type CapUnit = 'requests' | 'tokens';
export type CapResetType = 'calendar' | 'sliding';

export const CAP_WINDOWS: CapWindow[] = ['hour', 'day', 'week', 'month'];
export const CAP_UNITS: CapUnit[] = ['requests', 'tokens'];
/** Matches a fixed billing date to a safe day-of-month range (Feb-safe). */
export const CAP_RESET_DAY_MIN = 1;
export const CAP_RESET_DAY_MAX = 28;
export const DEFAULT_SOFT_PERCENT = 80;

export interface KeyCapRow {
  id: number;
  key_id: number | null;
  account_key: string | null;
  model_id: string | null;
  window: CapWindow;
  unit: CapUnit;
  cap: number;
  reset_type: CapResetType;
  timezone: string;
  reset_hour: number;
  reset_day_of_month: number | null;
  soft_percent: number;
  enabled: number;
}

export type CapVerdict =
  | { allowed: true }
  | { allowed: false; reason: 'cap_requests' | 'cap_tokens'; retryAfterSec: number };

export interface CapStatus {
  id: number;
  scope: 'key' | 'account' | 'model';
  accountKey: string | null;
  modelId: string | null;
  window: CapWindow;
  unit: CapUnit;
  cap: number;
  used: number;
  softPercent: number;
  softReached: boolean;
  hardReached: boolean;
  /** Epoch ms of the next reset. */
  resetAt: number;
  resetType: CapResetType;
  timezone: string;
  resetHour: number;
  resetDayOfMonth: number | null;
}

interface UsageRow { requests: number; tokens: number }

const WINDOW_MS: Record<CapWindow, number> = {
  hour: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
};

interface Reservation { capId: number; tokens: number; requests: number }
// Process-local, like key-budget's reservations: released when the request's
// route is released. A restarted process has no in-flight requests.
const reservations = new WeakMap<ReturnType<typeof getDb>, Map<number, Reservation>>();

function activeReservations(): Map<number, Reservation> {
  const db = getDb();
  let active = reservations.get(db);
  if (!active) { active = new Map(); reservations.set(db, active); }
  return active;
}

/** Test hook: drop every in-flight reservation. */
export function resetCapReservations(): void {
  const db = getDb();
  reservations.delete(db);
}

// ── Timezone helpers ────────────────────────────────────────────────────────
// SQLite has no timezone math, and the reset moment is data (a cap carries its
// own timezone), so this is done in JS through Intl. Two instants are enough:
// decompose a Date into wall-clock parts for the zone, then re-anchor those parts
// as if they were UTC and correct by the zone's offset at that instant.

function zonedParts(date: Date, timeZone: string): {
  year: number; month: number; day: number;
  hour: number; minute: number; second: number;
} {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  });
  const parts: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function zonedEpoch(
  year: number, month: number, day: number,
  hour: number, minute: number, second: number,
  timeZone: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const parts = zonedParts(new Date(guess), timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return guess - (asUtc - guess);
}

function zonedDayOfWeek(date: Date, timeZone: string): number {
  // 0 = Sunday … 6 = Saturday, computed from the zone's own wall clock.
  const parts = zonedParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0);
  return new Date(asUtc).getUTCDay();
}

function addDays(year: number, month: number, day: number, days: number): { year: number; month: number; day: number } {
  const shifted = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

function safeTimezone(timeZone: string | null | undefined): string {
  const candidate = (timeZone ?? 'UTC').trim() || 'UTC';
  try {
    // Throws RangeError for an unknown zone.
    new Intl.DateTimeFormat('en-US', { timeZone: candidate });
    return candidate;
  } catch {
    return 'UTC';
  }
}

/**
 * The cap's current window: `start`/`end` bound the usage query, `resetAt` is the
 * instant the counter rolls over (calendar windows only; a sliding window rolls
 * continuously, so `resetAt` is when the oldest counted request expires).
 */
export function capWindowSpan(cap: KeyCapRow, now = Date.now()): { start: number; end: number; resetAt: number } {
  if (cap.reset_type === 'sliding') {
    const width = WINDOW_MS[cap.window];
    return { start: now - width, end: now, resetAt: now + width };
  }

  const timeZone = safeTimezone(cap.timezone);
  const parts = zonedParts(new Date(now), timeZone);
  const hour = cap.reset_hour;
  let start: number;

  if (cap.window === 'hour') {
    start = zonedEpoch(parts.year, parts.month, parts.day, parts.hour, 0, 0, timeZone);
  } else if (cap.window === 'day') {
    start = zonedEpoch(parts.year, parts.month, parts.day, hour, 0, 0, timeZone);
    if (start > now) {
      const previous = addDays(parts.year, parts.month, parts.day, -1);
      start = zonedEpoch(previous.year, previous.month, previous.day, hour, 0, 0, timeZone);
    }
  } else if (cap.window === 'week') {
    // Monday 00:00 in the cap's zone.
    const dow = zonedDayOfWeek(new Date(now), timeZone);
    const monday = addDays(parts.year, parts.month, parts.day, -(dow === 0 ? 6 : dow - 1));
    start = zonedEpoch(monday.year, monday.month, monday.day, hour, 0, 0, timeZone);
    if (start > now) {
      const previous = addDays(monday.year, monday.month, monday.day, -7);
      start = zonedEpoch(previous.year, previous.month, previous.day, hour, 0, 0, timeZone);
    }
  } else {
    const day = Math.min(CAP_RESET_DAY_MAX, Math.max(CAP_RESET_DAY_MIN, cap.reset_day_of_month ?? 1));
    start = zonedEpoch(parts.year, parts.month, day, hour, 0, 0, timeZone);
    if (start > now) {
      const previousMonth = new Date(Date.UTC(parts.year, parts.month - 2, 1, 12, 0, 0));
      start = zonedEpoch(
        previousMonth.getUTCFullYear(), previousMonth.getUTCMonth() + 1, day, hour, 0, 0, timeZone,
      );
    }
  }

  const end = start + WINDOW_MS[cap.window];
  return { start, end, resetAt: end };
}

// ── Caps resolution ──────────────────────────────────────────────────────────

interface KeyIdentity { id: number; account_key: string | null }

export function getCapsFor(keyId: number, db = getDb()): KeyCapRow[] {
  const key = db.prepare('SELECT id, account_key FROM api_keys WHERE id = ?').get(keyId) as KeyIdentity | undefined;
  if (!key) return [];
  const rows = key.account_key
    ? db.prepare(`
        SELECT * FROM key_caps
         WHERE enabled = 1 AND (key_id = ? OR account_key = ?)
         ORDER BY id
      `).all(keyId, key.account_key) as KeyCapRow[]
    : db.prepare(`
        SELECT * FROM key_caps
         WHERE enabled = 1 AND key_id = ?
         ORDER BY id
      `).all(keyId) as KeyCapRow[];
  return rows;
}

function dbToRow(row: Record<string, unknown>): KeyCapRow {
  return {
    id: row.id as number,
    key_id: (row.key_id as number | null) ?? null,
    account_key: (row.account_key as string | null) ?? null,
    model_id: (row.model_id as string | null) ?? null,
    window: row.window as CapWindow,
    unit: row.unit as CapUnit,
    cap: Number(row.cap),
    reset_type: row.reset_type as CapResetType,
    timezone: (row.timezone as string) || 'UTC',
    reset_hour: Number(row.reset_hour),
    reset_day_of_month: (row.reset_day_of_month as number | null) ?? null,
    soft_percent: Number(row.soft_percent),
    enabled: Number(row.enabled),
  };
}

export function listCaps(filter: { keyId?: number; accountKey?: string } = {}, db = getDb()): KeyCapRow[] {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (filter.keyId !== undefined) { clauses.push('key_id = ?'); values.push(filter.keyId); }
  if (filter.accountKey !== undefined) { clauses.push('account_key = ?'); values.push(filter.accountKey); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return (db.prepare(`SELECT * FROM key_caps ${where} ORDER BY id`).all(...values) as Record<string, unknown>[])
    .map(dbToRow);
}

export interface CapInput {
  keyId?: number | null;
  accountKey?: string | null;
  modelId?: string | null;
  window: CapWindow;
  unit: CapUnit;
  cap: number;
  resetType?: CapResetType;
  timezone?: string;
  resetHour?: number;
  resetDayOfMonth?: number | null;
  softPercent?: number;
}

function validateCap(input: CapInput): string | null {
  // Defaults are materialized so every stored row is complete and each
  // branch can assert on a known type.
  // `??` after Number() would not default: Number(undefined) is NaN, which is
  // neither null nor undefined. Default first, then coerce.
  const resetType: CapResetType = input.resetType ?? 'calendar';
  const timezone = safeTimezone(input.timezone);   // throws on an unknown zone
  const resetHour: number = input.resetHour ?? 0;
  const resetDayOfMonth: number | null = input.resetDayOfMonth ?? null;
  const softPercent: number = input.softPercent ?? DEFAULT_SOFT_PERCENT;
  if (!CAP_WINDOWS.includes(input.window)) return `unknown window ${input.window}`;
  if (!CAP_UNITS.includes(input.unit)) return `unknown unit ${input.unit}`;
  if (!Number.isInteger(input.cap) || input.cap <= 0) return 'cap must be a positive integer';
  if (input.keyId == null && !input.accountKey) return 'a cap needs a key_id or an account_key';
  if (input.keyId != null && input.accountKey) return 'a cap is either key-scoped or account-scoped';
  if (!Number.isInteger(softPercent) || softPercent < 0 || softPercent > 100) {
    return 'softPercent must be an integer 0..100';
  }
  if (!Number.isInteger(resetHour) || resetHour < 0 || resetHour > 23) {
    return 'resetHour must be an integer 0..23';
  }
  if (resetDayOfMonth !== null && (!Number.isInteger(resetDayOfMonth)
      || resetDayOfMonth < CAP_RESET_DAY_MIN
      || resetDayOfMonth > CAP_RESET_DAY_MAX)) {
    return `resetDayOfMonth must be ${CAP_RESET_DAY_MIN}..${CAP_RESET_DAY_MAX}`;
  }
  if (resetType !== 'calendar' && resetType !== 'sliding') {
    return `unknown resetType ${resetType}`;
  }
  return null;
}

export function createCap(input: CapInput, db = getDb()): KeyCapRow {
  const problem = validateCap(input);
  if (problem) throw new Error(problem);
  const resetType: CapResetType = input.resetType ?? 'calendar';
  const timezone = safeTimezone(input.timezone);
  const resetHour: number = input.resetHour ?? 0;
  const resetDayOfMonth: number | null = input.resetDayOfMonth ?? null;
  const softPercent: number = input.softPercent ?? DEFAULT_SOFT_PERCENT;
  const info = db.prepare(`
    INSERT INTO key_caps
      (key_id, account_key, model_id, window, unit, cap, reset_type, timezone,
       reset_hour, reset_day_of_month, soft_percent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.keyId ?? null,
    input.accountKey ?? null,
    input.modelId ?? null,
    input.window,
    input.unit,
    input.cap,
    resetType,
    timezone,
    resetHour,
    resetDayOfMonth,
    softPercent,
  );
  const row = db.prepare('SELECT * FROM key_caps WHERE id = ?').get(info.lastInsertRowid) as Record<string, unknown>;
  return dbToRow(row);
}

export function updateCap(id: number, patch: Partial<CapInput>, db = getDb()): KeyCapRow | null {
  const existing = db.prepare('SELECT * FROM key_caps WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!existing) return null;
  const merged: CapInput = {
    keyId: (existing.key_id as number | null) ?? undefined,
    accountKey: (existing.account_key as string | null) ?? undefined,
    modelId: (existing.model_id as string | null) ?? undefined,
    window: existing.window as CapWindow,
    unit: existing.unit as CapUnit,
    cap: Number(existing.cap),
    resetType: existing.reset_type as CapResetType,
    timezone: existing.timezone as string,
    resetHour: Number(existing.reset_hour),
    resetDayOfMonth: (existing.reset_day_of_month as number | null) ?? undefined,
    softPercent: Number(existing.soft_percent),
    ...patch,
  };
  const problem = validateCap(merged);
  if (problem) throw new Error(problem);
  db.prepare(`
    UPDATE key_caps
       SET account_key = ?, model_id = ?, window = ?, unit = ?, cap = ?, reset_type = ?,
           timezone = ?, reset_hour = ?, reset_day_of_month = ?, soft_percent = ?,
           updated_at = datetime('now')
     WHERE id = ?
  `).run(
    merged.accountKey ?? null,
    merged.modelId ?? null,
    merged.window,
    merged.unit,
    merged.cap,
    merged.resetType ?? 'calendar',
    safeTimezone(merged.timezone),
    merged.resetHour ?? 0,
    merged.resetDayOfMonth ?? null,
    merged.softPercent ?? DEFAULT_SOFT_PERCENT,
    id,
  );
  const row = db.prepare('SELECT * FROM key_caps WHERE id = ?').get(id) as Record<string, unknown>;
  return dbToRow(row);
}

export function deleteCap(id: number, db = getDb()): boolean {
  return db.prepare('DELETE FROM key_caps WHERE id = ?').run(id).changes > 0;
}

export function setKeyAccount(keyId: number, accountKey: string | null, db = getDb()): boolean {
  const value = accountKey?.trim() ? accountKey.trim() : null;
  return db.prepare('UPDATE api_keys SET account_key = ? WHERE id = ?').run(value, keyId).changes > 0;
}

export function getKeyAccount(keyId: number, db = getDb()): string | null {
  const row = db.prepare('SELECT account_key FROM api_keys WHERE id = ?').get(keyId) as { account_key: string | null } | undefined;
  return row?.account_key ?? null;
}

// ── Usage ────────────────────────────────────────────────────────────────────

/** requests.created_at is 'YYYY-MM-DD HH:MM:SS' UTC — match that format exactly. */
function toSqliteTimestamp(epochMs: number): string {
  return new Date(epochMs).toISOString().replace('T', ' ').slice(0, 19);
}

function readUsage(cap: KeyCapRow, startMs: number, endMs: number, db = getDb()): UsageRow {
  const clauses: string[] = ["status = 'success'", 'created_at >= ?', 'created_at < ?'];
  const values: unknown[] = [toSqliteTimestamp(startMs), toSqliteTimestamp(endMs)];
  if (cap.key_id != null) {
    clauses.push('key_id = ?');
    values.push(cap.key_id);
  } else if (cap.account_key) {
    clauses.push("key_id IN (SELECT id FROM api_keys WHERE account_key = ?)");
    values.push(cap.account_key);
  }
  if (cap.model_id) {
    clauses.push('model_id = ?');
    values.push(cap.model_id);
  }
  const row = db.prepare(`
    SELECT COUNT(*) AS requests, COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens
      FROM requests
     WHERE ${clauses.join(' AND ')}
  `).get(...values) as { requests: number; tokens: number };
  return { requests: Number(row.requests), tokens: Number(row.tokens) };
}

function reservedFor(capId: number): Reservation {
  const active = activeReservations();
  let reservation = active.get(capId);
  if (!reservation) {
    reservation = { capId, tokens: 0, requests: 0 };
    active.set(capId, reservation);
  }
  return reservation;
}

function capUsed(cap: KeyCapRow, now: number, db: ReturnType<typeof getDb>): { used: number; requests: number; tokens: number; resetAt: number } {
  const { start, end, resetAt } = capWindowSpan(cap, now);
  const usage = readUsage(cap, start, Math.min(end, now), db);
  const reservation = activeReservations().get(cap.id);
  const requests = usage.requests + (reservation?.requests ?? 0);
  const tokens = usage.tokens + (reservation?.tokens ?? 0);
  return {
    used: cap.unit === 'requests' ? requests : tokens,
    requests,
    tokens,
    resetAt,
  };
}

/**
 * Hard gate: a cap whose current usage reached its limit removes the key from
 * rotation. `retryAfterSec` is the time until that window resets, so the caller
 * can surface a real Retry-After instead of a bare 429.
 */
export function checkKeyCaps(
  keyId: number,
  options: { estimatedTokens?: number; modelId?: string | null; now?: number } = {},
  db = getDb(),
): CapVerdict {
  const caps = getCapsFor(keyId, db);
  if (caps.length === 0) return { allowed: true };
  const now = options.now ?? Date.now();
  const estimated = Math.max(0, Math.floor(options.estimatedTokens ?? 0));

  for (const cap of caps) {
    if (cap.model_id && options.modelId && cap.model_id !== options.modelId) continue;
    const { used, resetAt } = capUsed(cap, now, db);
    // A cap of N admits N units: the request is rejected only once the window
    // is already spent (used + this request > cap).
    const projected = cap.unit === 'requests' ? used + 1 : used + estimated;
    if (projected > cap.cap) {
      return {
        allowed: false,
        reason: cap.unit === 'requests' ? 'cap_requests' : 'cap_tokens',
        retryAfterSec: Math.max(1, Math.ceil((resetAt - now) / 1000)),
      };
    }
  }
  return { allowed: true };
}

/** Reserve the caps this request will spend against; release on every terminal path. */
export function reserveKeyCaps(
  keyId: number,
  options: { estimatedTokens?: number; modelId?: string | null; now?: number } = {},
  db = getDb(),
): { allowed: true; release: () => void } | Extract<CapVerdict, { allowed: false }> {
  const verdict = checkKeyCaps(keyId, options, db);
  if (!verdict.allowed) return verdict;
  const now = options.now ?? Date.now();
  const estimated = Math.max(0, Math.floor(options.estimatedTokens ?? 0));
  const touched: Reservation[] = [];
  for (const cap of getCapsFor(keyId, db)) {
    if (cap.model_id && options.modelId && cap.model_id !== options.modelId) continue;
    if (cap.cap <= 0) continue;
    // Re-check after this reservation: a burst of parallel streams must not all
    // slip past the cap on the same tick.
    const { used } = capUsed(cap, now, db);
    const projected = cap.unit === 'requests' ? used + 1 : used + estimated;
    if (projected > cap.cap) {
      for (const reservation of touched) { reservation.tokens = 0; reservation.requests = 0; }
      return {
        allowed: false,
        reason: cap.unit === 'requests' ? 'cap_requests' : 'cap_tokens',
        retryAfterSec: Math.max(1, Math.ceil((capWindowSpan(cap, now).resetAt - now) / 1000)),
      };
    }
    const reservation = reservedFor(cap.id);
    reservation.requests += 1;
    reservation.tokens += estimated;
    touched.push(reservation);
  }
  return {
    allowed: true,
    release: () => {
      for (const reservation of touched) { reservation.tokens = 0; reservation.requests = 0; }
    },
  };
}

/**
 * Soft pressure: the cap is past `soft_percent` but under its hard limit. The key
 * stays eligible and is simply demoted (router prefers a cleaner key).
 */
export function capSoftPressures(
  keyId: number,
  options: { modelId?: string | null; now?: number } = {},
  db = getDb(),
): CapStatus[] {
  const now = options.now ?? Date.now();
  const out: CapStatus[] = [];
  for (const cap of getCapsFor(keyId, db)) {
    if (cap.model_id && options.modelId && cap.model_id !== options.modelId) continue;
    const { used, resetAt } = capUsed(cap, now, db);
    const softAt = Math.ceil((cap.soft_percent / 100) * cap.cap);
    if (used >= softAt && used < cap.cap) {
      out.push(statusFor(cap, used, resetAt, now));
    }
  }
  return out;
}

export function isCapSoftPressured(
  keyId: number,
  modelId?: string | null,
  now = Date.now(),
  db = getDb(),
): boolean {
  return capSoftPressures(keyId, { modelId, now }, db).length > 0;
}

function statusFor(cap: KeyCapRow, used: number, resetAt: number, now: number): CapStatus {
  const softAt = Math.ceil((cap.soft_percent / 100) * cap.cap);
  return {
    id: cap.id,
    scope: cap.model_id ? 'model' : cap.account_key ? 'account' : 'key',
    accountKey: cap.account_key,
    modelId: cap.model_id,
    window: cap.window,
    unit: cap.unit,
    cap: cap.cap,
    used,
    softPercent: cap.soft_percent,
    softReached: used >= softAt,
    hardReached: used >= cap.cap,
    resetAt,
    resetType: cap.reset_type,
    timezone: cap.timezone,
    resetHour: cap.reset_hour,
    resetDayOfMonth: cap.reset_day_of_month,
  };
}

/** Everything the key page needs: one row per cap, with live usage and reset. */
export function getKeyCapSummary(
  keyId: number,
  options: { now?: number } = {},
  db = getDb(),
): { keyId: number; accountKey: string | null; caps: CapStatus[] } {
  const now = options.now ?? Date.now();
  const caps = getCapsFor(keyId, db).map(cap => {
    const { used, resetAt } = capUsed(cap, now, db);
    return statusFor(cap, used, resetAt, now);
  });
  return { keyId, accountKey: getKeyAccount(keyId, db), caps };
}

/** Account-wide view: caps shared by every key with the same account_key. */
export function getAccountCapSummary(accountKey: string, options: { now?: number } = {}, db = getDb()): {
  accountKey: string;
  keyIds: number[];
  caps: CapStatus[];
} {
  const now = options.now ?? Date.now();
  const keyIds = (db.prepare('SELECT id FROM api_keys WHERE account_key = ? ORDER BY id').all(accountKey) as { id: number }[])
    .map(row => row.id);
  const caps = (db.prepare(`
    SELECT * FROM key_caps WHERE enabled = 1 AND account_key = ? ORDER BY id
  `).all(accountKey) as Record<string, unknown>[]).map(row => {
    const cap = dbToRow(row);
    const { used, resetAt } = capUsed(cap, now, db);
    return statusFor(cap, used, resetAt, now);
  });
  return { accountKey, keyIds, caps };
}
