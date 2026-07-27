/**
 * Cellexia Reviews — per-product aggregate recomputation.
 *
 * `recomputeProduct` is called after any review status change (approve /
 * reject / spam / delete / new auto-published review). It:
 *   1. recomputes the product stats (average, count, distribution),
 *   2. clears cached summaries when the product no longer has published
 *      reviews, and auto-regenerates the AI summary once the number of
 *      published reviews has drifted by >= `summaryAutoThreshold` since the
 *      last generation (settings-gated, best-effort),
 *   3. picks the 3 newest highest-helpful PUBLISHED reviews,
 *   4. syncs the `cellexia` product metafields for instant SSR + JSON-LD,
 *   5. records that sync's outcome on the shop's Setting row (SPEC-1.6.1 §A).
 *
 * Metafield/AI failures are logged inside the called services and never
 * propagate — the stats are always returned to the caller. Step 5 is what
 * stops a metafield failure from being invisible: `Setting.lastSyncError` /
 * `lastSyncAt` are read back by the admin's storefront health check and by the
 * token-gated `diag` block of `/api/ping`, so "the stars never updated" now has
 * an answer in the admin instead of only in the server log.
 */
import type { AdminApiContext as BaseAdminApiContext } from "@shopify/shopify-app-remix/server";

/**
 * Admin client accepted by this module. The app enables `future.removeRest`
 * (app/shopify.server.ts), so `authenticate.admin` yields
 * `AdminApiContextWithoutRest`, which the package's `/server` entry does not
 * re-export. This module only uses `graphql`, so accept exactly that —
 * contexts with and without REST both satisfy it structurally.
 */
type AdminApiContext = Pick<BaseAdminApiContext, "graphql">;
import type { Prisma, Review } from "@prisma/client";
import prisma from "~/db.server";
import type { ProductStatsDTO } from "~/types/cellexia";
import { generateSummary, parseStoredTopics } from "./ai.server";
import { syncProductMetafields } from "./metafields.server";
import type { MetafieldSyncResult, SummaryMetafieldSource } from "./metafields.server";
import { fetchRankedPage, getEffectiveDisplay } from "./ranking.server";
import { computeProductStats } from "./reviews.server";
import { getSettings } from "./settings.server";

/** Recomputed aggregates plus how the metafield write that followed went. */
export interface RecomputeResult {
  stats: ProductStatsDTO;
  sync: MetafieldSyncResult;
}

/**
 * Recompute a product's aggregates and push them to the metafields.
 *
 * The historical signature: callers that only need the numbers (every
 * moderation path) keep using this and stay unaware of the sync. Callers that
 * report on the sync itself — the Dashboard's "Re-sync all products", which
 * must show the first real error rather than a generic toast (SPEC-1.6.1 §A) —
 * use `recomputeProductWithSync` instead. Both record the outcome on Setting.
 */
export async function recomputeProduct(
  shop: string,
  productId: string,
  admin: AdminApiContext,
): Promise<ProductStatsDTO> {
  const { stats } = await recomputeProductWithSync(shop, productId, admin);
  return stats;
}

