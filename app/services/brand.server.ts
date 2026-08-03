/**
 * Cellexia Reviews — brand-wide ("Overall reviews") aggregation service
 * (SPEC-1.9 §1).
 *
 * Powers the homepage "Overall reviews" theme block:
 *   - computeShopStats(shop) — weighted average / count / verifiedPercent /
 *     star distribution across every product's PUBLISHED reviews. Rounding is
 *     identical to the per-product stats (average to one decimal, integer
 *     percents via the largest-remainder method).
 *   - pickTopBrandReviews(shop, limit?) — the block's featured reviews,
 *     honoring `Setting.overallWidget` ({ mode, pickedIds }): picked ids
 *     verbatim (published-only, stale ids dropped) backfilled by the auto
 *     ranking, or the pure auto ranking in "auto" mode.
 *   - listBrandReviews(shop, params) — one page of the brand-wide review list
 *     for GET /apps/cellexia/api/brand-reviews, ordered by the auto score
 *     (stars filter applies before scoring; picked reviews occupy the first
 *     global slots when unfiltered). Product info comes from the Review rows
 *     themselves — the proxy hot path never touches the Admin API.
 *   - syncShopRating(shop, admin) — writes the two SHOP metafields
 *     (`cellexia.shop_rating`, `cellexia.shop_top_reviews`) the block SSRs
 *     from. Failures are logged, never thrown (metafields.server.ts
 *     conventions).
 *   - scheduleShopRatingSync(shop, admin) — 60 s per-shop in-memory debounce
 *     around syncShopRating, fired from syncProductData so every moderation /
 *     import / generation / display-config path keeps the homepage data fresh
 *     without hammering the Admin API during bulk operations.
 *
 * AUTO RANKING (SPEC-1.9 §1): candidates are PUBLISHED reviews with
 * rating >= 4; score = helpfulCount·3 + (verified ? 4 : 0) + (hasMedia ? 3 : 0)
 * + bodyLengthBand (0–2, rewarding 80–600 chars) + recencyBand (0–3:
 * <= 30 d → 3, <= 90 d → 2, <= 365 d → 1); ties broken by createdAt desc then
 * id desc, so the ranking is fully deterministic. Diversity rule: at most 2
 * reviews per product in the final list (excess is skipped, the next
 * candidates backfill); when fewer than `limit` qualify the rating gate
 * relaxes to >= 3 — never below, and the 2-per-product cap never relaxes.
 */
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import type { Prisma, Review } from "@prisma/client";
import prisma from "~/db.server";
import { MAX_OVERALL_TOP_REVIEWS, OVERALL_WIDGET_MODES, SKIN_CONCERNS } from "~/types/cellexia";
import type {
  BrandReviewDTO,
  BrandReviewsResponse,
  OverallWidgetMode,
  ReviewDTO,
  ShopStatsDTO,
} from "~/types/cellexia";
import { getSettings } from "./settings.server";
import { buildDistribution, toReviewDTO } from "./reviews.server";
import type { ReviewWithMedia } from "./reviews.server";

/**
 * Admin client accepted by this module — `graphql` only, matching the
 * metafields/aggregates modules (the app's `future.removeRest` contexts
 * satisfy it structurally).
 */
type AdminClient = Pick<AdminApiContext, "graphql">;

const NAMESPACE = "cellexia";

/** Default page size of the brand-reviews proxy list (the block shows <= 12). */
export const DEFAULT_BRAND_PER_PAGE = 12;

/** Hard `per_page` cap of the brand-reviews proxy list (SPEC-1.9 §1). */
export const MAX_BRAND_PER_PAGE = 24;

/** Parsed, validated shape of `Setting.overallWidget` (SPEC-1.9 §1). */
export interface OverallWidgetConfig {
  mode: OverallWidgetMode;
  /** Review ids in the merchant's display order; only used in "picked" mode. */
  pickedIds: string[];
}

/**
 * Tolerant read of the `Setting.overallWidget` JSON. Contract: malformed
 * JSON, a non-object value or an unknown `mode` all degrade to auto;
 * `pickedIds` keeps only non-empty strings, first occurrence wins, capped at
 * MAX_OVERALL_TOP_REVIEWS. Never throws.
 */
