// provider-audit — measure a provider's whole model pool after one model fails.
//
// The failure path already benches the failing (model, key) pair. That is a
// single data point: it says nothing about whether the OTHER models behind the
// same upstream still answer. Without that second measurement the operator
// cannot tell the two very different situations apart:
//
//   - the pool is healthy except for a few dead models  → the current
//     configuration is UNSTABLE and wants more models added to the pool;
//   - nothing behind the upstream answers at all          → the provider is
//     DOWN and needs a human.
//
// So a failure schedules a background audit of the provider's model pool. The
// audit is deliberately gentle, because its job is to observe, not to compete
// with live traffic that has already failed over to another provider:
//
//   - one audit per upstream per AUDIT_COOLDOWN_MS (10 min), never two in
//     flight for the same upstream;
//   - serial probes (concurrency 1) with a gap between them, so the audit adds
//     one in-flight request at a time and never a burst;
//   - at most AUDIT_MAX_MODELS models per audit, and a per-model deadline;
//   - fire-and-forget from the request path: a slow audit can never add latency
//     to the failing request that triggered it.
//
// The result becomes an in-site notification (services/site-notifications.ts)
// plus an outbound event for configured webhook/Telegram channels.

import { getDb } from '../db/index.js';
import { providerLog } from '../lib/server-logs.js';
import { endpointScopeForBaseUrl, upstreamIdentity } from '../lib/endpoint-scope.js';
import { probeModel, recordProbeResult, selectProviderProbeCandidates, type ModelProbeRequestDeps, type ProbeCandidate } from './model-probe.js';
import { upsertSiteNotification, type SiteNotification } from './site-notifications.js';
import { setCooldown } from './ratelimit.js';
import { notify } from './notifications.js';
import {
  isRateLimitSignal, isKeyAuthError, isPaymentRequiredError, isDailyQuotaExhaustedError,
  isModelNotFoundError, isModelAccessForbiddenError, isAccountSuspendedError,
  isContextTooLargeError, isProviderBadRequestError, isClientAbortError, isHedgeAbortError,
} from '../lib/error-classify.js';

/** One audit per upstream per this window. Long enough that a provider having a
 *  bad minute is not re-audited by every failing request behind it. */
export const AUDIT_COOLDOWN_MS = 10 * 60 * 1000;

/** Models per audit. A pool of 200 models is sampled, not swept: the question
 *  is "does anything work here", and 12 serial answers settle it. */
export const AUDIT_MAX_MODELS = 12;

/** Gap between two probes inside one audit. Serial probes plus this gap keep
 *  the audit to roughly one request in flight against an upstream that live
 *  traffic has just given up on. */
export const AUDIT_PROBE_GAP_MS = 1_500;

/** Per-model wire deadline inside an audit. Shorter than the operator's
 *  default: an audit is a background question, not a promise. */
export const AUDIT_PROBE_TIMEOUT_MS = 15_000;

/** Delay before an audit starts. The request that failed has already been
 *  failed over by the time this fires, so the audit never shares the wire with
 *  the tail of the user's request. */
export const AUDIT_START_DELAY_MS = 20_000;

export type ProviderAuditVerdict = 'stable' | 'unstable' | 'down' | 'skipped';

export interface ProviderAuditResult {
  /** Upstream identity: the platform, or `platform@endpoint` for a relay. */
  provider: string;
  platform: string;
  endpointScope: string;
  verdict: ProviderAuditVerdict;
  checked: number;
  working: number;
  unavailable: number;
  inconclusive: number;
  workingModels: string[];
  failingModels: string[];
  sampleError: string | null;
  startedAtMs: number;
  finishedAtMs: number;
}

export interface ProviderAuditDeps {
  /** Injectable chat call for tests; defaults to the real probe transport. */
  chat?: ModelProbeRequestDeps['chat'];
  /** Injectable candidate list for tests. */
  select?: (platform: string, endpointScope: string | null) => ProbeCandidate[];
  /** Gap between probes; tests pass 0. */
  gapMs?: number;
  timeoutMs?: number;
}

export interface ProviderAuditInput extends ProviderAuditDeps {
  platform: string;
  endpointScope?: string | null;
  /** Model that failed and triggered this audit (never probed twice). */
  triggerModelId?: string | null;
  /** Key that failed the live request; gets a whole-key bench if the pool is down. */
  triggerKeyId?: number | null;
  /** How long to wait before the audit starts; tests pass 0. */
  startDelayMs?: number;
  now?: number;
}

