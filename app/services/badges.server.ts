/**
 * Cellexia Reviews — sitewide star-badge stats (SPEC-1.5 §2, SPEC-1.31 §3).
 *
 * `badgeStatsByHandles` resolves product handles to numeric Shopify product
 * ids and returns `{ average, count }` per handle, computed over PUBLISHED
 * reviews only. Resolution chain:
 *
 *   (a) the `productHandle` column on Review rows (one groupBy — reviews
 *       created by the storefront widget, CSV import and Bulk add carry it;
 *       storefront submissions from localized PDPs store translated handles
 *       there, so those act as organic aliases and are left alone),
 *   (b) for handles with no Review rows, one batched Admin API lookup via
 *       `resolveProducts` (import.server) — and the proven handle↔productId
 *       mapping is persisted back onto Review rows whose productHandle is
 *       NULL/empty (v1.8, SPEC-1.8 §5 audit #3), so those products resolve
 *       from the DB alone on every later request,
 *   (c) for handles STILL unresolved when the request carries a locale root
 *       prefix (SPEC-1.31 §3), a storefront JSON lookup —
 *       `https://{shop}{rootPrefix}products/{handle}.js` — which returns the
 *       locale-invariant product id for TRANSLATED URL handles that neither
 *       the DB nor the Admin `handle:"…"` query can ever match. Positive
 *       hits cache under a ROOT-SCOPED key (two locales may translate
 *       different products to the same slug); failures land in a short-TTL
 *       negative cache and degrade to omission. This step never backfills
 *       Review.productHandle — that column stays Admin-proven canonical
 *       (v1.8 §5 audit #3).
 *
 * All three steps are fronted by a module-level in-memory handle→productId
 * cache (TTL 6 h, capped at 2 000 entries) — steps (a)/(b) under canonical
 * `shop:handle` keys, step (c) under root-scoped keys, plus step (c)'s
 * short-TTL negative cache. Averages and counts reuse `computeProductStats`
 * per product id, so the one-decimal rounding is identical to every other
 * stats surface (SPEC-1.5 §2 — do not fork the rounding).
 *
 * Handles that resolve to nothing — unknown products, or products without a
 * single PUBLISHED review — are simply omitted from the result.
 *
 * Diagnostics (SPEC-1.32 §2 step 3): `badgeStatsByHandles` accepts an
 * OPTIONAL, append-only `trace` hook — `(handle, step) => void` — invoked at
 * each resolution decision ("cache", "review-rows", "admin-api",
 * "storefront-json", "negative-cache", "storefront-skipped", "unresolved")
 * so the Badge doctor can render the exact path every handle took. Default
 * undefined; existing callers are byte-for-byte unaffected, and a throwing
 * hook is swallowed (the hook observes resolution, it never participates).
 */
import type { AdminApiContext as BaseAdminApiContext } from "@shopify/shopify-app-remix/server";
import prisma from "~/db.server";
import type { BadgeStatsDTO } from "~/types/cellexia";
import { resolveProducts } from "./import.server";
import { computeProductStats } from "./reviews.server";

/**
 * Admin client accepted by this module. The app enables `future.removeRest`
 * (app/shopify.server.ts), so admin contexts lack REST; this module only
 * needs `graphql`, so accept exactly that — contexts with and without REST
 * both satisfy it structurally. `null` skips the Admin API fallback (the
 * DB-backed resolution still answers).
 */
export type AdminClient = Pick<BaseAdminApiContext, "graphql">;

/** Shopify handle shape (SPEC-1.5 §2) — mirrors the route's validation. */
const HANDLE_RE = /^[a-z0-9-]{1,255}$/;

/**
 * Resolution-decision labels the optional trace hook receives (SPEC-1.32 §2
 * step 3), in chain order:
 *
 *   - "cache"              canonical or root-scoped handle-cache hit
 *   - "review-rows"        resolved by step (a), Review.productHandle rows
 *   - "admin-api"          resolved by step (b), the batched Admin lookup
 *   - "storefront-json"    resolved by step (c), `{root}products/{handle}.js`
 *   - "negative-cache"     step (c) skipped — a recent lookup already failed
 *   - "storefront-skipped" step (c) skipped — per-request fresh cap or the
 *                          process-wide in-flight ceiling (SPEC-1.31 §3)
 *   - "unresolved"         final: no product id found, handle omitted
 *
 * A handle may receive several labels ("negative-cache" then "unresolved");
 * the last one is the outcome. Handles that resolve but have zero PUBLISHED
 * reviews keep their resolution label and are simply absent from the result.
 */