export function parseOverallWidget(raw: string | null | undefined): OverallWidgetConfig {
  let parsed: unknown = null;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }
  const record =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as { mode?: unknown; pickedIds?: unknown })
      : {};

  const mode: OverallWidgetMode =
    typeof record.mode === "string" &&
    (OVERALL_WIDGET_MODES as readonly string[]).includes(record.mode)
      ? (record.mode as OverallWidgetMode)
      : "auto";

  const pickedIds: string[] = [];
  if (Array.isArray(record.pickedIds)) {
    for (const entry of record.pickedIds) {
      if (typeof entry === "string" && entry && !pickedIds.includes(entry)) {
        pickedIds.push(entry);
      }
      if (pickedIds.length >= MAX_OVERALL_TOP_REVIEWS) break;
    }
  }

  return { mode, pickedIds };
}

/* ------------------------------------------------------------------------- *
 * computeShopStats
 * ------------------------------------------------------------------------- */

/**
 * Brand-wide aggregate stats over every product's PUBLISHED reviews
 * (SPEC-1.9 §1): weighted average to one decimal, star distribution with
 * largest-remainder integer percents, and the integer share of verified
 * purchases. An empty shop yields zeros everywhere (the block then renders
 * nothing at all).
 */
export async function computeShopStats(
  shop: string,
  options: { publicOnly?: boolean } = {},
): Promise<ShopStatsDTO> {
  // v1.19: the brand PAGE surface excludes synthetic QA rows; every other
  // caller keeps the historical behavior (all published reviews).
  const where: Prisma.ReviewWhereInput = {
    shop,
    status: "PUBLISHED",
    ...(options.publicOnly ? { isSynthetic: false } : {}),
  };
  const [grouped, verifiedCount] = await Promise.all([
    prisma.review.groupBy({
      by: ["rating"],
      where,
      _count: { _all: true },
    }),
    prisma.review.count({ where: { ...where, verified: true } }),
  ]);

  const counts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let total = 0;
  let weighted = 0;
  for (const group of grouped) {
    const rating = group.rating;
    if (rating >= 1 && rating <= 5) {
      counts[rating] = group._count._all;
      total += group._count._all;
      weighted += rating * group._count._all;
    }
  }

  return {
    average: total > 0 ? Math.round((weighted / total) * 10) / 10 : 0,
    count: total,
    verifiedPercent: total > 0 ? Math.round((verifiedCount * 100) / total) : 0,
    distribution: buildDistribution(counts, total) as ShopStatsDTO["distribution"],
  };
}

/* ------------------------------------------------------------------------- *
 * Auto ranking (SPEC-1.9 §1)
 * ------------------------------------------------------------------------- */

/** The fields the brand score needs, plus product info for diversity/DTOs. */
interface ScoredCandidate {
  id: string;
  productId: string;
  productTitle: string | null;
  productHandle: string | null;
  rating: number;
  helpfulCount: number;
  verified: boolean;
  hasMedia: boolean;
  createdAt: Date;
  score: number;
}

/**
 * Body-length band (0–2), rewarding substantial-but-readable reviews:
 * 80–600 chars is the sweet spot (2); a short-but-real 30–79 chars or a
 * long-form 601–1200 chars still helps (1); one-liners and walls of text get
 * nothing. The exact edges are this module's own deterministic choice — the
 * spec fixes only "0–2: reward 80–600 chars".
 */
function bodyLengthBand(length: number): number {
  if (length >= 80 && length <= 600) return 2;
  if ((length >= 30 && length < 80) || (length > 600 && length <= 1200)) return 1;
  return 0;
}

/** Recency band (0–3): <= 30 d → 3, <= 90 d → 2, <= 365 d → 1, older → 0. */
function recencyBand(createdAt: Date, now: number): number {
  const days = (now - createdAt.getTime()) / 86_400_000;
  if (days <= 30) return 3;
  if (days <= 90) return 2;
  if (days <= 365) return 1;
  return 0;
}

/**
 * Fetch every review matching `where` and return it scored, sorted score
 * desc with the deterministic createdAt desc / id desc tiebreak.
 *
 * The scan reads one row per matching review (body included — the length
 * band needs it) and scores in memory: the score mixes body length and
 * wall-clock recency, which SQL cannot express portably. Acceptable because
 * every caller sits behind a cache or debounce (60 s public cache + 120/h
 * rate bucket on the proxy list; 60 s debounce on the metafield sync) and the
 * database is process-local SQLite by default.
 */
