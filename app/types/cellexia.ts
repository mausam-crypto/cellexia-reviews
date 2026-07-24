/**
 * Shared constants, union types and DTO shapes for Cellexia Reviews.
 *
 * Every module imports these from `~/types/cellexia`. The DTO interfaces
 * mirror the storefront JSON API contract (SPEC §6) — the JSON field names on
 * the wire (snake_case where shown) are part of that contract.
 *
 * The i18n label for an option key `X` lives at `cellexia.age.X`,
 * `cellexia.skin.X`, `cellexia.time.X`, `cellexia.results.X` and
 * `cellexia.report.X` in the extension locale files.
 */

// ─── Option key sets ─────────────────────────────────────────────────────────

export const AGE_RANGES = [
  "under_25",
  "25_34",
  "35_44",
  "45_54",
  "55_64",
  "65_plus",
] as const;

export const SKIN_CONCERNS = [
  "fine_lines",
  "dark_spots",
  "dryness",
  "dullness",
  "firmness",
  "texture",
  "sensitivity",
  "redness",
  "pores",
  "dark_circles",
] as const;

export const TIME_USING = ["lt_1w", "w1_4", "m1_3", "m3_6", "gt_6m"] as const;

export const RESULTS_SEEN = [
  "smoother",
  "fewer_lines",
  "firmer",
  "radiance",
  "even_tone",
  "hydration",
  "calmer",
  "too_early",
] as const;

export const REPORT_REASONS = [
  "off_topic",
  "inappropriate",
  "spam",
  "privacy",
  "other",
] as const;

export const SORTS = ["top", "recent"] as const;

export const REVIEW_STATUSES = ["PENDING", "PUBLISHED", "REJECTED", "SPAM"] as const;

/**
 * Review provenance (SPEC-1.4 §0): how a review entered the system. Stored on
 * `Review.source`; a NULL database value marks pre-1.4 rows and is treated as
 * "storefront" by admin filters. Admin-only metadata — this field (and the
 * companion isSynthetic / syntheticBatchId / syntheticGeneratedAt columns) is
 * NEVER serialized into storefront DTOs or proxy responses.
 */
export const REVIEW_SOURCES = [
  "storefront",
  "csv-import",
  "bulk-add",
  "synthetic",
] as const;

export const SHOP_LOCALES = [
  "en",
  "fr",
  "de",
  "da",
  "sv",
  "fi",
  "nl",
  "it",
  "es",
  "ar",
  "pl",
  "pt-PT",
  "ja",
  "nb",
  "ro",
  "hu",
  "el",
] as const;

/**
 * Storefront widget design versions (SPEC-1.1, SPEC-1.3). Applied on the
 * widget root as `data-cx-skin`; "amazon" is the v1.0 look and stays the
 * default. "luxe" (v1.3) is the premium-skincare skin.
 */
export const DESIGN_THEMES = ["amazon", "cellexia", "luxe"] as const;

// ─── Union types ─────────────────────────────────────────────────────────────

export type AgeRange = (typeof AGE_RANGES)[number];
export type SkinConcern = (typeof SKIN_CONCERNS)[number];
export type TimeUsing = (typeof TIME_USING)[number];
export type ResultsSeen = (typeof RESULTS_SEEN)[number];
export type ReportReason = (typeof REPORT_REASONS)[number];
export type Sort = (typeof SORTS)[number];
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
export type ReviewSource = (typeof REVIEW_SOURCES)[number];
export type ShopLocale = (typeof SHOP_LOCALES)[number];
export type DesignTheme = (typeof DESIGN_THEMES)[number];

export type MediaType = "IMAGE" | "VIDEO";
export type TopicSentiment = "positive" | "negative" | "mixed";

// ─── Submission limits (SPEC §6, shared by [proxy] validation) ───────────────

export const MAX_TITLE_LENGTH = 150;
export const MAX_BODY_LENGTH = 5000;
export const MAX_AUTHOR_NAME_LENGTH = 80;
export const MAX_IMAGES_PER_REVIEW = 5;
export const MAX_VIDEOS_PER_REVIEW = 1;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB
export const MAX_VIDEO_BYTES = 80 * 1024 * 1024; // 80 MB
export const MAX_TRANSLATE_IDS = 20;
export const MEDIA_GALLERY_LIMIT = 12;
export const MIN_SUBMIT_DELAY_MS = 3000; // reject forms submitted < 3 s after t_start

// ─── DTOs (SPEC §6 JSON shapes) ──────────────────────────────────────────────

export interface ReviewMediaDTO {
  id: string;
  type: MediaType;
  /** Resolved CDN URL — null until Shopify finishes processing the file. */
  url: string | null;
  thumbUrl: string | null;
}

