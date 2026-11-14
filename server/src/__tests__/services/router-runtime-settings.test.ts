import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import express, { Router } from 'express';
import { initDb, getDb, setSetting } from '../../db/index.js';
import { resolveIntSetting } from '../../lib/runtime-setting.js';
import { resolveTransportParkAfter, getTransportParkAfter, TRANSPORT_PARK_AFTER_SETTING, SUGGESTED_TRANSPORT_PARK_AFTER } from '../../services/health.js';
import {
  streamStallTimeoutMs, resolveStreamStallTimeoutMs, providerTimeoutMs,
  DEFAULT_STREAM_STALL_TIMEOUT_MS, STREAM_STALL_TIMEOUT_SETTING, streamStallTimeoutSettingKey,
} from '../../lib/provider-timeout.js';

const ENV_KEYS = ['HEALTH_TRANSPORT_PARK_AFTER', 'PROVIDER_STREAM_STALL_TIMEOUT_MS', 'PROVIDER_TIMEOUT_GROQ'];
const SAVED = new Map(ENV_KEYS.map(k => [k, process.env[k]]));

/**
 * [fork 3/10] Runtime-tunable router knobs: the settings table wins over the
 * environment, which wins over the built-in default, and every layer is read
 * per call so a change lands on the next request instead of the next restart.
 */
describe('runtime settings ([fork 3/10])', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  afterAll(() => {
    for (const [key, value] of SAVED) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
    getDb().prepare('DELETE FROM settings').run();
  });

  it('falls back to the built-in default and reports the source', () => {
    const resolved = resolveIntSetting({ key: 'nothing_here', envVar: 'HEALTH_TRANSPORT_PARK_AFTER', defaultValue: 7 });
    expect(resolved).toMatchObject({ value: 7, source: 'default', envVar: 'HEALTH_TRANSPORT_PARK_AFTER' });
  });

  it('prefers the environment over the default', () => {
    process.env.HEALTH_TRANSPORT_PARK_AFTER = '4';
    expect(resolveIntSetting({ key: 'nothing_here', envVar: 'HEALTH_TRANSPORT_PARK_AFTER', defaultValue: 7 }))
      .toMatchObject({ value: 4, source: 'env' });
  });

  it('prefers the stored value over the environment', () => {
    process.env.HEALTH_TRANSPORT_PARK_AFTER = '4';
    setSetting('nothing_here', '2');
    const resolved = resolveIntSetting({ key: 'nothing_here', envVar: 'HEALTH_TRANSPORT_PARK_AFTER', defaultValue: 7 });
    expect(resolved).toMatchObject({ value: 2, source: 'db' });
    // The env value is still reported, so the UI can explain the layering.
    expect(resolved.envValue).toBe('4');
  });

  it('skips invalid and empty values at every level instead of clamping', () => {
    setSetting('nothing_here', 'not-a-number');
    process.env.HEALTH_TRANSPORT_PARK_AFTER = '';
    expect(resolveIntSetting({ key: 'nothing_here', envVar: 'HEALTH_TRANSPORT_PARK_AFTER', defaultValue: 7 }).value).toBe(7);

    setSetting('nothing_here', '-3');
    process.env.HEALTH_TRANSPORT_PARK_AFTER = '5';
    expect(resolveIntSetting({ key: 'nothing_here', envVar: 'HEALTH_TRANSPORT_PARK_AFTER', defaultValue: 7 }).value).toBe(5);

    delete process.env.HEALTH_TRANSPORT_PARK_AFTER;
    setSetting('nothing_here', '999999999');
    expect(resolveIntSetting({ key: 'nothing_here', envVar: 'HEALTH_TRANSPORT_PARK_AFTER', defaultValue: 7, max: 100 }).value).toBe(7);
  });

  it('defaults the transport park streak to 6 and honours a stored override', () => {
    expect(SUGGESTED_TRANSPORT_PARK_AFTER).toBe(6);
    expect(resolveTransportParkAfter()).toMatchObject({ value: 6, source: 'default' });

    setSetting(TRANSPORT_PARK_AFTER_SETTING, '2');
    expect(getTransportParkAfter()).toBe(2);
    expect(resolveTransportParkAfter().source).toBe('db');

    // 0 turns parking off, and it must be distinguishable from "unset".
    setSetting(TRANSPORT_PARK_AFTER_SETTING, '0');
    expect(getTransportParkAfter()).toBe(0);
    expect(resolveTransportParkAfter().source).toBe('db');
  });

  it('defaults the stream stall timeout to 30s and prefers the stored value', () => {
    expect(DEFAULT_STREAM_STALL_TIMEOUT_MS).toBe(30_000);
    expect(streamStallTimeoutMs()).toBe(30_000);

    setSetting(STREAM_STALL_TIMEOUT_SETTING, '5000');
    // Applies to the very next call: no restart, no provider reconstruction.
    expect(streamStallTimeoutMs()).toBe(5000);
    expect(streamStallTimeoutMs('groq')).toBe(5000);
    expect(resolveStreamStallTimeoutMs()).toMatchObject({ value: 5000, source: 'db' });

    // A per-platform stored value outranks the global one.
    setSetting(streamStallTimeoutSettingKey('groq'), '1000');
    expect(streamStallTimeoutMs('groq')).toBe(1000);
    expect(streamStallTimeoutMs('cerebras')).toBe(5000);
  });

  it('layers the per-platform chat timeout: stored → env → caller default', () => {
    expect(providerTimeoutMs('groq', 15_000)).toBe(15_000);

    process.env.PROVIDER_TIMEOUT_GROQ = '20000';
    expect(providerTimeoutMs('groq', 15_000)).toBe(20_000);

    setSetting('provider_timeout_ms_groq', '25000');
    expect(providerTimeoutMs('groq', 15_000)).toBe(25_000);

    // 0 means "no timeout" and must survive (never coerced to the default).
    setSetting('provider_timeout_ms_groq', '0');
    expect(providerTimeoutMs('groq', 15_000)).toBe(0);
  });
});