async function fetchScoredCandidates(
  where: Prisma.ReviewWhereInput,
): Promise<ScoredCandidate[]> {
  const rows = await prisma.review.findMany({
    where,
    select: {
      id: true,
      productId: true,
      productTitle: true,
      productHandle: true,
      rating: true,
      helpfulCount: true,
      verified: true,
      body: true,
      createdAt: true,
      _count: { select: { media: true } },
    },
  });

  const now = Date.now();
  const scored: ScoredCandidate[] = rows.map((row) => {
    const hasMedia = row._count.media > 0;
    return {
      id: row.id,
      productId: row.productId,
      productTitle: row.productTitle,
      productHandle: row.productHandle,
      rating: row.rating,
      helpfulCount: row.helpfulCount,
      verified: row.verified,
      hasMedia,
      createdAt: row.createdAt,
      score:
        row.helpfulCount * 3 +
        (row.verified ? 4 : 0) +
        (hasMedia ? 3 : 0) +
        bodyLengthBand(row.body.length) +
        recencyBand(row.createdAt, now),
    };
  });

  scored.sort(compareScored);
  return scored;
}

/** score desc, then createdAt desc, then id desc — fully deterministic. */
function compareScored(a: ScoredCandidate, b: ScoredCandidate): number {
  if (a.score !== b.score) return b.score - a.score;
  const at = a.createdAt.getTime();
  const bt = b.createdAt.getTime();
  if (at !== bt) return bt - at;
  if (a.id === b.id) return 0;
  return a.id > b.id ? -1 : 1;
}

/**
 * Walk score-ordered candidates and keep at most `need` of them while
 * enforcing the diversity rule: max 2 reviews per product in the final list
 * (`seedCounts` carries products already used by picked reviews, so the
 * backfill respects the cap across the whole list). Excess candidates are
 * skipped, later ones backfill. The seed map is cloned — both relax passes
 * must start from the same baseline.
 */
function applyDiversity(
  candidates: ScoredCandidate[],
  need: number,
  seedCounts: ReadonlyMap<string, number>,
): ScoredCandidate[] {
  const counts = new Map(seedCounts);
  const out: ScoredCandidate[] = [];
  for (const candidate of candidates) {
    if (out.length >= need) break;
    const used = counts.get(candidate.productId) ?? 0;
    if (used >= 2) continue;
    counts.set(candidate.productId, used + 1);
    out.push(candidate);
  }
  return out;
}

/**
 * The auto-ranked backfill: rating >= 4 candidates first; when the diversity
 * walk cannot fill `need` slots, the rating gate relaxes to >= 3 (one full
 * re-rank over the wider pool — deterministic, and the 2-per-product cap
 * never relaxes). Never goes below rating 3.
 */
async function autoRankCandidates(
  shop: string,
  need: number,
  excludeIds: readonly string[],
  seedCounts: ReadonlyMap<string, number>,
): Promise<ScoredCandidate[]> {
  if (need <= 0) return [];
  const baseWhere = (minRating: number): Prisma.ReviewWhereInput => ({
    shop,
    status: "PUBLISHED",
    rating: { gte: minRating },
    ...(excludeIds.length > 0 ? { id: { notIn: [...excludeIds] } } : {}),
  });

  const strict = await fetchScoredCandidates(baseWhere(4));
  let selection = applyDiversity(strict, need, seedCounts);
  if (selection.length < need) {
    const relaxed = await fetchScoredCandidates(baseWhere(3));
    selection = applyDiversity(relaxed, need, seedCounts);
  }
  return selection;
}

/* ------------------------------------------------------------------------- *
 * pickTopBrandReviews
 * ------------------------------------------------------------------------- */

/**
 * The block's featured reviews (SPEC-1.9 §1), in display order. Honors
 * `Setting.overallWidget`:
 *   - "picked": pickedIds verbatim (PUBLISHED-only, stale/foreign ids
 *     silently dropped), then the auto ranking backfills the remaining slots
 *     — picked products count toward the 2-per-product diversity cap, so a
 *     product the merchant already featured twice gets no backfill.
 *   - "auto" (default): the pure auto ranking.
 * Returns full Review rows so the metafield sync can serialize them.
 */
