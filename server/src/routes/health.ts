import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb, isKeyStoreDecryptable } from '../db/index.js';
import { checkKeyHealth, checkAllKeys, pollKeyQuota, supportsQuotaPolling } from '../services/health.js';
import { getDegradationStatus } from '../services/degradation.js';
import { runModelProbePass, selectModelProbeCandidatesByIds, selectProviderProbeCandidates } from '../services/model-probe.js';
import { listProviderAudits } from '../services/provider-audit.js';
import { hasProvider, resolveProvider } from '../providers/index.js';
import { getQuotaStateForKeys } from '../services/provider-quota.js';
import type { Platform } from '@freellmapi/shared/types.js';

export const healthRouter = Router();

// Operator checks are asynchronous: the POST only starts a bounded pass and
// Ember polls /probe-status for progress and for each finished model.
export interface ProviderProbeCheck {
  platform: string
  endpointScope: string | null
  total: number
  done: number
  timeoutMs: number
  startedAt: string
}
const activeProviderChecks = new Map<string, ProviderProbeCheck>()
const checkKey = (platform: string, endpointScope: string | null) => `${platform}:${endpointScope ?? ''}`

// Get health status for all platforms
healthRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();

  const platforms = db.prepare(`
    SELECT
      platform,
      COUNT(*) as total_keys,
      SUM(CASE WHEN status = 'healthy' THEN 1 ELSE 0 END) as healthy_keys,
      SUM(CASE WHEN status = 'rate_limited' THEN 1 ELSE 0 END) as rate_limited_keys,
      SUM(CASE WHEN status = 'invalid' THEN 1 ELSE 0 END) as invalid_keys,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_keys,
      SUM(CASE WHEN status = 'unknown' THEN 1 ELSE 0 END) as unknown_keys,
      SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) as enabled_keys
    FROM api_keys
    GROUP BY platform
  `).all() as any[];

  const keys = db.prepare(`
    SELECT id, platform, label, status, enabled, created_at, last_checked_at, last_healthy_at, last_health_error
    FROM api_keys
    ORDER BY platform, created_at DESC
  `).all() as any[];

  res.json({
    platforms: platforms.map(p => ({
      platform: p.platform,
      hasProvider: hasProvider(p.platform),
      totalKeys: p.total_keys,
      healthyKeys: p.healthy_keys,
      rateLimitedKeys: p.rate_limited_keys,
      invalidKeys: p.invalid_keys,
      errorKeys: p.error_keys,
      unknownKeys: p.unknown_keys,
      enabledKeys: p.enabled_keys,
    })),
    keys: keys.map(k => ({
      id: k.id,
      platform: k.platform,
      label: k.label,
      status: k.status,
      enabled: k.enabled === 1,
      createdAt: k.created_at,
      lastCheckedAt: k.last_checked_at,
      lastHealthyAt: k.last_healthy_at ?? null,
      lastHealthError: k.last_health_error,
    })),
    quotaStates: getQuotaStateForKeys(),
    degradation: getDegradationStatus(),
    // false means the encryption key no longer matches the stored ciphertext,
    // so every key below fails with a decrypt error for the same reason.
    keyStore: { decryptable: isKeyStoreDecryptable() },
  });
});

// Check a specific key
healthRouter.post('/check/:keyId', async (req: Request, res: Response) => {
  const keyId = parseInt(req.params.keyId as string, 10);
  if (isNaN(keyId)) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const status = await checkKeyHealth(keyId);
  res.json({ keyId, status });
});

// Check all keys. Forced: someone pressed the button and wants an answer about
// every key now, so the scheduled pass' recency skip and provider spacing (#553)
// don't apply, and providers that must not be polled (#1599) are checked too.
healthRouter.post('/check-all', async (_req: Request, res: Response) => {
  await checkAllKeys({ force: true, manual: true });
  res.json({ success: true });
});

// Poll one key's provider-reported balance now (#1403). The health pass only
// piggybacks the quota probe at most once per 15 minutes; this is the manual
// override — an operator adding a key wants the balance immediately instead
// of waiting for the next healthy pass after the throttle. Returns what the
// probe recorded (or the fresh state when the provider reported nothing, so
// the caller can tell "no quota endpoint / probe failed" from "fresh number").
healthRouter.post('/quota/:keyId', async (req: Request, res: Response) => {
  const keyId = parseInt(req.params.keyId as string, 10);
  if (isNaN(keyId)) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }
  const db = getDb();
  const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(keyId) as any;
  if (!row) {
    res.status(404).json({ error: { message: 'Key not found' } });
    return;
  }
  const provider = resolveProvider(row.platform as Platform, row.base_url);
  if (!provider || !supportsQuotaPolling(provider)) {
    res.status(400).json({ error: { message: `${row.platform} has no provider-reported quota endpoint` } });
    return;
  }
  // pollKeyQuota is failure-silent by design; its boolean tells us whether a
  // quota_api row was written, and the state query returns the fresh reading.
  const recorded = await pollKeyQuota(keyId, row, provider);
  const state = getQuotaStateForKeys().filter(
    q => q.keyId === keyId && q.source === 'quota_api',
  );
  res.json({ keyId, recorded, quotaStates: state });
});

