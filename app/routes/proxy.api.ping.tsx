/**
 * Storefront proxy: `GET /apps/<subpath>/api/ping` → `/proxy/api/ping`
 * (SPEC-1.6 §2).
 *
 * The discovery/heartbeat endpoint. It answers
 * `{ ok, app: "cellexia-reviews", version, live, ts }` — nothing else. It is
 * what `probeProxySubpath` (server side) and the widget's one-time discovery
 * sweep (browser side) use to decide which `/apps/<subpath>/api` actually
 * reaches this app: a reply proves the app-proxy wiring AND that
 * `SHOPIFY_API_SECRET` verifies, because Shopify signs the forwarded request.
 *
 * SPEC-1.6.1 §C adds ONE conditional extra: a request that carries the shop's
 * current `preview_token` also receives `diag` — the storefront's own view of
 * the review data (published / pending / products) and of the last metafield
 * sync. Without a valid token the response is byte-for-byte what it was
 * before, so nothing new is exposed to the public.
 *
 * Deliberate design points:
 *   - NOT gated by live/preview state (unlike every sibling route). Discovery
 *     has to work before a store goes live — that is the whole point.
 *   - The un-gated response carries no review data, no shop-identifying data
 *     and no PII, so it reveals nothing a storefront visitor cannot already
 *     see. `live` is the same bit the theme already acts on. The token-gated
 *     `diag` carries counts and the verbatim sync error only — still no PII,
 *     and only for someone who already holds the merchant's preview token.
 *   - READ-ONLY. Because there is no live gate, anyone on the internet can
 *     drive this route through `https://<store>/apps/<subpath>/api/ping` and
 *     Shopify will sign the forwarded request for them. It must therefore
 *     never take a write lock: `getSettings` would `upsert` (a write
 *     transaction on every hit, even when nothing changes — enough to
 *     serialise the whole app on the default SQLite deployment) and would
 *     lazily mint a preview token driven by anonymous storefront traffic.
 *     A plain `findUnique` cannot — which is also why the token comparison
 *     below reads the stored token instead of calling `getSettings`.
 *   - Rate limited per shop+IP (see below) as a second line of defence.
 *   - `Cache-Control: no-store` so a CDN can never answer for a path that has
 *     since changed.
 */

import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import prisma from "~/db.server";
import {
  NO_STORE_HEADERS,
  errorJson,
  getClientIp,
  recordStorefrontHit,
  verifyProxy,
} from "~/services/proxy.server";
import { APP_VERSION, PING_APP_ID } from "~/services/proxyhealth.server";

/**
 * Flood ceiling for one shop+IP, in requests per hour.
 *
 * The legitimate client sweeps at most the four candidate subpaths once per
 * page load (SPEC-1.6 §2), and the server-side probe runs at most a handful of
 * times per health check, so 300/h is orders of magnitude above real usage —
 * discovery can never false-negative because of it — while still capping what
 * a single unauthenticated host can cost the backend.
 *
 * A token bucket local to this route rather than an entry in
 * `ratelimit.server.ts`: that module budgets the shopper-facing actions
 * (submit/vote/report/translate/badges), whereas this ceiling exists purely to
 * bound anonymous discovery traffic. Same semantics and the same
 * per-process/multi-instance caveat as that module.
 */
const PING_MAX = 300;
const PING_WINDOW_MS = 60 * 60 * 1000;

/** Tracked buckets before fully-refilled ones are pruned. */
const PING_MAX_BUCKETS = 5000;

/** Hard cap on the `lastSyncError` text echoed into `diag`. */
const MAX_SYNC_ERROR_CHARS = 500;

/**
 * Storefront-visible diagnostics (SPEC-1.6.1 §C). Merchant-only: served ONLY
 * to a request carrying the shop's current preview token. Counts and a
 * Shopify error string — deliberately nothing that identifies a person.
 */
interface PingDiag {
  /** PUBLISHED reviews in this shop. */
  published: number;
  /** PENDING reviews waiting for approval. */
  pending: number;
  /** Distinct products that have at least one published review. */
  products: number;
  /** False once a metafield sync has recorded an error (SPEC-1.6.1 §A). */
  metafieldOk: boolean;
  /** Verbatim last metafield-sync error, or null when the last sync was clean. */
  lastSyncError: string | null;
}

interface PingBucket {
  /** Remaining tokens (fractional while refilling). */
  tokens: number;
  /** Last refill timestamp (ms). */
  updatedAt: number;
}

// Stored on globalThis so dev-server module reloads reuse one map (same
// pattern as ratelimit.server.ts / db.server.ts).
const globalPingStore = globalThis as typeof globalThis & {
  __cellexiaPingBuckets?: Map<string, PingBucket>;
};