export async function pickTopBrandReviews(
  shop: string,
  limit: number = MAX_OVERALL_TOP_REVIEWS,
): Promise<Review[]> {
  const max = clampInt(limit, 1, 100);
  const settings = await getSettings(shop);
  const config = parseOverallWidget(settings.overallWidget);

  const orderedIds: string[] = [];
  const productCounts = new Map<string, number>();

  if (config.mode === "picked" && config.pickedIds.length > 0) {
    const pickedRows = await prisma.review.findMany({
      where: { shop, status: "PUBLISHED", id: { in: config.pickedIds } },
      select: { id: true, productId: true },
    });
    const byId = new Map(pickedRows.map((row) => [row.id, row] as const));
    for (const id of config.pickedIds) {
      if (orderedIds.length >= max) break;
      const row = byId.get(id);
      if (!row) continue; // stale, unpublished or cross-shop id — dropped
      orderedIds.push(id);
      productCounts.set(row.productId, (productCounts.get(row.productId) ?? 0) + 1);
    }
  }

  if (orderedIds.length < max) {
    const backfill = await autoRankCandidates(
      shop,
      max - orderedIds.length,
      orderedIds,
      productCounts,
    );
    for (const candidate of backfill) orderedIds.push(candidate.id);
  }

  if (orderedIds.length === 0) return [];

  const rows = await prisma.review.findMany({ where: { shop, id: { in: orderedIds } } });
  return restoreOrder(rows, orderedIds);
}

/* ------------------------------------------------------------------------- *
 * listBrandReviews (GET /apps/cellexia/api/brand-reviews)
 * ------------------------------------------------------------------------- */

/** Query accepted by listBrandReviews — already validated by the route. */
export interface BrandListParams {
  /** 1-based, default 1. */
  page?: number;
  /** Default DEFAULT_BRAND_PER_PAGE, hard-capped at MAX_BRAND_PER_PAGE. */
  perPage?: number;
  /** Optional 1–5 star filter (applies before scoring). */
  stars?: number;
  /** v1.19 (SPEC-1.19 §9): optional product-handle filter. */
  product?: string;
  /** v1.19 (SPEC-1.19 §9): optional SKIN_CONCERNS key filter. */
  concern?: string;
  /** v1.19: exclude synthetic QA rows (the brand PAGE always sets this). */
  publicOnly?: boolean;
}

/**
 * One page of the brand-wide review list (SPEC-1.9 §1): every PUBLISHED
 * review across all products, ordered by the auto score (deterministic
 * tiebreaks). The optional `stars` filter narrows the set BEFORE scoring;
 * when unfiltered, hand-picked reviews (mode "picked") occupy the first
 * global slots in their stored order and the scored remainder excludes them,
 * so no page can duplicate a review. `stats` is always the unfiltered
 * shop-wide aggregate. Product info comes from the Review rows (best-effort
 * sibling-row enrichment) — no Admin API calls anywhere on this path.
 */