export interface ReviewDTO {
  id: string;
  rating: number;
  title: string | null;
  body: string;
  /** ISO 639-1 (+region for pt-PT). */
  language: string;
  authorName: string;
  /** ISO 3166-1 alpha-2 or null. */
  country: string | null;
  variantTitle: string | null;
  verified: boolean;
  /** ISO 8601 timestamp. */
  createdAt: string;
  ageRange: AgeRange | null;
  skinConcerns: SkinConcern[];
  timeUsing: TimeUsing | null;
  resultsSeen: ResultsSeen[];
  helpfulCount: number;
  reply: string | null;
  replyAt: string | null;
  media: ReviewMediaDTO[];
}

export type StarKey = "1" | "2" | "3" | "4" | "5";

export interface DistributionBucketDTO {
  count: number;
  /** Integer 0–100. */
  percent: number;
}

export interface ProductStatsDTO {
  /** Numeric Shopify product id as string. */
  id: string;
  /** Rounded to one decimal, e.g. 4.6. */
  average: number;
  count: number;
  distribution: Record<StarKey, DistributionBucketDTO>;
}

export interface TopicDTO {
  key: string;
  label: string;
  count: number;
  pos: number;
  neg: number;
  sentiment: TopicSentiment;
  blurb: string;
  /** Lowercase substrings used for client-side highlighting. */
  terms: string[];
  /**
   * Review ids the topic was extracted from. Present in the Summary.topics
   * JSON stored in the database (SPEC §7, used for topic → review filtering);
   * optional in public API payloads.
   */
  reviewIds?: string[];
}

export interface SummaryDTO {
  locale: string;
  text: string;
  topics: TopicDTO[];
}

export interface MediaGalleryItemDTO {
  reviewId: string;
  type: MediaType;
  url: string | null;
  thumbUrl: string | null;
  authorName: string;
  rating: number;
}

/** GET /apps/cellexia/api/reviews response body. */
export interface ListResponse {
  product: ProductStatsDTO;
  summary: SummaryDTO | null;
  reviews: ReviewDTO[];
  /** Up to MEDIA_GALLERY_LIMIT items on page 1, [] otherwise. */
  media_gallery: MediaGalleryItemDTO[];
  page: number;
  per_page: number;
  total: number;
  total_pages: number;
  /**
   * Storefront-relevant admin settings the theme block cannot read from the
   * app DB; the widget JS applies them on every load (applyServerSettings).
   */
  settings: {
    showTranslate: boolean;
    brandDisplayName: string;
    /** Active storefront design version, applied as `data-cx-skin`. */
    designTheme: DesignTheme;
  };
}

/** POST /apps/cellexia/api/reviews response body. */
export interface SubmitResponse {
  ok: boolean;
  /** Present when ok is true. */
  status?: "PENDING" | "PUBLISHED";
  /** Present when ok is false: field name (or "_") → error code. */
  errors?: Record<string, string>;
}

// ─── Service-layer inputs (SPEC §7 signatures) ───────────────────────────────

/** Parameters accepted by reviews.server.ts → listReviews. */
export interface ListParams {
  /** Numeric Shopify product id as string. Required. */
  productId: string;
  /** 1-based, default 1. */
  page?: number;
  /** Default from settings, max 50. */
  perPage?: number;
  /** Default "top". */
  sort?: Sort;
  /** 1–5. */
  stars?: number;
  verified?: boolean;
  withMedia?: boolean;
  ageRange?: AgeRange;
  skinConcern?: SkinConcern;
  timeUsing?: TimeUsing;
  resultsSeen?: ResultsSeen;
  /** Topic key from the product summary. */
  topic?: string;
  /** Case-insensitive text search over title + body. */
  q?: string;
  /** Widget locale. */
  locale?: string;
}

export interface CreateReviewMediaInput {
  type: MediaType;
  fileGid?: string | null;
  url?: string | null;
  thumbUrl?: string | null;
  position?: number;
}

/** Input accepted by reviews.server.ts → createReview. */
export interface CreateReviewInput {
  productId: string;
  rating: number;
  title?: string | null;
  body: string;
  authorName: string;
  authorEmail: string;
  language?: string;
  ageRange?: AgeRange | null;
  skinConcerns?: SkinConcern[];
  timeUsing?: TimeUsing | null;
  resultsSeen?: ResultsSeen[];
  variantTitle?: string | null;
  country?: string | null;
  customerId?: string | null;
  verified?: boolean;
  status?: ReviewStatus;
  ipHash?: string | null;
  productTitle?: string | null;
  productHandle?: string | null;
  media?: CreateReviewMediaInput[];
}
