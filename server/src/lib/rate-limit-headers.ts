/**
 * Provider rate-limit header parsing [fork 7/10].
 *
 * Providers that meter per credential state the remaining budget in headers, in
 * three families with overlapping vocabulary:
 *
 *   - OpenAI / Anthropic style: `x-ratelimit-remaining-requests`,
 *     `x-ratelimit-limit-requests`, `xl-ratelimit-reset-requests` (epoch or
 *     ISO for reset), plus the `-tokens` twins.
 *   - GitHub-style: `x-ratelimit-remaining`, `x-ratelimit-reset` (epoch).
 *   - OpenRouter-style: `x-ratelimit-remaining-credits` (fractional) — parsed
 *     but reported as generic "remaining credits", not requests/tokens.
 *
 * The parser is deliberately consensus-oriented: a header only counts when its
 * numeric meaning is unambiguous, and a malformed value is skipped rather than
 * treated as zero (a zero would suppress a key we actually know nothing about).
 */
export interface RateLimitSnapshot {
  requests?: { remaining: number; limit: number | null; resetMs: number | null };
  tokens?: { remaining: number; limit: number | null; resetMs: number | null };
  creditsRemaining?: number;
  observedAtMs: number;
}

import { AsyncLocalStorage } from 'node:async_hooks';

/** [fork 7/10] The response headers of an upstream attempt travel on ALS so the
 *  failover bookkeeping (which knows the key id, unlike the HTTP layer) can turn
 *  them into a per-key snapshot after the attempt. One attempt is in flight at a
 *  time per request, so a single slot per store is enough. */
const captureStore = new AsyncLocalStorage<{ headers: Headers | Record<string, string> }>();

export function runWithRateLimitCapture<T>(fn: () => T): T {
  return captureStore.run({ headers: {} }, fn);
}

export function captureRateLimitHeaders(headers: Headers | Record<string, string>): void {
  const store = captureStore.getStore();
  if (store) store.headers = headers;
}

export function takeCapturedRateLimitHeaders(): Headers | Record<string, string> | null {
  const store = captureStore.getStore();
  return store?.headers ?? null;
}

const int = (raw: string | null | undefined): number | null => {
  if (raw == null) return null;
  const text = raw.trim();
  if (!/^-?\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
};

/** Reset values arrive as epoch seconds, ISO-8601, or a Go-style duration like
 *  "1m30s" / "45s" / "6m0.5s". Returns epoch ms. */
const resetMs = (raw: string | null | undefined, now: number): number | null => {
  if (raw == null) return null;
  const text = raw.trim();
  if (!text) return null;
  const asInt = int(text);
  if (asInt != null) {
    // GitHub-style epoch SECONDS; a bare small number is ambiguous with a
    // seconds-relative duration, so treat <=1e9 as seconds-since-epoch.
    if (asInt >= 1e9) return asInt * 1000;
    return now + asInt * 1000;
  }
  const when = Date.parse(text);
  if (!Number.isNaN(when)) return when;
  // Go-style duration (e.g. "6m0.512s", "1.5h").
  const duration = /^((?:\d+(?:\.\d+)?)(h|m|s))+/i.exec(text);
  if (!duration) return null;
  let ms = 0;
  const parts = duration[0].match(/(\d+(?:\.\d+)?)(h|m|s)/gi) ?? [];
  for (const part of parts) {
    const match = /^(\d+(?:\.\d+)?)(h|m|s)$/i.exec(part);
    if (!match) continue;
    const n = Number(match[1]);
    const unit = match[2].toLowerCase();
    if (unit === 'h') ms += n * 3_600_000;
    else if (unit === 'm') ms += n * 60_000;
    else ms += n * 1000;
  }
  return ms > 0 ? now + ms : null;
};

/** Read a header from either a `Headers` object or a plain record. */
function header(headers: Headers | Record<string, string>, name: string): string | null {
  if (headers instanceof Headers) return headers.get(name);
  const value = headers[name];
  return value ?? null;
}

export function parseRateLimitHeaders(
  headers: Headers | Record<string, string>,
  now = Date.now(),
): RateLimitSnapshot {
  const get = (name: string) => header(headers, name);
  const snapshot: RateLimitSnapshot = { observedAtMs: now };

  const remainingRequests = int(get('x-ratelimit-remaining-requests') ?? get('x-ratelimit-remaining'));
  const limitRequests = int(get('x-ratelimit-limit-requests') ?? get('x-ratelimit-limit'));
  const resetRequests = resetMs(
    get('x-ratelimit-reset-requests') ?? get('x-ratelimit-reset') ?? get('ratelimit-reset'),
    now,
  );
  if (remainingRequests != null || limitRequests != null || resetRequests != null) {
    snapshot.requests = { remaining: remainingRequests ?? 0, limit: limitRequests, resetMs: resetRequests };
  }

  const remainingTokens = int(get('x-ratelimit-remaining-tokens'));
  const limitTokens = int(get('x-ratelimit-limit-tokens'));
  const resetTokens = resetMs(get('x-ratelimit-reset-tokens') ?? get('x-ratelimit-reset'), now);
  if (remainingTokens != null || limitTokens != null) {
    snapshot.tokens = { remaining: remainingTokens ?? 0, limit: limitTokens, resetMs: resetTokens };
  }

  const credits = get('x-ratelimit-remaining-credits');
  if (credits != null && /^[+-]?\d*\.?\d+$/.test(credits.trim())) {
    snapshot.creditsRemaining = Number(credits.trim());
  }

  return snapshot;
}

/** A provider that reported a remaining of zero has exhausted THIS KEY — that is
 *  a stronger signal than any reset time, and it should suppress the key. */
export function snapshotIsExhausted(snapshot: RateLimitSnapshot): boolean {
  return (snapshot.requests?.remaining ?? Infinity) <= 0
    || (snapshot.tokens?.remaining ?? Infinity) <= 0
    || (snapshot.creditsRemaining ?? Infinity) <= 0;
}