// ── One definition of "this install can serve this model row" ───────────────
//
// A model row is only usable when three independent gates agree, and each gate
// lives in a different table:
//
//   1. the catalog allows it        → models.enabled
//   2. the chain selects it         → profile_models.enabled (or fallback_config)
//   3. a credential can serve it    → an enabled api_keys row on the same
//                                     platform, whose model scope lists the
//                                     model (relay keys are often scoped to a
//                                     single model group, #657) and, for custom
//                                     relays, points at the same base_url (#651)
//
// Gate 3 is the one pages kept getting wrong: the chain listing counted rows
// whose platform this install has no key for at all, so a 700-row chain that can
// actually serve 15 models advertised "427 routable". Everything that needs to
// answer the question now asks this module, so the Models page, the chain list
// and the Routing badge cannot drift apart again.

import type { Db } from '../db/types.js';
import { endpointScopeForBaseUrl } from './endpoint-scope.js';
import { parseModelScope, scopeAllows } from './model-scope.js';

/** The columns of a `models` row this module reads. */
export interface ServingKeyTarget {
  platform: string;
  model_id: string;
  endpoint_scope?: string | null;
  key_id?: number | null;
}

export interface ServingKeyIndex {
  /**
   * How many enabled credentials can serve this exact row. 0 means the model
   * cannot be routed right now, whatever the catalog and the chain say.
   */
  count(target: ServingKeyTarget): number;
  /**
   * Whether this install has any credential for the row's upstream — enabled or
   * not. Distinguishes "provider not connected" from "provider paused", which is
   * the difference between hiding a row and showing it as inert.
   */
  configured(target: ServingKeyTarget): boolean;
}

export function buildServingKeyIndex(db: Db): ServingKeyIndex {
  const allKeys = db.prepare(`
    SELECT id, platform, base_url, model_scope_json, enabled
      FROM api_keys
  `).all() as Array<{ id: number; platform: string; base_url: string | null; model_scope_json: string | null; enabled: number }>;

  const ownerEndpoint = new Map(allKeys.map(key => [key.id, endpointScopeForBaseUrl(key.base_url)]));

  // A provider only "exists" for this install when at least one credential is
  // configured for it — enabled or not. The published catalog carries rows for
  // ~60 platforms nobody here has a key for; showing them everywhere made dead
  // providers look connected.
  const configuredPlatforms = new Set(allKeys.map(key => key.platform));
  const configuredEndpoints = new Set(
    allKeys.filter(key => key.platform === 'custom').map(key => endpointScopeForBaseUrl(key.base_url)),
  );

  const keysByPlatform = new Map<string, Array<{ id: number; endpoint: string; scope: Set<string> | null }>>();
  for (const key of allKeys) {
    if (key.enabled !== 1) continue;
    const list = keysByPlatform.get(key.platform) ?? [];
    list.push({
      id: key.id,
      endpoint: key.platform === 'custom' ? endpointScopeForBaseUrl(key.base_url) : '',
      scope: parseModelScope(key.model_scope_json),
    });
    keysByPlatform.set(key.platform, list);
  }

  /** The upstream a row belongs to: its own scope, else the one its key points at. */
  const endpointOf = (target: ServingKeyTarget): string => (target.endpoint_scope
    ? endpointScopeForBaseUrl(target.endpoint_scope)
    : (target.key_id == null ? '' : ownerEndpoint.get(target.key_id) ?? ''));

  const configured = (target: ServingKeyTarget): boolean => (target.platform === 'custom'
    ? configuredEndpoints.has(endpointOf(target))
    : configuredPlatforms.has(target.platform));

  const count = (target: ServingKeyTarget): number => {
    const keys = keysByPlatform.get(target.platform) ?? [];
    if (keys.length === 0) return 0;
    if (target.platform !== 'custom') {
      return keys.filter(key => scopeAllows(key.scope, target.model_id)).length;
    }
    const endpoint = endpointOf(target);
    if (!endpoint) return 0;
    return keys.filter(key => key.endpoint === endpoint
      && scopeAllows(key.scope, target.model_id)).length;
  };

  return { count, configured };
}
