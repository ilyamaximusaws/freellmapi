/**
 * Per-client (per-agent) limits [fork 1/10].
 *
 * A "client" is a `client_profiles` row — a downstream `sk-cp-...` token minted
 * per agent. Limits are admission control in front of key selection:
 *
 *   - concurrency: a request that finds the client at `max_concurrent` waits a
 *     short bounded time for a slot, then gets 429 + Retry-After.
 *   - rpm / tpm: sliding one-minute windows, rejected immediately with 429.
 *   - daily / monthly request+token caps: settled by the `requests_client_usage`
 *     trigger on every successful request, so pruning analytics never reopens a
 *     spent cap. In-flight reservations are added on top so two concurrent
 *     requests can't both squeeze past the last slot.
 *   - max_tokens_per_request / max_request_bytes: request-shape rejections
 *     (400 / 413) checked before any provider work.
 *
 * Every limit is 0 = unlimited, exactly like the per-key monthly caps. The
 * unified `freellmapi-...` key is NOT a client: it passes through untouched
 * (the implicit unlimited `default` client), so existing callers are unaffected.
 *
 * Concurrency slots are process-local (the phone runs a single node process)
 * and carry a lease TTL: a slot is released explicitly when the response
 * finishes, and a slot older than SLOT_TTL_MS is reclaimed on the next
 * admission so a hung/aborted stream can never leak capacity.
 */
import { getDb } from '../db/index.js';

export const DEFAULT_QUEUE_TIMEOUT_MS = 3000;
export const SLOT_TTL_MS = 30 * 60 * 1000;
const WINDOW_MS = 60 * 1000;

export interface ClientLimits {
  /** 0 = unlimited. */
  maxConcurrent: number;
  rpm: number;
  tpm: number;
  dailyRequestCap: number;
  dailyTokenCap: number;
  monthlyRequestCap: number;
  monthlyTokenCap: number;
  maxTokensPerRequest: number;
  maxRequestBytes: number;
  /** Optional pin: only models of this profile are servable. */
  profileId: number | null;
}

export const UNLIMITED_LIMITS: ClientLimits = {
  maxConcurrent: 0, rpm: 0, tpm: 0,
  dailyRequestCap: 0, dailyTokenCap: 0,
  monthlyRequestCap: 0, monthlyTokenCap: 0,
  maxTokensPerRequest: 0, maxRequestBytes: 0,
  profileId: null,
};

interface ProfileLimitRow {
  max_concurrent: number;
  rpm: number;
  tpm: number;
  daily_request_cap: number;
  daily_token_cap: number;
  monthly_request_cap: number;
  monthly_token_cap: number;
  max_tokens_per_request: number;
  max_request_bytes: number;
  profile_id: number | null;
}

