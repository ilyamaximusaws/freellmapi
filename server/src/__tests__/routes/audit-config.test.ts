import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, setSetting } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { mintDashboardToken } from '../helpers/auth.js';
import { exportConfig, importConfig } from '../../services/config-port.js';

/**
 * [fork 10/10] Audit log + config export/import over the API.
 */

let app: Express;
let dashToken = '';

async function request(method: string, path: string, opts: { body?: unknown; token?: string } = {}) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: {
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const body = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body };
}

function insertKey(label = 'audit-key'): number {
  const { encrypted, iv, authTag } = encrypt('gsk_audit_test');
  const info = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES ('groq', ?, ?, ?, ?, 'healthy', 1)
  `).run(label, encrypted, iv, authTag);
  return Number(info.lastInsertRowid);
}

describe('audit log ([fork 10/10])', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken('audit@example.com');
  });

  beforeEach(() => {
    getDb().exec('DELETE FROM audit_log; DELETE FROM api_keys;');
  });

  it('records a key field change with old and new value', async () => {
    const keyId = insertKey('before-name');
    const res = await request('PATCH', `/api/keys/${keyId}`, { token: dashToken, body: { label: 'after-name' } });
    expect(res.status).toBe(200);

    const audit = await request('GET', '/api/audit?entityType=api_keys', { token: dashToken });
    const entries = (audit.body as { entries: Array<{ field: string; oldValue: string | null; newValue: string }> }).entries;
    const labelChange = entries.find(entry => entry.field === 'label');
    expect(labelChange).toBeTruthy();
    expect(labelChange!.oldValue).toBe('before-name');
    expect(labelChange!.newValue).toBe('after-name');
  });

  it('records a generic mutation (settings) via the middleware', async () => {
    await request('PUT', '/api/notifications/settings', { token: dashToken, body: { readyUpstreamsMin: 5 } });
    const audit = await request('GET', '/api/audit?action=update', { token: dashToken });
    const entries = (audit.body as { entries: Array<{ entityType: string }> }).entries;
    expect(entries.some(entry => entry.entityType === 'notifications' || entry.entityType === 'settings')).toBe(true);
  });

  it('never logs a secret value', async () => {
    const keyId = insertKey();
    // A key change flows through the generic middleware with the (redacted) body.
    await request('PATCH', `/api/keys/${keyId}`, { token: dashToken, body: { key: 'gsk_new_super_secret_key' } });
    const audit = await request('GET', '/api/audit', { token: dashToken });
    const text = JSON.stringify(audit.body);
    expect(text).not.toContain('gsk_new_super_secret_key');
  });

  it('requires auth', async () => {
    const res = await request('GET', '/api/audit');
    expect(res.status).toBe(401);
  });
});

describe('config export/import ([fork 10/10])', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken('config@example.com');
  });

  beforeEach(() => {
    getDb().exec('DELETE FROM api_keys; DELETE FROM key_caps; DELETE FROM settings; DELETE FROM notification_channels; DELETE FROM action_rules;');
  });

  it('export strips secrets, import reproduces settings and caps', async () => {
    const keyId = insertKey('group-key');
    setSetting('payment_provider', 'stripe');
    setSetting('unified_key_secret', 'sk-im-a-secret');
    getDb().prepare('UPDATE api_keys SET owner = ?, key_type = ?, rpm_limit = ? WHERE id = ?')
      .run('alice', 'credits', 42, keyId);
    getDb().prepare(`
      INSERT INTO key_caps (key_id, window, unit, cap, reset_type, timezone, reset_hour, soft_percent, enabled)
      VALUES (?, 'day', 'requests', 500, 'calendar', 'UTC', 0, 80, 1)
    `).run(keyId);

    const exported = exportConfig();

    // No credential columns and no secret material.
    expect(Object.keys(exported.keys[0])).not.toContain('encrypted_key');
    expect(Object.keys(exported.keys[0])).not.toContain('iv');
    const secretSetting = exported.settings.find(row => row.key === 'unified_key_secret');
    expect(secretSetting?.value).toBe('[redacted]');
    // The non-secret setting survives.
    expect(exported.settings.find(row => row.key === 'payment_provider')?.value).toBe('stripe');
    expect(exported.keys[0].owner).toBe('alice');
    expect(exported.keys[0].rpm_limit).toBe(42);
    expect(exported.key_caps).toHaveLength(1);

    // Mutate away, then import back.
    getDb().exec("DELETE FROM settings WHERE key = 'payment_provider'; DELETE FROM key_caps;");
    getDb().prepare('UPDATE api_keys SET rpm_limit = NULL WHERE id = ?').run(keyId);

    const report = importConfig(exported, 'restore@example.com');

    const paymentRow = getDb().prepare("SELECT value FROM settings WHERE key = 'payment_provider'").get() as { value: string } | undefined;
    expect(paymentRow?.value).toBe('stripe');
    expect((getDb().prepare('SELECT COUNT(*) AS c FROM key_caps').get() as { c: number }).c).toBe(1);
    expect(report.caps).toBe(1);
  });
});