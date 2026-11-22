// provider-audit tests: the audit measures a provider's pool after a live
// failure, is debounced per upstream, stays serial, and turns its verdict into
// the two operator alerts (unstable / down).

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import {
  runProviderAudit,
  scheduleProviderAudit,
  notificationForAudit,
  benchKeyForDeadPool,
  shouldAuditAfterFailure,
  listProviderAudits,
  resetProviderAuditState,
  AUDIT_MAX_MODELS,
  type ProviderAuditResult,
} from '../../services/provider-audit.js';
import { resetModelProbeState } from '../../services/model-probe.js';
import { resetSiteNotifications, listSiteNotifications } from '../../services/site-notifications.js';

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

beforeEach(() => {
  resetModelProbeState();
  resetProviderAuditState();
  resetSiteNotifications();
  const db = getDb();
  db.prepare('DELETE FROM model_probe_status').run();
  db.prepare('DELETE FROM fallback_config').run();
  db.prepare('DELETE FROM profile_models').run();
  db.prepare('DELETE FROM models').run();
  db.prepare('DELETE FROM api_keys').run();
  db.prepare(`INSERT INTO api_keys (id, platform, label, encrypted_key, iv, auth_tag, status, enabled)
              VALUES (1, 'audit-test', '', '', '', '', 'healthy', 1)`).run();
});

function addModel(id: number, modelId: string): void {
  getDb().prepare(`INSERT INTO models (id, platform, model_id, display_name, intelligence_rank, speed_rank, endpoint_scope, enabled)
                   VALUES (?, 'audit-test', ?, ?, 0, 0, '', 1)`).run(id, modelId, modelId);
}

describe('provider audit', () => {
  it('reports the pool as down when nothing answers', async () => {
    for (const id of [1, 2]) addModel(id, `m${id}`);
    const chat = vi.fn(async () => { throw new Error('upstream 503'); });
    const result = await runProviderAudit({ platform: 'audit-test', chat, gapMs: 0 });
    expect(result.verdict).toBe('down');
    expect(result.checked).toBe(2);
    expect(result.working).toBe(0);
    expect(result.sampleError).toContain('503');
  });

  it('reports the pool as unstable when some models still answer', async () => {
    addModel(1, 'good');
    addModel(2, 'bad');
    const chat = vi.fn(async (candidate: { modelId: string }) => {
      if (candidate.modelId === 'bad') throw new Error('upstream 503');
      return {};
    });
    const result = await runProviderAudit({ platform: 'audit-test', chat, gapMs: 0 });
    expect(result.verdict).toBe('unstable');
    expect(result.workingModels).toEqual(['good']);
    expect(result.failingModels).toEqual(['bad']);
  });

  it('reports the pool as stable when every model answers', async () => {
    addModel(1, 'a');
    addModel(2, 'b');
    const result = await runProviderAudit({ platform: 'audit-test', chat: vi.fn(async () => ({})), gapMs: 0 });
    expect(result.verdict).toBe('stable');
    expect(result.working).toBe(2);
  });

  it('caps how many models one audit measures', async () => {
    for (let id = 1; id <= AUDIT_MAX_MODELS + 5; id++) addModel(id, `m${id}`);
    const result = await runProviderAudit({ platform: 'audit-test', chat: vi.fn(async () => ({})), gapMs: 0 });
    expect(result.checked).toBe(AUDIT_MAX_MODELS);
  });

  it('skips the model that triggered the audit', async () => {
    addModel(1, 'trigger');
    addModel(2, 'other');
    const chat = vi.fn(async () => ({}));
    const result = await runProviderAudit({ platform: 'audit-test', triggerModelId: 'trigger', chat, gapMs: 0 });
    expect(result.checked).toBe(1);
    expect(chat.mock.calls.map(call => (call[0] as { modelId: string }).modelId)).toEqual(['other']);
  });

  it('writes an in-site alert when the pool is down', async () => {
    addModel(1, 'a');
    const result = await runProviderAudit({
      platform: 'audit-test', chat: vi.fn(async () => { throw new Error('down'); }), gapMs: 0,
    });
    notificationForAudit(result);
    const feed = listSiteNotifications();
    expect(feed.unread).toBe(1);
    expect(feed.notifications[0].kind).toBe('provider_down');
    expect(feed.notifications[0].severity).toBe('critical');
  });

  it('writes an in-site alert that recommends more models when unstable', async () => {
    addModel(1, 'good');
    addModel(2, 'bad');
    const chat = vi.fn(async (candidate: { modelId: string }) => {
      if (candidate.modelId === 'bad') throw new Error('503');
      return {};
    });
    const result = await runProviderAudit({ platform: 'audit-test', chat, gapMs: 0 });
    notificationForAudit(result);
    const [alert] = listSiteNotifications().notifications;
    expect(alert.kind).toBe('provider_unstable');
    expect(alert.body).toMatch(/добавить ещё модели/);
  });

  it('updates one row per provider instead of stacking alerts', async () => {
    addModel(1, 'a');
    const failing = vi.fn(async () => { throw new Error('down'); });
    notificationForAudit(await runProviderAudit({ platform: 'audit-test', chat: failing, gapMs: 0 }));
    notificationForAudit(await runProviderAudit({ platform: 'audit-test', chat: failing, gapMs: 0 }));
    expect(listSiteNotifications(true).notifications).toHaveLength(1);
  });

  it('debounces scheduled audits per upstream', async () => {
    addModel(1, 'a');
    const chat = vi.fn(async () => { throw new Error('503'); });
    scheduleProviderAudit({ platform: 'audit-test', chat, gapMs: 0, startDelayMs: 0 });
    scheduleProviderAudit({ platform: 'audit-test', chat, gapMs: 0, startDelayMs: 0 });
    await new Promise(resolve => setTimeout(resolve, 30));
    // One audit ran; the second was suppressed by the cooldown window.
    expect(chat.mock.calls.length).toBeLessThanOrEqual(1);
    expect(listProviderAudits()).toHaveLength(1);
  });

  it('waits before probing so it never shares the wire with the failed request', async () => {
    addModel(1, 'a');
    const chat = vi.fn(async () => ({}));
    scheduleProviderAudit({ platform: 'audit-test', chat, gapMs: 0, startDelayMs: 40 });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(chat).not.toHaveBeenCalled();
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(chat).toHaveBeenCalled();
  });
});

