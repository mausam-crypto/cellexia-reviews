/**
 * Cellexia Reviews — review read/write service.
 *
 * Implements the §7 service contract consumed by the proxy and admin routes:
 *   - listReviews(shop, params)  → §6 ListResponse (published reviews only,
 *     product stats with integer percents that sum to 100, summary, media
 *     gallery on page 1, filters/search/sort semantics), plus the opt-in
 *     merchant-only `meta.pendingCount` of SPEC-1.6.1 §B
 *   - createReview(shop, input)  → persists a review + media rows; records
 *     v1.4 provenance (source defaults to "storefront"; the import/bulk-add/
 *     synthetic services pass their own source + metadata)
 *   - voteHelpful(shop, id, tok) → idempotent helpful vote per visitor token
 *   - reportReview(shop, id, tok, reason) → idempotent report; auto-flips the
 *     review back to PENDING at >= 3 distinct reports
 *
 * Option keys are validated upstream (the proxy returns 422 for unknown keys)
 * and re-validated defensively here, which makes the LIKE-based JSON
 * containment matching on `skinConcerns`/`resultsSeen` safe: keys are always
 * [a-z0-9_]+ and matched with their surrounding quotes.
 */
import type { Prisma, Review } from "@prisma/client";
import prisma from "~/db.server";
import {
  AGE_RANGES,
  REPORT_REASONS,
  RESULTS_SEEN,
  REVIEW_SOURCES,
  REVIEW_STATUSES,
  SHOP_LOCALES,
  SKIN_CONCERNS,
  TIME_USING,
} from "~/types/cellexia";
import type {
  ListResponse,
  ProductStatsDTO,
  ReviewDTO,
  ReviewSource,
  ReviewStatus,
  Sort,
  SummaryDTO,
} from "~/types/cellexia";
import { parseStoredTopics, topicsToDTO } from "./ai.server";
import { getSettings } from "./settings.server";

/** Query parameters accepted by listReviews (camelCase of the §6 query params). */
export interface ListParams {
  productId: string;
  page?: number;
  perPage?: number;
  sort?: Sort | string;
  stars?: number;
  verified?: boolean;
  withMedia?: boolean;
  ageRange?: string;
  timeUsing?: string;
  skinConcern?: string;
  resultsSeen?: string;
  topic?: string;
  q?: string;
  locale?: string;
  /**
   * Populate the merchant-only `ListResponse.meta` (SPEC-1.6.1 §B).
   *
   * SECURITY: `meta` carries moderation data (how many reviews are waiting for
   * approval) that a shopper must never see. This flag is the only way to get
   * it, it defaults to off, and the only caller that may turn it on is the
   * proxy route — after it has verified that the request carried the shop's
   * current preview token. Never derive it from the shop's live state.
   */
  includeMeta?: boolean;
}

/** Media descriptor accepted by createReview. */
export interface CreateReviewMediaInput {
  type: "IMAGE" | "VIDEO";
  fileGid?: string | null;
  url?: string | null;
  thumbUrl?: string | null;
  position?: number;
}

/** Input accepted by createReview — already validated/shaped by the caller. */
export interface CreateReviewInput {
  productId: string;
  productTitle?: string | null;
  productHandle?: string | null;
  rating: number;
  title?: string | null;
  body: string;
  language?: string | null;
  authorName: string;
  authorEmail?: string | null;
  customerId?: string | null;
  country?: string | null;
  variantTitle?: string | null;
  verified?: boolean;
  status?: ReviewStatus;
  ageRange?: string | null;
  skinConcerns?: string[] | null;
  timeUsing?: string | null;
  resultsSeen?: string[] | null;
  ipHash?: string | null;
  media?: CreateReviewMediaInput[] | null;
  /**
   * v1.4 provenance (SPEC-1.4 §0). The storefront submit path omits this and
   * the row is recorded as "storefront"; the CSV-import / bulk-add / synthetic
   * services pass their own value. Unknown values fall back to "storefront".
   * These fields are admin-only and are never serialized to the storefront
   * (see toReviewDTO).
   */
  source?: ReviewSource | null;
  /** QA-generator flag; defaults to false. */
  isSynthetic?: boolean | null;
  /** QA-generator batch id; ignored (stored null) unless a non-empty string. */
  syntheticBatchId?: string | null;
  /** When the QA generator actually created the row (createdAt is backdated). */
  syntheticGeneratedAt?: Date | string | null;
  /**
   * Optional backdated review date for imported / synthetic rows. Invalid or
   * missing values fall back to the database default (now).
   */
  createdAt?: Date | string | null;
  /** Imported helpful-vote count; defaults to 0 when absent/invalid. */
  helpfulCount?: number | null;
  /** Imported merchant reply (+ its date). */
  reply?: string | null;
  replyAt?: Date | string | null;
}

