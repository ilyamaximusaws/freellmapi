/**
 * Audit log service [fork 10/10].
 *
 * Single write path for the observable "who changed what". Callers pass an
 * entity, an action and optionally a per-field before/after, and this module
 * redacts secrets and writes one row per field. The generic request middleware
 * (middleware/audit.ts) covers mutations that never get a bespoke hook; targeted
 * calls here add the OLD value those generic rows cannot see.
 */
import { getDb } from '../db/index.js';

export interface AuditEntry {
  actor?: string;
  entityType: string;
  entityId?: string | number | null;
  action: 'create' | 'update' | 'delete' | 'set' | 'import' | 'export';
  field?: string;
  oldValue?: unknown;
  newValue?: unknown;
}

const SECRET_FIELD_PATTERN = /(key|token|secret|password|credential|auth_tag|iv|proxy)/i;
const SECRET_VALUE_PATTERN = /\b(sk-[A-Za-z0-9_-]{8,}|gsk_[A-Za-z0-9_=-]{8,}|Bearer\s+\S+|xox[bap]-[A-Za-z0-9-]{10,})\b/;

export function redactSecretValue(value: unknown): string {
  const text = value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  return text.replace(SECRET_VALUE_PATTERN, '[redacted]');
}

export function isSecretField(field: string): boolean {
  return SECRET_FIELD_PATTERN.test(field);
}

/** Record one audit row per field that actually changed (or one '*' row when
 *  there is no field-level diff). */
export function recordAudit(entry: AuditEntry): void {
  const actor = entry.actor?.trim() || 'system';
  const entityId = entry.entityId == null ? null : String(entry.entityId);
  const field = entry.field || '*';
  const changed = entry.oldValue !== undefined || entry.newValue !== undefined;

  if (!changed) {
    getDb().prepare(`
      INSERT INTO audit_log (actor, entity_type, entity_id, action, field, old_value, new_value)
      VALUES (?, ?, ?, ?, ?, NULL, NULL)
    `).run(actor, entry.entityType, entityId, entry.action, field);
    return;
  }

  const oldRaw = isSecretField(field) ? '[redacted]' : redactSecretValue(entry.oldValue);
  const newRaw = isSecretField(field) ? '[redacted]' : redactSecretValue(entry.newValue);
  getDb().prepare(`
    INSERT INTO audit_log (actor, entity_type, entity_id, action, field, old_value, new_value)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(actor, entry.entityType, entityId, entry.action, field, oldRaw, newRaw);
}

export interface AuditFilter {
  entityType?: string;
  entityId?: string;
  actor?: string;
  action?: string;
  limit?: number;
}

export function listAudit(filter: AuditFilter = {}): unknown[] {
  const clauses: string[] = [];
  const values: string[] = [];
  if (filter.entityType) { clauses.push('entity_type = ?'); values.push(filter.entityType); }
  if (filter.entityId) { clauses.push('entity_id = ?'); values.push(filter.entityId); }
  if (filter.actor) { clauses.push('actor = ?'); values.push(filter.actor); }
  if (filter.action) { clauses.push('action = ?'); values.push(filter.action); }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(filter.limit ?? 200, 1000));
  return getDb().prepare(`
    SELECT id, actor, entity_type AS entityType, entity_id AS entityId, action, field, old_value AS oldValue, new_value AS newValue, created_at AS createdAt
      FROM audit_log
      ${where}
  ORDER BY id DESC
     LIMIT ?
  `).all(...values, limit);
}

/** The audit log currently in the DB (used by export/import parity tests). */
export function auditCount(): number {
  return (getDb().prepare('SELECT COUNT(*) AS c FROM audit_log').get() as { c: number }).c;
}