// model-probe tests (#1438 PR 1): candidate selection (stalest-first, fresh
// real-traffic skip), label recording, per-pass budget, restart stagger +
// first-sighting scheduling, failed-probe backoff, transport-error
// inconclusiveness (verdict preserved), and the kill switch.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import {
  selectProbeCandidates,
  selectProviderProbeCandidates,
  selectModelProbeCandidatesByIds,
  probeModel,
  recordProbeResult,
  runModelProbePass,
  resetModelProbeState,
  startModelProbe,
  stopModelProbe,
  MODEL_PROBE_STALE_MS,
} from '../../services/model-probe.js';
import type { ProbeCandidate } from '../../services/model-probe.js';

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

beforeEach(() => {
  resetModelProbeState();
  const db = getDb();
  db.prepare('DELETE FROM model_probe_status').run();
  db.prepare('DELETE FROM fallback_config').run();
  db.prepare('DELETE FROM profile_models').run();
  db.prepare('DELETE FROM api_keys').run();
  db.prepare('DELETE FROM models').run();
  // Fresh healthy key the models can hang off.
  db.prepare(`INSERT INTO api_keys (id, platform, label, encrypted_key, iv, auth_tag, status, enabled)
              VALUES (1, 'probe-test', '', '', '', '', 'healthy', 1)`).run();
});

function addModel(id: number, modelId: string, opts: { enabled?: number } = {}): void {
  getDb().prepare(`INSERT INTO models (id, platform, model_id, display_name, intelligence_rank, speed_rank, endpoint_scope, enabled)
                   VALUES (?, 'probe-test', ?, ?, 0, 0, '', ?)`).run(id, modelId, modelId, opts.enabled ?? 1);
}

const candidate = (over: Partial<ProbeCandidate> = {}): ProbeCandidate => ({
  keyId: 1,
  platform: 'probe-test',
  modelId: 'm1',
  modelDbId: 1,
  endpointScope: '',
  ...over,
});

// Seed one pass' worth of candidates so stagger/backoff choreography is
// deterministic: first sighting schedules (no probe), next pass probes.
function seedCandidates(n: number): ProbeCandidate[] {
  const out: ProbeCandidate[] = [];
  for (let i = 1; i <= n; i++) {
    addModel(i, `m${i}`);
    out.push(candidate({ modelId: `m${i}`, modelDbId: i }));
  }
  return out;
}

const selectFrom = (list: ProbeCandidate[]) => (limit: number) => list.slice(0, limit);
const chatOk = () => vi.fn(async () => ({}));
const chatFail = (message: string) => vi.fn(async () => { throw new Error(message); });
const noJitter = () => 0;