/** How long a key is benched across the provider's models once the pool is
 *  confirmed dead. Long enough to stop the router hammering a dark upstream,
 *  short enough that the next audit (10 min) can lift it. */
export const AUDIT_DOWN_BENCH_MS = 10 * 60 * 1000;

interface AuditState {
  lastRunAtMs: number;
  inFlight: boolean;
  lastResult?: ProviderAuditResult;
}

const audits = new Map<string, AuditState>();

function stateOf(provider: string): AuditState {
  let state = audits.get(provider);
  if (!state) {
    state = { lastRunAtMs: 0, inFlight: false };
    audits.set(provider, state);
  }
  return state;
}

/** A relay reads better as its host than as the word "custom". */
function providerLabel(platform: string, endpointScope: string): string {
  if (platform !== 'custom') return platform;
  const scope = endpointScopeForBaseUrl(endpointScope);
  if (!scope) return 'custom';
  try {
    return new URL(scope).host || scope;
  } catch {
    return scope.replace(/^https?:\/\//, '').replace(/\/.*$/, '') || scope;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    // A pending audit must not keep the process (or a test runner) alive.
    timer.unref?.();
  });
}

/** Candidates for an audit: one credential per enabled model of the upstream. */
function auditCandidates(input: ProviderAuditInput): ProbeCandidate[] {
  const scope = input.platform === 'custom'
    ? (input.endpointScope ?? null)
    : null;
  const picked = selectProviderProbeCandidates(
    getDb(), input.platform, scope, AUDIT_MAX_MODELS, false,
  );
  // The model that just failed is already benched — re-probing it spends quota
  // to re-learn what we know, and it is not the question being asked.
  const filtered = input.triggerModelId
    ? picked.filter(candidate => candidate.modelId !== input.triggerModelId)
    : picked;
  return filtered.slice(0, AUDIT_MAX_MODELS);
}

/**
 * Run one audit now. Serial, gapped, bounded. Never throws: an audit is
 * background observation, and its failure must not surface anywhere.
 */
export async function runProviderAudit(input: ProviderAuditInput): Promise<ProviderAuditResult> {
  const startedAtMs = input.now ?? Date.now();
  const provider = upstreamIdentity(input.platform, input.endpointScope ?? '');
  const base: ProviderAuditResult = {
    provider,
    platform: input.platform,
    endpointScope: input.endpointScope ?? '',
    verdict: 'skipped',
    checked: 0,
    working: 0,
    unavailable: 0,
    inconclusive: 0,
    workingModels: [],
    failingModels: [],
    sampleError: null,
    startedAtMs,
    finishedAtMs: startedAtMs,
  };

  let candidates: ProbeCandidate[] = [];
  try {
    candidates = input.select
      ? input.select(input.platform, input.endpointScope ?? null).slice(0, AUDIT_MAX_MODELS)
      : auditCandidates(input);
  } catch (error: any) {
    providerLog('warn', `[ProviderAudit] could not list ${provider} models: ${error?.message ?? error}`, {
      provider: input.platform, event: 'provider_audit_error',
    });
    return base;
  }
  if (candidates.length === 0) return base;

  const result = { ...base };
  for (let index = 0; index < candidates.length; index++) {
    if (index > 0) await sleep(input.gapMs ?? AUDIT_PROBE_GAP_MS);
    const candidate = candidates[index];
    const outcome = await probeModel(candidate, { chat: input.chat, timeoutMs: input.timeoutMs ?? AUDIT_PROBE_TIMEOUT_MS });
    try {
      recordProbeResult(getDb(), candidate, outcome);
    } catch { /* the verdict below is what matters, not the row */ }
    result.checked++;
    if (outcome.status === 'working') {
      result.working++;
      result.workingModels.push(candidate.modelId);
    } else {
      if (outcome.status === 'unavailable') result.unavailable++;
      else result.inconclusive++;
      result.failingModels.push(candidate.modelId);
      result.sampleError ??= outcome.error ?? null;
    }
  }
  result.finishedAtMs = Date.now();
  result.verdict = result.working === 0
    ? 'down'
    : result.working === result.checked ? 'stable' : 'unstable';
  return result;
}

