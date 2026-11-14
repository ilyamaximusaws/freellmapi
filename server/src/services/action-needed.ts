/**
 * Action needed [fork 5/10].
 *
 * Some keys are valid but unusable until a human does something on the
 * provider's site. The gateway only saw the symptom — a key answering 401/402/403
 * forever — which looks exactly like a dead credential. This module turns that
 * symptom into a first-class state:
 *
 *   - one active flag per key (reason, url, note, policy);
 *   - `exclude_from_rotation` removes the key from routing, `inform_only` only
 *     surfaces it (a revoked key is informational; an unverified one wastes
 *     every request);
 *   - auto-detection from provider error text via editable rules;
 *   - recurrence for the daily-claim case: a cleared flag with an interval or a
 *     time-of-day is re-raised by `raiseDueActions()`, which the scheduler calls;
 *   - snooze: a snoozed flag stops being surfaced and stops notifying until it
 *     wakes, without losing the underlying state.
 *
 * Clearing is either manual ("done") or automatic when a health probe or a
 * served request proves the key works again — see `noteKeySuccess()`.
 */
import { getDb } from '../db/index.js';
import { providerLog } from '../lib/server-logs.js';

export const ACTION_REASONS = [
  'verify_phone', 'accept_tos', 'add_card', 'captcha',
  'trial_expired', 'daily_claim', 'rotate_key', 'other',
] as const;
export type ActionReason = (typeof ACTION_REASONS)[number];

export const ACTION_POLICIES = ['inform_only', 'exclude_from_rotation'] as const;
export type ActionPolicy = (typeof ACTION_POLICIES)[number];

export const RECURRENCE_KINDS = ['none', 'interval', 'daily'] as const;
export type RecurrenceKind = (typeof RECURRENCE_KINDS)[number];

/** Reasonable bounds: a recurrence under an hour is a polling loop, and over a
 *  month is not a "daily claim" any more. */
export const MIN_RECURRENCE_HOURS = 1;
export const MAX_RECURRENCE_HOURS = 24 * 31;
export const DEFAULT_SNOOZE_HOURS = 4;

export interface ActionFlag {
  id: number;
  keyId: number;
  reason: ActionReason;
  url: string | null;
  note: string | null;
  policy: ActionPolicy;
  source: 'manual' | 'auto';
  ruleId: number | null;
  recurrenceKind: RecurrenceKind;
  recurrenceHours: number | null;
  recurrenceHour: number | null;
  timezone: string;
  createdAt: string;
  updatedAt: string;
  clearedAt: string | null;
  snoozedUntilMs: number | null;
  /** Epoch ms of the next automatic re-raise (recurrence only). */
  nextDueMs: number | null;
}

export interface ActionRule {
  id: number;
  name: string;
  reason: ActionReason;
  statuses: number[];
  pattern: string;
  url: string | null;
  policy: ActionPolicy;
  enabled: boolean;
}

export interface RaiseInput {
  keyId: number;
  reason: ActionReason;
  url?: string | null;
  note?: string | null;
  policy?: ActionPolicy;
  source?: 'manual' | 'auto';
  ruleId?: number | null;
  recurrenceKind?: RecurrenceKind;
  recurrenceHours?: number | null;
  recurrenceHour?: number | null;
  timezone?: string;
}

interface ActionRow {
  id: number;
  key_id: number;
  reason: ActionReason;
  url: string | null;
  note: string | null;
  policy: ActionPolicy;
  source: 'manual' | 'auto';
  rule_id: number | null;
  recurrence_kind: RecurrenceKind;
  recurrence_hours: number | null;
  recurrence_hour: number | null;
  timezone: string;
  created_at: string;
  updated_at: string;
  cleared_at: string | null;
  snoozed_until_ms: number | null;
  active: number;
  next_due_ms: number | null;
}

function toFlag(row: ActionRow): ActionFlag {
  return {
    id: row.id,
    keyId: row.key_id,
    reason: row.reason,
    url: row.url,
    note: row.note,
    policy: row.policy,
    source: row.source,
    ruleId: row.rule_id,
    recurrenceKind: row.recurrence_kind,
    recurrenceHours: row.recurrence_hours,
    recurrenceHour: row.recurrence_hour,
    timezone: row.timezone,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    clearedAt: row.cleared_at,
    snoozedUntilMs: row.snoozed_until_ms,
    nextDueMs: row.next_due_ms,
  };
}

// ── Recurrence math ─────────────────────────────────────────────────────────

function safeTimezone(timeZone: string | null | undefined): string {
  const candidate = (timeZone ?? 'UTC').trim() || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate });
    return candidate;
  } catch {
    return 'UTC';
  }
}