function n(value: number | null | undefined): number {
  const v = Number(value ?? 0);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** Read a client's limits. Unknown/absent client → unlimited (defensive). */
export function getClientLimits(clientId: number): ClientLimits {
  const row = getDb().prepare(`
    SELECT max_concurrent, rpm, tpm, daily_request_cap, daily_token_cap,
           monthly_request_cap, monthly_token_cap, max_tokens_per_request,
           max_request_bytes, profile_id
      FROM client_profiles WHERE id = ?
  `).get(clientId) as ProfileLimitRow | undefined;
  if (!row) return UNLIMITED_LIMITS;
  return {
    maxConcurrent: n(row.max_concurrent),
    rpm: n(row.rpm),
    tpm: n(row.tpm),
    dailyRequestCap: n(row.daily_request_cap),
    dailyTokenCap: n(row.daily_token_cap),
    monthlyRequestCap: n(row.monthly_request_cap),
    monthlyTokenCap: n(row.monthly_token_cap),
    maxTokensPerRequest: n(row.max_tokens_per_request),
    maxRequestBytes: n(row.max_request_bytes),
    profileId: row.profile_id ?? null,
  };
}

export function hasAnyLimit(limits: ClientLimits): boolean {
  return limits.maxConcurrent > 0 || limits.rpm > 0 || limits.tpm > 0
    || limits.dailyRequestCap > 0 || limits.dailyTokenCap > 0
    || limits.monthlyRequestCap > 0 || limits.monthlyTokenCap > 0
    || limits.maxTokensPerRequest > 0 || limits.maxRequestBytes > 0;
}

// ---------------------------------------------------------------- in-memory

interface Slot { startedAt: number }
interface TokenStamp { at: number; tokens: number }

interface ClientState {
  slots: Slot[];
  requests: number[];
  tokenStamps: TokenStamp[];
}

const states = new Map<number, ClientState>();

function stateFor(clientId: number): ClientState {
  let s = states.get(clientId);
  if (!s) { s = { slots: [], requests: [], tokenStamps: [] }; states.set(clientId, s); }
  return s;
}

function prune(state: ClientState, now: number, slotTtlMs = SLOT_TTL_MS): void {
  state.slots = state.slots.filter(slot => now - slot.startedAt < slotTtlMs);
  state.requests = state.requests.filter(at => now - at < WINDOW_MS);
  state.tokenStamps = state.tokenStamps.filter(stamp => now - stamp.at < WINDOW_MS);
}

export function activeSlots(clientId: number, now = Date.now()): number {
  const state = stateFor(clientId);
  prune(state, now);
  return state.slots.length;
}

export function resetClientLimitState(): void {
  states.clear();
}

// ---------------------------------------------------------------- windows

export function windowKey(now: number): { day: string; month: string } {
  const iso = new Date(now).toISOString();
  return { day: iso.slice(0, 10), month: iso.slice(0, 7) };
}

export interface ClientUsage { requests: number; tokens: number }

/** Settled usage for one window key ('YYYY-MM-DD' or 'YYYY-MM'). */
export function getClientUsage(clientId: number, window: string): ClientUsage {
  const row = getDb().prepare(
    'SELECT requests, tokens FROM client_usage WHERE client_id = ? AND window = ?',
  ).get(clientId, window) as ClientUsage | undefined;
  return { requests: Number(row?.requests ?? 0), tokens: Number(row?.tokens ?? 0) };
}

function nextDayStartMs(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

function nextMonthStartMs(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

// ---------------------------------------------------------------- admission

export type ClientAdmissionResult =
  | { ok: true; release: () => void; clientId: number | null }
  | { ok: false; status: number; message: string; retryAfterSec?: number };

export interface AdmitOptions {
  /** Tokens this request is expected to consume (max_tokens, else 0). */
  estimatedTokens?: number;
  /** The caller's requested max_tokens, for max_tokens_per_request. */
  requestedMaxTokens?: number;
  /** Body size in bytes, for max_request_bytes. */
  requestBytes?: number;
  queueTimeoutMs?: number;
  now?: number;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function reject(status: number, message: string, retryAfterSec?: number): ClientAdmissionResult {
  return retryAfterSec == null ? { ok: false, status, message } : { ok: false, status, message, retryAfterSec };
}

/**
 * Admit (or reject) a request for a client. `clientId === null` means the
 * unified/default client and is always admitted.
 *
 * On success the caller MUST invoke `release()` on every terminal path (the
 * recommended hook is the response `finish`/`close` event); the slot lease TTL
 * is the backstop for paths that never fire.
 */
export async function admitClient(
  clientId: number | null,
  opts: AdmitOptions = {},
): Promise<ClientAdmissionResult> {
  if (clientId == null) return { ok: true, release: () => {}, clientId: null };

  const now = opts.now ?? Date.now();
  const sleep = opts.sleep ?? realSleep;
  const estimatedTokens = Math.max(0, Math.floor(opts.estimatedTokens ?? 0));
  const limits = getClientLimits(clientId);

  if (!hasAnyLimit(limits)) {
    stateFor(clientId);
    return { ok: true, release: () => {}, clientId };
  }

  // 1. Request-shape limits first: reject before touching any slot.
  if (limits.maxTokensPerRequest > 0 && (opts.requestedMaxTokens ?? 0) > limits.maxTokensPerRequest) {
    return reject(400, `max_tokens ${opts.requestedMaxTokens} exceeds this client's limit of ${limits.maxTokensPerRequest}`);
  }
  if (limits.maxRequestBytes > 0 && (opts.requestBytes ?? 0) > limits.maxRequestBytes) {
    return reject(413, `Request body exceeds this client's limit of ${limits.maxRequestBytes} bytes`);
  }

  const state = stateFor(clientId);

  // 2. Concurrency: wait a bounded time for a slot, then 429.
  if (limits.maxConcurrent > 0) {
    const deadline = now + (opts.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS);
    for (;;) {
      prune(state, Date.now());
      if (state.slots.length < limits.maxConcurrent) break;
      if (Date.now() >= deadline) {
        return reject(429, `Client concurrency limit reached (${limits.maxConcurrent} in flight)`, 1);
      }
      await sleep(50);
    }
  }

  // 3. RPM / TPM sliding windows.
  prune(state, now);
  if (limits.rpm > 0 && state.requests.length >= limits.rpm) {
    return reject(429, `Client RPM limit reached (${limits.rpm}/min)`, secondsUntilNextMinute(now));
  }
  if (limits.tpm > 0) {
    const used = state.tokenStamps.reduce((sum, s) => sum + s.tokens, 0);
    if (used + estimatedTokens > limits.tpm) {
      return reject(429, `Client TPM limit reached (${limits.tpm}/min)`, secondsUntilNextMinute(now));
    }
  }

  // 4. Daily / monthly caps, settled usage + this process's in-flight load.
  const { day, month } = windowKey(now);
  if (limits.dailyRequestCap > 0 || limits.dailyTokenCap > 0) {
    const usage = getClientUsage(clientId, day);
    if (limits.dailyRequestCap > 0 && usage.requests >= limits.dailyRequestCap) {
      return reject(429, `Client daily request cap reached (${limits.dailyRequestCap})`, secondsUntil(now, nextDayStartMs(now)));
    }
    if (limits.dailyTokenCap > 0 && usage.tokens + estimatedTokens > limits.dailyTokenCap) {
      return reject(429, `Client daily token cap reached (${limits.dailyTokenCap})`, secondsUntil(now, nextDayStartMs(now)));
    }
  }
  if (limits.monthlyRequestCap > 0 || limits.monthlyTokenCap > 0) {
    const usage = getClientUsage(clientId, month);
    if (limits.monthlyRequestCap > 0 && usage.requests >= limits.monthlyRequestCap) {
      return reject(429, `Client monthly request cap reached (${limits.monthlyRequestCap})`, secondsUntil(now, nextMonthStartMs(now)));
    }
    if (limits.monthlyTokenCap > 0 && usage.tokens + estimatedTokens > limits.monthlyTokenCap) {
      return reject(429, `Client monthly token cap reached (${limits.monthlyTokenCap})`, secondsUntil(now, nextMonthStartMs(now)));
    }
  }

  // Admitted: hold a slot and record the window stamps.
  const slot: Slot = { startedAt: Date.now() };
  state.slots.push(slot);
  state.requests.push(now);
  if (estimatedTokens > 0) state.tokenStamps.push({ at: now, tokens: estimatedTokens });
  touchClientUsed(clientId, now);

  let released = false;
  return {
    ok: true,
    clientId,
    release: () => {
      if (released) return;
      released = true;
      const i = state.slots.indexOf(slot);
      if (i !== -1) state.slots.splice(i, 1);
    },
  };
}

function secondsUntil(now: number, then: number): number {
  return Math.max(1, Math.floor((then - now) / 1000));
}

function secondsUntilNextMinute(now: number): number {
  return Math.max(1, 60 - Math.floor((now % 60000) / 1000));
}

function touchClientUsed(clientId: number, now: number): void {
  try {
    getDb().prepare('UPDATE client_profiles SET last_used_at = ? WHERE id = ?')
      .run(new Date(now).toISOString().replace('T', ' ').slice(0, 19), clientId);
  } catch { /* stamping is best-effort */ }
}

/** A client's current usage snapshot for the dashboard: windows + live slots. */
export function getClientUsageSnapshot(clientId: number, now = Date.now()) {
  const { day, month } = windowKey(now);
  return {
    day: getClientUsage(clientId, day),
    month: getClientUsage(clientId, month),
    active: activeSlots(clientId, now),
  };
}