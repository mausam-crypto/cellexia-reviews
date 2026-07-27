/**
 * Server-only helpers shared by the admin routes (SPEC §11).
 *
 * Every status change (approve / reject / spam / delete / import) must recompute the
 * per-product aggregates and re-sync the `cellexia` product metafields, so that flow
 * lives here in one place: recomputeProduct (§7 aggregates.server) already fetches the
 * 3 newest highest-helpful PUBLISHED reviews plus the latest stored AI summary and
 * syncs the metafields internally.
 */
import prisma from "~/db.server";
import { recomputeProduct } from "~/services/aggregates.server";
import { scheduleShopRatingSync } from "~/services/brand.server";

/** Admin API context type as declared by the services layer (SPEC §7). */
export type AdminApi = Parameters<typeof recomputeProduct>[2];

/**
 * Recomputes aggregates for a product and pushes them (plus top reviews and the latest
 * AI summary) into the product metafields. Returns the recomputed stats.
 * recomputeProduct handles the metafield sync internally — no extra work needed here.
 *
 * v1.9 (SPEC-1.9 §1): every per-product re-sync can also move the brand-wide
 * aggregates the "Overall reviews" homepage block shows, so a debounced
 * shop-rating sync is scheduled after each one. All moderation / import /
 * generation / display-config paths funnel through this function, and the
 * 60 s per-shop debounce keeps bulk operations cheap (one metafield write per
 * window, reading fresh data when it fires). Fire-and-forget by design.
 */
export async function syncProductData(shop: string, productId: string, admin: AdminApi) {
  const stats = await recomputeProduct(shop, productId, admin);
  scheduleShopRatingSync(shop, admin);
  return stats;
}

/**
 * Sets the status of the given reviews (scoped to the shop), then recomputes + re-syncs
 * every affected product. Returns the number of reviews actually updated.
 */
export async function updateReviewStatuses(
  shop: string,
  ids: string[],
  status: string,
  admin: AdminApi,
): Promise<number> {
  if (!ids.length) return 0;
  const rows = await prisma.review.findMany({
    where: { shop, id: { in: ids } },
    select: { id: true, productId: true },
  });
  if (!rows.length) return 0;

  await prisma.review.updateMany({
    where: { shop, id: { in: rows.map((r) => r.id) } },
    data: { status },
  });

  const productIds = [...new Set(rows.map((r) => r.productId))];
  for (const productId of productIds) {
    await syncProductData(shop, productId, admin);
  }
  return rows.length;
}

/**
 * Permanently deletes the given reviews (scoped to the shop) plus their cached
 * translations, then recomputes + re-syncs every affected product.
 * Returns the number of reviews deleted.
 */
export async function deleteReviews(
  shop: string,
  ids: string[],
  admin: AdminApi,
): Promise<number> {
  if (!ids.length) return 0;
  const rows = await prisma.review.findMany({
    where: { shop, id: { in: ids } },
    select: { id: true, productId: true },
  });
  if (!rows.length) return 0;

  const rowIds = rows.map((r) => r.id);
  await prisma.translationCache.deleteMany({ where: { reviewId: { in: rowIds } } });
  // ReviewMedia + Vote rows cascade via the schema relations.
  await prisma.review.deleteMany({ where: { shop, id: { in: rowIds } } });

  const productIds = [...new Set(rows.map((r) => r.productId))];
  for (const productId of productIds) {
    await syncProductData(shop, productId, admin);
  }
  return rows.length;
}