describe('shouldAuditAfterFailure', () => {
  const withStatus = (status: number, message = 'nope') => Object.assign(new Error(message), { status });

  it('audits after a real upstream failure', () => {
    expect(shouldAuditAfterFailure(withStatus(503, 'upstream overloaded'))).toBe(true);
    expect(shouldAuditAfterFailure(Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' }))).toBe(true);
  });

  it('does not audit after rate limits, auth, payment or model-scope errors', () => {
    expect(shouldAuditAfterFailure(withStatus(429, 'rate limit exceeded'))).toBe(false);
    expect(shouldAuditAfterFailure(withStatus(401, 'invalid api key'))).toBe(false);
    expect(shouldAuditAfterFailure(withStatus(402, 'payment required'))).toBe(false);
    expect(shouldAuditAfterFailure(withStatus(404, 'model not found'))).toBe(false);
  });
});

describe('benchKeyForDeadPool', () => {
  it('benches the failing key across every model once the pool is dead', async () => {
    addModel(1, 'a');
    addModel(2, 'b');
    const result = await runProviderAudit({
      platform: 'audit-test', chat: vi.fn(async () => { throw new Error('down'); }), gapMs: 0,
    });
    expect(benchKeyForDeadPool(result, 1)).toBe(2);
    const rows = getDb().prepare('SELECT model_id FROM rate_limit_cooldowns WHERE key_id = 1').all() as Array<{ model_id: string }>;
    expect(rows.map(row => row.model_id).sort()).toEqual(['a', 'b']);
  });

  it('leaves the key alone when part of the pool still answers', async () => {
    addModel(1, 'good');
    addModel(2, 'bad');
    const chat = vi.fn(async (candidate: { modelId: string }) => {
      if (candidate.modelId === 'bad') throw new Error('503');
      return {};
    });
    const result = await runProviderAudit({ platform: 'audit-test', chat, gapMs: 0 });
    expect(benchKeyForDeadPool(result, 1)).toBe(0);
  });
});

describe('provider audit notifications', () => {
  it('resolves rather than duplicates once the pool answers again', () => {
    const base: ProviderAuditResult = {
      provider: 'audit-test', platform: 'audit-test', endpointScope: '', verdict: 'unstable',
      checked: 2, working: 1, unavailable: 1, inconclusive: 0,
      workingModels: ['a'], failingModels: ['b'], sampleError: null,
      startedAtMs: 1, finishedAtMs: 2,
    };
    notificationForAudit(base);
    notificationForAudit({ ...base, verdict: 'stable', working: 2, unavailable: 0, failingModels: [] });
    const feed = listSiteNotifications(30, true);
    expect(feed.unread).toBe(0);
    expect(feed.notifications[0].kind).toBe('provider_recovered');
  });
});
