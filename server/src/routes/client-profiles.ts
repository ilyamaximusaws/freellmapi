import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { encrypt, decrypt, maskKey } from '../lib/crypto.js';
import { mintClientProfileKey, hashClientProfileKey } from '../lib/system-prompt.js';
import { getClientUsageSnapshot } from '../services/client-limits.js';

// Per-client resource limits ([fork 1/10]). All values are 0 = unlimited, the
// same convention as the per-key monthly caps; profileId pins the client to a
// profile's model set. The unified key is the implicit unlimited `default`
// client and is not represented here.
const limitsSchema = z.object({
  maxConcurrent: z.number().int().min(0).max(1000).optional(),
  rpm: z.number().int().min(0).max(1_000_000).optional(),
  tpm: z.number().int().min(0).max(100_000_000).optional(),
  dailyRequestCap: z.number().int().min(0).max(10_000_000).optional(),
  dailyTokenCap: z.number().int().min(0).max(1_000_000_000).optional(),
  monthlyRequestCap: z.number().int().min(0).max(100_000_000).optional(),
  monthlyTokenCap: z.number().int().min(0).max(10_000_000_000).optional(),
  maxTokensPerRequest: z.number().int().min(0).max(10_000_000).optional(),
  maxRequestBytes: z.number().int().min(0).max(1_000_000_000).optional(),
  profileId: z.number().int().positive().nullable().optional(),
}).strict();

const LIMIT_COLUMNS: Array<[keyof z.infer<typeof limitsSchema>, string]> = [
  ['maxConcurrent', 'max_concurrent'],
  ['rpm', 'rpm'],
  ['tpm', 'tpm'],
  ['dailyRequestCap', 'daily_request_cap'],
  ['dailyTokenCap', 'daily_token_cap'],
  ['monthlyRequestCap', 'monthly_request_cap'],
  ['monthlyTokenCap', 'monthly_token_cap'],
  ['maxTokensPerRequest', 'max_tokens_per_request'],
  ['maxRequestBytes', 'max_request_bytes'],
  ['profileId', 'profile_id'],
];

// Client-profile CRUD (#411), mounted under /api/client-profiles behind the
// dashboard session gate like every other admin route. The full `sk-cp-...`
// key is returned exactly once — from create and rotate; the list endpoint
// only ever shows the masked form (rendered from the encrypted copy, since
// the auth path stores nothing but a hash).

export const clientProfilesRouter = Router();

const MAX_NAME_LEN = 100;
// Generous ceiling — a system prompt is configuration, not a document.
const MAX_PROMPT_LEN = 32_000;

const createSchema = z.object({
  name: z.string().trim().min(1).max(MAX_NAME_LEN),
  systemPrompt: z.string().max(MAX_PROMPT_LEN).nullish(),
  limits: limitsSchema.optional(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(MAX_NAME_LEN).optional(),
  // null clears the prompt (the profile key then authenticates without
  // injecting anything); absent leaves it untouched.
  systemPrompt: z.string().max(MAX_PROMPT_LEN).nullable().optional(),
  enabled: z.boolean().optional(),
  limits: limitsSchema.optional(),
});

interface ProfileRow {
  id: number;
  name: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  system_prompt: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
  max_concurrent: number;
  rpm: number;
  tpm: number;
  daily_request_cap: number;
  daily_token_cap: number;
  monthly_request_cap: number;
  monthly_token_cap: number;
  max_tokens_per_request: number;
  max_request_bytes: number;
  profile_id: number | null;
  last_used_at: string | null;
}

function maskedKeyFor(row: Pick<ProfileRow, 'encrypted_key' | 'iv' | 'auth_tag'>): string {
  try {
    return maskKey(decrypt(row.encrypted_key, row.iv, row.auth_tag));
  } catch {
    return '[decrypt failed]';
  }
}

function toJson(row: ProfileRow) {
  return {
    id: row.id,
    name: row.name,
    maskedKey: maskedKeyFor(row),
    systemPrompt: row.system_prompt,
    enabled: row.enabled === 1,
    limits: {
      maxConcurrent: row.max_concurrent,
      rpm: row.rpm,
      tpm: row.tpm,
      dailyRequestCap: row.daily_request_cap,
      dailyTokenCap: row.daily_token_cap,
      monthlyRequestCap: row.monthly_request_cap,
      monthlyTokenCap: row.monthly_token_cap,
      maxTokensPerRequest: row.max_tokens_per_request,
      maxRequestBytes: row.max_request_bytes,
      profileId: row.profile_id,
    },
    // Live usage: settled daily/monthly ledger plus this process's in-flight count.
    usage: getClientUsageSnapshot(row.id),
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getProfile(id: number): ProfileRow | undefined {
  return getDb().prepare('SELECT * FROM client_profiles WHERE id = ?').get(id) as ProfileRow | undefined;
}

function parseId(req: Request, res: Response): number | null {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: { message: 'Invalid profile id' } });
    return null;
  }
  return id;
}