/**
 * The settings API surface: one GET that reports every knob with its effective
 * value and provenance, one PUT that writes or clears values.
 */
describe('GET/PUT /api/settings/router ([fork 3/10])', () => {
  const KNOBS = {
    transportParkAfter: { key: TRANSPORT_PARK_AFTER_SETTING, envVar: 'HEALTH_TRANSPORT_PARK_AFTER', defaultValue: SUGGESTED_TRANSPORT_PARK_AFTER },
    streamStallTimeoutMs: { key: STREAM_STALL_TIMEOUT_SETTING, envVar: 'PROVIDER_STREAM_STALL_TIMEOUT_MS', defaultValue: DEFAULT_STREAM_STALL_TIMEOUT_MS },
  };

  let router: Router;

  beforeAll(async () => {
    const { settingsRouter } = await import('../../routes/settings.js');
    router = settingsRouter;
  });

  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const app = express();
    app.use(express.json());
    app.use('/api/settings', router);
    const server = app.listen(0, '127.0.0.1');
    if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
    const port = (server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => null);
    server.close();
    return { status: res.status, body: json };
  }

  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
    getDb().prepare('DELETE FROM settings').run();
  });

  it('reports every knob with value, source, env var and default', async () => {
    const { status, body } = await call('GET', '/api/settings/router');
    expect(status).toBe(200);
    for (const [name, spec] of Object.entries(KNOBS)) {
      expect(body[name], name).toMatchObject({
        value: spec.defaultValue,
        source: 'default',
        envVar: spec.envVar,
        defaultValue: spec.defaultValue,
      });
    }
    // Fork 2/10 knobs ride along so one page holds every router knob.
    expect(body.keyMaxConcurrentDefault.value).toBe(3);
    expect(body.keyConcurrencyQueueTimeoutMs.value).toBe(3000);
    expect(body.fallbackTimeBudgetMs.value).toBe(45_000);
    expect(body.maxConsecutiveUpstreamFails.value).toBe(0);
  });

  it('writes a value and reflects it immediately, then clears back to the default', async () => {
    const put = await call('PUT', '/api/settings/router', { transportParkAfter: 2, streamStallTimeoutMs: 5000 });
    expect(put.status).toBe(200);
    expect(put.body.transportParkAfter).toMatchObject({ value: 2, source: 'db' });
    expect(getTransportParkAfter()).toBe(2);
    expect(streamStallTimeoutMs()).toBe(5000);

    const cleared = await call('PUT', '/api/settings/router', { streamStallTimeoutMs: null });
    expect(cleared.body.streamStallTimeoutMs).toMatchObject({ value: 30_000, source: 'default' });
    expect(streamStallTimeoutMs()).toBe(30_000);
  });

  it('rejects a malformed payload', async () => {
    const { status } = await call('PUT', '/api/settings/router', { transportParkAfter: 'soon' });
    expect(status).toBe(400);
  });
});