export type BadgeTraceStep =
  | "cache"
  | "review-rows"
  | "admin-api"
  | "storefront-json"
  | "negative-cache"
  | "storefront-skipped"
  | "unresolved";

/** The optional trace hook (SPEC-1.32 §2 step 3). */
export type BadgeTrace = (handle: string, step: BadgeTraceStep) => void;

/** Hard cap on handles per request (SPEC-1.5 §2). */
export const MAX_BADGE_HANDLES = 48;

/** Locale segment shape accepted for the `root` param (SPEC-1.31 §2). */
const ROOT_SEGMENT_RE = /^[a-z]{2,3}(-[a-z]{2,4})?$/;

/**
 * Normalizes the widget's `root` query param into a locale root prefix
 * (SPEC-1.31 §2): trim, strip leading/trailing slashes, lowercase; valid
 * iff a bare locale segment (`fr`, `pt-br`) remains → `"/fr/"`. Anything
 * else → null, and the route IGNORES an invalid root (never an error) —
 * badges keep answering with canonical-only resolution.
 */
export function normalizeBadgeRoot(raw: string | null): string | null {
  if (typeof raw !== "string") return null;
  const segment = raw.trim().replace(/^\/+/, "").replace(/\/+$/, "").toLowerCase();
  return ROOT_SEGMENT_RE.test(segment) ? `/${segment}/` : null;
}

/** handle→productId cache entries live for 6 hours (SPEC-1.5 §2). */
const HANDLE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** Cache size cap (SPEC-1.5 §2). */
const HANDLE_CACHE_MAX_ENTRIES = 2000;

/** Step (c) storefront lookup timeout (SPEC-1.31 §3). */
const STOREFRONT_TIMEOUT_MS = 5000;

/** Step (c) storefront fetches in flight at once PER REQUEST (SPEC-1.31 §3). */
const STOREFRONT_MAX_IN_FLIGHT = 6;

/** Step (c) failures are remembered for 10 minutes (SPEC-1.31 §3). */
const NEGATIVE_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * v1.31 review hardening (SPEC-1.31 §3): one signed badges request must not
 * amplify into an unbounded outbound fan-out. Two independent ceilings:
 *
 * - PER REQUEST, at most this many FRESH (neither cached nor negative-
 *   cached) storefront lookups run; the rest are omitted this time and
 *   resolve on later requests as the caches warm. Sized above any real
 *   card grid's first cold view while capping an attacker who randomizes
 *   48 junk handles per request.
 * - PROCESS-WIDE, at most STOREFRONT_GLOBAL_MAX_IN_FLIGHT step (c) fetches
 *   run concurrently across ALL requests. Lookups that would exceed it are
 *   SKIPPED (omitted — deliberately NOT negative-cached: saturation is
 *   transient and must not hide badges for the 10-minute negative TTL).
 *
 * Worst case per request: ceil(16/6) = 3 chunks × 5 s ≈ 15 s, ≤ 12 sockets
 * process-wide no matter how many requests are in flight.
 */
const STOREFRONT_MAX_FRESH_PER_REQUEST = 16;
const STOREFRONT_GLOBAL_MAX_IN_FLIGHT = 12;
let storefrontInFlight = 0;

/** Step (c) follows at most this many redirect hops (SPEC-1.31 §3). */
const STOREFRONT_MAX_REDIRECTS = 2;

interface HandleCacheEntry {
  productId: string;
  expiresAt: number;
}

/**
 * Module-level handle→productId cache keyed `shop:handle`. Insertion-ordered
 * Map with FIFO eviction at the cap; entries expire lazily after the TTL.
 * A handle keeps pointing at the same product for its lifetime, and a stale
 * mapping only ever yields count 0 (→ the handle is omitted), so the long
 * TTL is safe. Per Node.js process, like the rate limiter — the multi-
 * instance caveat in ratelimit.server.ts applies here too (each instance
 * warms its own cache; correctness is unaffected).
 */
const handleCache = new Map<string, HandleCacheEntry>();

function cacheKey(shop: string, handle: string): string {
  return `${shop}:${handle}`;
}

/**
 * Root-scoped key for storefront-resolved entries (step (c), SPEC-1.31 §3).
 * Scoping is collision safety: two locales may translate DIFFERENT products
 * to the same slug. `rootPrefix` contains slashes, which the shop-domain and
 * handle charsets both exclude, so the two key spaces cannot collide.
 */
