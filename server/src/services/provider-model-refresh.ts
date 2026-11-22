import type { Db } from '../db/types.js';
import { decrypt } from '../lib/crypto.js';
import { endpointScopeForBaseUrl } from '../lib/endpoint-scope.js';
import { syncCustomEndpoint } from './custom-model-sync.js';
import {
  autoRegistrable,
  builtinDiscoveryEligibility,
  discoverBuiltinModels,
  ineligibleMessage,
  registerDiscoveredModels,
} from './builtin-model-discovery.js';
import { syncCatalog, type SyncResult } from './catalog-sync.js';

// ── Operator-triggered model-list refresh ────────────────────────────────────
//
// "Refresh models" on a provider card answers one question: what does this
// provider serve TODAY? Two sources can answer it, and the button must not
// pretend they are the same thing:
//
//  - a custom relay (or a built-in provider that fills its list from its own
//    /models): ask the provider, register the NEW chat models add-only, with
//    the exact filters the scheduled sync uses (tombstones, non-chat ids,
//    free-only policy). Add-only is deliberate: a model that vanished upstream
//    is left for the health and retirement paths, never deleted behind the
//    operator's back.
//  - a catalog-managed built-in provider: its model list belongs to the signed
//    catalog, so "refresh" means re-sync that catalog. Faking a provider fetch
//    here is how a free install would hand itself models the catalog gates.
//
// The result says which source answered, so the UI can word the toast honestly.

export interface RefreshModelsTarget {
  platform: string;
  /** Custom relay base URL, when the caller only knows the host. */
  baseUrl?: string | null;
  /** A specific credential: pins the relay to one of its accounts. */
  keyId?: number | null;
}

export interface RefreshModelsResult {
  platform: string;
  endpointScope: string | null;
  source: 'provider' | 'catalog';
  /** How many models the source listed today (0 for a catalog refresh). */
  discovered: number;
  /** Newly registered chat models. */
  added: string[];
  /** Already known upstream. */
  skipped: number;
  /** Deleted by the operator earlier, kept deleted. */
  tombstoned: number;
  /** Media / embedding / rerank ids: not chat models. */
  nonChat: number;
  /** Skipped by the free-only policy. */
  paid: number;
  /** Present when the catalog answered. */
  catalog?: SyncResult;
}

export class RefreshModelsError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'RefreshModelsError';
  }
}

interface CredentialRow {
  id: number;
  base_url: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
}

function readSecret(row: CredentialRow): string | null {
  try {
    return decrypt(row.encrypted_key, row.iv, row.auth_tag);
  } catch {
    // A row whose ciphertext no longer decrypts still names the endpoint; the
    // provider call then goes out keyless, which is what keyless relays expect.
    return null;
  }
}

function resolveCustomCredential(db: Db, target: RefreshModelsTarget): CredentialRow {
  if (target.keyId != null) {
    const row = db.prepare(`
      SELECT id, base_url, encrypted_key, iv, auth_tag
        FROM api_keys
       WHERE id = ? AND platform = 'custom' AND base_url IS NOT NULL
    `).get(target.keyId) as CredentialRow | undefined;
    if (!row) throw new RefreshModelsError('No custom endpoint credential with that id.', 404);
    return row;
  }

  if (!target.baseUrl) throw new RefreshModelsError('A custom provider needs its base URL (or a key id).');

  const row = db.prepare(`
    SELECT id, base_url, encrypted_key, iv, auth_tag
      FROM api_keys
     WHERE platform = 'custom' AND base_url = ?
     ORDER BY enabled DESC, CASE status WHEN 'healthy' THEN 0 ELSE 1 END, id
     LIMIT 1
  `).get(target.baseUrl) as CredentialRow | undefined;
  if (!row) throw new RefreshModelsError('No credential stored for that custom endpoint.', 404);
  return row;
}

/** Catalog-owned rows for this platform: chat rows the catalog wrote, plus any
 *  embedding / media row (only the catalog and the bundled baseline write those
 *  for a built-in platform). */
