/**
 * Penalty cooldown with exponential growth [fork 8/10].
 *
 * `max_consecutive_upstream_fails` stops ONE request; a key whose provider is
 * timing out or stalling every call used to look no different from a healthy one
 * to the router an instant later — the next request hit the same dead edge, paid
 * the same failover budget, and only the request that carried it learned it was
 * sick. This module gives a key a MEMORY between requests:
 *
 *   - a failure streak counts only real edge failures (timeout, stream stall,
 *     transport error). A 429 is explicitly NOT a failure: rate limiting is a
 *     quota fact handled by the cooldown ladder, not evidence the key is broke.
 *   - once the streak reaches the threshold the key is penalized: skipped by
 *     the router for a duration that GROWS each time the streak is re-tripped
 *     (30s → 2min → 10min → ceiling), so a sick key stops soaking every Nth
 *     request and the failover budget it carries.
 *   - the penalty expires on its own; the first request after that is the trial.
 *     A success resets the streak AND the growth step; a failure re-penalizes at
 *     the next-longer step. The key is never permanently out — the router just
 *     stops preferring it while it is provably failing.
 *
 * Parameters are runtime-tunable through the settings table (`penalty_streak_*`)
 * so a provider-specific tune does not need a release. State is in-memory per
 * process (one node process on the phone), like the cooldown ladders; a restart
 * resets it, which is fine — the first failures after a restart re-establish it.
 */
import { getSetting } from '../db/index.js';
import { isTimeoutErrorText, isTransportError, isClientAbortError, isHedgeAbortError, isRateLimitSignal } from '../lib/error-classify.js';

/** Runtime knobs. Read fresh on every call so a change applies without restart. */
export const PENALTY_STREAK_THRESHOLD_KEY = 'penalty_streak_threshold';
export const PENALTY_STEPS_KEY = 'penalty_steps_ms';
export const PENALTY_CEILING_KEY = 'penalty_ceiling_ms';

export const DEFAULT_STREAK_THRESHOLD = 3;
export const DEFAULT_STEPS_MS = [30_000, 120_000, 600_000]; // 30s, 2min, 10min
export const DEFAULT_CEILING_MS = 10 * 60_000;

export interface PenaltyState {
  keyId: number;
  streak: number;
  step: number;
  penalizedUntilMs: number | null;
  lastFailureMs: number | null;
  lastSuccessMs: number | null;
}

const state = new Map<number, PenaltyState>();

function readIntSetting(key: string, fallback: number): number {
  try {
    const raw = getSetting(key);
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  } catch {
    return fallback;
  }
}

function readSteps(): number[] {
  const fallback = DEFAULT_STEPS_MS;
  try {
    const raw = getSetting(PENALTY_STEPS_KEY);
    if (raw === undefined || raw.trim() === '') return fallback;
    const values = raw.split(',').map(part => Number(part.trim())).filter(Number.isFinite);
    // A negative value would re-arm the penalty in the past and re-trip forever.
    return values.length > 0 && values.every(value => value > 0) ? values : fallback;
  } catch {
    return fallback;
  }
}

function stepsForStreak(streak: number): number {
  const steps = readSteps();
  const ceiling = readIntSetting(PENALTY_CEILING_KEY, DEFAULT_CEILING_MS);
  const index = Math.max(0, Math.min(streak - 1, steps.length - 1));
  return Math.min(steps[index], ceiling);
}

function entryFor(keyId: number): PenaltyState {
  let entry = state.get(keyId);
  if (!entry) {
    entry = { keyId, streak: 0, step: 0, penalizedUntilMs: null, lastFailureMs: null, lastSuccessMs: null };
    state.set(keyId, entry);
  }
  return entry;
}

/** Is this error a REAL edge failure (counts toward the streak)? 429 is not. */
export function isStreakFailure(err: any): boolean {
  if (isClientAbortError(err) || isHedgeAbortError(err)) return false;
  if (isRateLimitSignal(err)) return false; // 429/402 quota: the cooldown ladder's job
  if (err?.status === 429) return false;
  return isTimeoutErrorText(err?.message) || isTransportError(err);
}

/** Record a failure; re-arm/penalize the key when the streak crosses the
 *  threshold. Returns true when the key just got (re-)penalized. */
export function recordKeyFailure(keyId: number, err: any, now = Date.now()): boolean {
  if (!isStreakFailure(err)) return false;
  const entry = entryFor(keyId);
  entry.streak += 1;
  entry.lastFailureMs = now;
  const threshold = readIntSetting(PENALTY_STREAK_THRESHOLD_KEY, DEFAULT_STREAK_THRESHOLD);
  if (entry.streak >= threshold) {
    // Exponential growth: each re-trip uses the next step (capped at the list).
    entry.step = Math.min(entry.step + 1, readSteps().length);
    const duration = stepsForStreak(entry.step);
    entry.penalizedUntilMs = now + duration;
    return true;
  }
  return false;
}

/** A success clears the streak AND the growth step: the key has proven itself
 *  again, so the next failure starts from scratch rather than inheriting an
 *  up-to-ceiling penalty for a single blip. */
export function recordKeySuccess(keyId: number, now = Date.now()): void {
  const entry = state.get(keyId);
  if (!entry) return;
  entry.streak = 0;
  entry.step = 0;
  entry.penalizedUntilMs = null;
  entry.lastSuccessMs = now;
}

/** The router's gate: should this key be skipped right now? */
export function isKeyPenalized(keyId: number, now = Date.now()): boolean {
  const entry = state.get(keyId);
  return entry != null && entry.penalizedUntilMs != null && entry.penalizedUntilMs > now;
}

/** When the current penalty lapses (ms), or null. For the exhaustion diagnostic
 *  and the UI "returns at …". */
export function penaltyLapseMs(keyId: number, now = Date.now()): number | null {
  const entry = state.get(keyId);
  if (!entry || entry.penalizedUntilMs == null || entry.penalizedUntilMs <= now) return null;
  return entry.penalizedUntilMs;
}

/** Penalized now or recently penalized (the "in penalty" UI row). */
export function penaltySnapshot(keyId: number, now = Date.now()): PenaltyState | null {
  const entry = state.get(keyId);
  if (!entry) return null;
  if (entry.penalizedUntilMs == null && entry.streak === 0) return null;
  return { ...entry };
}

export function allPenaltySnapshots(now = Date.now()): PenaltyState[] {
  return [...state.values()]
    .filter(entry => entry.penalizedUntilMs != null || entry.streak > 0)
    .map(entry => ({ ...entry }))
    .sort((a, b) => a.keyId - b.keyId);
}

/** Operator override: clear the penalty and streak early (the UI's "unpark"). */
export function clearKeyPenalty(keyId: number): boolean {
  return state.delete(keyId);
}

/** Test hook. */
export function resetPenaltyState(): void {
  state.clear();
}