/**
 * Per-key concurrency queue ([fork 2/10]).
 *
 * The router gives up on a model whose keys are all at their in-flight cap and
 * throws an exhaustion whose diagnostics mention `key-concurrency`. Failing the
 * request there is needlessly harsh: the slots free up in seconds. This helper
 * wraps a routing call, and when it fails for that one reason, waits up to
 * `key_concurrency_queue_timeout_ms` (default 3s, 0 disables) re-running it every
 * 100ms until a slot appears or the queue times out.
 *
 * It takes the routing call as a closure on purpose: the caller passes its own
 * `routeRequest` reference, so test doubles that replace that import keep working
 * (the wrapper never reaches into the router module itself).
 *
 * A wait is charged to the keys that were saturated while it happened, which is
 * what the dashboard's per-key "queue wait" column reports. Only a genuine
 * `key-concurrency` exhaustion is waited on — every other failure (cooldown,
 * quota, scope, no key at all) is rethrown immediately, so the queue can never
 * mask an outage.
 */
import { getKeyConcurrencyQueueTimeoutMs, saturatedKeys, recordKeyQueueWait } from '../services/ratelimit.js';

export interface SlotWaitOptions {
  /** Override the runtime `key_concurrency_queue_timeout_ms` setting. */
  queueTimeoutMs?: number;
  /** Test seams. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** True when every candidate key was at its in-flight cap — the one exhaustion
 *  a short wait can resolve. */
export function concurrencyBlockedError(err: unknown): boolean {
  const diagnostics = (err as { diagnostics?: unknown } | null | undefined)?.diagnostics;
  return Array.isArray(diagnostics)
    && diagnostics.some(line => typeof line === 'string' && line.includes('key-concurrency'));
}

/**
 * Wrap a routing function so its concurrency-blocked exhaustion waits for a slot.
 * Pass the caller's own reference (`slotWaitRouter(routeRequest)`), never a
 * dynamic import: the caller's binding is what test doubles replace.
 */
export function slotWaitRouter<F extends (...args: any[]) => unknown>(route: F): F {
  return (function (this: unknown, ...args: unknown[]) {
    return withConcurrencySlotWait(() => route.apply(this, args as never));
  }) as unknown as F;
}

export async function withConcurrencySlotWait<T>(
  run: () => T,
  opts: SlotWaitOptions = {},
): Promise<T> {
  try {
    return run();
  } catch (err) {
    const timeoutMs = opts.queueTimeoutMs ?? getKeyConcurrencyQueueTimeoutMs();
    if (timeoutMs <= 0 || !concurrencyBlockedError(err)) throw err;

    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    const now = opts.now ?? Date.now;

    // Which keys forced the wait, captured while they are still saturated (their
    // leases are held by the requests that beat us to them), then charged the
    // whole wait once — whether a slot frees up or the queue times out.
    const tracked = new Map<string, { platform: string; keyId: number }>();
    const rememberSaturated = () => {
      for (const key of saturatedKeys(now())) tracked.set(`${key.platform}:${key.keyId}`, key);
    };
    rememberSaturated();

    const started = now();
    const deadline = started + timeoutMs;
    const attribute = () => {
      const waitedMs = now() - started;
      for (const key of tracked.values()) recordKeyQueueWait(key.platform, key.keyId, waitedMs);
    };

    for (;;) {
      const remaining = deadline - now();
      if (remaining <= 0) break;
      await sleep(Math.min(100, Math.max(1, remaining)));
      rememberSaturated();
      try {
        const result = run();
        attribute();
        return result;
      } catch (again) {
        if (!concurrencyBlockedError(again)) {
          attribute();
          throw again;
        }
      }
    }

    attribute();
    throw err;
  }
}