function hasCatalogRows(db: Db, platform: string): boolean {
  const row = db.prepare(`
    SELECT (SELECT COUNT(*) FROM models           WHERE platform = ? AND source = 'catalog')
         + (SELECT COUNT(*) FROM embedding_models WHERE platform = ?)
         + (SELECT COUNT(*) FROM media_models     WHERE platform = ?) AS c
  `).get(platform, platform, platform) as { c: number };
  return row.c > 0;
}

/** Pick the credential a built-in discovery call should use. */
function usableBuiltinKey(db: Db, platform: string) {
  return db.prepare(`
    SELECT id, platform, encrypted_key, iv, auth_tag, proxy_encrypted, proxy_iv, proxy_auth_tag
      FROM api_keys
     WHERE platform = ? AND enabled = 1 AND status != 'invalid'
     ORDER BY CASE status WHEN 'healthy' THEN 0 ELSE 1 END, id
     LIMIT 1
  `).get(platform) as Parameters<typeof discoverBuiltinModels>[1] | undefined;
}

/**
 * Refresh one provider's model list from the source that owns it.
 * Throws `RefreshModelsError` with an operator-readable message on refusal.
 */
export async function refreshProviderModels(db: Db, target: RefreshModelsTarget): Promise<RefreshModelsResult> {
  const platform = target.platform.trim();
  if (!platform) throw new RefreshModelsError('A provider platform is required.');

  if (platform === 'custom') {
    const row = resolveCustomCredential(db, target);
    const apiKey = readSecret(row);
    const one = await syncCustomEndpoint(db, { keyId: row.id, baseUrl: row.base_url, apiKey });
    return {
      platform: 'custom',
      endpointScope: endpointScopeForBaseUrl(row.base_url),
      source: 'provider',
      discovered: one.discovered,
      added: one.added,
      skipped: one.skipped,
      tombstoned: one.tombstoned,
      nonChat: one.nonChatSkipped,
      paid: one.paidSkipped,
    };
  }

  const eligibility = builtinDiscoveryEligibility(db, platform);

  if (eligibility.eligible && eligibility.provider) {
    const key = usableBuiltinKey(db, platform);
    if (!key) throw new RefreshModelsError(`No usable ${platform} key to ask the provider with.`, 409);

    const discovered = await discoverBuiltinModels(eligibility.provider, key);
    const { accepted, nonChat, paid } = autoRegistrable(discovered);
    const registered = registerDiscoveredModels(
      db,
      platform,
      accepted.map(model => ({
        modelId: model.id,
        contextWindow: model.contextWindow,
        vision: model.vision,
      })),
      // An operator clicked "refresh", not "re-add": a model they deleted stays
      // deleted, exactly as in the scheduled pass.
      { explicit: false },
    );
    return {
      platform,
      endpointScope: null,
      source: 'provider',
      discovered: discovered.length,
      added: registered.created,
      skipped: registered.existing.length,
      tombstoned: registered.tombstoned.length,
      nonChat,
      paid,
    };
  }

  if (eligibility.reason === 'catalog_managed' || hasCatalogRows(db, platform)) {
    // The catalog owns this provider's list. Refreshing it is the only honest
    // way to "get the new model list from the provider": the catalog IS that
    // list, and the button must not fabricate rows the catalog gates.
    const catalog = await syncCatalog(true);
    if (!catalog.ok) {
      throw new RefreshModelsError(
        `Catalog refresh failed: ${catalog.detail ?? catalog.action}.`,
        502,
      );
    }
    return {
      platform,
      endpointScope: null,
      source: 'catalog',
      discovered: 0,
      added: [],
      skipped: 0,
      tombstoned: 0,
      nonChat: 0,
      paid: 0,
      catalog,
    };
  }

  throw new RefreshModelsError(ineligibleMessage(platform, eligibility.reason), 400);
}