function rootCacheKey(shop: string, rootPrefix: string, handle: string): string {
  return `${shop}:${rootPrefix}:${handle}`;
}

function cacheGet(key: string): string | null {
  const entry = handleCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    handleCache.delete(key);
    return null;
  }
  return entry.productId;
}

function cacheSet(key: string, productId: string): void {
  if (!handleCache.has(key) && handleCache.size >= HANDLE_CACHE_MAX_ENTRIES) {
    // FIFO eviction: drop the oldest inserted entry to stay under the cap.
    const oldest = handleCache.keys().next();
    if (!oldest.done) handleCache.delete(oldest.value);
  }
  handleCache.set(key, { productId, expiresAt: Date.now() + HANDLE_CACHE_TTL_MS });
}

/**
 * Negative cache for step (c): root-scoped keys whose storefront lookup
 * failed (non-200, bad body, timeout, network error) — re-requested handles
 * skip the storefront fetch until the entry expires (SPEC-1.31 §3). Short
 * TTL: a product published (or a locale added) mid-window shows badges
 * within 10 minutes. Same FIFO-cap pattern and multi-instance caveat as
 * handleCache above.
 */
const negativeCache = new Map<string, number>();

function negativeCacheHas(key: string): boolean {
  const expiresAt = negativeCache.get(key);
  if (expiresAt === undefined) return false;
  if (expiresAt <= Date.now()) {
    negativeCache.delete(key);
    return false;
  }
  return true;
}

function negativeCacheSet(key: string): void {
  if (!negativeCache.has(key) && negativeCache.size >= HANDLE_CACHE_MAX_ENTRIES) {
    const oldest = negativeCache.keys().next();
    if (!oldest.done) negativeCache.delete(oldest.value);
  }
  negativeCache.set(key, Date.now() + NEGATIVE_CACHE_TTL_MS);
}

/**
 * Step (c) single lookup: `GET https://{shop}{rootPrefix}products/{handle}.js`
 * (SPEC-1.31 §3). SSRF boundary: every URL token is verified — `shop` comes
 * from the proxy HMAC (verifyProxy), `rootPrefix` matched ROOT_SEGMENT_RE
 * (normalizeBadgeRoot), `handle` matched HANDLE_RE — so the INITIAL target is
 * provably this shop's own storefront. Redirects are followed MANUALLY
 * (review hardening): Shopify's myshopify→primary-domain hop keeps the path,
 * so each hop must stay https on the default port, land on a dotted,
 * non-IP-literal host and keep the EXACT original pathname — a merchant-
 * crafted URL redirect (e.g. to a metadata IP) fails those checks and the
 * handle degrades to omission. ≤ STOREFRONT_MAX_REDIRECTS hops. Accepts only
 * status 200 whose JSON body carries a positive integer `id`; returns null
 * on ANY failure (non-200, non-JSON, bad id, timeout, network) — a 404 here
 * is the ordinary "unknown handle" outcome, not an error worth logging.
 * Non-200 bodies are cancelled so undici releases the socket immediately
 * instead of holding it until GC (review hardening).
 */