// Last known availability labels for the operator's "check this provider"
// panel. Rows are per model+key pair; Ember shows one row per model.
healthRouter.get('/probe-status', (req: Request, res: Response) => {
  const platform = typeof req.query.platform === 'string' && req.query.platform.trim()
    ? req.query.platform.trim() : null;
  const endpointScope = typeof req.query.endpointScope === 'string' ? req.query.endpointScope : null;
  const rows = getDb().prepare(`
    SELECT m.id AS modelDbId, s.platform, s.model_id AS modelId, s.endpoint_scope AS endpointScope, s.key_id AS keyId,
           s.status, s.last_probed_at AS lastProbedAt, s.last_error AS lastError, s.latency_ms AS latencyMs,
           m.display_name AS displayName, k.label AS keyLabel
      FROM model_probe_status s
      LEFT JOIN models m ON m.platform = s.platform AND m.model_id = s.model_id AND m.endpoint_scope = s.endpoint_scope
      LEFT JOIN api_keys k ON k.id = s.key_id
     WHERE (? IS NULL OR s.platform = ?) AND (? IS NULL OR s.endpoint_scope = ?)
     ORDER BY (s.status = 'unavailable') DESC, s.last_probed_at DESC, s.model_id ASC
  `).all(platform, platform, endpointScope, endpointScope) as Array<{
    platform: string; modelId: string; endpointScope: string | null; keyId: number;
    status: string; lastProbedAt: string | null; lastError: string | null;
    latencyMs: number | null; displayName: string | null; keyLabel: string | null;
  }>;
  res.json({ rows, checks: [...activeProviderChecks.values()], audits: listProviderAudits() });
});

// Latest background pool-audit verdict per upstream. Written by
// services/provider-audit.ts when a live request failed; Ember shows it on the
// provider cards so an unstable pool is visible without opening a dialog.
healthRouter.get('/provider-audits', (_req: Request, res: Response) => {
  res.json({ audits: listProviderAudits() });
});

// Start a provider check. It runs in the background so slow models cannot
// freeze the UI: Ember polls /probe-status for `checks` progress and rows.
// Without a platform this remains the legacy synchronous full pass.
healthRouter.post('/probe-models', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    platform?: unknown; endpointScope?: unknown; limit?: unknown; timeoutMs?: unknown; all?: unknown; modelDbIds?: unknown
  };
  const platform = typeof body.platform === 'string' && body.platform.trim() ? body.platform.trim() : null;
  const endpointScope = typeof body.endpointScope === 'string' ? body.endpointScope : null;
  const parsedLimit = Number(body.limit);
  const checkAll = body.all === true || parsedLimit === 0;
  const limit = checkAll ? 0 : Number.isInteger(parsedLimit) ? Math.max(1, Math.min(100, parsedLimit)) : 10;
  const parsedTimeout = Number(body.timeoutMs);
  const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0
    ? Math.max(3_000, Math.min(60_000, parsedTimeout))
    : 30_000;

  const modelDbIds = Array.isArray(body.modelDbIds)
    ? body.modelDbIds.filter((value): value is number => Number.isInteger(value) && value > 0)
    : [];
  const idCheck = modelDbIds.length > 0;

  if (!platform && !idCheck) {
    await runModelProbePass();
    res.json({ started: true, total: 0, timeoutMs });
    return;
  }

  const checkPlatform = idCheck ? '__models__' : platform!;
  const key = idCheck ? `ids:${modelDbIds.join(',')}` : checkKey(checkPlatform, endpointScope);
  const existing = activeProviderChecks.get(key);
  if (existing) {
    res.status(202).json({ started: false, alreadyRunning: true, ...existing });
    return;
  }

  // Include disabled models: availability is useful precisely when a model is
  // off in Ember, and the operator decides whether to turn it back on.
  const candidates = idCheck
    ? selectModelProbeCandidatesByIds(getDb(), modelDbIds, limit)
    : selectProviderProbeCandidates(getDb(), checkPlatform, endpointScope, limit, true);
  const check: ProviderProbeCheck = {
    platform: checkPlatform, endpointScope: idCheck ? null : endpointScope,
    total: candidates.length, done: 0, timeoutMs, startedAt: new Date().toISOString(),
  };
  activeProviderChecks.set(key, check);

  void runModelProbePass({
    force: true,
    maxProbes: checkAll || idCheck ? candidates.length : limit,
    concurrency: 4,
    timeoutMs,
    select: () => candidates,
    onProgress: done => { check.done = done; },
  }).catch(error => {
    console.error(`[ModelProbe] provider check failed for ${platform}:`, error);
  }).finally(() => {
    activeProviderChecks.delete(key);
  });

  res.status(202).json({ started: candidates.length > 0, total: candidates.length, timeoutMs });
});
