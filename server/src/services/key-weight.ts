/**
 * Key weight and rotation order [fork 6/10].
 *
 * `enabled` was all-or-nothing: the only way to stop preferring a key was to
 * take it out of the pool. Two knobs replace that:
 *
 *   - `key_order` (default 0): the rotation GROUP. Keys of the lowest group are
 *     walked first; a later group is only reached when every key of the earlier
 *     one is unusable — which the router's existing walk already does, because
 *     it returns the first key that passes the gates.
 *   - `weight` (default 1): the key's share WITHIN its group, applied as a
 *     weighted random permutation, so a weight-2 key takes roughly twice the
 *     requests of a weight-1 sibling instead of waiting for a strict turn.
 *
 * Weighted randomness is a real behavioural change, so it is opt-in: an install
 * where every key keeps the defaults (weight 1, order 0) keeps the previous
 * score/round-robin ordering byte for byte. `usesWeighting` is that gate.
 *
 * A key past its soft cap threshold is demoted rather than removed ([fork 4/10]),
 * which is exactly a temporary weight reduction — `SOFT_CAP_WEIGHT_FACTOR`.
 */
import { getCapsFor, capSoftPressures } from './key-caps.js';

export const DEFAULT_KEY_WEIGHT = 1;
export const DEFAULT_KEY_ORDER = 0;
/** Weight multiplier for a key that crossed its cap's soft threshold. Small but
 *  non-zero: the key is still used when nothing else can serve. */
export const SOFT_CAP_WEIGHT_FACTOR = 0.25;
/** Guards against a pathological weight in the DB (hand-edited or imported). */
export const MAX_KEY_WEIGHT = 1_000_000;

export interface WeightedKey {
  id: number;
  weight?: number | null;
  key_order?: number | null;
}

export function keyWeight(key: WeightedKey): number {
  const raw = Number(key.weight ?? DEFAULT_KEY_WEIGHT);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_KEY_WEIGHT;
  // 0 is deliberate, not garbage: "never prefer this key" — it still sits in the
  // permutation as the last resort, which is different from disabling it.
  return Math.min(MAX_KEY_WEIGHT, raw);
}

export function keyOrder(key: WeightedKey): number {
  const raw = Number(key.key_order ?? DEFAULT_KEY_ORDER);
  return Number.isFinite(raw) ? raw : DEFAULT_KEY_ORDER;
}

/** Does this pool need the weight/order path at all? */
export function usesWeighting(keys: WeightedKey[]): boolean {
  return keys.some(k => keyWeight(k) !== DEFAULT_KEY_WEIGHT || keyOrder(k) !== DEFAULT_KEY_ORDER);
}

export type RandomFn = () => number;

/**
 * Weighted random permutation (Efraimidis–Spirakis): sort by u^(1/w) descending.
 * A permutation, not a single pick, because the caller walks the whole list —
 * the keys after the first are the fallbacks, and they should also be ordered by
 * their share rather than by rowid.
 */
export function weightedShuffle<T extends WeightedKey>(
  keys: T[],
  options: { weightOf?: (key: T) => number; random?: RandomFn } = {},
): T[] {
  const random = options.random ?? Math.random;
  const weightOf = options.weightOf ?? ((key: T) => keyWeight(key));
  return keys
    .map(key => {
      // A zero or negative weight means "never prefer this key", not "skip it":
      // it still lands in the permutation, at the back.
      const weight = Math.max(0, weightOf(key));
      const u = Math.min(1 - Number.EPSILON, Math.max(Number.EPSILON, random()));
      return { key, rank: weight <= 0 ? -1 : Math.pow(u, 1 / weight) };
    })
    .sort((a, b) => b.rank - a.rank)
    .map(entry => entry.key);
}

/**
 * The walk order for a pool of keys: groups by ascending `key_order`, each group
 * weighted-shuffled internally. Group boundaries are what make a later group a
 * true fallback — the router only reaches it after every earlier key failed.
 */
export function orderKeysByWeight<T extends WeightedKey>(
  keys: T[],
  options: { weightOf?: (key: T) => number; random?: RandomFn } = {},
): T[] {
  const groups = new Map<number, T[]>();
  for (const key of keys) {
    const group = keyOrder(key);
    const bucket = groups.get(group);
    if (bucket) bucket.push(key);
    else groups.set(group, [key]);
  }
  const out: T[] = [];
  for (const group of [...groups.keys()].sort((a, b) => a - b)) {
    out.push(...weightedShuffle(groups.get(group)!, options));
  }
  return out;
}

/**
 * Effective weight for a key, with the soft-cap discount applied. Reads the caps
 * only for keys that have any, so the common install pays one indexed lookup.
 */
export function effectiveKeyWeight(key: WeightedKey, modelId?: string | null, now = Date.now()): number {
  const base = keyWeight(key);
  try {
    if (getCapsFor(key.id).length === 0) return base;
    if (capSoftPressures(key.id, { modelId, now }).length === 0) return base;
    return base * SOFT_CAP_WEIGHT_FACTOR;
  } catch {
    // Weighting is an optimization; a lookup failure must not fail routing.
    return base;
  }
}
