import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  NOTIFY_EVENTS, notify, flushNotifications, runNotificationSweep,
  getNotificationSettings, listChannels, createChannel, updateChannel, deleteChannel,
  type NotifyEvent,
} from '../services/notifications.js';
import { setSetting } from '../db/index.js';
import { listSiteNotifications, markAllSiteNotificationsRead, markSiteNotificationRead } from '../services/site-notifications.js';

/**
 * Notification channels and settings [fork 9/10].
 *
 * The dashboard owns the config: which channel talks for which event, and how
 * hard to retry a flaky webhook. Sweep/flush are POST-ed manually for a "test
 * now" button and by the scheduler on its 60s tick.
 */

export const notificationsRouter = Router();

const SETTINGS_KEY = 'notification_settings';

const eventEnum = z.enum(NOTIFY_EVENTS as unknown as [string, ...string[]]);

const channelCreateSchema = z.object({
  kind: z.enum(['webhook', 'telegram']),
  name: z.string().trim().min(1).max(100),
  url: z.string().trim().max(2000).nullable().optional(),
  botToken: z.string().trim().max(200).nullable().optional(),
  chatId: z.string().trim().max(100).nullable().optional(),
  events: z.record(z.string(), z.boolean()).optional(),
}).strict();

const channelUpdateSchema = z.object({
  kind: z.enum(['webhook', 'telegram']).optional(),
  name: z.string().trim().min(1).max(100).optional(),
  url: z.string().trim().max(2000).nullable().optional(),
  botToken: z.string().trim().max(200).nullable().optional(),
  chatId: z.string().trim().max(100).nullable().optional(),
  events: z.record(z.string(), z.boolean()).optional(),
  enabled: z.boolean().optional(),
}).strict();

const settingsSchema = z.object({
  events: z.record(z.string(), z.boolean()).optional(),
  webhookTimeoutMs: z.number().int().min(100).max(120_000).optional(),
  cooldownMs: z.number().int().min(0).max(86_400_000).optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  backoffBaseMs: z.number().int().min(100).max(3_600_000).optional(),
  readyUpstreamsMin: z.number().int().min(0).max(1000).optional(),
}).strict();

notificationsRouter.get('/settings', (_req: Request, res: Response) => {
  res.json(getNotificationSettings());
});

notificationsRouter.put('/settings', (req: Request, res: Response) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ') } });
    return;
  }
  const settings = getNotificationSettings();
  const next = { ...settings, ...parsed.data };
  // `events` must always hold every known event (the list is the source of
  // truth; a partial map would silently disable the rest).
  if (parsed.data.events !== undefined) {
    next.events = { ...DEFAULT_EVENTS_MAP(), ...parsed.data.events };
  }
  setSetting(SETTINGS_KEY, JSON.stringify(next));
  res.json(next);
});

function DEFAULT_EVENTS_MAP(): Record<string, boolean> {
  return Object.fromEntries(NOTIFY_EVENTS.map(event => [event, true]));
}

notificationsRouter.get('/channels', (_req: Request, res: Response) => {
  res.json({ channels: listChannels() });
});

notificationsRouter.post('/channels', (req: Request, res: Response) => {
  const parsed = channelCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ') } });
    return;
  }
  try {
    res.status(201).json({ channel: createChannel(parsed.data) });
  } catch (err) {
    res.status(400).json({ error: { message: (err as Error).message } });
  }
});

notificationsRouter.patch('/channels/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const parsed = channelUpdateSchema.safeParse(req.body);
  if (!parsed.success || !Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: { message: parsed.success ? 'Invalid channel id' : 'Invalid body' } });
    return;
  }
  try {
    const channel = updateChannel(id, parsed.data);
    if (!channel) {
      res.status(404).json({ error: { message: 'Channel not found' } });
      return;
    }
    res.json({ channel });
  } catch (err) {
    res.status(400).json({ error: { message: (err as Error).message } });
  }
});

notificationsRouter.delete('/channels/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: { message: 'Invalid channel id' } });
    return;
  }
  res.json({ deleted: deleteChannel(id) });
});

// ── In-site feed ───────────────────────────────────────────────────────────
// Provider audits (services/provider-audit.ts) write here so Ember can show an
// alert even when no webhook or Telegram channel is configured.

const feedQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  includeResolved: z.coerce.boolean().optional(),
});

notificationsRouter.get('/site', (req: Request, res: Response) => {
  const parsed = feedQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid query' } });
    return;
  }
  res.json(listSiteNotifications(parsed.data.limit ?? 30, parsed.data.includeResolved ?? false));
});

notificationsRouter.post('/site/:id/read', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: { message: 'Invalid notification id' } });
    return;
  }
  res.json({ ok: markSiteNotificationRead(id) });
});

notificationsRouter.post('/site/read-all', (_req: Request, res: Response) => {
  res.json({ marked: markAllSiteNotificationsRead() });
});

// Manual triggers ("test now"): sweep picks up current fleet state, flush pushes
// the pending queue. Both are what the scheduler runs, so the buttons exercise
// the real path.
notificationsRouter.post('/sweep', async (_req: Request, res: Response) => {
  const results = await runNotificationSweep();
  res.json({ queued: results.reduce((sum, result) => sum + result.queued, 0), results });
});

notificationsRouter.post('/flush', async (_req: Request, res: Response) => {
  const attempted = await flushNotifications();
  res.json({ attempted });
});

// Test/verify: send a pigeon directly, bypassing the fleet sweep.
notificationsRouter.post('/test', (req: Request, res: Response) => {
  const parsed = z.object({ event: eventEnum, title: z.string().max(200), body: z.string().max(4000).optional() }).strict().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ') } });
    return;
  }
  const result = notify(parsed.data.event as NotifyEvent, { title: parsed.data.title, body: parsed.data.body ?? '' });
  res.json(result);
});