// Runtime-tunable numeric settings ([fork 3/10]).
//
// One precedence rule for every router/health knob that used to be env-only:
//
//   1. the value stored in the settings table (set from the UI or the API)
//   2. the environment variable
//   3. the built-in default
//
// Values are read per call, never cached, so a change applies to the next
// request without a restart. The resolver also reports WHERE the value came
// from, which is what the dashboard shows next to each field ("set here" vs
// "from env" vs "default") — an operator otherwise cannot tell whether the
// number on screen is actually in force.
//
// Invalid or empty values at any level are skipped rather than clamped, so a
// typo in the DB cannot silently pin a knob to 0.
import { getSetting } from '../db/index.js';

export type SettingSource = 'db' | 'env' | 'default';

export interface ResolvedIntSetting {
  value: number;
  source: SettingSource;
  /** Present when an env fallback exists, whether or not it is in use. */
  envVar?: string;
  /** The raw env value when one is set (even if the DB value wins). */
  envValue?: string;
  defaultValue: number;
}

export interface IntSettingSpec {
  /** settings-table key. */
  key: string;
  /** Environment variable consulted when the DB has no valid value. */
  envVar?: string;
  defaultValue: number;
  /** Values below this are rejected (default 0, i.e. only non-negatives). */
  min?: number;
  /** Values above this are rejected — guards against a paste of epoch millis. */
  max?: number;
}

function parse(value: string | undefined, min: number, max: number): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const n = Number(value.trim());
  if (!Number.isInteger(n) || n < min || n > max) return undefined;
  return n;
}

/** Resolve an integer setting with its source. */
export function resolveIntSetting(spec: IntSettingSpec): ResolvedIntSetting {
  const min = spec.min ?? 0;
  const max = spec.max ?? Number.MAX_SAFE_INTEGER;
  const envValue = spec.envVar === undefined ? undefined : process.env[spec.envVar];

  let stored: string | undefined;
  try {
    stored = getSetting(spec.key);
  } catch {
    stored = undefined; // DB not ready (tests, early boot) — never throw on the hot path
  }

  const fromDb = parse(stored, min, max);
  if (fromDb !== undefined) {
    return { value: fromDb, source: 'db', envVar: spec.envVar, envValue, defaultValue: spec.defaultValue };
  }
  const fromEnv = parse(envValue, min, max);
  if (fromEnv !== undefined) {
    return { value: fromEnv, source: 'env', envVar: spec.envVar, envValue, defaultValue: spec.defaultValue };
  }
  return { value: spec.defaultValue, source: 'default', envVar: spec.envVar, envValue, defaultValue: spec.defaultValue };
}

/** Just the value — the common call shape on hot paths. */
export function intSettingValue(spec: IntSettingSpec): number {
  return resolveIntSetting(spec).value;
}