/**
 * Should a failure of this class put the provider's pool under measurement?
 *
 * A failed request is only evidence about the UPSTREAM when the upstream is
 * what refused. Auth, payment, quota, per-model access and request-shape
 * failures are facts about one key or one model, and auditing the pool after
 * them would report a healthy provider as "down" — the exact false alarm that
 * makes an operator stop trusting the alerts.
 */
export function shouldAuditAfterFailure(err: any): boolean {
  if (!err) return false;
  if (isClientAbortError(err) || isHedgeAbortError(err)) return false;
  if (isRateLimitSignal(err)) return false;
  if (isKeyAuthError(err) || isPaymentRequiredError(err)) return false;
  if (isDailyQuotaExhaustedError(err) || isAccountSuspendedError(err)) return false;
  if (isModelNotFoundError(err) || isModelAccessForbiddenError(err)) return false;
  if (isContextTooLargeError(err) || isProviderBadRequestError(err)) return false;
  return true;
}

/**
 * Bench the failing key across the provider's whole model list.
 *
 * When no model behind the upstream answers, retrying the SAME key against a
 * sibling model is guaranteed to burn the cooldown window and add latency to
 * live traffic that has already failed over. A provider-wide verdict is the
 * evidence needed to hold the key itself for the same window the audit uses.
 */
export function benchKeyForDeadPool(result: ProviderAuditResult, keyId: number | null | undefined, now = Date.now()): number {
  if (result.verdict !== 'down' || !keyId) return 0;
  const rows = getDb().prepare(
    "SELECT model_id FROM models WHERE platform = ? AND enabled = 1",
  ).all(result.platform) as Array<{ model_id: string }>;
  let benched = 0;
  for (const row of rows) {
    try {
      setCooldown(result.platform, row.model_id, keyId, AUDIT_DOWN_BENCH_MS, 'heuristic');
      benched++;
    } catch { /* one row failing must not abort the bench */ }
  }
  return benched;
}

/** Build the operator-facing alert for one audit, or null when nothing is wrong. */
export function notificationForAudit(result: ProviderAuditResult): SiteNotification | null {
  if (result.verdict === 'skipped') return null;
  const label = providerLabel(result.platform, result.endpointScope);
  const meta = {
    provider: result.provider,
    platform: result.platform,
    endpointScope: result.endpointScope,
    verdict: result.verdict,
    checked: result.checked,
    working: result.working,
    unavailable: result.unavailable,
    inconclusive: result.inconclusive,
    workingModels: result.workingModels.slice(0, 20),
    failingModels: result.failingModels.slice(0, 20),
    sampleError: result.sampleError,
  };

  if (result.verdict === 'down') {
    return upsertSiteNotification({
      provider: result.provider,
      kind: 'provider_down',
      severity: 'critical',
      title: `${label} не отвечает полностью`,
      body: `0 из ${result.checked} проверенных моделей ответили. Провайдер не обслуживает запросы — нужно внимание: проверьте ключи, баланс и статус провайдера.`,
      metadata: meta,
    });
  }
  if (result.verdict === 'unstable') {
    return upsertSiteNotification({
      provider: result.provider,
      kind: 'provider_unstable',
      severity: 'warning',
      title: `Конфигурация ${label} нестабильна`,
      body: `${result.unavailable + result.inconclusive} из ${result.checked} проверенных моделей недоступны, работают ${result.working}. Рекомендуется добавить ещё модели этого провайдера в пул.`,
      metadata: meta,
    });
  }
  // stable → resolve a previous alert instead of stacking a "recovered" banner.
  return upsertSiteNotification({
    provider: result.provider,
    kind: 'provider_recovered',
    severity: 'success',
    title: `${label} снова отвечает`,
    body: `Все ${result.checked} проверенных моделей ответили — инцидент закрыт.`,
    metadata: meta,
  });
}

/**
 * Fire-and-forget audit for a provider that just failed a live request.
 * Debounced per upstream; the caller never awaits it and never sees an error.
 */