type ReviewWithMedia = Prisma.ReviewGetPayload<{ include: { media: true } }>;

/* ------------------------------------------------------------------------- *
 * listReviews
 * ------------------------------------------------------------------------- */

export async function listReviews(shop: string, params: ListParams): Promise<ListResponse> {
  const settings = await getSettings(shop);
  const productId = String(params.productId);
  const page = clampInt(params.page ?? 1, 1, 100000);
  const perPage = clampInt(params.perPage ?? settings.reviewsPerPage, 1, 50);
  const sort: Sort = params.sort === "recent" ? "recent" : "top";

  const where: Prisma.ReviewWhereInput = { shop, productId, status: "PUBLISHED" };

  if (
    typeof params.stars === "number" &&
    Number.isInteger(params.stars) &&
    params.stars >= 1 &&
    params.stars <= 5
  ) {
    where.rating = params.stars;
  }
  if (params.verified) where.verified = true;
  if (params.withMedia) where.media = { some: {} };
  if (params.ageRange && includesKey(AGE_RANGES, params.ageRange)) {
    where.ageRange = params.ageRange;
  }
  if (params.timeUsing && includesKey(TIME_USING, params.timeUsing)) {
    where.timeUsing = params.timeUsing;
  }
  // Array-contains against JSON string columns. LIKE containment with the
  // surrounding quotes is exact here because keys are validated against the
  // §5 vocabularies (no key is a quoted substring of another).
  if (params.skinConcern && includesKey(SKIN_CONCERNS, params.skinConcern)) {
    where.skinConcerns = { contains: `"${params.skinConcern}"` };
  }
  if (params.resultsSeen && includesKey(RESULTS_SEEN, params.resultsSeen)) {
    where.resultsSeen = { contains: `"${params.resultsSeen}"` };
  }
  if (params.q && params.q.trim()) {
    // SQLite LIKE is case-insensitive for ASCII, which satisfies the §6
    // "case-insensitive" search requirement for title + body.
    const q = params.q.trim().slice(0, 120);
    where.OR = [{ title: { contains: q } }, { body: { contains: q } }];
  }
  if (params.topic) {
    where.id = { in: await topicReviewIds(shop, productId, params.topic, params.locale) };
  }

  const orderBy: Prisma.ReviewOrderByWithRelationInput[] =
    sort === "top"
      ? [{ helpfulCount: "desc" }, { verified: "desc" }, { createdAt: "desc" }]
      : [{ createdAt: "desc" }];

  // The pending count deliberately ignores `where`: it answers "is anything
  // waiting for approval on this product?", not "does anything match the
  // shopper's filters?". Only queried when the caller asked for it.
  const [total, rows, stats, pendingCount] = await Promise.all([
    prisma.review.count({ where }),
    prisma.review.findMany({
      where,
      orderBy,
      skip: (page - 1) * perPage,
      take: perPage,
      include: { media: { orderBy: { position: "asc" } } },
    }),
    computeProductStats(shop, productId),
    params.includeMeta === true
      ? prisma.review.count({ where: { shop, productId, status: "PENDING" } })
      : Promise.resolve(null),
  ]);

  const summary = settings.showSummary
    ? await findSummaryDTO(shop, productId, params.locale)
    : null;
  const mediaGallery =
    page === 1 && settings.showMediaStrip ? await loadMediaGallery(shop, productId) : [];

  const response = {
    product: stats,
    summary,
    reviews: rows.map(toReviewDTO),
    media_gallery: mediaGallery,
    page,
    per_page: perPage,
    total,
    total_pages: total === 0 ? 0 : Math.ceil(total / perPage),
    settings: {
      showTranslate: settings.showTranslate && settings.translationProvider !== "off",
      brandDisplayName: settings.brandDisplayName,
      designTheme: settings.designTheme,
    },
  } as ListResponse;

  // SPEC-1.6.1 §B — merchant-only. The key is ADDED here, never defaulted:
  // without an explicit `includeMeta` the serialized payload has no `meta`
  // property at all, so a shopper response cannot carry it even as `null`.
  if (params.includeMeta === true && pendingCount !== null) {
    response.meta = { pendingCount };
  }

  return response;
}