describe('candidate selection', () => {
  it('selects every enabled key for an explicitly checked model', () => {
    addModel(1, 'a');
    getDb().prepare(`INSERT INTO api_keys (id, platform, label, encrypted_key, iv, auth_tag, status, enabled)
                   VALUES (2, 'probe-test', '', '', '', '', 'healthy', 1)`).run();
    const picked = selectModelProbeCandidatesByIds(getDb(), [1], 0);
    expect(picked.map(candidate => candidate.keyId)).toEqual([1, 2]);
  });

  it('selects every model when the limit is zero', () => {
    for (const id of [1, 2, 3]) addModel(id, `m${id}`);
    expect(selectProviderProbeCandidates(getDb(), 'probe-test', null, 0)).toHaveLength(3);
  });

  it('includes disabled models when the operator asks to check a provider', () => {
    addModel(1, 'on');
    addModel(2, 'off', { enabled: 0 });
    const enabledOnly = selectProviderProbeCandidates(getDb(), 'probe-test', null, 10);
    const all = selectProviderProbeCandidates(getDb(), 'probe-test', null, 10, true);
    expect(enabledOnly.map(candidate => candidate.modelId)).toEqual(['on']);
    expect(all.map(candidate => candidate.modelId)).toEqual(['on', 'off']);
  });

  it('selects one credential per model for a provider check', () => {
    const db = getDb();
    db.prepare(`INSERT INTO api_keys (id, platform, label, encrypted_key, iv, auth_tag, status, enabled)
                VALUES (2, 'probe-test', '', '', '', '', 'healthy', 1)`).run();
    addModel(1, 'm1');
    addModel(2, 'm2');
    const picked = selectProviderProbeCandidates(db, 'probe-test', null, 5);
    expect(picked.map(c => [c.modelId, c.keyId])).toEqual([['m1', 1], ['m2', 1]]);
    expect(selectProviderProbeCandidates(db, 'other-platform', null, 5)).toEqual([]);
    expect(selectProviderProbeCandidates(db, 'probe-test', null, 1)).toHaveLength(1);
  });

  it('probes immediately when forced, ignoring first-sighting stagger', async () => {
    const list = seedCandidates(1);
    const pass = await runModelProbePass({
      select: selectFrom(list), maxProbes: 1, force: true, now: 1_000_000, chat: chatOk(), jitter: noJitter,
    });
    expect(pass.outcomes).toHaveLength(1);
    expect(pass.outcomes[0].outcome.status).toBe('working');
  });

  it('runs an operator pass concurrently instead of serialising dead endpoints', async () => {
    const list = seedCandidates(6);
    const chat = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 120)); return {}; });
    const started = Date.now();
    const pass = await runModelProbePass({
      select: selectFrom(list), maxProbes: 6, force: true, concurrency: 6, timeoutMs: 1000, chat,
    });
    expect(pass.outcomes).toHaveLength(6);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('reports progress after each finished model', async () => {
    const list = seedCandidates(3);
    const progress: number[] = [];
    await runModelProbePass({
      select: selectFrom(list), maxProbes: 3, force: true, concurrency: 1,
      chat: chatOk(), onProgress: done => { progress.push(done); },
    });
    expect(progress).toEqual([1, 2, 3]);
  });

  it('enforces the caller deadline when the adapter hangs', async () => {
    const list = seedCandidates(1);
    const pass = await runModelProbePass({
      select: selectFrom(list), maxProbes: 1, force: true, timeoutMs: 25,
      chat: () => new Promise(() => { /* never resolves */ }),
    });
    expect(pass.outcomes[0].outcome.status).toBe('error');
    expect(pass.outcomes[0].outcome.error).toContain('timed out');
  });

  it('probes the stalest evidence first, never-probed before stale', () => {
    const db = getDb();
    addModel(1, 'old');
    addModel(2, 'fresh');
    addModel(3, 'never');
    recordProbeResult(db, candidate({ modelId: 'old', modelDbId: 1 }),
      { status: 'working', latencyMs: 5 }, new Date(Date.now() - MODEL_PROBE_STALE_MS - 1000));
    recordProbeResult(db, candidate({ modelId: 'fresh', modelDbId: 2 }),
      { status: 'working', latencyMs: 5 }, new Date());

    const picked = selectProbeCandidates(db, 10);
    expect(picked.map(p => p.modelId)).toEqual(['never', 'old']);
  });

  it('skips models with fresh evidence (staleness window)', () => {
    const db = getDb();
    addModel(1, 'fresh');
    recordProbeResult(db, candidate({ modelId: 'fresh', modelDbId: 1 }),
      { status: 'working', latencyMs: 5 }, new Date());
    expect(selectProbeCandidates(db, 10)).toEqual([]);
  });

  it('ignores disabled models and disabled/invalid keys', () => {
    const db = getDb();
    addModel(1, 'off-model', { enabled: 0 });
    addModel(2, 'bad-key-model');
    db.prepare("UPDATE api_keys SET status = 'invalid' WHERE id = 1").run();
    expect(selectProbeCandidates(db, 10)).toEqual([]);
  });
});