async function fetchStorefrontProductId(
  shop: string,
  rootPrefix: string,
  handle: string,
): Promise<string | null> {
  const path = `${rootPrefix}products/${handle}.js`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STOREFRONT_TIMEOUT_MS);
  const drain = (response: Response) => {
    response.body?.cancel().catch(() => {});
  };
  try {
    let url = `https://${shop}${path}`;
    for (let hop = 0; hop <= STOREFRONT_MAX_REDIRECTS; hop += 1) {
      const response = await fetch(url, {
        signal: controller.signal,
        redirect: "manual",
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        drain(response);
        if (!location || hop === STOREFRONT_MAX_REDIRECTS) return null;
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          return null;
        }
        if (
          next.protocol !== "https:" ||
          next.port !== "" ||
          next.hostname.startsWith("[") || // IPv6 literal
          /^\d{1,3}(\.\d{1,3}){3}$/.test(next.hostname) || // IPv4 literal
          !next.hostname.includes(".") ||
          next.pathname !== path
        ) {
          return null;
        }
        url = next.href;
        continue;
      }
      if (response.status !== 200) {
        drain(response);
        return null;
      }
      const body = (await response.json()) as { id?: unknown };
      const id = body?.id;
      if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) return null;
      return String(id);
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Star-badge stats for up to MAX_BADGE_HANDLES product handles (SPEC-1.5 §2).
 *
 * Returns a record keyed by the requested (lowercased) handle; only handles
 * with at least one PUBLISHED review appear. Admin API failures degrade to
 * "those handles are omitted" — DB-resolved handles still answer, and the
 * function only throws on database errors (the route maps those to a 500).
 *
 * `trace` (SPEC-1.32 §2 step 3) is append-only and OPTIONAL — see BadgeTrace.
 * Undefined (every pre-1.32 caller) means zero behavior change; defined, it
 * is called with (handle, step) at each resolution decision and its errors
 * are swallowed so a diagnostic hook can never alter resolution.
 */
export async function badgeStatsByHandles(
  shop: string,
  admin: AdminClient | null,
  handles: string[],
  rootPrefix: string | null = null,
  trace?: BadgeTrace,
): Promise<Record<string, BadgeStatsDTO>> {
  const note = (handle: string, step: BadgeTraceStep): void => {
    if (!trace) return;
    try {
      trace(handle, step);
    } catch {
      // Observability only — a throwing hook must not break badge answers.
    }
  };
  // Defensive re-validation — the route already enforces this contract.
  const wanted: string[] = [];
  for (const raw of Array.isArray(handles) ? handles : []) {
    if (typeof raw !== "string") continue;
    const handle = raw.trim().toLowerCase();
    if (!HANDLE_RE.test(handle) || wanted.includes(handle)) continue;
    wanted.push(handle);
    if (wanted.length >= MAX_BADGE_HANDLES) break;
  }
  if (wanted.length === 0) return {};

  // Defensive re-normalization of the locale root too (SPEC-1.31 §2/§3) —
  // step (c) interpolates it into a URL, so only the normalizer's exact
  // `/fr/` shape may pass; anything else falls back to canonical-only.
  const root = rootPrefix === null ? null : normalizeBadgeRoot(rootPrefix);

  const productIdByHandle = new Map<string, string>();

  // Cache pass — the canonical key first, then the root-scoped key on
  // localized requests (SPEC-1.31 §3).
  const uncached: string[] = [];
  for (const handle of wanted) {
    const cached =
      cacheGet(cacheKey(shop, handle)) ??
      (root ? cacheGet(rootCacheKey(shop, root, handle)) : null);
    if (cached) {
      productIdByHandle.set(handle, cached);
      note(handle, "cache");
    } else uncached.push(handle);
  }

  // (a) Review.productHandle rows. Any status is fine for RESOLUTION — a
  // handle recorded on any review row identifies the product; the stats
  // below then count PUBLISHED reviews only.
  if (uncached.length > 0) {
    const rows = await prisma.review.groupBy({
      by: ["productHandle", "productId"],
      where: { shop, productHandle: { in: uncached } },
      _count: { _all: true },
    });
    // A handle normally maps to exactly one product; on dirty data (e.g. a
    // re-used handle in old imports) the productId with the most rows wins,
    // with a deterministic tie-break.
    const best = new Map<string, { productId: string; rows: number }>();
    for (const row of rows) {
      const handle = row.productHandle;
      if (!handle) continue;
      const count = row._count._all;
      const current = best.get(handle);
      if (
        !current ||
        count > current.rows ||
        (count === current.rows && row.productId < current.productId)
      ) {
        best.set(handle, { productId: row.productId, rows: count });
      }
    }
    for (const [handle, hit] of best) {
      productIdByHandle.set(handle, hit.productId);
      cacheSet(cacheKey(shop, handle), hit.productId);
      note(handle, "review-rows");
    }
  }

  // (b) Batched Admin API fallback for handles with no Review rows (products
  // whose reviews predate the productHandle column, or have none yet).
  const unresolved = wanted.filter((handle) => !productIdByHandle.has(handle));
  if (unresolved.length > 0 && admin) {
    try {
      const resolved = await resolveProducts(
        admin,
        unresolved.map((handle) => ({ handle })),
      );
      for (const handle of unresolved) {
        const product = resolved.get(handle);
        if (product) {
          productIdByHandle.set(handle, product.id);
          cacheSet(cacheKey(shop, handle), product.id);
          note(handle, "admin-api");
        }
      }
      // SPEC-1.8 §5 audit #3: a product whose Review rows ALL have a NULL
      // productHandle (pre-1.5 data, or imports that only carried product
      // ids) lands here on every badge request. The Admin API just proved
      // the mapping in both directions (handle ↔ productId), so persist the
      // handle back onto those rows: the next request resolves from the DB
      // alone — no Admin API dependency, and badges keep working even when
      // the offline admin client is unavailable later. Failures are
      // non-fatal (this request already has its mapping in memory).
      for (const handle of unresolved) {
        const product = resolved.get(handle);
        if (!product) continue;
        try {
          await prisma.review.updateMany({
            where: {
              shop,
              productId: product.id,
              OR: [{ productHandle: null }, { productHandle: "" }],
            },
            data: { productHandle: product.handle || handle },
          });
        } catch (error) {
          console.error("[cellexia] badge productHandle backfill failed", error);
        }
      }
    } catch (error) {
      // Unknown handles are omitted by contract — a failed Shopify lookup
      // degrades to exactly that instead of failing the whole response.
      console.error("[cellexia] badge handle lookup failed", error);
    }
  }

  // (c) Storefront JSON lookup for handles STILL unresolved on localized
  // requests (SPEC-1.31 §3): `{root}products/{translated-handle}.js` serves
  // the locale-invariant product id for translated URL handles, which
  // neither the DB (canonical/organic handles) nor the Admin `handle:"…"`
  // query can match. Positive hits cache root-scoped; failures go to the
  // negative cache and the handle is omitted. No Review.productHandle
  // backfill from this step — that column stays Admin-proven canonical
  // (v1.8 §5 audit #3).
  if (root) {
    // Review hardening: cap FRESH lookups per request — the tail is omitted
    // this time and resolves on later requests as the caches warm. (v1.32:
    // split from one filter().slice() chain only so the trace hook can label
    // negative-cache and fresh-cap skips — same predicates, same order.)
    const eligible: string[] = [];
    for (const handle of wanted) {
      if (productIdByHandle.has(handle)) continue;
      if (negativeCacheHas(rootCacheKey(shop, root, handle))) note(handle, "negative-cache");
      else eligible.push(handle);
    }
    const pending = eligible.slice(0, STOREFRONT_MAX_FRESH_PER_REQUEST);
    for (const handle of eligible.slice(STOREFRONT_MAX_FRESH_PER_REQUEST)) {
      note(handle, "storefront-skipped");
    }
    // Chunked so at most STOREFRONT_MAX_IN_FLIGHT fetches run at once for
    // THIS request; storefrontInFlight caps the whole process — a lookup
    // that would exceed it is skipped WITHOUT a negative-cache entry
    // (saturation is transient; a miss recorded here would hide a real
    // product's badges for the whole negative TTL).
    for (let i = 0; i < pending.length; i += STOREFRONT_MAX_IN_FLIGHT) {
      await Promise.all(
        pending.slice(i, i + STOREFRONT_MAX_IN_FLIGHT).map(async (handle) => {
          if (storefrontInFlight >= STOREFRONT_GLOBAL_MAX_IN_FLIGHT) {
            note(handle, "storefront-skipped");
            return;
          }
          storefrontInFlight += 1;
          try {
            const productId = await fetchStorefrontProductId(shop, root, handle);
            if (productId) {
              productIdByHandle.set(handle, productId);
              cacheSet(rootCacheKey(shop, root, handle), productId);
              note(handle, "storefront-json");
            } else {
              negativeCacheSet(rootCacheKey(shop, root, handle));
            }
          } finally {
            storefrontInFlight -= 1;
          }
        }),
      );
    }
  }

  // Trace epilogue (SPEC-1.32 §2 step 3): every requested handle that ends
  // the chain without a product id is omitted — that is its final decision.
  if (trace) {
    for (const handle of wanted) {
      if (!productIdByHandle.has(handle)) note(handle, "unresolved");
    }
  }

  if (productIdByHandle.size === 0) return {};

  // Stats per unique product id, with the exact computeProductStats rounding.
  const uniqueIds = [...new Set(productIdByHandle.values())];
  const statsList = await Promise.all(
    uniqueIds.map((productId) => computeProductStats(shop, productId)),
  );
  const statsById = new Map(statsList.map((stats) => [stats.id, stats]));

  const badges: Record<string, BadgeStatsDTO> = {};
  for (const [handle, productId] of productIdByHandle) {
    const stats = statsById.get(productId);
    if (stats && stats.count > 0) {
      badges[handle] = { average: stats.average, count: stats.count };
    }
  }
  return badges;
}
