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

/**
 * Background generation job lifecycle (SPEC-1.7 §1). QUEUED jobs wait for a
 * runner slot (max 2 RUNNING per shop); RUNNING jobs heartbeat after every
 * chunk; COMPLETED / FAILED / CANCELLED are terminal. A job ends FAILED only
 * when zero reviews were created or the AI key is missing/invalid; cancelling
 * keeps everything already generated.
 */
export const JOB_STATUSES = [
  "QUEUED",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;

/**
 * Review display-order systems (SPEC-1.8 §2). "amazon_top" is the shipped
 * default and orders exactly like the historical "top" sort, so out-of-the-box
 * stores keep today's ordering. Stored on `Setting.rankingStrategy` (shop-wide
 * default) and `ProductDisplayConfig.strategy` (per-product override, null =
 * inherit). The i18n/admin label for a key lives with the admin display page,
 * never in the storefront payload.
 */
export const RANKING_STRATEGIES = [
  "amazon_top",
  "top_positive",
  "most_recent",
  "verified_first",
  "media_first",
  "balanced",
] as const;

/**
 * Translation display modes (SPEC-1.8 §4). "original" is the shipped default
 * (original language + a per-review Translate button — the pre-1.8 behavior);
 * "translated" auto-translates foreign-language reviews into the shopper's
 * locale server-side, and the widget offers "See original"/"See translation"
 * toggles instead of the Translate button.
 */
export const TRANSLATION_DISPLAYS = ["original", "translated"] as const;

/**
 * "Overall reviews" homepage-block modes (SPEC-1.9 §1), stored inside the
 * `Setting.overallWidget` JSON. "auto" (the default) lets the brand ranking
 * pick the strongest recent reviews across all products (max 2 per product);
 * "picked" shows the merchant's hand-picked review ids in their stored order,
 * auto-backfilled when fewer than the block displays. Unknown stored modes
 * degrade to "auto" on read.
 */
export const OVERALL_WIDGET_MODES = ["auto", "picked"] as const;

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
export type JobStatus = (typeof JOB_STATUSES)[number];
export type RankingStrategy = (typeof RANKING_STRATEGIES)[number];
export type TranslationDisplay = (typeof TRANSLATION_DISPLAYS)[number];
export type OverallWidgetMode = (typeof OVERALL_WIDGET_MODES)[number];

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
/** SPEC-1.8 §3: at most this many pinned ("featured") reviews per product. */
export const MAX_PINNED_REVIEWS = 10;
/**
 * SPEC-1.9 §1/§4: the "Overall reviews" block's featured-review budget — the
 * `cellexia.shop_top_reviews` metafield holds at most this many entries and
 * the admin's hand-picked list is capped to the same number.
 */
export const MAX_OVERALL_TOP_REVIEWS = 12;

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
  /**
   * v1.8 (SPEC-1.8 §4): server-side auto-translation of title/body/reply into
   * the request locale, attached only when the shop runs the "translated"
   * display mode, the review's language differs from the shopper's locale and
   * a translation was actually available (cache or provider). `from` is the
   * review's original language code — the widget renders "Translated from X"
   * and a See original toggle from it. Provider failures simply omit the key
   * (the widget falls back to the original text), never an error.
   * Public-safe by design: translated content of a PUBLISHED review.
   */
  translated?: { title: string | null; body: string; reply: string | null; from: string };
  /**
   * v1.8 (SPEC-1.8 §2): present (as `true`) ONLY on merchant-pinned
   * ("featured") reviews served in the pinned region of the unfiltered "top"
   * sort. Absent everywhere else — filtered views, "recent" sort and
   * non-pinned rows never carry the key. Public-safe by design (the pinned
   * reviews themselves are ordinary published reviews).
   */
  pinned?: true;
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
    /**
     * v1.8 (SPEC-1.8 §4): the EFFECTIVE translation display mode. Serialized
     * as "translated" only when the stored setting is "translated" AND
     * translations are possible at all (showTranslate on, provider not off) —
     * mirroring how `showTranslate` above collapses, so the widget never
     * hides its Translate controls for a mode that can't produce content.
     */
    translationDisplay: TranslationDisplay;
  };
  /**
   * MERCHANT-ONLY extras (SPEC-1.6.1 §B) — optional by design.
   *
   * HARD SECURITY CONTRACT: the proxy route serializes this key ONLY when the
   * request proved it is a merchant session by carrying the shop's CURRENT
   * preview token. A shopper on a live store (no token) must never receive it,
   * so `listReviews` populates it only when explicitly asked
   * (`ListParams.includeMeta`) and the route decides that flag from the token,
   * never from the live state. Anything added here inherits the same rule:
   * this object is the only place in the storefront payload where data the
   * public may not see is allowed to appear.
   */
  meta?: {
    /**
     * Reviews for THIS product awaiting approval in the app. Powers the
     * merchant notice "No published reviews yet — N awaiting approval"
     * (`cellexia.notice.empty_pending`) when the list comes back empty.
     */
    pendingCount: number;
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

/**
 * One product's sitewide star-badge stats (SPEC-1.5 §2), computed over
 * PUBLISHED reviews only with the same one-decimal average rounding as
 * ProductStatsDTO.
 */
export interface BadgeStatsDTO {
  /** Rounded to one decimal, e.g. 4.6. */
  average: number;
  count: number;
}

/** GET /apps/cellexia/api/badges response body (SPEC-1.5 §2). */
export interface BadgesResponse {
  /**
   * Keyed by product handle. Only handles with at least one PUBLISHED review
   * appear — unknown or reviewless handles are simply omitted.
   */
  badges: Record<string, BadgeStatsDTO>;
}

// ─── v1.9 brand-wide "Overall reviews" (SPEC-1.9 §1) ─────────────────────────

/**
 * Brand-wide aggregate stats over every product's PUBLISHED reviews
 * (SPEC-1.9 §1), mirrored onto the `cellexia.shop_rating` SHOP metafield for
 * SSR and served by GET /apps/cellexia/api/brand-reviews. Rounding matches
 * ProductStatsDTO: weighted average to one decimal, integer distribution
 * percents via the largest-remainder method (they sum to 100 when count > 0).
 */
export interface ShopStatsDTO {
  /** Weighted average across all products, rounded to one decimal. */
  average: number;
  /** Total PUBLISHED reviews across all products. */
  count: number;
  /** Integer 0–100: share of PUBLISHED reviews that are verified purchases. */
  verifiedPercent: number;
  distribution: Record<StarKey, DistributionBucketDTO>;
}

/**
 * One review in the brand-wide list (SPEC-1.9 §1): the ordinary public
 * ReviewDTO (same whitelist — no admin-only fields can ever appear) plus the
 * product it belongs to, resolved from the Review row itself so the proxy hot
 * path never calls the Admin API.
 */
export interface BrandReviewDTO extends ReviewDTO {
  product: {
    title: string | null;
    handle: string | null;
    /** Relative product URL ("/products/<handle>"), null when the handle is unknown. */
    url: string | null;
  };
}

/** GET /apps/cellexia/api/brand-reviews response body (SPEC-1.9 §1). */
export interface BrandReviewsResponse {
  /** Shop-wide stats — always unfiltered, even when `stars` narrows the list. */
  stats: ShopStatsDTO;
  /**
   * Ordered by the brand auto score (stars filter applies before scoring;
   * hand-picked reviews occupy the first slots when unfiltered).
   */
  reviews: BrandReviewDTO[];
  page: number;
  per_page: number;
  total: number;
  total_pages: number;
}

// ─── v1.7 background generation (SPEC-1.7 §1/§3/§4) ─────────────────────────

/**
 * The pricing row an estimate was computed with, echoed back so the UI can
 * name the rates (and the introductory-pricing window while it applies)
 * without hardcoding them.
 */
export interface EstimatePricingDTO {
  /** USD per million input tokens. */
  inPerMTok: number;
  /** USD per million output tokens. */
  outPerMTok: number;
  /**
   * Last day (YYYY-MM-DD, inclusive) of an introductory rate, present only
   * while `inPerMTok`/`outPerMTok` above ARE that introductory rate.
   */
  introUntil?: string;
}

/**
 * Pre-generation cost & time estimate (SPEC-1.7 §4), produced by
 * `estimateGeneration` (app/services/estimate.server.ts) and stored verbatim
 * on `GenerationJob.estimate`.
 */
export interface EstimateDTO {
  /** Review count the estimate was computed for. */
  reviews: number;
  /** ceil(reviews / 8) Claude calls. */
  chunks: number;
  /** Estimated total input tokens across all chunks. */
  inputTokens: number;
  /** Estimated total output tokens across all chunks. */
  outputTokens: number;
  /** inputTokens/1e6 * inRate + outputTokens/1e6 * outRate (USD). */
  costUsd: number;
  /** Expected duration in seconds (low end). */
  seconds: number;
  /** Pessimistic duration in seconds (high end of the range). */
  secondsHigh: number;
  /**
   * "measured" = calibrated from this shop's own ModelThroughput history;
   * "baseline" = token-count of one sample chunk (or the documented static
   * fallback) plus the documented default chunk duration.
   */
  basis: "measured" | "baseline";
  /** Model id the estimate was priced for. */
  model: string;
  pricing: EstimatePricingDTO;
  /**
   * Human basis line for the UI's subdued detail row, e.g. "Based on your
   * last 27 generated batches" or "Based on a token count of one sample
   * batch". Optional so the DTO shape of SPEC-1.7 §1 stays the contract.
   */
  detail?: string;
  /** "Estimate only — actual usage may differ." (UI never hardcodes it.) */
  caveat?: string;
}

/**
 * Admin-facing shape of one generation job (SPEC-1.7 §3), returned by
 * `listJobs` / `activeJobSummary` (app/services/jobs.server.ts) and polled by
 * `/app/jobs/status`. All timestamps are ISO 8601 strings.
 *
 * `chunksTotal`/`chunksDone` describe the CURRENT run: they are recomputed
 * when a job is (re)claimed after a crash, so the live ETA derived from them
 * self-corrects instead of being skewed by pre-crash progress.
 */
export interface JobDTO {
  id: string;
  status: JobStatus;
  productId: string;
  productTitle: string | null;
  /** The Review.syntheticBatchId this job writes ("View reviews" link). */
  batchId: string;
  /** Reviews requested. */
  target: number;
  /** Reviews created so far (survives crash/resume — counted from the DB). */
  created: number;
  /** Specs attempted but not created (failed chunks, DB errors). */
  failed: number;
  chunksTotal: number;
  chunksDone: number;
  /** Actual token usage summed across chunks (0 until the first chunk). */
  inputTokens: number;
  outputTokens: number;
  /** Actual cost in USD computed from real token usage. */
  costUsd: number;
  /** The pre-run estimate, when the merchant produced one. */
  estimate: EstimateDTO | null;
  /** First fatal error (FAILED jobs), truncated to 500 chars. */
  error: string | null;
  /** Per-chunk failure messages, capped at 20. */
  errors: string[];
  cancelRequested: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  heartbeatAt: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * Live ETA in seconds for RUNNING jobs, recomputed from this job's own
   * observed chunk durations (SPEC-1.7 §4); falls back to the stored
   * estimate before the first chunk completes. Null for non-running jobs.
   */
  etaSeconds: number | null;
  /**
   * Seconds between startedAt and finishedAt (finished jobs) or "now"
   * (running jobs). Null before the job first starts.
   */
  elapsedSeconds: number | null;
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
  /**
   * Populate the merchant-only `ListResponse.meta` (SPEC-1.6.1 §B). The proxy
   * route sets this ONLY for a request carrying a valid preview token — never
   * for an ordinary storefront visitor. Defaults to false/absent, so every
   * existing caller keeps producing a shopper-safe payload.
   */
  includeMeta?: boolean;
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