/**
 * Per-product aggregate stats over PUBLISHED reviews. Percentages are integers
 * computed with the largest-remainder method so they always sum to 100 when at
 * least one review exists (matching the §6 example: 81/10/5/1/3).
 *
 * Exported so aggregates.server.ts reuses the exact same rounding.
 */
export async function computeProductStats(
  shop: string,
  productId: string,
): Promise<ProductStatsDTO> {
  const grouped = await prisma.review.groupBy({
    by: ["rating"],
    where: { shop, productId: String(productId), status: "PUBLISHED" },
    _count: { _all: true },
  });

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

  const average = total > 0 ? Math.round((weighted / total) * 10) / 10 : 0;

  return {
    id: String(productId),
    average,
    count: total,
    distribution: buildDistribution(counts, total) as ProductStatsDTO["distribution"],
  } as ProductStatsDTO;
}

/* ------------------------------------------------------------------------- *
 * createReview
 * ------------------------------------------------------------------------- */

export async function createReview(shop: string, input: CreateReviewInput): Promise<Review> {
  const settings = await getSettings(shop);

  const status: ReviewStatus =
    input.status && includesKey(REVIEW_STATUSES, input.status)
      ? input.status
      : settings.autoPublish
        ? "PUBLISHED"
        : "PENDING";

  const language =
    input.language && includesKey(SHOP_LOCALES, input.language) ? input.language : "en";

  const media = (input.media ?? []).slice(0, 6);

  // v1.4 provenance (SPEC-1.4 §0): every row created from here on records how
  // it entered the system. The storefront submit path passes no `source`, so
  // it defaults to "storefront"; unknown values are never written.
  const source: ReviewSource =
    input.source && includesKey(REVIEW_SOURCES, input.source) ? input.source : "storefront";
  const createdAt = toValidDate(input.createdAt);
  const syntheticGeneratedAt = toValidDate(input.syntheticGeneratedAt);
  const reply = normalize(input.reply, 5000);
  // A reply date without a reply is meaningless — drop it defensively.
  const replyAt = reply !== null ? toValidDate(input.replyAt) : null;
  const helpfulCount =
    typeof input.helpfulCount === "number" && Number.isFinite(input.helpfulCount)
      ? clampInt(input.helpfulCount, 0, 1000000)
      : null;

  return prisma.review.create({
    data: {
      shop,
      productId: String(input.productId),
      productTitle: normalize(input.productTitle, 255),
      productHandle: normalize(input.productHandle, 255),
      rating: clampInt(input.rating, 1, 5),
      title: normalize(input.title, 150),
      body: String(input.body ?? "").trim().slice(0, 5000),
      language,
      authorName: String(input.authorName ?? "").trim().slice(0, 80),
      authorEmail: normalize(input.authorEmail, 254)?.toLowerCase() ?? null,
      customerId: input.customerId ? String(input.customerId) : null,
      country: normalize(input.country, 2)?.toUpperCase() ?? null,
      variantTitle: normalize(input.variantTitle, 120),
      verified: Boolean(input.verified),
      status,
      ageRange: input.ageRange && includesKey(AGE_RANGES, input.ageRange) ? input.ageRange : null,
      skinConcerns: JSON.stringify(filterKeys(SKIN_CONCERNS, input.skinConcerns)),
      timeUsing:
        input.timeUsing && includesKey(TIME_USING, input.timeUsing) ? input.timeUsing : null,
      resultsSeen: JSON.stringify(filterKeys(RESULTS_SEEN, input.resultsSeen)),
      ipHash: input.ipHash ?? null,
      reply,
      replyAt,
      source,
      isSynthetic: input.isSynthetic === true,
      syntheticBatchId: normalize(input.syntheticBatchId, 64),
      syntheticGeneratedAt,
      // Only override the database defaults when the caller supplied a valid
      // value (imports/QA backdate createdAt and seed helpful counts).
      ...(createdAt ? { createdAt } : {}),
      ...(helpfulCount !== null ? { helpfulCount } : {}),
      media: {
        create: media.map((m, index) => ({
          type: m.type === "VIDEO" ? "VIDEO" : "IMAGE",
          fileGid: m.fileGid ?? null,
          url: m.url ?? null,
          thumbUrl: m.thumbUrl ?? null,
          position: typeof m.position === "number" ? m.position : index,
        })),
      },
    },
    include: { media: true },
  });
}

