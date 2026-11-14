/**
 * Key metadata [fork 9/10].
 *
 * Credentials plus context: who owns the account, when the trial/credits die,
 * how much credit is left, which console to open, and free-form tags for bulk
 * operations. Split out of routes/keys.ts so the routers, the notification sweep
 * and the API all read the same shape.
 */
import { getDb } from '../db/index.js';
import type { KeyMetadata, KeyType } from '@freellmapi/shared/types.js';

export const KEY_TYPES: readonly KeyType[] = ['free', 'credits', 'paid'];
export const DEFAULT_EXPIRE_REMINDER_DAYS = 3;

interface MetadataRow {
  id: number;
  owner: string | null;
  console_url: string | null;
  note: string | null;
  tags: string | null;
  key_type: string | null;
  credits_remaining: number | null;
  expires_at: string | null;
  expire_reminder_days: number | null;
}

export function isKeyType(value: unknown): value is KeyType {
  return typeof value === 'string' && (KEY_TYPES as readonly string[]).includes(value);
}

/** Tags are stored as a JSON array; accept a comma list or an array and always
 *  return the normalised, de-duplicated, lower-cased list. */
export function normalizeTags(input: unknown): string[] {
  let parts: string[] = [];
  if (Array.isArray(input)) parts = input.map(part => String(part));
  else if (typeof input === 'string') parts = input.split(',');
  const seen = new Set<string>();
  for (const part of parts) {
    const tag = part.trim().toLowerCase();
    if (tag) seen.add(tag);
  }
  return [...seen];
}

export function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? normalizeTags(parsed) : [];
  } catch {
    return normalizeTags(raw);
  }
}

function toMetadata(row: MetadataRow): KeyMetadata {
  return {
    keyId: row.id,
    owner: row.owner ?? null,
    consoleUrl: row.console_url ?? null,
    note: row.note ?? null,
    tags: parseTags(row.tags),
    keyType: isKeyType(row.key_type) ? row.key_type : 'free',
    creditsRemaining: row.credits_remaining ?? null,
    expiresAt: row.expires_at ?? null,
    expireReminderDays: row.expire_reminder_days ?? DEFAULT_EXPIRE_REMINDER_DAYS,
  };
}

const SELECT = `
  SELECT id, owner, console_url, note, tags, key_type, credits_remaining, expires_at, expire_reminder_days
    FROM api_keys
`;

export function getKeyMetadata(keyId: number): KeyMetadata | null {
  const row = getDb().prepare(`${SELECT} WHERE id = ?`).get(keyId) as MetadataRow | undefined;
  return row ? toMetadata(row) : null;
}

export interface MetadataPatch {
  owner?: string | null;
  consoleUrl?: string | null;
  note?: string | null;
  tags?: unknown;
  keyType?: KeyType | null;
  creditsRemaining?: number | null;
  expiresAt?: string | null;
  expireReminderDays?: number | null;
}

/** Patch only the fields present, so a partial edit never wipes the rest. */
export function setKeyMetadata(keyId: number, patch: MetadataPatch): KeyMetadata | null {
  const sets: string[] = [];
  const values: Array<string | number | null> = [];

  const push = (column: string, value: string | number | null) => {
    sets.push(`${column} = ?`);
    values.push(value);
  };

  if (patch.owner !== undefined) push('owner', patch.owner?.trim() || null);
  if (patch.consoleUrl !== undefined) push('console_url', patch.consoleUrl?.trim() || null);
  if (patch.note !== undefined) push('note', patch.note?.trim() || null);
  if (patch.tags !== undefined) {
    const tags = normalizeTags(patch.tags);
    push('tags', tags.length > 0 ? JSON.stringify(tags) : null);
  }
  if (patch.keyType !== undefined) push('key_type', patch.keyType ?? 'free');
  if (patch.creditsRemaining !== undefined) push('credits_remaining', patch.creditsRemaining);
  if (patch.expiresAt !== undefined) push('expires_at', patch.expiresAt?.trim() || null);
  if (patch.expireReminderDays !== undefined) push('expire_reminder_days', patch.expireReminderDays ?? DEFAULT_EXPIRE_REMINDER_DAYS);

  if (sets.length > 0) {
    getDb().prepare(`UPDATE api_keys SET ${sets.join(', ')} WHERE id = ?`).run(...values, keyId);
  }
  return getKeyMetadata(keyId);
}

/** Every key carrying the tag (case-insensitive, exact tag match). */
export function keysWithTag(tag: string): number[] {
  const wanted = tag.trim().toLowerCase();
  if (!wanted) return [];
  const rows = getDb().prepare(`${SELECT} WHERE tags IS NOT NULL`).all() as MetadataRow[];
  return rows.filter(row => parseTags(row.tags).includes(wanted)).map(row => row.id);
}

/** Bulk enable/disable or metadata edit for a whole tag group. */
export function bulkApplyToTag(
  tag: string,
  patch: MetadataPatch & { enabled?: boolean },
): { updated: number; keyIds: number[] } {
  const keyIds = keysWithTag(tag);
  if (keyIds.length === 0) return { updated: 0, keyIds: [] };

  if (patch.enabled !== undefined) {
    const stmt = getDb().prepare('UPDATE api_keys SET enabled = ? WHERE id = ?');
    for (const id of keyIds) stmt.run(patch.enabled ? 1 : 0, id);
  }
  const metadataPatch: MetadataPatch = { ...patch };
  delete (metadataPatch as { enabled?: boolean }).enabled;
  if (Object.keys(metadataPatch).length > 0) {
    for (const id of keyIds) setKeyMetadata(id, metadataPatch);
  }
  return { updated: keyIds.length, keyIds };
}

export interface ExpiringKey {
  keyId: number;
  label: string;
  platform: string;
  expiresAt: string;
  reminderDays: number;
  daysLeft: number;
}

/** Keys whose expires_at falls inside their own reminder window. `daysLeft` is
 *  fractional and may be negative (a date that has already passed). */
export function expiringKeys(now = Date.now()): ExpiringKey[] {
  const rows = getDb().prepare(`
    SELECT id, label, platform, expires_at, expire_reminder_days
      FROM api_keys
     WHERE expires_at IS NOT NULL AND expires_at <> '' AND enabled = 1
  `).all() as Array<{ id: number; label: string | null; platform: string; expires_at: string; expire_reminder_days: number | null }>;

  const out: ExpiringKey[] = [];
  for (const row of rows) {
    const expiresMs = Date.parse(row.expires_at);
    if (!Number.isFinite(expiresMs)) continue;
    const reminderDays = row.expire_reminder_days ?? DEFAULT_EXPIRE_REMINDER_DAYS;
    const daysLeft = (expiresMs - now) / 86_400_000;
    if (daysLeft <= reminderDays) {
      out.push({
        keyId: row.id,
        label: row.label ?? `#${row.id}`,
        platform: row.platform,
        expiresAt: row.expires_at,
        reminderDays,
        daysLeft: Math.round(daysLeft * 100) / 100,
      });
    }
  }
  return out;
}

/** Tag → number of keys, for the dashboard's group list. */
export function tagSummary(): Array<{ tag: string; keys: number }> {
  const rows = getDb().prepare(`${SELECT} WHERE tags IS NOT NULL`).all() as MetadataRow[];
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const tag of parseTags(row.tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()].map(([tag, keys]) => ({ tag, keys })).sort((a, b) => a.tag.localeCompare(b.tag));
}