import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import { refreshProviderModels, RefreshModelsError } from '../../services/provider-model-refresh.js';
import { discoverEndpointModels } from '../../services/model-discovery.js';
import { recordCustomModelTombstone } from '../../services/custom-model-tombstone.js';
import { endpointScopeForBaseUrl } from '../../lib/endpoint-scope.js';

// The refresh talks to the outside world through discoverEndpointModels; stub it
// so each test controls what a relay "serves" today.
vi.mock('../../services/model-discovery.js', async () => {
  const actual = await vi.importActual('../../services/model-discovery.js');
  return { ...actual, discoverEndpointModels: vi.fn() };
});

vi.mock('../../lib/crypto.js', async () => {
  const actual = await vi.importActual('../../lib/crypto.js');
  return { ...actual, decrypt: vi.fn(() => 'mocked-api-key') };
});

const BASE_URL = 'https://relay.example.com/v1';
const FREEPATTERNS = process.env.CUSTOM_MODEL_SYNC_FREE_PATTERNS;

function addCustomEndpoint(baseUrl = BASE_URL): number {
  const info = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
    VALUES ('custom', 'relay', 'enc', 'iv', 'tag', 'healthy', 1, ?)
  `).run(baseUrl);
  return Number(info.lastInsertRowid);
}

function mockServed(models: Array<{ id: string; kind?: string }>): void {
  (discoverEndpointModels as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
    models.map(model => ({ ownedBy: null, ...model })),
  );
}

describe('refreshProviderModels', () => {
  beforeEach(() => {
    process.env.DEV_MODE = 'true';
    process.env.NODE_ENV = 'test';
    delete process.env.CUSTOM_MODEL_SYNC_FREE_PATTERNS;
    initDb(':memory:');
    getDb().exec('DELETE FROM fallback_config; DELETE FROM api_keys; DELETE FROM models; DELETE FROM requests;');
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (FREEPATTERNS === undefined) delete process.env.CUSTOM_MODEL_SYNC_FREE_PATTERNS;
    else process.env.CUSTOM_MODEL_SYNC_FREE_PATTERNS = FREEPATTERNS;
  });

  it('registers only the models the relay added, add-only', async () => {
    addCustomEndpoint();
    const scope = endpointScopeForBaseUrl(BASE_URL);
    getDb().prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled, endpoint_scope)
      VALUES ('custom', 'known-model', 'known-model', 50, 50, 'Medium', 1, ?)
    `).run(scope);
    mockServed([{ id: 'known-model' }, { id: 'fresh-model' }]);

    const result = await refreshProviderModels(getDb(), { platform: 'custom', baseUrl: BASE_URL });

    expect(result.source).toBe('provider');
    expect(result.endpointScope).toBe(scope);
    expect(result.discovered).toBe(2);
    expect(result.added).toEqual(['fresh-model']);
    expect(result.skipped).toBe(1);
    const row = getDb().prepare("SELECT enabled FROM models WHERE platform = 'custom' AND model_id = 'fresh-model' AND endpoint_scope = ?").get(scope) as { enabled: number };
    expect(row.enabled).toBe(1);
  });

  it('keeps a deleted model deleted instead of resurrecting it', async () => {
    addCustomEndpoint();
    const scope = endpointScopeForBaseUrl(BASE_URL);
    recordCustomModelTombstone(getDb(), scope, 'deleted-model');
    mockServed([{ id: 'deleted-model' }]);

    const result = await refreshProviderModels(getDb(), { platform: 'custom', baseUrl: BASE_URL });

    expect(result.added).toEqual([]);
    expect(result.tombstoned).toBe(1);
    const row = getDb().prepare("SELECT 1 FROM models WHERE platform = 'custom' AND model_id = 'deleted-model'").get();
    expect(row).toBeUndefined();
  });

  it('reports media and embedding ids instead of registering them as chat', async () => {
    addCustomEndpoint();
    mockServed([{ id: 'whisper-1', kind: 'audio' }, { id: 'text-embedding-3-small', kind: 'embedding' }]);

    const result = await refreshProviderModels(getDb(), { platform: 'custom', baseUrl: BASE_URL });

    expect(result.added).toEqual([]);
    expect(result.nonChat).toBe(2);
    expect(getDb().prepare("SELECT COUNT(*) AS c FROM models WHERE platform = 'custom'").get()).toEqual({ c: 0 });
  });

  it('pins the refresh to the account whose key id was given', async () => {
    addCustomEndpoint();
    const second = addCustomEndpoint();
    mockServed([{ id: 'fresh-model' }]);

    const result = await refreshProviderModels(getDb(), { platform: 'custom', keyId: second });

    expect(result.added).toEqual(['fresh-model']);
    const bound = getDb().prepare("SELECT key_id FROM models WHERE platform = 'custom' AND model_id = 'fresh-model'").get() as { key_id: number };
    expect(bound.key_id).toBe(second);
  });

  it('refuses a custom refresh when the endpoint has no stored credential', async () => {
    await expect(refreshProviderModels(getDb(), { platform: 'custom', baseUrl: 'https://nope.example.com/v1' }))
      .rejects.toBeInstanceOf(RefreshModelsError);
  });

  it('refuses a platform whose model list belongs to the catalog', async () => {
    // No catalog, embedding or media rows exist for this id, so there is no
    // honest source to refresh from — the button must refuse, not invent a list.
    await expect(refreshProviderModels(getDb(), { platform: 'not-a-real-platform' }))
      .rejects.toMatchObject({ name: 'RefreshModelsError', status: 400 });
  });
});