export async function listBrandReviews(
  shop: string,
  params: BrandListParams,
): Promise<BrandReviewsResponse> {
  const page = clampInt(params.page ?? 1, 1, 100000);
  const perPage = clampInt(params.perPage ?? DEFAULT_BRAND_PER_PAGE, 1, MAX_BRAND_PER_PAGE);
  const stars =
    typeof params.stars === "number" &&
    Number.isInteger(params.stars) &&
    params.stars >= 1 &&
    params.stars <= 5
      ? params.stars
      : undefined;

  const productHandle =
    typeof params.product === "string" && /^[a-z0-9-]{1,120}$/.test(params.product)
      ? params.product
      : undefined;
  const concern =
    typeof params.concern === "string" && (SKIN_CONCERNS as readonly string[]).includes(params.concern)
      ? params.concern
      : undefined;

  const where: Prisma.ReviewWhereInput = {
    shop,
    status: "PUBLISHED",
    ...(stars !== undefined ? { rating: stars } : {}),
    ...(productHandle ? { productHandle } : {}),
    // skinConcerns is a JSON array string — substring match on the quoted key
    // is exact because keys are a fixed whitelist with no overlaps.
    ...(concern ? { skinConcerns: { contains: `"${concern}"` } } : {}),
    ...(params.publicOnly ? { isSynthetic: false } : {}),
  };
  const filtered = stars !== undefined || productHandle || concern;

  const [stats, scored, settings] = await Promise.all([
    computeShopStats(shop, { publicOnly: params.publicOnly === true }),
    fetchScoredCandidates(where),
    getSettings(shop),
  ]);

  // Global display order: picked ids first (unfiltered "picked" mode only —
  // a stars filter must honor the filter and the pure score order), then the
  // scored list minus the picked ids. `scored` covers every matching
  // PUBLISHED row, so picked validation is plain set membership.
  const byId = new Map(scored.map((candidate) => [candidate.id, candidate] as const));
  let orderedIds: string[];
  const config = parseOverallWidget(settings.overallWidget);
  if (!filtered && config.mode === "picked" && config.pickedIds.length > 0) {
    const picked = config.pickedIds.filter((id) => byId.has(id));
    const pickedSet = new Set(picked);
    orderedIds = [
      ...picked,
      ...scored.filter((candidate) => !pickedSet.has(candidate.id)).map((c) => c.id),
    ];
  } else {
    orderedIds = scored.map((candidate) => candidate.id);
  }

  const total = orderedIds.length;
  const pageIds = orderedIds.slice((page - 1) * perPage, (page - 1) * perPage + perPage);

  let reviews: BrandReviewDTO[] = [];
  if (pageIds.length > 0) {
    const rows = await prisma.review.findMany({
      where: { shop, id: { in: pageIds } },
      include: { media: { orderBy: { position: "asc" as const } } },
    });
    const ordered = restoreOrder(rows, pageIds);
    const info = await resolveProductInfo(shop, ordered);
    reviews = ordered.map((row) => toBrandReviewDTO(row, info.get(row.productId)));
  }

  return {
    stats,
    reviews,
    page,
    per_page: perPage,
    total,
    total_pages: total === 0 ? 0 : Math.ceil(total / perPage),
  };
}

/* ------------------------------------------------------------------------- *
 * syncShopRating / scheduleShopRatingSync
 * ------------------------------------------------------------------------- */

/** One entry of the `cellexia.shop_top_reviews` metafield (SPEC-1.9 §1). */
interface ShopTopReviewEntry {
  rating: number;
  title: string;
  body: string;
  author: string;
  /** YYYY-MM-DD, same convention as the product `top_reviews` metafield. */
  date: string;
  verified: boolean;
  hasMedia: boolean;
  productId: string;
  productTitle: string | null;
  productHandle: string | null;
  productReviewCount: number;
}

/**
 * Writes the two SHOP metafields the "Overall reviews" block SSRs from
 * (SPEC-1.9 §1):
 *   cellexia.shop_rating       json  { average, count, verifiedPercent, distribution }
 *   cellexia.shop_top_reviews  json  up to MAX_OVERALL_TOP_REVIEWS entries in display order
 *
 * Follows the metafields.server.ts SHOP-metafield conventions: resolve the
 * shop GID, one metafieldsSet, log userErrors/errors, NEVER throw — a
 * metafield hiccup must not fail the moderation/import action that triggered
 * the sync (the next sync self-heals).
 */