/** As `recomputeProduct`, but also hands back the metafield sync outcome. */
export async function recomputeProductWithSync(
  shop: string,
  productId: string,
  admin: AdminApiContext,
): Promise<RecomputeResult> {
  const pid = String(productId);
  const stats = await computeProductStats(shop, pid);
  const settings = await getSettings(shop);

  let summaryRow = await latestSummary(shop, pid);

  if (stats.count === 0) {
    // No published reviews left — cached summaries are stale, drop them.
    if (summaryRow) {
      try {
        await prisma.summary.deleteMany({ where: { shop, productId: pid } });
      } catch (error) {
        console.error("[cellexia] failed to clear stale summaries", error);
      }
      summaryRow = null;
    }
  } else if (settings.aiProvider === "anthropic" && settings.anthropicApiKey) {
    const threshold = Math.max(1, settings.summaryAutoThreshold || 1);
    const drift = summaryRow ? Math.abs(stats.count - summaryRow.reviewCount) : stats.count;
    if (drift >= threshold) {
      try {
        await generateSummary(shop, pid, summaryRow?.locale ?? "en");
        summaryRow = await latestSummary(shop, pid);
      } catch (error) {
        // generateSummary itself never throws, but stay defensive.
        console.error("[cellexia] summary auto-regeneration failed", error);
      }
    }
  }

  // v1.8 (SPEC-1.8 §2): the 3 SSR/JSON-LD reviews follow the same effective
  // display config as the live widget's unfiltered "top" page — pinned
  // ("featured") reviews first in their stored order, then the shop/product
  // ranking strategy — so the server-rendered stars and rich snippets match
  // what the widget shows once it loads.
  const topWhere: Prisma.ReviewWhereInput = { shop, productId: pid, status: "PUBLISHED" };
  let topReviews: Review[];
  try {
    const display = await getEffectiveDisplay(shop, pid);
    const ranked = await fetchRankedPage(shop, pid, display, 1, 3, topWhere);
    if (ranked.ids === null) {
      topReviews = await prisma.review.findMany({
        where: topWhere,
        orderBy: ranked.orderBy,
        take: 3,
      });
    } else {
      const unordered = await prisma.review.findMany({
        where: { shop, id: { in: ranked.ids } },
      });
      const position = new Map(ranked.ids.map((id, index) => [id, index] as [string, number]));
      topReviews = unordered
        .filter((row) => position.has(row.id))
        .sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));
    }
  } catch (error) {
    // The metafield sync must keep working even if the display config read
    // fails — fall back to the pre-1.8 selection rather than skipping the
    // sync (a moderation action depends on this function completing).
    console.error("[cellexia] display-config top_reviews selection failed", error);
    topReviews = await prisma.review.findMany({
      where: topWhere,
      orderBy: [{ helpfulCount: "desc" }, { createdAt: "desc" }],
      take: 3,
    });
  }

  const summary: SummaryMetafieldSource | null = summaryRow
    ? {
        text: summaryRow.text,
        topics: parseStoredTopics(summaryRow.topics).map((topic) => ({
          key: topic.key,
          label: topic.label,
          count: topic.count,
          sentiment: topic.sentiment,
        })),
      }
    : null;

  const sync = await syncProductMetafields(admin, pid, stats, topReviews, summary);
  await recordSyncOutcome(shop, sync);

  return { stats, sync };
}

/**
 * Persist the metafield sync outcome on the shop's Setting row: the error text
 * on failure, `null` on success (so a fixed store stops being reported as
 * broken), plus the timestamp of the attempt either way.
 *
 * A targeted `update` rather than an `upsert`: the row is guaranteed to exist
 * (getSettings upserted it earlier in this call), and writing only these two
 * columns cannot clobber a settings save racing with a moderation action. The
 * whole thing is best-effort — a bookkeeping write must never be able to fail
 * an approve/reject/import, which is exactly the class of silent breakage this
 * release exists to remove, so a throw here is logged and swallowed. Prisma's
 * P2025 (row deleted, e.g. an uninstall mid-flight) lands here too.
 */
async function recordSyncOutcome(shop: string, sync: MetafieldSyncResult): Promise<void> {
  try {
    await prisma.setting.update({
      where: { shop },
      data: {
        lastSyncAt: new Date(),
        lastSyncError: sync.ok ? null : sync.error,
      },
    });
  } catch (error) {
    console.error("[cellexia] recording the metafield sync outcome failed", error);
  }
}

/**
 * The most recently updated summary row for a product. Because generateSummary
 * deletes sibling locale rows after a regeneration, the newest row is the
 * default-locale summary whenever one exists.
 */
async function latestSummary(shop: string, productId: string) {
  return prisma.summary.findFirst({
    where: { shop, productId },
    orderBy: { updatedAt: "desc" },
  });
}