/**
 * When a flag raised `fromMs` is next due. Pure so the schedule is testable.
 *
 * `interval` counts from the raise time: a claim that resets every 24h is due
 * 24h after it was last satisfied. `daily` pins a wall-clock hour in the flag's
 * timezone — a claim that resets at 00:00 provider time, not 24h after whatever
 * moment the operator happened to click.
 */
export function nextDueAt(
  kind: RecurrenceKind,
  options: { hours?: number | null; hour?: number | null; timezone?: string },
  fromMs: number,
): number | null {
  if (kind === 'none') return null;
  if (kind === 'interval') {
    const hours = Math.min(MAX_RECURRENCE_HOURS, Math.max(MIN_RECURRENCE_HOURS, options.hours ?? 24));
    return fromMs + hours * 3_600_000;
  }
  // daily: the next occurrence of `hour` in the flag's zone, strictly after now.
  const timeZone = safeTimezone(options.timezone);
  const hour = Math.min(23, Math.max(0, options.hour ?? 0));
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(fromMs));
  const bag: Record<string, string> = {};
  for (const part of parts) if (part.type !== 'literal') bag[part.type] = part.value;
  const wallAsUtc = Date.UTC(
    Number(bag.year), Number(bag.month) - 1, Number(bag.day),
    Number(bag.hour) % 24, Number(bag.minute), Number(bag.second),
  );
  // Offset of the zone at this instant, applied to place the target hour in UTC.
  const offset = wallAsUtc - fromMs;
  const dayStart = wallAsUtc - (Number(bag.hour) % 24) * 3_600_000
    - Number(bag.minute) * 60_000 - Number(bag.second) * 1000;
  let target = dayStart + hour * 3_600_000 - offset;
  if (target <= fromMs) target += 86_400_000;
  return target;
}

// ── Rules ───────────────────────────────────────────────────────────────────

function ruleFromRow(row: {
  id: number; name: string; reason: ActionReason; statuses: string;
  pattern: string; url: string | null; policy: ActionPolicy; enabled: number;
}): ActionRule {
  return {
    id: row.id,
    name: row.name,
    reason: row.reason,
    statuses: row.statuses.split(',').map(s => Number(s.trim())).filter(Number.isFinite),
    pattern: row.pattern,
    url: row.url,
    policy: row.policy,
    enabled: row.enabled === 1,
  };
}

export function listActionRules(): ActionRule[] {
  const rows = getDb().prepare('SELECT * FROM action_rules ORDER BY id').all() as Parameters<typeof ruleFromRow>[0][];
  return rows.map(ruleFromRow);
}

export interface RuleMatch {
  rule: ActionRule;
  reason: ActionReason;
  policy: ActionPolicy;
  url: string | null;
}

/**
 * Which rule (if any) explains this failure. First match wins, in id order, so
 * a specific rule added later can be ordered above a broad one by its id.
 * Statuses default to 401/402/403; a rule that lists them does not fire on a
 * 429 or a 500 — those are transient, not "go do something".
 */
export function matchActionRule(
  status: number | undefined,
  message: string,
  rules: ActionRule[] = listActionRules(),
): RuleMatch | null {
  const text = String(message ?? '').toLowerCase();
  if (!text && status === undefined) return null;
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (status !== undefined && rule.statuses.length > 0 && !rule.statuses.includes(status)) continue;
    let re: RegExp;
    try {
      re = new RegExp(rule.pattern, 'i');
    } catch {
      // A broken pattern must not take down request handling.
      continue;
    }
    if (re.test(text)) return { rule, reason: rule.reason, policy: rule.policy, url: rule.url };
  }
  return null;
}

export interface RuleInput {
  name: string;
  reason: ActionReason;
  statuses?: number[];
  pattern: string;
  url?: string | null;
  policy?: ActionPolicy;
  enabled?: boolean;
}

export function validateRule(input: RuleInput): string | null {
  if (!input.name?.trim()) return 'name is required';
  if (!ACTION_REASONS.includes(input.reason)) return `unknown reason ${input.reason}`;
  if (!input.pattern?.trim()) return 'pattern is required';
  try {
    new RegExp(input.pattern);
  } catch (err) {
    return `invalid pattern: ${(err as Error).message}`;
  }
  if (input.policy && !ACTION_POLICIES.includes(input.policy)) return `unknown policy ${input.policy}`;
  for (const status of input.statuses ?? []) {
    if (!Number.isInteger(status) || status < 100 || status > 599) return `invalid status ${status}`;
  }
  return null;
}