export async function syncShopRating(shop: string, admin: AdminClient): Promise<void> {
  try {
    const [stats, topReviews] = await Promise.all([
      computeShopStats(shop),
      pickTopBrandReviews(shop, MAX_OVERALL_TOP_REVIEWS),
    ]);

    const ids = topReviews.map((row) => row.id);
    const productIds = [...new Set(topReviews.map((row) => row.productId))];

    const hasMediaSet = new Set<string>();
    if (ids.length > 0) {
      const mediaRows = await prisma.reviewMedia.findMany({
        where: { reviewId: { in: ids } },
        select: { reviewId: true },
        distinct: ["reviewId"],
      });
      for (const row of mediaRows) hasMediaSet.add(row.reviewId);
    }

    const reviewCounts = new Map<string, number>();
    if (productIds.length > 0) {
      const countGroups = await prisma.review.groupBy({
        by: ["productId"],
        where: { shop, productId: { in: productIds }, status: "PUBLISHED" },
        _count: { _all: true },
      });
      for (const group of countGroups) {
        reviewCounts.set(group.productId, group._count._all);
      }
    }

    const info = await resolveProductInfo(shop, topReviews);

    const entries: ShopTopReviewEntry[] = topReviews.map((review) => {
      const product = info.get(review.productId);
      return {
        rating: review.rating,
        title: review.title ?? "",
        body: review.body.slice(0, 300),
        author: review.authorName,
        date: toIsoDate(review.createdAt),
        verified: review.verified,
        hasMedia: hasMediaSet.has(review.id),
        productId: review.productId,
        productTitle: product?.title ?? null,
        productHandle: product?.handle ?? null,
        productReviewCount: reviewCounts.get(review.productId) ?? 0,
      };
    });

    const ownerId = await fetchShopId(admin);
    if (!ownerId) return;

    const response = await admin.graphql(BRAND_METAFIELDS_SET, {
      variables: {
        metafields: [
          {
            ownerId,
            namespace: NAMESPACE,
            key: "shop_rating",
            type: "json",
            value: JSON.stringify(stats),
          },
          {
            ownerId,
            namespace: NAMESPACE,
            key: "shop_top_reviews",
            type: "json",
            value: JSON.stringify(entries),
          },
        ],
      },
    });
    const json = (await response.json()) as {
      data?: { metafieldsSet?: { userErrors?: Array<{ message?: string }> } };
      errors?: unknown;
    };
    const userErrors = json.data?.metafieldsSet?.userErrors ?? [];
    if (userErrors.length > 0) {
      console.error("[cellexia] syncShopRating userErrors:", userErrors);
    }
    if (json.errors) {
      console.error("[cellexia] syncShopRating errors:", json.errors);
    }
  } catch (error) {
    console.error("[cellexia] syncShopRating failed", error);
  }
}

/** 60 s (SPEC-1.9 §1): how long scheduleShopRatingSync coalesces triggers. */
const SHOP_RATING_SYNC_DEBOUNCE_MS = 60_000;

/**
 * Module-level pending-sync map for scheduleShopRatingSync. The admin
 * reference is refreshed on every call so the eventual sync uses the newest
 * client. Dev-server module reloads replace the map; an orphaned timer from
 * the old module instance still fires its one sync harmlessly.
 */
const pendingShopRatingSyncs = new Map<
  string,
  { timer: ReturnType<typeof setTimeout>; admin: AdminClient }
>();

/**
 * Debounced brand-data refresh (SPEC-1.9 §1): the first call for a shop
 * schedules ONE syncShopRating 60 s out; further calls inside the window are
 * absorbed (the pending sync reads fresh data when it runs, so nothing is
 * lost — and a long bulk import cannot postpone the sync forever, which a
 * timer-resetting debounce would). Fire-and-forget by design: callers are
 * moderation/import paths that must never block or fail on homepage
 * bookkeeping.
 *
 * SINGLE-INSTANCE CAVEAT: the debounce map is per Node.js process. With N
 * app instances up to N syncs may run per window — harmless (the write is
 * idempotent, last one wins) but wasteful; for strict coalescing move the
 * schedule into a shared store/queue, keeping this signature.
 */
export function scheduleShopRatingSync(shop: string, admin: AdminClient): void {
  const pending = pendingShopRatingSyncs.get(shop);
  if (pending) {
    pending.admin = admin; // sync with the freshest client when it fires
    return;
  }

  const timer = setTimeout(() => {
    // Read the entry back so the sync runs with the freshest admin client
    // any absorbed call provided during the window.
    const current = pendingShopRatingSyncs.get(shop);
    pendingShopRatingSyncs.delete(shop);
    void syncShopRating(shop, current?.admin ?? admin).catch((error) => {
      // syncShopRating never throws by contract — belt and braces.
      console.error("[cellexia] debounced syncShopRating failed", error);
    });
  }, SHOP_RATING_SYNC_DEBOUNCE_MS);
  // Never keep the process alive just for a pending sync (Node timers only).
  const unref = (timer as unknown as { unref?: () => void }).unref;
  if (typeof unref === "function") unref.call(timer);
  pendingShopRatingSyncs.set(shop, { timer, admin });
}

/* ------------------------------------------------------------------------- *
 * Internals
 * ------------------------------------------------------------------------- */

