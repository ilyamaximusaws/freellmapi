// Per-provider HTTP timeout overrides (issue #547, reworked from PR #509).
//
// PROVIDER_TIMEOUT_<PLATFORM>=<milliseconds> overrides the platform's built-in
// chat timeout (e.g. PROVIDER_TIMEOUT_NVIDIA=300000). 0 disables the timeout
// entirely. Values are read when the provider is constructed — for the built-in
// platforms that means process start, so a change requires a restart.
//
// PROVIDER_STREAM_STALL_TIMEOUT_MS is the streaming counterpart for the
// mid-stream inactivity watchdog (issue #553): how long an SSE stream may go
// without a single byte before the gateway gives up on it.
// PROVIDER_STREAM_STALL_TIMEOUT_<PLATFORM> (issue #584) overrides it for one
// platform; precedence is per-platform > global > built-in default.
//
// [fork 3/10] Both knobs are now runtime-tunable: each level is resolved
// settings-table → env → built-in default, and read per call, so a value set in
// the dashboard applies to the next request instead of the next restart. The
// global stall default is 30s (was 90s): a provider that has sent nothing for
// half a minute is dead for this request, and waiting the full 90s only burns
// the client's failover budget.
//
// The stall watchdog does NOT bound time-to-first-byte: the FIRST read of a
// stream gets a grace budget derived from the platform's chat timeout (the
// PROVIDER_TIMEOUT_<PLATFORM> knob above), floored at the stall budget — see
// BaseProvider.readSseStream. Before #584 the stall budget also bounded the
// first byte, which killed healthy long prefills (NVIDIA NIM sends SSE headers
// instantly, then prefills 100k-token prompts for minutes) at 90s.

import { getSetting } from '../db/index.js';
import { resolveIntSetting, type ResolvedIntSetting } from './runtime-setting.js';

const warned = new Set<string>();

function warnOnce(name: string, message: string): void {
  if (warned.has(name)) return;
  warned.add(name);
  console.warn(message);
}

function parseTimeoutEnv(name: string, defaultMs: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return defaultMs;
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed < 0) {
    warnOnce(name, `[config] Ignoring ${name}="${raw}": expected a non-negative integer of milliseconds (0 disables the timeout). Using the default ${defaultMs}ms.`);
    return defaultMs;
  }
  if (parsed > 0 && parsed < 1000) {
    warnOnce(name, `[config] ${name}=${parsed}ms is under a second; nearly every request to this provider will abort. Was this meant to be seconds?`);
  }
  return parsed;
}

export function providerTimeoutEnvName(platform: string): string {
  return `PROVIDER_TIMEOUT_${platform.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

/** settings-table key holding the per-platform chat timeout ([fork 3/10]). */
export function providerTimeoutSettingKey(platform: string): string {
  return `provider_timeout_ms_${platform.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
}

/** Effective chat timeout for a platform: the stored per-platform override,
 * then the PROVIDER_TIMEOUT_<PLATFORM> env override, then the caller's built-in
 * default. Returns 0 to mean "no timeout" — callers must skip their abort timer
 * for 0, never schedule setTimeout(0). */
export function providerTimeoutMs(platform: string, defaultMs: number): number {
  const stored = readStoredMs(providerTimeoutSettingKey(platform));
  if (stored !== undefined) return stored;
  return parseTimeoutEnv(providerTimeoutEnvName(platform), defaultMs);
}

export const DEFAULT_STREAM_STALL_TIMEOUT_MS = 30_000;

/** settings-table keys for the stall watchdog ([fork 3/10]). */
export const STREAM_STALL_TIMEOUT_SETTING = 'provider_stream_stall_timeout_ms';

export function streamStallTimeoutEnvName(platform: string): string {
  return `PROVIDER_STREAM_STALL_TIMEOUT_${platform.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

export function streamStallTimeoutSettingKey(platform: string): string {
  return `provider_stream_stall_timeout_ms_${platform.toLowerCase().replace(/[^A-Z0-9]/g, '_')}`;
}

/** Effective mid-stream inactivity timeout, 0 disables. Resolved per call, so a
 * dashboard change applies to the next request. Precedence (#584 + [fork 3/10]):
 * the per-platform stored value, its env var, the global stored value, the
 * global env var, then the built-in default. */
export function streamStallTimeoutMs(platform?: string): number {
  if (platform) {
    const stored = readStoredMs(streamStallTimeoutSettingKey(platform));
    if (stored !== undefined) return stored;
    const env = readEnvMs(streamStallTimeoutEnvName(platform));
    if (env !== undefined) return env;
  }
  const globalStored = readStoredMs(STREAM_STALL_TIMEOUT_SETTING);
  if (globalStored !== undefined) return globalStored;
  return parseTimeoutEnv('PROVIDER_STREAM_STALL_TIMEOUT_MS', DEFAULT_STREAM_STALL_TIMEOUT_MS);
}

/** The global stall budget with its provenance, for the settings page. */
export function resolveStreamStallTimeoutMs(): ResolvedIntSetting {
  return resolveIntSetting({
    key: STREAM_STALL_TIMEOUT_SETTING,
    envVar: 'PROVIDER_STREAM_STALL_TIMEOUT_MS',
    defaultValue: DEFAULT_STREAM_STALL_TIMEOUT_MS,
    min: 0,
  });
}

/** The per-platform chat timeout with its provenance, for the settings page. */
export function resolveProviderTimeoutMs(platform: string, defaultMs: number): ResolvedIntSetting {
  return resolveIntSetting({
    key: providerTimeoutSettingKey(platform),
    envVar: providerTimeoutEnvName(platform),
    defaultValue: defaultMs,
    min: 0,
  });
}

/** Parse a non-negative integer of milliseconds, else undefined. */
function parseMs(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** A stored millisecond value, or undefined when absent/invalid. Never throws:
 * the provider hot path must survive an uninitialised DB. */
function readStoredMs(settingKey: string): number | undefined {
  try {
    return parseMs(getSetting(settingKey));
  } catch {
    return undefined;
  }
}

/** An env millisecond value, or undefined when absent/invalid. Malformed values
 *  warn once and fall through to the next layer, exactly like parseTimeoutEnv —
 *  the only difference is that falling through continues the precedence chain
 *  instead of returning this level's default. */
function readEnvMs(envName: string): number | undefined {
  const raw = process.env[envName];
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed < 0) {
    warnOnce(envName, `[config] Ignoring ${envName}="${raw}": expected a non-negative integer of milliseconds (0 disables the timeout).`);
    return undefined;
  }
  if (parsed > 0 && parsed < 1000) {
    warnOnce(envName, `[config] ${envName}=${parsed}ms is under a second; nearly every request to this provider will abort. Was this meant to be seconds?`);
  }
  return parsed;
}

/** Test hook: forget which malformed values have already been warned about. */
export function resetTimeoutWarnings(): void {
  warned.clear();
}
