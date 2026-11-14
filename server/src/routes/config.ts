import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { exportConfig, importConfig } from '../services/config-port.js';
import { recordAudit } from '../services/audit-log.js';

/**
 * Config export/import [fork 10/10].
 *
 * GET /api/config/export returns the operator's config as JSON with every secret
 * stripped; POST /api/config/import applies a previously exported document back.
 */

export const configRouter = Router();

configRouter.get('/export', (_req: Request, res: Response) => {
  const actor = (_req as Request & { user?: { email?: string } }).user?.email;
  recordAudit({ actor, entityType: 'config', action: 'export', oldValue: null, newValue: null });
  res.json(exportConfig());
});

const importSchema = z.object({
  version: z.number().int().positive(),
  settings: z.array(z.object({ key: z.string().min(1), value: z.string() })).optional(),
  keys: z.array(z.record(z.string(), z.unknown())).optional(),
  key_caps: z.array(z.record(z.string(), z.unknown())).optional(),
  action_rules: z.array(z.record(z.string(), z.unknown())).optional(),
  notification_channels: z.array(z.record(z.string(), z.unknown())).optional(),
}).strict();

configRouter.post('/import', (req: Request, res: Response) => {
  const parsed = importSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ') } });
    return;
  }
  const actor = (req as Request & { user?: { email?: string } }).user?.email ?? 'system';
  const report = importConfig(parsed.data as Parameters<typeof importConfig>[0], actor);
  res.json(report);
});