const BRAND_METAFIELDS_SET = `#graphql
  mutation CellexiaBrandMetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        key
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

/** The SHOP GID, or null when the query fails (logged by the caller's catch). */
async function fetchShopId(admin: AdminClient): Promise<string | null> {
  const response = await admin.graphql(`#graphql
      query CellexiaBrandShopId { shop { id } }`);
  const json = (await response.json()) as { data?: { shop?: { id?: string } } };
  const ownerId = json.data?.shop?.id;
  if (!ownerId) {
    console.error("[cellexia] syncShopRating: no shop id");
    return null;
  }
  return ownerId;
}


/** Best-known product title/handle per productId. */
interface ProductInfo {
  title: string | null;
  handle: string | null;
}

/**
 * Resolve product title/handle for the given reviews FROM REVIEW ROWS ONLY
 * (SPEC-1.9 §1 — no Admin API in the hot path). The review's own columns win;
 * products whose row lacks a value are enriched best-effort from sibling rows
 * of the same product (two bounded `distinct` queries). A product no row
 * knows stays null — the consumers nil-guard.
 */
async function resolveProductInfo(
  shop: string,
  reviews: ReadonlyArray<Pick<Review, "productId" | "productTitle" | "productHandle">>,
): Promise<Map<string, ProductInfo>> {
  const info = new Map<string, ProductInfo>();
  for (const review of reviews) {
    const existing = info.get(review.productId) ?? { title: null, handle: null };
    if (existing.title === null && review.productTitle) existing.title = review.productTitle;
    if (existing.handle === null && review.productHandle) {
      existing.handle = review.productHandle;
    }
    info.set(review.productId, existing);
  }

  const missingHandle = [...info.entries()]
    .filter(([, value]) => value.handle === null)
    .map(([productId]) => productId);
  if (missingHandle.length > 0) {
    const rows = await prisma.review.findMany({
      where: { shop, productId: { in: missingHandle }, productHandle: { not: null } },
      select: { productId: true, productTitle: true, productHandle: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      distinct: ["productId"],
    });
    for (const row of rows) {
      const entry = info.get(row.productId);
      if (!entry) continue;
      if (entry.handle === null && row.productHandle) entry.handle = row.productHandle;
      if (entry.title === null && row.productTitle) entry.title = row.productTitle;
    }
  }

  const missingTitle = [...info.entries()]
    .filter(([, value]) => value.title === null)
    .map(([productId]) => productId);
  if (missingTitle.length > 0) {
    const rows = await prisma.review.findMany({
      where: { shop, productId: { in: missingTitle }, productTitle: { not: null } },
      select: { productId: true, productTitle: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      distinct: ["productId"],
    });
    for (const row of rows) {
      const entry = info.get(row.productId);
      if (entry && entry.title === null && row.productTitle) entry.title = row.productTitle;
    }
  }

  return info;
}

/**
 * STRICT WHITELIST — mirrors `toReviewDTO` in reviews.server.ts (module-
 * private there, so this copy is the brand list's single serialization
 * point; keep the two in sync). Fields are copied one by one; the Prisma row
 * is never spread. Private/admin-only columns — authorEmail, ipHash,
 * customerId, status, reportCount and the v1.4 provenance columns — must
 * NEVER be added here (SPEC-1.9 §1: "ReviewDTO whitelist rules unchanged").
 * On top of the public ReviewDTO this adds ONLY the product block, itself
 * built from the Review row's own product columns.
 */
function toBrandReviewDTO(
  review: ReviewWithMedia,
  product: ProductInfo | undefined,
): BrandReviewDTO {
  const handle = product?.handle ?? null;
  // Delegates to reviews.server's toReviewDTO — the single whitelist that
  // guarantees admin-only columns can never leak into storefront payloads.
  return {
    ...toReviewDTO(review),
    product: {
      title: product?.title ?? null,
      handle,
      url: handle ? `/products/${handle}` : null,
    },
  };
}

/** Reorder fetched rows into the exact id order a ranking decided. */
function restoreOrder<T extends { id: string }>(rows: T[], orderedIds: string[]): T[] {
  const position = new Map(orderedIds.map((id, index) => [id, index] as const));
  return rows
    .filter((row) => position.has(row.id))
    .sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));
}


function toIsoDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime())
    ? new Date().toISOString().slice(0, 10)
    : date.toISOString().slice(0, 10);
}

function clampInt(value: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}
