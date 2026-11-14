/**
 * Generic audit middleware [fork 10/10].
 *
 * Catches every mutating call to the admin surface so no setting change goes
 * unrecorded, even one whose handler has no bespoke audit hook. The actor is the
 * dashboard session email; the new value is the (secret-redacted) request body.
 * The old value is not available here — handlers that know it call recordAudit
 * themselves to add the before/after diff.
 */
import type { Request, Response, NextFunction } from 'express';
import { recordAudit, redactSecretValue } from '../services/audit-log.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const SKIP_PREFIXES = ['/api/auth', '/api/audit', '/api/analytics'];

export function auditMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Record on 'finish' rather than inline: this middleware is mounted for the
  // whole /api surface, so it runs BEFORE the per-route requireAuth that sets
  // req.user. By finish time the session email is populated and only requests
  // that actually completed are logged (a 401 never mutates anything).
  if (!MUTATING.has(req.method)) return next();
  if (SKIP_PREFIXES.some(prefix => req.path.startsWith(prefix) || req.originalUrl.startsWith(prefix))) return next();

  let recorded = false;
  res.once('finish', () => {
    if (recorded) return;
    recorded = true;
    const entityType = entityTypeForPath(req.path);
    const action = req.method === 'POST' ? 'create' : req.method === 'DELETE' ? 'delete' : 'update';
    const actorEmail = (req as Request & { user?: { email?: string } }).user?.email;
    const body = req.body ?? undefined;

    recordAudit({
      actor: actorEmail,
      entityType,
      action,
      newValue: body === undefined ? undefined : redactSecretValue(JSON.stringify(body)),
    });
  });

  next();
}

function entityTypeForPath(path: string): string {
  if (path.startsWith('/keys')) return 'api_keys';
  if (path.startsWith('/client-profiles')) return 'client_profiles';
  if (path.startsWith('/notifications')) return 'notifications';
  if (path.startsWith('/settings')) return 'settings';
  if (path.startsWith('/models')) return 'models';
  if (path.startsWith('/profiles')) return 'profiles';
  if (path.startsWith('/config')) return 'config';
  const segments = path.split('/').filter(Boolean);
  return segments.length > 0 ? segments[0] : 'api';
}