/* ------------------------------------------------------------------------- *
 * voteHelpful / reportReview
 * ------------------------------------------------------------------------- */

/**
 * Records one helpful vote per visitor token (idempotent) and returns the
 * current helpfulCount. Throws Error("review_not_found") for unknown ids —
 * the calling route maps that to a 404.
 */
export async function voteHelpful(
  shop: string,
  reviewId: string,
  token: string,
): Promise<number> {
  const review = await prisma.review.findFirst({
    where: { id: reviewId, shop, status: "PUBLISHED" },
    select: { id: true, helpfulCount: true },
  });
  if (!review) throw new Error("review_not_found");

  const visitorToken = String(token).slice(0, 128);
  try {
    await prisma.vote.create({
      data: { reviewId: review.id, visitorToken, type: "HELPFUL" },
    });
  } catch (error) {
    if (isUniqueViolation(error)) return review.helpfulCount; // already voted
    throw error;
  }

  const updated = await prisma.review.update({
    where: { id: review.id },
    data: { helpfulCount: { increment: 1 } },
    select: { helpfulCount: true },
  });
  return updated.helpfulCount;
}

/**
 * Records one report per visitor token (idempotent). At >= 3 distinct reports
 * the review auto-flips back to PENDING for re-moderation. Throws
 * Error("review_not_found") for unknown ids.
 */
export async function reportReview(
  shop: string,
  reviewId: string,
  token: string,
  reason: string,
): Promise<void> {
  const review = await prisma.review.findFirst({
    where: { id: reviewId, shop },
    select: { id: true, status: true },
  });
  if (!review) throw new Error("review_not_found");

  const safeReason = includesKey(REPORT_REASONS, reason) ? reason : "other";
  const visitorToken = String(token).slice(0, 128);

  try {
    await prisma.vote.create({
      data: { reviewId: review.id, visitorToken, type: "REPORT", reason: safeReason },
    });
  } catch (error) {
    if (isUniqueViolation(error)) return; // this visitor already reported
    throw error;
  }

  const distinctReports = await prisma.vote.count({
    where: { reviewId: review.id, type: "REPORT" },
  });

  await prisma.review.update({
    where: { id: review.id },
    data: {
      reportCount: distinctReports,
      ...(distinctReports >= 3 && review.status === "PUBLISHED"
        ? { status: "PENDING" }
        : {}),
    },
  });
}

/* ------------------------------------------------------------------------- *
 * Internals
 * ------------------------------------------------------------------------- */

/**
 * STRICT WHITELIST — verified for SPEC-1.4 §0. This is the only place a Review
 * row is serialized for the storefront, and it copies allowed fields one by
 * one; never spread the Prisma row here. Private/admin-only columns —
 * authorEmail, ipHash, customerId, status, reportCount and the v1.4
 * provenance columns (isSynthetic, source, syntheticBatchId,
 * syntheticGeneratedAt) — must NEVER be added to this output, so they can
 * never leak through the proxy responses.
 */
function toReviewDTO(review: ReviewWithMedia): ReviewDTO {
  return {
    id: review.id,
    rating: review.rating,
    title: review.title ?? null,
    body: review.body,
    language: review.language,
    authorName: review.authorName,
    country: review.country ?? null,
    variantTitle: review.variantTitle ?? null,
    verified: review.verified,
    createdAt: review.createdAt.toISOString(),
    ageRange: review.ageRange ?? null,
    skinConcerns: parseStringArray(review.skinConcerns),
    timeUsing: review.timeUsing ?? null,
    resultsSeen: parseStringArray(review.resultsSeen),
    helpfulCount: review.helpfulCount,
    reply: review.reply ?? null,
    replyAt: review.replyAt ? review.replyAt.toISOString() : null,
    media: review.media
      .filter((m) => m.url)
      .map((m) => ({
        id: m.id,
        type: (m.type === "VIDEO" ? "VIDEO" : "IMAGE") as "IMAGE" | "VIDEO",
        url: m.url as string,
        thumbUrl: m.thumbUrl ?? (m.url as string),
      })),
  } as ReviewDTO;
}

