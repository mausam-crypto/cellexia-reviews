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
 *   4. syncs the `cellexia` product metafields for instant SSR + JSON-LD.
 *
 * Metafield/AI failures are logged inside the called services and never
 * propagate — the stats are always returned to the caller.
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
import prisma from "~/db.server";
import type { ProductStatsDTO } from "~/types/cellexia";
import { generateSummary, parseStoredTopics } from "./ai.server";
import { syncProductMetafields } from "./metafields.server";
import type { SummaryMetafieldSource } from "./metafields.server";
import { computeProductStats } from "./reviews.server";
import { getSettings } from "./settings.server";

export async function recomputeProduct(
  shop: string,
  productId: string,
  admin: AdminApiContext,
): Promise<ProductStatsDTO> {
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

  const topReviews = await prisma.review.findMany({
    where: { shop, productId: pid, status: "PUBLISHED" },
    orderBy: [{ helpfulCount: "desc" }, { createdAt: "desc" }],
    take: 3,
  });

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

  await syncProductMetafields(admin, pid, stats, topReviews, summary);

  return stats;
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