/** Consume one token for `key` (`shop:ip`); `false` means rate limited. */
function allowPing(key: string): boolean {
  let buckets = globalPingStore.__cellexiaPingBuckets;
  if (!buckets) {
    buckets = new Map();
    globalPingStore.__cellexiaPingBuckets = buckets;
  }

  const now = Date.now();
  const bucket = buckets.get(key);
  let tokens = PING_MAX;

  if (bucket) {
    const elapsed = Math.max(0, now - bucket.updatedAt);
    tokens = Math.min(PING_MAX, bucket.tokens + (elapsed * PING_MAX) / PING_WINDOW_MS);
  } else if (buckets.size >= PING_MAX_BUCKETS) {
    // Drop buckets that have fully refilled (dropping them changes nothing)
    // rather than letting the map grow without bound.
    for (const [otherKey, other] of buckets) {
      if (now - other.updatedAt >= PING_WINDOW_MS) buckets.delete(otherKey);
    }
  }

  const allowed = tokens >= 1;
  buckets.set(key, { tokens: allowed ? tokens - 1 : tokens, updatedAt: now });
  return allowed;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const auth = await verifyProxy(request);
  if (!auth) return errorJson(401, { _: "unauthorized" });
  const { shop } = auth;

  recordStorefrontHit(shop, request);

  if (!allowPing(`${shop}:${getClientIp(request)}`)) {
    return errorJson(429, { _: "rate_limited" });
  }

  // A settings hiccup must not turn discovery into a failure: the path is
  // still proven, so answer with the safe default (`live: false`) — which is
  // also what a shop with no settings row yet reports.
  //
  // The whole row is read rather than a `select`, because SPEC-1.6.1 §A adds
  // `lastSyncError` to it: selecting a column by name would break this route
  // on a deployment whose migration has not run yet, and the row is only ever
  // read here — never serialized (see `buildDiag`).
  let live = false;
  let previewToken: string | null = null;
  let lastSyncError: string | null = null;
  let settingsRead = false;
  try {
    const settings = await prisma.setting.findUnique({ where: { shop } });
    live = settings?.isLive ?? false;
    previewToken = settings?.previewToken ?? null;
    lastSyncError = readLastSyncError(settings);
    settingsRead = true;
  } catch (error) {
    console.error("[cellexia] ping: reading the live state failed", error);
  }

  // SPEC-1.6.1 §C — the merchant-only half. A token that does not match (or a
  // settings read that failed) produces exactly the pre-1.6.1 response body.
  const token = new URL(request.url).searchParams.get("preview_token");
  const merchantPreview =
    settingsRead && !!token && previewToken != null && token === previewToken;
  const diag = merchantPreview ? await buildDiag(shop, lastSyncError) : null;

  return json(
    {
      ok: true,
      app: PING_APP_ID,
      version: APP_VERSION,
      live,
      ts: new Date().toISOString(),
      ...(diag ? { diag } : {}),
    },
    { headers: NO_STORE_HEADERS },
  );
}

/**
 * The storefront's own view of the review data (SPEC-1.6.1 §C), so the admin
 * health card can compare what the app *stores* with what the storefront path
 * actually *answers*. Read-only. Returns null on any database problem —
 * omitting `diag` is honest, inventing zeroes would not be.
 */
async function buildDiag(
  shop: string,
  lastSyncError: string | null,
): Promise<PingDiag | null> {
  try {
    const [published, pending, products] = await Promise.all([
      prisma.review.count({ where: { shop, status: "PUBLISHED" } }),
      prisma.review.count({ where: { shop, status: "PENDING" } }),
      prisma.review.groupBy({
        by: ["productId"],
        where: { shop, status: "PUBLISHED" },
      }),
    ]);
    return {
      published,
      pending,
      products: products.length,
      metafieldOk: lastSyncError === null,
      lastSyncError,
    };
  } catch (error) {
    console.error("[cellexia] ping: building the diagnostics failed", error);
    return null;
  }
}

/**
 * `Setting.lastSyncError` (SPEC-1.6.1 §A), read structurally so this route
 * compiles and runs both before and after that column exists. Empty strings
 * normalize to null — "no error" must be a single value — and the text is
 * capped so a pathological Shopify error can never bloat the response.
 */
function readLastSyncError(settings: unknown): string | null {
  if (!settings || typeof settings !== "object") return null;
  const value = (settings as Record<string, unknown>).lastSyncError;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_SYNC_ERROR_CHARS
    ? `${trimmed.slice(0, MAX_SYNC_ERROR_CHARS)}…`
    : trimmed;
}

export async function action() {
  return errorJson(405, { _: "method_not_allowed" });
}
