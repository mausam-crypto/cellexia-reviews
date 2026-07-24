/**
 * In-memory token-bucket rate limiter for the storefront proxy API (SPEC §10).
 *
 * Buckets are keyed `shop:ip:action` with per-action hourly limits:
 * submit 5/h, vote 60/h, report 20/h, translate 120/h. Routes that receive
 * `false` respond `429 {ok:false, errors:{_:"rate_limited"}}`.
 *
 * MULTI-INSTANCE CAVEAT: this limiter is per Node.js process. When the app
 * runs on more than one instance (horizontal scaling, serverless with many
 * concurrent workers), each instance keeps its own buckets, so the effective
 * limit is `limit × instances`. For strict global limits swap this module's
 * storage for a shared store (e.g. Redis with a token-bucket script) — the
 * `checkRateLimit` signature is designed so callers never need to change.
 */

const HOUR_MS = 60 * 60 * 1000;

export const RATE_LIMITS = {
  submit: { max: 5, windowMs: HOUR_MS },
  vote: { max: 60, windowMs: HOUR_MS },
  report: { max: 20, windowMs: HOUR_MS },
  translate: { max: 120, windowMs: HOUR_MS },
} as const;

export type RateLimitAction = keyof typeof RATE_LIMITS;

interface Bucket {
  /** Remaining tokens (fractional while refilling). */
  tokens: number;
  /** Last refill timestamp (ms). */
  updatedAt: number;
}

interface RateLimitStore {
  buckets: Map<string, Bucket>;
  sweeper: ReturnType<typeof setInterval> | null;
}

/** Sweep idle buckets every 10 minutes to keep memory bounded. */
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/** Buckets untouched for this long are dropped (fully refilled anyway). */
const BUCKET_IDLE_MS = 2 * HOUR_MS;

// Stored on globalThis so dev-server module reloads reuse one store and never
// stack multiple sweep intervals (same pattern as the template's db.server).
const globalStore = globalThis as typeof globalThis & {
  __cellexiaRateLimitStore?: RateLimitStore;
};

function getStore(): RateLimitStore {
  let store = globalStore.__cellexiaRateLimitStore;
  if (!store) {
    store = { buckets: new Map(), sweeper: null };
    globalStore.__cellexiaRateLimitStore = store;
  }
  if (store.sweeper === null) {
    const timer = setInterval(() => sweep(store as RateLimitStore), SWEEP_INTERVAL_MS);
    // Never keep the process alive just for the sweeper (Node timers only).
    const unref = (timer as unknown as { unref?: () => void }).unref;
    if (typeof unref === "function") unref.call(timer);
    store.sweeper = timer;
  }
  return store;
}

function sweep(store: RateLimitStore): void {
  const now = Date.now();
  for (const [key, bucket] of store.buckets) {
    if (now - bucket.updatedAt > BUCKET_IDLE_MS) {
      store.buckets.delete(key);
    }
  }
}

/**
 * Consume one token for `action` on behalf of `shop`/`ip`.
 * Returns `true` when the request is allowed, `false` when rate limited.
 */
export function checkRateLimit(
  shop: string,
  ip: string,
  action: RateLimitAction,
): boolean {
  const { max, windowMs } = RATE_LIMITS[action];
  const store = getStore();
  const key = `${shop}:${ip}:${action}`;
  const now = Date.now();

  let bucket = store.buckets.get(key);
  if (!bucket) {
    bucket = { tokens: max, updatedAt: now };
    store.buckets.set(key, bucket);
  } else {
    const elapsed = Math.max(0, now - bucket.updatedAt);
    bucket.tokens = Math.min(max, bucket.tokens + (elapsed * max) / windowMs);
    bucket.updatedAt = now;
  }

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return true;
  }
  return false;
}