function notFound(res: Response): void {
  res.status(404).json({ error: { message: 'Client profile not found' } });
}

clientProfilesRouter.get('/', (_req: Request, res: Response) => {
  const rows = getDb().prepare('SELECT * FROM client_profiles ORDER BY id').all() as ProfileRow[];
  res.json(rows.map(toJson));
});

clientProfilesRouter.post('/', (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'A profile name is required' } });
    return;
  }
  const key = mintClientProfileKey();
  const { encrypted, iv, authTag } = encrypt(key);
  const prompt = parsed.data.systemPrompt?.trim() || null;
  const limits = parsed.data.limits ?? {};
  const cols = LIMIT_COLUMNS.filter(([field]) => limits[field] !== undefined);
  const colNames = cols.map(([, column]) => column).join(', ');
  const placeholders = cols.map(() => '?').join(', ');
  const colValues = cols.map(([field]) => (limits[field] ?? null) as number | null);
  const info = getDb().prepare(`
    INSERT INTO client_profiles (name, token_hash, encrypted_key, iv, auth_tag, system_prompt${colNames ? ', ' + colNames : ''})
    VALUES (?, ?, ?, ?, ?, ?${placeholders ? ', ' + placeholders : ''})
  `).run(parsed.data.name, hashClientProfileKey(key), encrypted, iv, authTag, prompt, ...colValues);
  const row = getProfile(Number(info.lastInsertRowid))!;
  // The only time the full key leaves the server (besides rotate).
  res.status(201).json({ ...toJson(row), key });
});

clientProfilesRouter.patch('/:id', (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid profile update' } });
    return;
  }
  const row = getProfile(id);
  if (!row) return notFound(res);

  const { name, systemPrompt, enabled, limits } = parsed.data;
  const nextPrompt = systemPrompt === undefined
    ? row.system_prompt
    : (systemPrompt?.trim() || null);
  // Limit changes apply without a restart: admission reads client_profiles on
  // every request ([fork 1/10]), so a PATCH takes effect immediately.
  const limitSets = LIMIT_COLUMNS
    .filter(([field]) => limits?.[field] !== undefined)
    .map(([field, column]) => ({ column, value: (limits![field] ?? null) as number | null }));
  const limitSql = limitSets.map(({ column }) => `${column} = ?`).join(', ');
  getDb().prepare(`
    UPDATE client_profiles
    SET name = ?, system_prompt = ?, enabled = ?, updated_at = datetime('now')${limitSql ? ', ' + limitSql : ''}
    WHERE id = ?
  `).run(
    name ?? row.name,
    nextPrompt,
    enabled === undefined ? row.enabled : (enabled ? 1 : 0),
    ...limitSets.map(({ value }) => value),
    id,
  );
  res.json(toJson(getProfile(id)!));
});

clientProfilesRouter.post('/:id/rotate', (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  const row = getProfile(id);
  if (!row) return notFound(res);

  const key = mintClientProfileKey();
  const { encrypted, iv, authTag } = encrypt(key);
  getDb().prepare(`
    UPDATE client_profiles
    SET token_hash = ?, encrypted_key = ?, iv = ?, auth_tag = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(hashClientProfileKey(key), encrypted, iv, authTag, id);
  res.json({ ...toJson(getProfile(id)!), key });
});

clientProfilesRouter.delete('/:id', (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  const info = getDb().prepare('DELETE FROM client_profiles WHERE id = ?').run(id);
  if (info.changes === 0) return notFound(res);
  res.json({ success: true });
});