export function scheduleProviderAudit(input: ProviderAuditInput): void {
  if (process.env.PROVIDER_AUDIT_DISABLED === '1') return;
  const provider = upstreamIdentity(input.platform, input.endpointScope ?? '');
  const state = stateOf(provider);
  const now = input.now ?? Date.now();
  if (state.inFlight) return;
  if (now - state.lastRunAtMs < AUDIT_COOLDOWN_MS) return;
  state.inFlight = true;
  state.lastRunAtMs = now;

  void (async () => {
    try {
      const delay = input.startDelayMs ?? AUDIT_START_DELAY_MS;
      if (delay > 0) await sleep(delay);
      const result = await runProviderAudit(input);
      state.lastResult = result;
      if (result.verdict === 'skipped') return;
      const alert = notificationForAudit(result);
      if (result.verdict === 'down') {
        // The pool answered nothing: hold the key that just failed across the
        // provider's models so the router stops paying a dead upstream while
        // the alert is unread.
        benchKeyForDeadPool(result, input.triggerKeyId);
      }
      providerLog(
        result.verdict === 'down' ? 'warn' : 'info',
        `[ProviderAudit] ${provider}: ${result.verdict} — ${result.working}/${result.checked} models answered`,
        { provider: input.platform, event: `provider_audit_${result.verdict}` },
      );
      if (result.verdict === 'down') {
        notify('provider_down', {
          title: `${providerLabel(result.platform, result.endpointScope)} не отвечает`,
          body: `0 из ${result.checked} моделей ответили${result.sampleError ? ` (${result.sampleError})` : ''}.`,
          dedupKey: `provider_down:${provider}`,
        });
      } else if (result.verdict === 'unstable') {
        notify('provider_unstable', {
          title: `Конфигурация ${providerLabel(result.platform, result.endpointScope)} нестабильна`,
          body: `${result.unavailable + result.inconclusive} из ${result.checked} моделей недоступны — добавьте ещё модели этого провайдера.`,
          dedupKey: `provider_unstable:${provider}`,
        });
      }
      void alert;
    } catch (error: any) {
      providerLog('warn', `[ProviderAudit] ${provider} audit failed: ${error?.message ?? error}`, {
        provider: input.platform, event: 'provider_audit_error',
      });
    } finally {
      state.inFlight = false;
    }
  })();
}

export interface ProviderAuditSummary {
  provider: string;
  verdict: ProviderAuditVerdict;
  checked: number;
  working: number;
  unavailable: number;
  inconclusive: number;
  finishedAtMs: number;
}

/**
 * Latest verdict per upstream, for the Providers page badges.
 *
 * In-memory results are authoritative for this process, but they die on
 * restart. Unresolved alerts in `site_notifications` carry the same counts in
 * their metadata, so an unstable/down provider keeps its badge across a
 * supervisor restart instead of silently looking healthy.
 */
export function listProviderAudits(): ProviderAuditSummary[] {
  const out = new Map<string, ProviderAuditSummary>();
  try {
    const rows = getDb().prepare(`
      SELECT provider, kind, metadata, updated_at_ms FROM site_notifications
       WHERE resolved_at_ms IS NULL AND kind IN ('provider_unstable', 'provider_down')
       ORDER BY updated_at_ms ASC
    `).all() as Array<{ provider: string; kind: string; metadata: string; updated_at_ms: number }>;
    for (const row of rows) {
      let meta: any = {};
      try { meta = JSON.parse(row.metadata); } catch { continue; }
      out.set(row.provider, {
        provider: row.provider,
        verdict: row.kind === 'provider_down' ? 'down' : 'unstable',
        checked: Number(meta.checked) || 0,
        working: Number(meta.working) || 0,
        unavailable: Number(meta.unavailable) || 0,
        inconclusive: Number(meta.inconclusive) || 0,
        finishedAtMs: row.updated_at_ms,
      });
    }
  } catch { /* no DB yet (tests): in-memory results still report */ }

  for (const [provider, state] of audits) {
    const result = state.lastResult;
    if (!result || result.verdict === 'skipped') continue;
    if (result.verdict === 'stable') { out.delete(provider); continue; }
    out.set(provider, {
      provider,
      verdict: result.verdict,
      checked: result.checked,
      working: result.working,
      unavailable: result.unavailable,
      inconclusive: result.inconclusive,
      finishedAtMs: result.finishedAtMs,
    });
  }
  return [...out.values()];
}

/** Test hook. */
export function resetProviderAuditState(): void {
  audits.clear();
}