import type { Db } from '../types.js';

function hasTable(db: Db, table: string): boolean {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table) !== undefined;
}

/**
 * Action needed [fork 5/10].
 *
 * A key can be perfectly valid and still be unusable until a human does
 * something on the provider's site: confirm a phone number, accept new terms,
 * add a card, solve a captcha, claim the daily free bonus. Before this, the only
 * symptom was a key that kept answering 401/402/403 — indistinguishable from a
 * dead credential, so the operator either replaced a working key or, worse,
 * never noticed and wondered why a platform was never routed to.
 *
 * `key_action_needed` holds at most ONE active row per key (enforced by a
 * partial unique index), because two simultaneous "do this" prompts on one key
 * is a support ticket, not a feature. `action_rules` holds the auto-detection
 * rules: a regex over the provider's error text plus the statuses it applies to,
 * mapping to a reason. Rules are data, so they are editable from the dashboard
 * instead of requiring a release every time a provider rewords its paywall.
 *
 * Recurrence covers the daily-claim case: a cleared flag with a recurrence is
 * re-raised by the scheduler at the next due moment (every N hours, or a fixed
 * time of day in a timezone), so the operator's reminder survives the "done".
 *
 * DOWN: reversible (drops both tables).
 */
export function up(db: Db): void {
  if (!hasTable(db, 'key_action_needed')) {
    db.exec(`
      CREATE TABLE key_action_needed (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key_id INTEGER NOT NULL,
        reason TEXT NOT NULL CHECK (reason IN (
          'verify_phone', 'accept_tos', 'add_card', 'captcha',
          'trial_expired', 'daily_claim', 'rotate_key', 'other'
        )),
        url TEXT,
        note TEXT,
        policy TEXT NOT NULL DEFAULT 'exclude_from_rotation'
          CHECK (policy IN ('inform_only', 'exclude_from_rotation')),
        source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'auto')),
        rule_id INTEGER,
        recurrence_kind TEXT NOT NULL DEFAULT 'none'
          CHECK (recurrence_kind IN ('none', 'interval', 'daily')),
        recurrence_hours INTEGER,
        recurrence_hour INTEGER,
        timezone TEXT NOT NULL DEFAULT 'UTC',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        cleared_at TEXT,
        snoozed_until_ms INTEGER,
        active INTEGER NOT NULL DEFAULT 1,
        next_due_ms INTEGER
      );
      CREATE UNIQUE INDEX idx_key_action_active ON key_action_needed(key_id) WHERE active = 1;
      CREATE INDEX idx_key_action_next_due ON key_action_needed(next_due_ms) WHERE active = 0;
    `);
  }

  if (!hasTable(db, 'action_rules')) {
    db.exec(`
      CREATE TABLE action_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        reason TEXT NOT NULL CHECK (reason IN (
          'verify_phone', 'accept_tos', 'add_card', 'captcha',
          'trial_expired', 'daily_claim', 'rotate_key', 'other'
        )),
        statuses TEXT NOT NULL DEFAULT '401,402,403',
        pattern TEXT NOT NULL,
        url TEXT,
        policy TEXT NOT NULL DEFAULT 'exclude_from_rotation'
          CHECK (policy IN ('inform_only', 'exclude_from_rotation')),
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    // Built-in rules carry the migration's own stamp rather than datetime('now'):
    // a seed whose values come from the wall clock makes a migration
    // non-deterministic, and the up/down/up round-trip check compares two ups
    // that land in different seconds. Rules created later still default to
    // datetime('now').
    const SEEDED_AT = '2026-11-14 00:00:00';
    const insert = db.prepare(`
      INSERT INTO action_rules (name, reason, statuses, pattern, url, policy, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const seed = (name: string, reason: string, statuses: string, pattern: string, url: string | null, policy: string) =>
      insert.run(name, reason, statuses, pattern, url, policy, SEEDED_AT, SEEDED_AT);

    // Seeded from the phrasings actually observed in provider error bodies.
    seed(
      'Out of credits / balance',
      'add_card', '401,402,403',
      'insufficient (balance|credit|quota)|out of credit|no credit|payment required|billing',
      null, 'exclude_from_rotation',
    );
    seed(
      'Phone verification',
      'verify_phone', '401,402,403',
      'verify your (phone|number)|phone verification|unverified (phone|account)',
      null, 'exclude_from_rotation',
    );
    seed(
      'Terms of service',
      'accept_tos', '401,402,403',
      'accept (the )?(new )?terms|terms of (service|use)|tos (update|acceptance)',
      null, 'exclude_from_rotation',
    );
    seed(
      'Captcha / challenge',
      'captcha', '401,402,403',
      'captcha|challenge required|human verification',
      null, 'exclude_from_rotation',
    );
    seed(
      'Trial ended',
      'trial_expired', '401,402,403',
      'trial (has )?(expired|ended)|free trial over',
      null, 'exclude_from_rotation',
    );
    seed(
      'Daily check-in',
      'daily_claim', '402',
      'daily check-?in|daily (bonus|claim)',
      null, 'exclude_from_rotation',
    );
    seed(
      'Key revoked',
      'rotate_key', '401,403',
      'invalid api key|api key (revoked|deleted|expired)|key (was )?revoked',
      null, 'inform_only',
    );
  }
}

export function down(db: Db): void {
  db.exec('DROP TABLE IF EXISTS key_action_needed;');
  db.exec('DROP TABLE IF EXISTS action_rules;');
}