async function findSummaryDTO(
  shop: string,
  productId: string,
  locale: string | undefined,
): Promise<SummaryDTO | null> {
  const rows = await prisma.summary.findMany({
    where: { shop, productId },
    orderBy: { updatedAt: "desc" },
  });
  if (rows.length === 0) return null;
  const row = (locale && rows.find((r) => r.locale === locale)) || rows[0];
  return {
    locale: row.locale,
    text: row.text,
    topics: topicsToDTO(parseStoredTopics(row.topics)),
  } as SummaryDTO;
}

/**
 * Resolves the review ids belonging to a topic chip. Topic -> review filtering
 * uses the `reviewIds` stored inside the Summary topics JSON (§7); the ids are
 * identical across locale variants, so any summary row for the product works —
 * the requested locale is simply preferred.
 */
async function topicReviewIds(
  shop: string,
  productId: string,
  topicKey: string,
  locale: string | undefined,
): Promise<string[]> {
  const rows = await prisma.summary.findMany({
    where: { shop, productId },
    orderBy: { updatedAt: "desc" },
  });
  const ordered = locale
    ? [...rows.filter((r) => r.locale === locale), ...rows.filter((r) => r.locale !== locale)]
    : rows;
  for (const row of ordered) {
    const topic = parseStoredTopics(row.topics).find((t) => t.key === topicKey);
    if (topic && topic.reviewIds.length > 0) return topic.reviewIds;
  }
  return [];
}

async function loadMediaGallery(
  shop: string,
  productId: string,
): Promise<ListResponse["media_gallery"]> {
  const rows = await prisma.reviewMedia.findMany({
    where: {
      url: { not: null },
      review: { shop, productId, status: "PUBLISHED" },
    },
    orderBy: [{ review: { createdAt: "desc" } }, { position: "asc" }],
    take: 12,
    include: { review: { select: { authorName: true, rating: true } } },
  });
  return rows.map((m) => ({
    reviewId: m.reviewId,
    type: (m.type === "VIDEO" ? "VIDEO" : "IMAGE") as "IMAGE" | "VIDEO",
    url: m.url as string,
    thumbUrl: m.thumbUrl ?? (m.url as string),
    authorName: m.review.authorName,
    rating: m.review.rating,
  })) as ListResponse["media_gallery"];
}

/**
 * Largest-remainder rounding: floor each percentage, then hand the remaining
 * points to the buckets with the biggest fractional parts (non-empty buckets
 * only), so integer percents sum to exactly 100 whenever total > 0.
 */
function buildDistribution(
  counts: Record<number, number>,
  total: number,
): Record<string, { count: number; percent: number }> {
  const entries = [5, 4, 3, 2, 1].map((star) => {
    const count = counts[star] ?? 0;
    const exact = total > 0 ? (count * 100) / total : 0;
    const floored = Math.floor(exact);
    return { star, count, percent: floored, remainder: exact - floored };
  });

  if (total > 0) {
    let deficit = 100 - entries.reduce((sum, entry) => sum + entry.percent, 0);
    const byRemainder = [...entries].sort(
      (a, b) => b.remainder - a.remainder || b.count - a.count,
    );
    for (const entry of byRemainder) {
      if (deficit <= 0) break;
      if (entry.count > 0) {
        entry.percent += 1;
        deficit -= 1;
      }
    }
  }

  const distribution: Record<string, { count: number; percent: number }> = {};
  for (const entry of entries) {
    distribution[String(entry.star)] = { count: entry.count, percent: entry.percent };
  }
  return distribution;
}

function parseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function includesKey(list: readonly string[], value: string): boolean {
  return list.includes(value);
}

/**
 * Coerces a Date or date string into a valid Date, or null when absent or
 * unparsable — imported/generated data must never crash a create with an
 * Invalid Date reaching Prisma.
 */
function toValidDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  try {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  } catch {
    return null;
  }
}

/** Trim a nullable string to a max length; empty results become null. */
function normalize(value: string | null | undefined, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim().slice(0, maxLength);
  return trimmed.length > 0 ? trimmed : null;
}

function filterKeys(list: readonly string[], values: string[] | null | undefined): string[] {
  if (!Array.isArray(values)) return [];
  const unique: string[] = [];
  for (const value of values) {
    if (typeof value === "string" && list.includes(value) && !unique.includes(value)) {
      unique.push(value);
    }
  }
  return unique;
}

function clampInt(value: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}