describe('probe outcome classification', () => {
  it('a successful chat is working with latency', async () => {
    const outcome = await probeModel(candidate(), { chat: chatOk() });
    expect(outcome.status).toBe('working');
    expect(outcome.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('a provider rejection is unavailable and carries the sanitized error', async () => {
    const outcome = await probeModel(candidate(), { chat: chatFail('403: quota exhausted upstream') });
    expect(outcome.status).toBe('unavailable');
    expect(outcome.error).toContain('403');
  });

  it('a transport error is inconclusive (error), never unavailable', async () => {
    const outcome = await probeModel(candidate(), { chat: chatFail('fetch failed: getaddrinfo ENOTFOUND api.example.com') });
    expect(outcome.status).toBe('error');
  });
});

describe('recording', () => {
  it('writes working with latency and clears prior errors', () => {
    const db = getDb();
    recordProbeResult(db, candidate(), { status: 'unavailable', error: '403' });
    recordProbeResult(db, candidate(), { status: 'working', latencyMs: 42 });
    const row = db.prepare('SELECT * FROM model_probe_status').get() as any;
    expect(row.status).toBe('working');
    expect(row.latency_ms).toBe(42);
    expect(row.last_error).toBeNull();
  });

  it('an inconclusive probe replaces a stale working verdict', () => {
    const db = getDb();
    recordProbeResult(db, candidate(), { status: 'working', latencyMs: 10 });
    recordProbeResult(db, candidate(), { status: 'error', error: 'fetch failed (UND_ERR_CONNECT_TIMEOUT api.reformboss.com)' });
    const row = db.prepare('SELECT * FROM model_probe_status').get() as any;
    // Showing "Available" next to a fresh connect timeout is wrong: the last
    // check never reached the provider.
    expect(row.status).toBe('error');
    expect(row.last_error).toContain('UND_ERR_CONNECT_TIMEOUT');
  });

  it('keeps the reason on an unavailable verdict', () => {
    const db = getDb();
    recordProbeResult(db, candidate(), { status: 'unavailable', error: '404: model not found' });
    const row = db.prepare('SELECT * FROM model_probe_status').get() as any;
    expect(row.status).toBe('unavailable');
    expect(row.last_error).toBe('404: model not found');
  });

  it('records the first inconclusive probe so the UI can show it', () => {
    const db = getDb();
    recordProbeResult(db, candidate(), { status: 'error', error: 'timeout' });
    const row = db.prepare('SELECT * FROM model_probe_status').get() as any;
    expect(row.status).toBe('error');
    expect(row.last_error).toBe('timeout');
    expect(row.last_probed_at).toBeTruthy();
  });
});

describe('probe pass', () => {
  it('first sighting schedules instead of probing; the next pass probes within budget', async () => {
    const list = seedCandidates(5);
    const chat = chatOk();
    const pass1 = await runModelProbePass({ chat, jitter: noJitter, maxProbes: 3, select: selectFrom(list) });
    expect(pass1.probed).toEqual([]);
    expect(chat).not.toHaveBeenCalled();

    const pass2 = await runModelProbePass({ chat, jitter: noJitter, maxProbes: 3, select: selectFrom(list) });
    expect(pass2.probed).toHaveLength(3);
    expect(chat).toHaveBeenCalledTimes(3);
  });

  it('a working probe clears pacing so the model is not re-probed until stale', async () => {
    const list = seedCandidates(1);
    const chat = chatOk();
    await runModelProbePass({ chat, jitter: noJitter, select: selectFrom(list) });
    await runModelProbePass({ chat, jitter: noJitter, select: selectFrom(list) });
    // Third pass: the single candidate just worked; nothing is probeable.
    const pass3 = await runModelProbePass({ chat, jitter: noJitter, select: selectFrom(list) });
    expect(pass3.probed).toEqual([]);
  });

  it('an unavailable probe backs off instead of re-probing every pass', async () => {
    const list = seedCandidates(1);
    const chat = chatFail('403 quota');
    // Pass 1: first sighting only schedules.
    await runModelProbePass({ chat, jitter: noJitter, select: selectFrom(list) });
    // Pass 2: the actual probe — fails, sets a 30m backoff.
    const pass2 = await runModelProbePass({ chat, jitter: noJitter, select: selectFrom(list) });
    expect(pass2.probed).toHaveLength(1);
    // Pass 3 immediately after: still inside the backoff, nothing probed.
    const pass3 = await runModelProbePass({ chat, jitter: noJitter, select: selectFrom(list) });
    expect(pass3.probed).toEqual([]);
    // Past the first backoff step (30m) it probes again.
    const later = Date.now() + 31 * 60_000;
    const pass4 = await runModelProbePass({ chat, jitter: noJitter, select: selectFrom(list), now: later });
    expect(pass4.probed).toHaveLength(1);
  });

  it('records outcomes in the table', async () => {
    const list = seedCandidates(2);
    await runModelProbePass({ chat: chatOk(), jitter: noJitter, select: selectFrom(list) });
    await runModelProbePass({ chat: chatOk(), jitter: noJitter, select: selectFrom(list) });
    const rows = getDb().prepare('SELECT model_id, status FROM model_probe_status ORDER BY model_id').all() as any[];
    expect(rows).toEqual([
      { model_id: 'm1', status: 'working' },
      { model_id: 'm2', status: 'working' },
    ]);
  });
});

describe('kill switch and lifecycle', () => {
  it('is off by default: the scheduler does not start without MODEL_PROBE_ENABLED=1', () => {
    delete process.env.MODEL_PROBE_ENABLED;
    const scheduler = { every: vi.fn(() => () => undefined) };
    startModelProbe(scheduler as any);
    expect(scheduler.every).not.toHaveBeenCalled();
    stopModelProbe();
  });

  it('MODEL_PROBE_ENABLED=1 schedules the job on the 30m cadence', () => {
    process.env.MODEL_PROBE_ENABLED = '1';
    const scheduler = { every: vi.fn(() => () => undefined) };
    startModelProbe(scheduler as any);
    expect(scheduler.every).toHaveBeenCalledTimes(1);
    expect(scheduler.every.mock.calls[0][0]).toBe(30 * 60 * 1000);
    delete process.env.MODEL_PROBE_ENABLED;
    stopModelProbe();
  });
});
