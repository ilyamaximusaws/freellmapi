import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some((candidate) => candidate.name === column);
}

/**
 * Per-client (per-agent) limits [fork 1/10].
 *
 * A "client" is the existing `client_profiles` row (a downstream `sk-cp-...`
 * token minted per agent). We attach per-client resource limits to that table
 * and track their usage in `client_usage`. The unified `freellmapi-...` key is
 * NOT represented by a row — it is treated as the implicit `default` client
 * with all limits 0 (unlimited), so existing callers are untouched.
 *
 * All limit values use 0 = unlimited (no limit), matching key monthly caps.
 *
 * Column semantics:
 *   max_concurrent     max in-flight requests (queued briefly, then 429)
 *   rpm / tpm          sliding-window requests / tokens per minute
 *   daily_request_cap / daily_token_cap    calendar-day (UTC) caps
 *   monthly_request_cap / monthly_token_cap calendar-month (UTC) caps
 *   max_tokens_per_request  reject a single request asking for more (400)
 *   max_request_bytes       reject a body larger than this (413)
 *   profile_id          optional pin: only models of that profile are servable
 *   last_used_at        stamp for the dashboard's "current usage" view
 *
 * DOWN: reversible (drops the added columns, the usage table and the request
 * client_id column).
 */
export function up(db: Db): void {
  const cols: Array<[string, string]> = [
    ['max_concurrent', 'INTEGER NOT NULL DEFAULT 0'],
    ['rpm', 'INTEGER NOT NULL DEFAULT 0'],
    ['tpm', 'INTEGER NOT NULL DEFAULT 0'],
    ['daily_request_cap', 'INTEGER NOT NULL DEFAULT 0'],
    ['daily_token_cap', 'INTEGER NOT NULL DEFAULT 0'],
    ['monthly_request_cap', 'INTEGER NOT NULL DEFAULT 0'],
    ['monthly_token_cap', 'INTEGER NOT NULL DEFAULT 0'],
    ['max_tokens_per_request', 'INTEGER NOT NULL DEFAULT 0'],
    ['max_request_bytes', 'INTEGER NOT NULL DEFAULT 0'],
    ['profile_id', 'INTEGER'],
    ['last_used_at', 'TEXT'],
  ];
  for (const [name, ddl] of cols) {
    if (!hasColumn(db, 'client_profiles', name)) {
      db.prepare(`ALTER TABLE client_profiles ADD COLUMN ${name} ${ddl}`).run();
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS client_usage (
      client_id INTEGER NOT NULL,
      window TEXT NOT NULL,
      requests INTEGER NOT NULL DEFAULT 0,
      tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (client_id, window)
    );
  `);

  if (!hasColumn(db, 'requests', 'client_id')) {
    db.prepare('ALTER TABLE requests ADD COLUMN client_id INTEGER').run();
  }
  db.prepare('CREATE INDEX IF NOT EXISTS idx_requests_client_id_created ON requests(client_id, created_at)').run();

  // Durable usage ledger for daily/monthly caps (the same pattern as
  // key_monthly_usage): pruning request analytics must never reopen a spent
  // client cap, so successful requests settle here via trigger.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS requests_client_usage
    AFTER INSERT ON requests
    WHEN NEW.client_id IS NOT NULL AND NEW.status = 'success'
      AND strftime('%Y-%m-%d', NEW.created_at) IS NOT NULL
    BEGIN
      INSERT INTO client_usage (client_id, window, requests, tokens)
      VALUES (NEW.client_id, strftime('%Y-%m-%d', NEW.created_at), 1,
              MAX(0, NEW.input_tokens) + MAX(0, NEW.output_tokens))
      ON CONFLICT(client_id, window) DO UPDATE SET
        requests = requests + 1,
        tokens = tokens + excluded.tokens;

      INSERT INTO client_usage (client_id, window, requests, tokens)
      VALUES (NEW.client_id, strftime('%Y-%m', NEW.created_at), 1,
              MAX(0, NEW.input_tokens) + MAX(0, NEW.output_tokens))
      ON CONFLICT(client_id, window) DO UPDATE SET
        requests = requests + 1,
        tokens = tokens + excluded.tokens;
    END;
  `);
}

export function down(db: Db): void {
  db.exec('DROP TRIGGER IF EXISTS requests_client_usage;');
  const cols = [
    'max_concurrent', 'rpm', 'tpm',
    'daily_request_cap', 'daily_token_cap',
    'monthly_request_cap', 'monthly_token_cap',
    'max_tokens_per_request', 'max_request_bytes',
    'profile_id', 'last_used_at',
  ];
  for (const name of cols) {
    if (hasColumn(db, 'client_profiles', name)) {
      db.prepare(`ALTER TABLE client_profiles DROP COLUMN ${name}`).run();
    }
  }
  db.exec('DROP TABLE IF EXISTS client_usage;');
  if (hasColumn(db, 'requests', 'client_id')) {
    db.prepare('DROP INDEX IF EXISTS idx_requests_client_id_created').run();
    db.prepare('ALTER TABLE requests DROP COLUMN client_id').run();
  }
}