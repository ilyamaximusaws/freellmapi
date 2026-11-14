import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { explainRouteForModel } from '../services/router.js';
import { getDb } from '../db/index.js';

/**
 * Router diagnostics [fork 10/10].
 *
 * POST /api/router/dry-run: explain, without side effects, which key the router
 * would pick for a model and why it skipped every other candidate.
 */

export const routerDiagnosticsRouter = Router();

const dryRunSchema = z.object({
  model: z.string().min(1).max(200),
  estimatedTokens: z.number().int().min(1).max(10_000_000).optional(),
}).strict();

routerDiagnosticsRouter.post('/dry-run', (req: Request, res: Response) => {
  const parsed = dryRunSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ') } });
    return;
  }
  res.json(explainRouteForModel(parsed.data.model, parsed.data.estimatedTokens ?? 1000));
});

/**
 * GET /api/router/key-stats: per-key p50/p95 latency, timeout rate and cooldown
 * count over the recent window, so an operator can see at a glance which key is
 * the slow or flaky one.
 */
interface LatencyRow { latency_ms: number }
routerDiagnosticsRouter.get('/key-stats', (_req: Request, res: Response) => {
  const db = getDb();
  const limit = 1000;
  const rows = db.prepare(`
    SELECT key_id AS keyId, latency_ms
      FROM requests
     WHERE key_id IS NOT NULL AND latency_ms > 0
  ORDER BY id DESC
     LIMIT ${limit}
  `).all() as Array<{ keyId: number; latency_ms: number }>;

  const byKey = new Map<number, number[]>();
  for (const row of rows) {
    const list = byKey.get(row.keyId) ?? [];
    list.push(row.latency_ms);
    byKey.set(row.keyId, list);
  }

  const cooldowns = db.prepare(`
    SELECT key_id AS keyId, COUNT(*) AS count FROM rate_limit_cooldowns GROUP BY key_id
  `).all() as Array<{ keyId: number; count: number }>;
  const cooldownMap = new Map(cooldowns.map(row => [row.keyId, row.count]));

  const timeoutRows = db.prepare(`
    SELECT key_id AS keyId, COUNT(*) AS count
      FROM requests
     WHERE key_id IS NOT NULL AND status != 'success'
       AND (error LIKE '%timeout%' OR error LIKE '%stall%' OR error LIKE '%aborted%')
  GROUP BY key_id
  `).all() as Array<{ keyId: number; count: number }>;
  const timeoutCount = new Map(timeoutRows.map(row => [row.keyId, row.count]));
  const successCount = db.prepare(`
    SELECT key_id AS keyId, COUNT(*) AS count FROM requests WHERE key_id IS NOT NULL AND status = 'success' GROUP BY key_id
  `).all() as Array<{ keyId: number; count: number }>;
  const successMap = new Map(successCount.map(row => [row.keyId, row.count]));

  const stats: Array<Record<string, unknown>> = [];
  for (const [keyId, latencies] of byKey) {
    const sorted = latencies.slice().sort((a, b) => a - b);
    const percentile = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
    const timeouts = timeoutCount.get(keyId) ?? 0;
    const successes = successMap.get(keyId) ?? 0;
    stats.push({
      keyId,
      p50Ms: percentile(0.5),
      p95Ms: percentile(0.95),
      timeoutRate: successes + timeouts === 0 ? 0 : Math.round((timeouts / (successes + timeouts)) * 10000) / 10000,
      cooldowns: cooldownMap.get(keyId) ?? 0,
      successCount: successes,
    });
  }
  stats.sort((a, b) => (a.keyId as number) - (b.keyId as number));
  res.json({ stats });
});