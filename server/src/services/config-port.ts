/**
 * Configuration export/import [fork 10/10].
 *
 * Export snapshots the operator's CONFIG — settings, key routing/metadata, caps
 * and action rules — with every secret stripped. Import applies it back, so a
 * clean install (or a rebuilt phone) reproduces the same behaviour: the operator
 * only re-pastes credentials. Secrets are never exported or imported.
 */
import { getDb } from '../db/index.js';
import { recordAudit } from './audit-log.js';

export interface ExportedConfig {
  version: 1;
  exported_at: string;
  settings: Array<{ key: string; value: string }>;
  keys: Array<Record<string, unknown> & { platform: string; label: string | null }>;
  key_caps: Array<Record<string, unknown>>;
  action_rules: Array<Record<string, unknown>>;
  notification_channels: Array<Record<string, unknown>>;
}

const KEY_COLUMNS = [
  'platform', 'label', 'enabled', 'status', 'weight', 'key_order',
  'rpm_limit', 'tpm_limit', 'rpd_limit', 'monthly_request_cap', 'monthly_token_cap',
  'max_concurrent', 'model_scope_json', 'account_key', 'owner', 'console_url', 'note',
  'tags', 'key_type', 'credits_remaining', 'expires_at', 'expire_reminder_days', 'group_label',
];

const CAP_COLUMNS = [
  'key_id_platform', 'key_id_label', 'account_key', 'model_id', 'window', 'unit', 'cap',
  'reset_type', 'timezone', 'reset_hour', 'reset_day_of_month', 'soft_percent', 'enabled',
];

const RULE_COLUMNS = ['name', 'reason', 'statuses', 'pattern', 'url', 'policy', 'enabled'];

const CHANNEL_COLUMNS = ['kind', 'name', 'url', 'events', 'enabled']; // bot_token/chat_id excluded

const SETTING_REDACT_KEYS = /(token|secret|password|key)/i;

export function exportConfig(): ExportedConfig {
  const db = getDb();

  const settings = (db.prepare('SELECT key, value FROM settings ORDER BY key').all() as Array<{ key: string; value: string }>)
    .map(row => SETTING_REDACT_KEYS.test(row.key) ? { key: row.key, value: '[redacted]' } : row);

  // Key CONFIG only — the credential columns (encrypted_key/iv/auth_tag/proxy_*)
  // are not selected, so there is nothing to strip.
  const keys = (db.prepare(`
    SELECT ${KEY_COLUMNS.join(', ')} FROM api_keys ORDER BY platform, label
  `).all() as unknown[]) as Array<Record<string, unknown> & { platform: string; label: string | null }>;

  // Caps reference their key by (platform, label) so import survives new row ids.
  const keyCaps = (db.prepare(`
    SELECT kc.account_key, kc.model_id, kc.window, kc.unit, kc.cap, kc.reset_type,
           kc.timezone, kc.reset_hour, kc.reset_day_of_month, kc.soft_percent, kc.enabled,
           k.platform AS key_id_platform, k.label AS key_id_label
      FROM key_caps kc
      LEFT JOIN api_keys k ON k.id = kc.key_id
  ORDER BY kc.id
  `).all() as unknown[]) as Array<Record<string, unknown>>;

  const actionRules = db.prepare(`
    SELECT ${RULE_COLUMNS.join(', ')} FROM action_rules ORDER BY id
  `).all() as Array<Record<string, unknown>>;

  const channels = db.prepare(`
    SELECT ${CHANNEL_COLUMNS.join(', ')} FROM notification_channels ORDER BY id
  `).all() as Array<Record<string, unknown>>;

  return { version: 1, exported_at: new Date().toISOString(), settings, keys, key_caps: keyCaps, action_rules: actionRules, notification_channels: channels };
}

export interface ImportReport {
  settings: number;
  keysMatched: number;
  keysSkipped: number;
  caps: number;
  rules: number;
  channels: number;
}

export function importConfig(input: ExportedConfig, actor?: string): ImportReport {
  const db = getDb();
  const report: ImportReport = { settings: 0, keysMatched: 0, keysSkipped: 0, caps: 0, rules: 0, channels: 0 };

  const transaction = db.transaction(() => {
    // 1. Settings.
    const upsertSetting = db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    for (const row of input.settings ?? []) {
      if (SETTING_REDACT_KEYS.test(row.key) || row.value === '[redacted]') continue;
      upsertSetting.run(row.key, row.value);
      report.settings += 1;
    }

    // 2. Key routing/metadata on EXISTING rows, matched by (platform, label).
    //    No key rows are created (a credential must be pasted by the operator);
    //    the config just rides whichever key already has that platform+label.
    for (const row of input.keys ?? []) {
      const existing = db.prepare('SELECT id FROM api_keys WHERE platform = ? AND label = ?')
        .get(row.platform, row.label ?? '') as { id: number } | undefined;
      if (!existing) { report.keysSkipped += 1; continue; }
      const updatables = KEY_COLUMNS.filter(column => row[column] !== undefined);
      const sets = updatables.map(column => `${column} = ?`).join(', ');
      const values = updatables.map(column => row[column]);
      db.prepare(`UPDATE api_keys SET ${sets} WHERE id = ?`).run(...values, existing.id);
      report.keysMatched += 1;
    }

    // 3. Caps (upsert re-resolves key_id from platform+label).
    const keyIdByRef = (platform: unknown, label: unknown): number | null => {
      if (platform == null) return null;
      const row = db.prepare('SELECT id FROM api_keys WHERE platform = ? AND label = ?').get(platform, label ?? '') as { id: number } | undefined;
      return row ? row.id : null;
    };
    for (const cap of input.key_caps ?? []) {
      const keyId = keyIdByRef(cap.key_id_platform, cap.key_id_label);
      if (keyId == null && !cap.account_key) continue; // account-scoped is fine without a key
      db.prepare(`
        INSERT INTO key_caps (key_id, account_key, model_id, window, unit, cap, reset_type, timezone, reset_hour, reset_day_of_month, soft_percent, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        keyId, cap.account_key ?? null, cap.model_id ?? null, cap.window, cap.unit, cap.cap,
        cap.reset_type ?? 'calendar', cap.timezone ?? 'UTC', cap.reset_hour ?? 0,
        cap.reset_day_of_month ?? null, cap.soft_percent ?? 80, cap.enabled ?? 1,
      );
      report.caps += 1;
    }

    // 4. Action rules.
    for (const rule of input.action_rules ?? []) {
      db.prepare(`
        INSERT INTO action_rules (name, reason, statuses, pattern, url, policy, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(rule.name, rule.reason, rule.statuses ?? '401,402,403', rule.pattern, rule.url ?? null, rule.policy ?? 'exclude_from_rotation', rule.enabled ?? 1);
      report.rules += 1;
    }

    // 5. Notification channels (no secrets: bot_token/chat_id absent on export).
    for (const channel of input.notification_channels ?? []) {
      db.prepare(`
        INSERT INTO notification_channels (kind, name, url, events, enabled)
        VALUES (?, ?, ?, ?, ?)
      `).run(channel.kind, channel.name, channel.url ?? null, channel.events ?? '{}', channel.enabled ?? 1);
      report.channels += 1;
    }
  });

  transaction();
  recordAudit({ actor, entityType: 'config', action: 'import', oldValue: null, newValue: `settings:${report.settings} caps:${report.caps} rules:${report.rules} channels:${report.channels}` });
  return report;
}