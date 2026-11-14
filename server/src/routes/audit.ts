import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { listAudit, recordAudit } from '../services/audit-log.js';

/**
 * Audit log [fork 10/10].
 *
 * Read-only surface over the change history written by the audit middleware and
 * the bespoke before/after hooks. Filterable by entity type/id, actor and action.
 */

export const auditRouter = Router();

const querySchema = z.object({
  entityType: z.string().max(64).optional(),
  entityId: z.string().max(64).optional(),
  actor: z.string().max(128).optional(),
  action: z.string().max(16).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
}).strict();

auditRouter.get('/', (req: Request, res: Response) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ') } });
    return;
  }
  res.json({ entries: listAudit(parsed.data) });
});

// A manual audit-write for scripts/tests to record a non-HTTP change (e.g. a CLI
// edit). Dashboard-session gated by the router mount.
auditRouter.post('/', (req: Request, res: Response) => {
  const parsed = z.object({
    entityType: z.string().min(1).max(64),
    entityId: z.string().max(64).nullable().optional(),
    action: z.enum(['create', 'update', 'delete', 'set', 'import', 'export']),
    field: z.string().max(64).optional(),
    oldValue: z.string().max(4000).optional(),
    newValue: z.string().max(4000).optional(),
  }).strict().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ') } });
    return;
  }
  const actor = (req as Request & { user?: { email?: string } }).user?.email ?? 'system';
  recordAudit({ ...parsed.data, entityId: parsed.data.entityId ?? undefined, actor } as Parameters<typeof recordAudit>[0]);
  res.status(201).json({ success: true });
});