export function createActionRule(input: RuleInput): ActionRule {
  const problem = validateRule(input);
  if (problem) throw new Error(problem);
  const info = getDb().prepare(`
    INSERT INTO action_rules (name, reason, statuses, pattern, url, policy, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.name.trim(),
    input.reason,
    (input.statuses ?? [401, 402, 403]).join(','),
    input.pattern,
    input.url ?? null,
    input.policy ?? 'exclude_from_rotation',
    input.enabled === false ? 0 : 1,
  );
  const row = getDb().prepare('SELECT * FROM action_rules WHERE id = ?').get(info.lastInsertRowid);
  return ruleFromRow(row as Parameters<typeof ruleFromRow>[0]);
}

export function updateActionRule(id: number, patch: Partial<RuleInput>): ActionRule | null {
  const existing = getDb().prepare('SELECT * FROM action_rules WHERE id = ?').get(id) as
    Parameters<typeof ruleFromRow>[0] | undefined;
  if (!existing) return null;
  const current = ruleFromRow(existing);
  const merged: RuleInput = {
    name: patch.name ?? current.name,
    reason: patch.reason ?? current.reason,
    statuses: patch.statuses ?? current.statuses,
    pattern: patch.pattern ?? current.pattern,
    url: patch.url !== undefined ? patch.url : current.url,
    policy: patch.policy ?? current.policy,
    enabled: patch.enabled ?? current.enabled,
  };
  const problem = validateRule(merged);
  if (problem) throw new Error(problem);
  getDb().prepare(`
    UPDATE action_rules
       SET name = ?, reason = ?, statuses = ?, pattern = ?, url = ?, policy = ?, enabled = ?,
           updated_at = datetime('now')
     WHERE id = ?
  `).run(
    merged.name.trim(), merged.reason, (merged.statuses ?? []).join(','), merged.pattern,
    merged.url ?? null, merged.policy ?? 'exclude_from_rotation', merged.enabled === false ? 0 : 1, id,
  );
  const row = getDb().prepare('SELECT * FROM action_rules WHERE id = ?').get(id);
  return ruleFromRow(row as Parameters<typeof ruleFromRow>[0]);
}

export function deleteActionRule(id: number): boolean {
  return getDb().prepare('DELETE FROM action_rules WHERE id = ?').run(id).changes > 0;
}

// ── Flags ───────────────────────────────────────────────────────────────────

export function validateRaise(input: RaiseInput): string | null {
  if (!Number.isInteger(input.keyId) || input.keyId <= 0) return 'keyId must be a positive integer';
  if (!ACTION_REASONS.includes(input.reason)) return `unknown reason ${input.reason}`;
  if (input.policy && !ACTION_POLICIES.includes(input.policy)) return `unknown policy ${input.policy}`;
  const kind = input.recurrenceKind ?? 'none';
  if (!RECURRENCE_KINDS.includes(kind)) return `unknown recurrenceKind ${kind}`;
  if (kind === 'interval') {
    const hours = input.recurrenceHours ?? 24;
    if (!Number.isInteger(hours) || hours < MIN_RECURRENCE_HOURS || hours > MAX_RECURRENCE_HOURS) {
      return `recurrenceHours must be ${MIN_RECURRENCE_HOURS}..${MAX_RECURRENCE_HOURS}`;
    }
  }
  if (kind === 'daily') {
    const hour = input.recurrenceHour ?? 0;
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return 'recurrenceHour must be 0..23';
  }
  if (input.url) {
    try {
      const u = new URL(input.url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'url must be http(s)';
    } catch {
      return 'url must be an absolute http(s) URL';
    }
  }
  return null;
}

/**
 * Raise (or update) the active flag for a key. Idempotent by design: a key that
 * fails the same way five times in one request must not produce five prompts,
 * and the partial unique index would reject the insert anyway — so an existing
 * active flag is UPDATED (a manual note is preserved, the machine-detected
 * reason/policy is refreshed) rather than duplicated.
 */
export function raiseAction(input: RaiseInput, now = Date.now()): ActionFlag {
  const problem = validateRaise(input);
  if (problem) throw new Error(problem);
  const db = getDb();
  const existing = db.prepare('SELECT * FROM key_action_needed WHERE key_id = ? AND active = 1')
    .get(input.keyId) as ActionRow | undefined;

  const kind = input.recurrenceKind ?? existing?.recurrence_kind ?? 'none';
  const hours = input.recurrenceHours ?? existing?.recurrence_hours ?? (kind === 'interval' ? 24 : null);
  const hour = input.recurrenceHour ?? existing?.recurrence_hour ?? (kind === 'daily' ? 0 : null);
  const timezone = safeTimezone(input.timezone ?? existing?.timezone);

  if (existing) {
    db.prepare(`
      UPDATE key_action_needed
         SET reason = ?, url = COALESCE(?, url), note = COALESCE(?, note), policy = ?,
             source = ?, rule_id = COALESCE(?, rule_id),
             recurrence_kind = ?, recurrence_hours = ?, recurrence_hour = ?, timezone = ?,
             next_due_ms = ?, updated_at = datetime('now')
       WHERE id = ?
    `).run(
      input.reason,
      input.url ?? null,
      input.note ?? null,
      input.policy ?? existing.policy,
      input.source ?? existing.source,
      input.ruleId ?? null,
      kind, hours, hour, timezone,
      nextDueAt(kind, { hours, hour, timezone }, now),
      existing.id,
    );
    const row = db.prepare('SELECT * FROM key_action_needed WHERE id = ?').get(existing.id) as ActionRow;
    return toFlag(row);
  }

  const info = db.prepare(`
    INSERT INTO key_action_needed
      (key_id, reason, url, note, policy, source, rule_id,
       recurrence_kind, recurrence_hours, recurrence_hour, timezone, next_due_ms, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    input.keyId, input.reason, input.url ?? null, input.note ?? null,
    input.policy ?? 'exclude_from_rotation', input.source ?? 'manual', input.ruleId ?? null,
    kind, hours, hour, timezone,
    nextDueAt(kind, { hours, hour, timezone }, now),
  );
  const row = db.prepare('SELECT * FROM key_action_needed WHERE id = ?').get(info.lastInsertRowid) as ActionRow;
  providerLog('warn',
    `[action] key ${input.keyId} needs action: ${input.reason}` +
      `${input.source === 'auto' ? ' (detected)' : ''} — ${input.policy === 'exclude_from_rotation' ? 'excluded from rotation' : 'informational'}`,
    { event: 'action_needed.created' });
  return toFlag(row);
}

/** The active flag for a key, if any (snoozed or not). */
export function getAction(keyId: number): ActionFlag | null {
  const row = getDb().prepare('SELECT * FROM key_action_needed WHERE key_id = ? AND active = 1')
    .get(keyId) as ActionRow | undefined;
  return row ? toFlag(row) : null;
}

export function listActions(options: { includeSnoozed?: boolean; now?: number } = {}): Array<ActionFlag & { snoozed: boolean }> {
  const now = options.now ?? Date.now();
  const rows = getDb().prepare('SELECT * FROM key_action_needed WHERE active = 1 ORDER BY id').all() as ActionRow[];
  return rows
    .map(row => {
      const flag = toFlag(row);
      const snoozed = flag.snoozedUntilMs != null && flag.snoozedUntilMs > now;
      return { ...flag, snoozed };
    })
    .filter(flag => options.includeSnoozed || !flag.snoozed);
}

/** Key ids the router must not use: an active, non-snoozed exclude flag. */
export function excludedKeyIds(now = Date.now()): Set<number> {
  const rows = getDb().prepare(`
    SELECT key_id, snoozed_until_ms FROM key_action_needed
     WHERE active = 1 AND policy = 'exclude_from_rotation'
  `).all() as { key_id: number; snoozed_until_ms: number | null }[];
  const out = new Set<number>();
  for (const row of rows) {
    // A snoozed flag still excludes: "remind me later" is about the prompt, not
    // about the key suddenly working.
    void now;
    out.add(row.key_id);
  }
  return out;
}

export function isKeyExcluded(keyId: number): boolean {
  const row = getDb().prepare(`
    SELECT 1 FROM key_action_needed
     WHERE key_id = ? AND active = 1 AND policy = 'exclude_from_rotation'
  `).get(keyId);
  return row !== undefined;
}

/**
 * Clear the active flag. A recurring flag is not deleted but re-armed: `active`
 * goes to 0 with `next_due_ms` set, so `raiseDueActions()` brings it back on
 * schedule and the history of "done" is kept. A one-shot flag is simply closed.
 */
export function clearAction(keyId: number, options: { now?: number } = {}): boolean {
  const now = options.now ?? Date.now();
  const db = getDb();
  const row = db.prepare('SELECT * FROM key_action_needed WHERE key_id = ? AND active = 1')
    .get(keyId) as ActionRow | undefined;
  if (!row) return false;
  const nextDue = row.recurrence_kind === 'none'
    ? null
    : nextDueAt(row.recurrence_kind, {
        hours: row.recurrence_hours, hour: row.recurrence_hour, timezone: row.timezone,
      }, now);
  db.prepare(`
    UPDATE key_action_needed
       SET active = 0, cleared_at = datetime('now'), updated_at = datetime('now'),
           snoozed_until_ms = NULL, next_due_ms = ?
     WHERE id = ?
  `).run(nextDue, row.id);
  return true;
}

/** Suppress the prompt until `untilMs`; the flag itself stays active. */
export function snoozeAction(keyId: number, hours = DEFAULT_SNOOZE_HOURS, now = Date.now()): ActionFlag | null {
  const h = Number.isFinite(hours) && hours > 0 ? Math.min(24 * 30, hours) : DEFAULT_SNOOZE_HOURS;
  const db = getDb();
  const row = db.prepare('SELECT * FROM key_action_needed WHERE key_id = ? AND active = 1')
    .get(keyId) as ActionRow | undefined;
  if (!row) return null;
  db.prepare(`
    UPDATE key_action_needed SET snoozed_until_ms = ?, updated_at = datetime('now') WHERE id = ?
  `).run(now + h * 3_600_000, row.id);
  const updated = db.prepare('SELECT * FROM key_action_needed WHERE id = ?').get(row.id) as ActionRow;
  return toFlag(updated);
}

/** Re-raise every recurring flag whose next due moment has passed. */
export function raiseDueActions(now = Date.now()): number[] {
  const db = getDb();
  const due = db.prepare(`
    SELECT * FROM key_action_needed
     WHERE active = 0 AND next_due_ms IS NOT NULL AND next_due_ms <= ?
  `).all(now) as ActionRow[];
  const raised: number[] = [];
  for (const row of due) {
    db.prepare(`
      UPDATE key_action_needed
         SET active = 1, cleared_at = NULL, snoozed_until_ms = NULL, updated_at = datetime('now'),
             next_due_ms = ?
       WHERE id = ?
    `).run(
      nextDueAt(row.recurrence_kind, {
        hours: row.recurrence_hours, hour: row.recurrence_hour, timezone: row.timezone,
      }, now),
      row.id,
    );
    raised.push(row.key_id);
    providerLog('warn',
      `[action] key ${row.key_id} needs action again: ${row.reason} (recurring)`,
      { event: 'action_needed.created' });
  }
  return raised;
}

/**
 * Auto-detect from a provider failure. Called from the failover path, so it must
 * stay cheap: the rule list is one small table read, and nothing is written
 * unless a rule actually matches.
 */
export function detectAction(keyId: number, status: number | undefined, message: string): ActionFlag | null {
  try {
    const match = matchActionRule(status, message);
    if (!match) return null;
    const existing = getAction(keyId);
    // A manual flag is the operator's statement; do not overwrite its reason.
    if (existing && existing.source === 'manual') return existing;
    if (existing && existing.reason === match.reason) return existing;
    return raiseAction({
      keyId,
      reason: match.reason,
      url: match.url,
      policy: match.policy,
      source: 'auto',
      ruleId: match.rule.id,
      note: `detected from upstream ${status ?? 'error'}: ${String(message ?? '').slice(0, 200)}`,
    });
  } catch {
    // Detection is diagnostic; it must never break the request that failed.
    return null;
  }
}

/**
 * A key that just served a request (or passed a probe) no longer needs manual
 * action — that is the strongest possible evidence the operator did it. Only
 * one-shot flags clear this way; a recurring one keeps its schedule, otherwise
 * the daily claim would be silently un-scheduled by any successful request.
 */
export function noteKeySuccess(keyId: number, now = Date.now()): boolean {
  const row = getDb().prepare('SELECT * FROM key_action_needed WHERE key_id = ? AND active = 1')
    .get(keyId) as ActionRow | undefined;
  if (!row) return false;
  if (row.recurrence_kind !== 'none') return false;
  return clearAction(keyId, { now });
}

export interface ActionSummary {
  total: number;
  excluded: number;
  byReason: Record<string, number>;
}

/** Home-page badge source: how many keys need something, snoozed excluded. */
export function actionSummary(now = Date.now()): ActionSummary {
  const flags = listActions({ now });
  const byReason: Record<string, number> = {};
  let excluded = 0;
  for (const flag of flags) {
    byReason[flag.reason] = (byReason[flag.reason] ?? 0) + 1;
    if (flag.policy === 'exclude_from_rotation') excluded += 1;
  }
  return { total: flags.length, excluded, byReason };
}

/** Test hook. */
export function resetActionState(): void {
  // Nothing is cached in-process today; kept so tests can call it uniformly.
}