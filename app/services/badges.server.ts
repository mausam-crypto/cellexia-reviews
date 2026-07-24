/**
 * Cellexia Reviews — sitewide star-badge stats (SPEC-1.5 §2).
 *
 * `badgeStatsByHandles` resolves product handles to numeric Shopify product
 * ids and returns `{ average, count }` per handle, computed over PUBLISHED
 * reviews only. Resolution chain:
 *
 *   (a) the `productHandle` column on Review rows (one groupBy — reviews
 *       created by the storefront widget, CSV import and Bulk add carry it),
 *   (b) for handles with no Review rows, one batched Admin API lookup via
 *       `resolveProducts` (import.server),
 *
 * fronted by a module-level in-memory handle→productId cache (TTL 6 h,
 * capped at 2 000 entries). Averages and counts reuse `computeProductStats`
 * per product id, so the one-decimal rounding is identical to every other
 * stats surface (SPEC-1.5 §2 — do not fork the rounding).
 *
 * Handles that resolve to nothing — unknown products, or products without a
 * single PUBLISHED review — are simply omitted from the result.
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

/** Hard cap on handles per request (SPEC-1.5 §2). */
export const MAX_BADGE_HANDLES = 48;

/** handle→productId cache entries live for 6 hours (SPEC-1.5 §2). */
const HANDLE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** Cache size cap (SPEC-1.5 §2). */
const HANDLE_CACHE_MAX_ENTRIES = 2000;

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

function cacheGet(shop: string, handle: string): string | null {
  const key = cacheKey(shop, handle);
  const entry = handleCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    handleCache.delete(key);
    return null;
  }
  return entry.productId;
}

function cacheSet(shop: string, handle: string, productId: string): void {
  const key = cacheKey(shop, handle);
  if (!handleCache.has(key) && handleCache.size >= HANDLE_CACHE_MAX_ENTRIES) {
    // FIFO eviction: drop the oldest inserted entry to stay under the cap.
    const oldest = handleCache.keys().next();
    if (!oldest.done) handleCache.delete(oldest.value);
  }
  handleCache.set(key, { productId, expiresAt: Date.now() + HANDLE_CACHE_TTL_MS });
}

/**
 * Star-badge stats for up to MAX_BADGE_HANDLES product handles (SPEC-1.5 §2).
 *
 * Returns a record keyed by the requested (lowercased) handle; only handles
 * with at least one PUBLISHED review appear. Admin API failures degrade to
 * "those handles are omitted" — DB-resolved handles still answer, and the
 * function only throws on database errors (the route maps those to a 500).
 */
export async function badgeStatsByHandles(
  shop: string,
  admin: AdminClient | null,
  handles: string[],
): Promise<Record<string, BadgeStatsDTO>> {
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

  const productIdByHandle = new Map<string, string>();

  // Cache pass.
  const uncached: string[] = [];
  for (const handle of wanted) {
    const cached = cacheGet(shop, handle);
    if (cached) productIdByHandle.set(handle, cached);
    else uncached.push(handle);
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
      cacheSet(shop, handle, hit.productId);
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
          cacheSet(shop, handle, product.id);
        }
      }
    } catch (error) {
      // Unknown handles are omitted by contract — a failed Shopify lookup
      // degrades to exactly that instead of failing the whole response.
      console.error("[cellexia] badge handle lookup failed", error);
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
