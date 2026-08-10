/**
 * Cellexia Reviews — synthetic QA review generator (SPEC-1.4 §C).
 *
 * Pipeline overview:
 *   - CODE (not AI) assigns every structured field per review: star rating
 *     (integer distribution derived to match the target average ±0.05),
 *     language, backdated createdAt, verified flag, variant, long-tail helpful
 *     votes, rating-coherent structured attributes, reply-yes/no + reply date,
 *     persona/tone/length spec (rotated through the prompt bank honoring
 *     LENGTH_MIX) and a batch-unique reviewer display name from the per-locale
 *     name pools.
 *   - The AI writes ONLY title / body / (optional) merchant reply, in the
 *     assigned language, via strict-JSON chunks of 8 reviews per Messages API
 *     call (`callClaudeWithUsage` below — a usage-capturing mirror of the
 *     ai.server.ts client, see its comment). Parallelism 2 inside
 *     `generateSyntheticBatch`; per-chunk retry once; failed chunks are
 *     reported in `errors` without aborting the batch.
 *   - Every row is flagged `isSynthetic: true, source: "synthetic",
 *     syntheticBatchId, syntheticGeneratedAt` with `ipHash: null`. Those
 *     columns are admin-only and are never serialized to the storefront.
 *
 * Determinism: the whole batch plan is a pure function of (config, batchId) —
 * a seeded PRNG keyed on the batchId rebuilds the identical plan on every
 * call. That makes the chunk-driven progress flow (app.qa-generator.tsx
 * submits sequential chunks of 8, threading the batchId through a hidden
 * field) stateless on the server: each request recomputes the plan and
 * processes only its slice.
 *
 * Error handling: no function in this module throws for AI failures — missing
 * key, network errors, malformed JSON and refusals all degrade into honest
 * per-chunk `errors` entries with `failed` counts. Database errors are caught
 * per row. `syntheticStats` never throws (the QA page loader depends on it).
 *
 * v1.7 (SPEC-1.7): the per-batch cap is gone and the background job runner
 * (jobs.server.ts) drives the exported per-chunk unit `generateChunk`, which
 * additionally reports ACTUAL Anthropic token usage, the model used and the
 * wall-clock chunk duration (feeding GenerationJob cost actuals and the
 * ModelThroughput calibration). `generateSyntheticChunk` and
 * `generateSyntheticBatch` are unchanged wrappers for pre-1.7 callers.
 * Deleting a batch now also cancels/deletes its GenerationJob rows
 * (SPEC-1.7 §7).
 *
 * v1.10 (SPEC-1.10 §2–§4):
 *   - Optional `languageWeights` / `variantWeights` share maps on the config
 *     (validated in parseSyntheticConfig; keys ⊆ the selected languages /
 *     the product's variants + the reserved "__none__" row). When present,
 *     buildBatchPlan apportions counts by deterministic largest remainder
 *     and shuffles the assignment across specs; when absent, the pre-1.10
 *     paths run byte-identically (same RNG consumption), so existing batch
 *     plans and resumed jobs rebuild unchanged.
 *   - Em/en-dash scrub: STYLE_RULES is appended to the chunk generation
 *     prompt and scrubDashes sanitizes every parsed title/body/reply, so
 *     generated reviews never ship em or en dashes (hyphens untouched).
 */
import crypto from "node:crypto";
import type { AdminApiContext as BaseAdminApiContext } from "@shopify/shopify-app-remix/server";
import type { Setting } from "@prisma/client";
import prisma from "~/db.server";
import {
  AGE_RANGES,
  RESULTS_SEEN,
  SHOP_LOCALES,
  SKIN_CONCERNS,
  TIME_USING,
} from "~/types/cellexia";
import type { ShopLocale } from "~/types/cellexia";
import { recomputeProduct } from "./aggregates.server";
import { createReview } from "./reviews.server";
import { extractJson } from "./ai.server";
import { thinkingParamFor } from "./pricing.server";
import { getSettings } from "./settings.server";
import {
  DISPLAY_FORMATS,
  formatDisplayName,
  poolFor,
} from "./synthetic-names.server";
import {
  LENGTH_MIX,
  PERSONA_BRIEFS,
  STYLE_RULES,
  hasFragranceFreeClaim,
  scrubDashes,
  scrubEmojis,
} from "./synthetic-prompts.server";
import type { LengthBand } from "./synthetic-prompts.server";

/**
 * Admin client accepted by this module — same structural shape the other
 * services use (`future.removeRest` is enabled, so only `graphql` is relied
 * on; contexts with and without REST both satisfy it).
 */
export type AdminClient = Pick<BaseAdminApiContext, "graphql">;

/** Reviews per Messages API call (SPEC-1.4 §C, unchanged by SPEC-1.7 §2). */
export const SYNTHETIC_CHUNK_SIZE = 8;
/**
 * @deprecated v1.7 removed the per-batch cap (SPEC-1.7 §2) — this constant is
 * no longer enforced anywhere and is kept only so pre-1.7 importers still
 * compile. The only remaining bound is MAX_SYNTHETIC_REVIEWS below.
 */
export const MAX_SYNTHETIC_PER_BATCH = 200;
/**
 * Defensive ceiling on `count` (SPEC-1.7 §2 removes the product cap; the UI
 * warns via the live estimate instead). This is NOT a product limit — it only
 * stops a malformed/hostile request from making buildBatchPlan allocate an
 * absurd plan (each spec is a few hundred bytes; 100k ≈ tens of MB, fine —
 * 1e9 would OOM the process).
 */
export const MAX_SYNTHETIC_REVIEWS = 100000;
/** Concurrent AI calls inside generateSyntheticBatch. */
const AI_PARALLELISM = 2;
/** Cap on collected error strings so a pathological run can't bloat responses. */
const MAX_ERRORS = 50;

const NO_AI_KEY_MESSAGE =
  "The generator needs the Anthropic API key from Settings → AI Summary";

/**
 * Reserved `variantWeights` key meaning "no variant assigned" (SPEC-1.10 §3).
 * The admin UI mirrors this constant client-side (a .server module cannot be
 * imported into the browser bundle).
 */
export const VARIANT_NONE_KEY = "__none__";

/* ------------------------------------------------------------------------- *
 * Config
 * ------------------------------------------------------------------------- */

/** Every knob of the QA-generator config form (SPEC-1.4 §C), typed. */
export interface SyntheticConfig {
  /** Numeric Shopify product id as a string. */
  productId: string;
  productTitle: string;
  productHandle: string | null;
  /** Plain-text product description for the AI context, ≤ 4000 chars. */
  productDescription: string;
  productType: string | null;
  productTags: string[];
  /** Real variant titles of the product (may be empty). */
  productVariants: string[];
  /** Number of reviews (default 20, min 1; uncapped since v1.7 — SPEC-1.7 §2). */
  count: number;
  /** Target average star rating (default 4.5, 1.0–5.0 step 0.1). */
  targetAverage: number;
  /** Verified purchases % (default 80). */
  verifiedPercent: number;
  /** Assigned languages (subset of SHOP_LOCALES, default ["en"]). */
  languages: ShopLocale[];
  /** Merchant replies % (default 15). */
  repliesPercent: number;
  /** Max helpful votes per review (default 25). */
  maxHelpfulVotes: number;
  /** Review date range, YYYY-MM-DD (default 2025-04-01 → today). */
  dateStart: string;
  dateEnd: string;
  /** Assign product variants to some reviews. */
  assignVariants: boolean;
  /** Fill age/skin/time/results with rating-coherent combinations. */
  structuredAttrs: boolean;
  /** Status at creation. */
  status: "PUBLISHED" | "PENDING";
  /**
   * v1.30 (SPEC-1.30): scheduled auto-publish. An ISO-8601 UTC instant
   * (always stored normalized, e.g. "2026-08-12T06:00:00.000Z"). When
   * present the reviews are created as PENDING (`status` is forced) and the
   * publish scheduler flips the batch to PUBLISHED once the job has finished
   * — skeptic pass included — AND this time has passed. Absent = the
   * pre-1.30 behavior (the merchant's chosen status, no scheduling).
   */
  publishAt?: string;
  /**
   * v1.25: how human the writing reads, 0-100. 0 = every review polished,
   * 100 = most reviews carry slips. Maps onto the clean/minor/sloppy mix;
   * 50 (the default) restores the v1.23 feel after v1.24 overshot.
   */
  humanTouch: number;
  /** v1.24: the skeptical double-check pass (SPEC-1.24 §1). */
  skepticCheck: boolean;
  /** Reviews per skeptic call ("every batch of X"), clamped 5–60. */
  skepticBatchSize: number;
  /**
   * v1.29 (SPEC-1.29): this product is a HAIR product. Reviews talk about
   * hair and scalp (hair-variant persona briefs + a category instruction in
   * the prompt), skin-concern attributes are left empty and results_seen is
   * restricted to hair-safe keys. Default false = the skincare behavior.
   */
  hairProduct: boolean;
  /**
   * v1.29: optional merchant-written product context, appended verbatim to
   * the prompt's PRODUCT CONTEXT block (≤ 2000 chars). Empty = omitted.
   */
  extraProductInfo: string;
  /**
   * Optional per-language shares (SPEC-1.10 §2). Keys ⊆ `languages`, values
   * ≥ 0 relative weights (the UI sends percentages; any positive scale
   * works — counts are apportioned by largest remainder over the total).
   * Absent ⇒ the pre-1.10 even split + jitter.
   */
  languageWeights?: Record<string, number>;
  /**
   * Optional per-variant shares (SPEC-1.10 §3). Keys ⊆ `productVariants`
   * plus the reserved VARIANT_NONE_KEY ("__none__") row; same semantics as
   * languageWeights. Only meaningful while `assignVariants` is on.
   * Absent ⇒ the pre-1.10 randomized weighting.
   */
  variantWeights?: Record<string, number>;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function cleanString(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  // Strip control characters (tab and newline are kept — descriptions carry
  // their line breaks into the AI prompt). Escape-free on purpose.
  let out = "";
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    const isControl = (code < 32 && code !== 9 && code !== 10) || code === 127;
    out += isControl ? " " : ch;
  }
  return out.trim().slice(0, max);
}

function isIsoDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return !Number.isNaN(new Date(`${value}T12:00:00.000Z`).getTime());
}

/**
 * Validates an optional share-weight map (SPEC-1.10 §2/§3): every key must be
 * in `allowedKeys`, every value a finite number ≥ 0, and at least one value
 * positive — anything else invalidates the WHOLE map (⇒ undefined ⇒ the
 * pre-1.10 behavior; the UI cannot produce an invalid map, so a broken one is
 * a hand-crafted request that safely degrades). Values are rounded to 2
 * decimals and capped, keeping the sanitized config idempotent under
 * re-parsing (the job runner stores it as JSON and re-reads it every run).
 * Weights are relative — they do NOT need to sum to 100.
 */
function parseShareWeights(
  raw: unknown,
  allowedKeys: readonly string[],
): Record<string, number> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const allowed = new Set(allowedKeys);
  const out: Record<string, number> = {};
  let anyPositive = false;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!allowed.has(key)) return undefined;
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) return undefined;
    const clean = Math.min(1_000_000, Math.round(num * 100) / 100);
    out[key] = clean;
    if (clean > 0) anyPositive = true;
  }
  if (!anyPositive) return undefined;
  return out;
}

function todayIsoDay(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * v1.30 (SPEC-1.30 §1): the scheduled publish instant must be an EXPLICIT
 * UTC ISO string — the trailing Z is required, because a zone-less string
 * would be parsed in the server's local timezone (a silent dialect the UI
 * never speaks). Seconds/milliseconds are optional; the value is stored
 * normalized via toISOString().
 */
const PUBLISH_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/;
/** Static validity bounds — deterministic under re-parse, unlike "now". */
const PUBLISH_AT_MIN_MS = Date.UTC(2020, 0, 1);
const PUBLISH_AT_MAX_MS = Date.UTC(2100, 0, 1);

/**
 * Sanitizes an untrusted (client-supplied) config object into a valid
 * SyntheticConfig. Everything except the product reference clamps to safe
 * defaults; a missing/invalid product id is the only hard error.
 *
 * IMPORTANT: sanitation must be deterministic for a fixed input — the chunked
 * generation flow re-sends the same JSON with every chunk and the batch plan
 * is derived from the sanitized result.
 */
export function parseSyntheticConfig(
  raw: unknown,
): { config: SyntheticConfig; error: null } | { config: null; error: string } {
  if (typeof raw !== "object" || raw === null) {
    return { config: null, error: "The generator configuration is malformed" };
  }
  const v = raw as Record<string, unknown>;

  const idSource = cleanString(v.productId, 128);
  const idMatch = idSource.match(/\d+/g);
  const productId = /^\d+$/.test(idSource)
    ? idSource
    : idMatch
      ? idMatch.reduce((a, b) => (b.length > a.length ? b : a), "")
      : "";
  if (!productId) {
    return { config: null, error: "Pick a product before generating reviews" };
  }

  const languagesRaw = Array.isArray(v.languages) ? v.languages : [];
  const languageSet = new Set<string>();
  for (const lang of languagesRaw) {
    if (typeof lang === "string" && (SHOP_LOCALES as readonly string[]).includes(lang)) {
      languageSet.add(lang);
    }
  }
  // Stable order (SHOP_LOCALES order) so the batch plan does not depend on
  // the click order in the form.
  const languages = (SHOP_LOCALES as readonly string[]).filter((l) =>
    languageSet.has(l),
  ) as ShopLocale[];

  const today = todayIsoDay();
  let dateStart =
    typeof v.dateStart === "string" && isIsoDay(v.dateStart.trim())
      ? v.dateStart.trim()
      : "2025-04-01";
  let dateEnd =
    typeof v.dateEnd === "string" && isIsoDay(v.dateEnd.trim()) ? v.dateEnd.trim() : today;
  // Future review dates would look broken in the widget — clamp to today.
  if (dateEnd > today) dateEnd = today;
  if (dateStart > dateEnd) [dateStart, dateEnd] = [dateEnd, dateStart];

  const tags: string[] = [];
  if (Array.isArray(v.productTags)) {
    for (const tag of v.productTags) {
      const t = cleanString(tag, 80);
      if (t && !tags.includes(t)) tags.push(t);
      if (tags.length >= 25) break;
    }
  }
  const variants: string[] = [];
  if (Array.isArray(v.productVariants)) {
    for (const variant of v.productVariants) {
      const t = cleanString(variant, 120);
      if (t && t !== "Default Title" && !variants.includes(t)) variants.push(t);
      if (variants.length >= 100) break;
    }
  }

  const rawAverage = Number(v.targetAverage);
  const targetAverage = Number.isFinite(rawAverage)
    ? Math.min(5, Math.max(1, Math.round(rawAverage * 10) / 10))
    : 4.5;

  const languageList = languages.length ? languages : (["en"] as ShopLocale[]);
  const assignVariants = v.assignVariants === true || v.assignVariants === "true";
  // SPEC-1.10 §2/§3 — optional share maps. Only meaningful with more than one
  // language (resp. variants actually being assigned); dropped otherwise so
  // the stored config stays minimal and the legacy plan paths run.
  const languageWeights =
    languageList.length > 1 ? parseShareWeights(v.languageWeights, languageList) : undefined;
  const variantWeights =
    assignVariants && variants.length > 0
      ? parseShareWeights(v.variantWeights, [VARIANT_NONE_KEY, ...variants])
      : undefined;

  // v1.30 (SPEC-1.30 §1): scheduled auto-publish. A malformed schedule is a
  // HARD error, never a silent drop — dropping it would either publish the
  // reviews immediately or strand them pending forever, both a silent
  // contradiction of what the merchant configured (the v1.17 sanitizer
  // lesson). A publish time in the past is accepted: the job may be enqueued
  // moments before the instant, or retried after it — the scheduler then
  // publishes as soon as the job finishes.
  let publishAt: string | undefined;
  if (v.publishAt !== undefined && v.publishAt !== null && v.publishAt !== "") {
    const rawPublish = typeof v.publishAt === "string" ? v.publishAt.trim() : "";
    const ms = PUBLISH_AT_RE.test(rawPublish) ? Date.parse(rawPublish) : NaN;
    if (!Number.isFinite(ms)) {
      return {
        config: null,
        error:
          "The scheduled publish time is invalid — use a UTC time like 2026-08-12T06:00:00.000Z",
      };
    }
    // Upper bound exclusive — the exact same contract as the admin form's
    // client mirror, so no instant passes one check and fails the other.
    if (ms < PUBLISH_AT_MIN_MS || ms >= PUBLISH_AT_MAX_MS) {
      return { config: null, error: "The scheduled publish time is out of range" };
    }
    publishAt = new Date(ms).toISOString();
  }

  const config: SyntheticConfig = {
    productId,
    productTitle: cleanString(v.productTitle, 255) || `Product ${productId}`,
    productHandle: cleanString(v.productHandle, 255) || null,
    productDescription: cleanString(v.productDescription, 4000),
    productType: cleanString(v.productType, 120) || null,
    productTags: tags,
    productVariants: variants,
    count: clampInt(v.count, 1, MAX_SYNTHETIC_REVIEWS, 20),
    targetAverage,
    verifiedPercent: clampInt(v.verifiedPercent, 0, 100, 80),
    languages: languageList,
    repliesPercent: clampInt(v.repliesPercent, 0, 100, 15),
    maxHelpfulVotes: clampInt(v.maxHelpfulVotes, 0, 1000, 25),
    dateStart,
    dateEnd,
    assignVariants,
    structuredAttrs: !(v.structuredAttrs === false || v.structuredAttrs === "false"),
    // A scheduled batch always starts PENDING — that is the whole point of
    // the schedule; a client-sent PUBLISHED must not leak the reviews early.
    status: publishAt ? "PENDING" : v.status === "PENDING" ? "PENDING" : "PUBLISHED",
    humanTouch: clampInt(v.humanTouch, 0, 100, 50),
    skepticCheck: !(v.skepticCheck === false || v.skepticCheck === "false"),
    skepticBatchSize: clampInt(v.skepticBatchSize, 5, 60, 20),
    hairProduct: v.hairProduct === true || v.hairProduct === "true",
    extraProductInfo: cleanString(v.extraProductInfo, 2000),
    ...(publishAt ? { publishAt } : {}),
    ...(languageWeights ? { languageWeights } : {}),
    ...(variantWeights ? { variantWeights } : {}),
  };
  return { config, error: null };
}

/* ------------------------------------------------------------------------- *
 * Star distribution derivation (deterministic — no RNG)
 *
 * NOTE: app/routes/app.qa-generator.tsx contains a client-side MIRROR of this
 * function for the live "Distribution preview". Keep both in sync.
 * ------------------------------------------------------------------------- */

/** Shape anchors: [actual mean of the row, % per star 1→5]. */
const DISTRIBUTION_ANCHORS: ReadonlyArray<readonly [number, readonly number[]]> = [
  [1.19, [88, 8, 2, 1, 1]],
  [1.66, [62, 22, 8, 4, 4]],
  [2.19, [38, 30, 15, 9, 8]],
  [3.02, [14, 18, 34, 20, 14]],
  [3.6, [8, 10, 22, 34, 26]],
  [4.14, [5, 5, 12, 27, 51]],
  [4.52, [3, 2, 7, 16, 72]],
  [4.74, [2, 1, 3, 9, 85]],
  [4.98, [0, 0, 0, 2, 98]],
];

/**
 * Derives a realistic integer star distribution (counts for 1★..5★) whose
 * mean matches the target average within ±0.05 whenever that is numerically
 * possible for `count` integer ratings (for very small counts the nearest
 * achievable mean is used). Skews high — mostly 5s/4s with a few low
 * outliers — when the target is ≥ 4, per SPEC-1.4 §C.
 */
export function deriveStarDistribution(count: number, targetAverage: number): number[] {
  const n = Math.max(1, Math.min(MAX_SYNTHETIC_REVIEWS, Math.round(count)));
  const avg = Math.min(5, Math.max(1, targetAverage));

  // 1. Interpolate a shape (percentages) between the neighboring anchors.
  let lower = DISTRIBUTION_ANCHORS[0];
  let upper = DISTRIBUTION_ANCHORS[DISTRIBUTION_ANCHORS.length - 1];
  for (let i = 0; i < DISTRIBUTION_ANCHORS.length - 1; i += 1) {
    if (avg >= DISTRIBUTION_ANCHORS[i][0] && avg <= DISTRIBUTION_ANCHORS[i + 1][0]) {
      lower = DISTRIBUTION_ANCHORS[i];
      upper = DISTRIBUTION_ANCHORS[i + 1];
      break;
    }
  }
  if (avg < DISTRIBUTION_ANCHORS[0][0]) upper = lower;
  const spanMean = upper[0] - lower[0];
  const t = spanMean > 0 ? Math.min(1, Math.max(0, (avg - lower[0]) / spanMean)) : 0;
  const shape = lower[1].map((p, i) => p + (upper[1][i] - p) * t);

  // 2. Scale to n reviews via largest remainder.
  const shapeTotal = shape.reduce((a, b) => a + b, 0) || 1;
  const exact = shape.map((p) => (p / shapeTotal) * n);
  const counts = exact.map((x) => Math.floor(x));
  let assigned = counts.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || b.i - a.i);
  for (const { i } of order) {
    if (assigned >= n) break;
    counts[i] += 1;
    assigned += 1;
  }

  // 3. Repair to the exact integer sum for the target mean.
  const targetSum = Math.min(5 * n, Math.max(n, Math.round(avg * n)));
  let sum = counts.reduce((acc, c, i) => acc + c * (i + 1), 0);
  const promoteFrom = [3, 2, 1, 0]; // 4→5 first, keep the low tail
  const demoteFrom = [1, 2, 3, 4]; // 2→1 first, keep the 5-star mass
  let guard = 5 * n + 10;
  while (sum < targetSum && guard > 0) {
    guard -= 1;
    const from = promoteFrom.find((i) => counts[i] > 0);
    if (from === undefined) break;
    counts[from] -= 1;
    counts[from + 1] += 1;
    sum += 1;
  }
  while (sum > targetSum && guard > 0) {
    guard -= 1;
    const from = demoteFrom.find((i) => counts[i] > 0);
    if (from === undefined) break;
    counts[from] -= 1;
    counts[from - 1] += 1;
    sum -= 1;
  }

  // 4. Unit-free assertion (SPEC-1.4 §C): the achieved mean must sit within
  // ±0.05 of the target unless integer granularity makes that impossible
  // (|round(avg·n) − avg·n| / n can exceed 0.05 only when n < 10).
  const achieved = sum / n;
  if (Math.abs(achieved - avg) > 0.05 + 0.5 / n + 1e-9) {
    console.error(
      `[cellexia] synthetic distribution drifted: target ${avg}, achieved ${achieved.toFixed(3)} for n=${n}`,
    );
  }
  return counts;
}

/* ------------------------------------------------------------------------- *
 * Seeded PRNG (plan determinism across chunk requests)
 * ------------------------------------------------------------------------- */

/** FNV-1a 32-bit string hash. */
function hashSeed(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — small deterministic PRNG, plenty for test-data variety. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function weightedPick<T>(items: readonly T[], weights: readonly number[], rng: () => number): T {
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = rng() * (total > 0 ? total : 1);
  for (let i = 0; i < items.length; i += 1) {
    roll -= weights[i] ?? 0;
    if (roll <= 0) return items[i];
  }
  return items[items.length - 1];
}

/**
 * Largest-remainder apportionment of `n` items across non-negative weights
 * (SPEC-1.10 §2/§3). Fully deterministic — no RNG: floors first, then hands
 * the remaining items to the largest fractional parts, ties broken by lowest
 * index. Weights are relative (they need not sum to 100); a non-positive
 * total degrades to an even split so the function can never under-allocate.
 */
function largestRemainderCounts(weights: readonly number[], n: number): number[] {
  const slots = weights.length;
  if (slots === 0) return [];
  const total = weights.reduce((a, b) => a + b, 0);
  const safe = total > 0 ? weights : new Array<number>(slots).fill(1);
  const safeTotal = total > 0 ? total : slots;
  const exact = safe.map((w) => (w / safeTotal) * n);
  const counts = exact.map((x) => Math.floor(x));
  let assigned = counts.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (assigned >= n) break;
    counts[i] += 1;
    assigned += 1;
  }
  // Floating-point paranoia — each slot lost < 1 to the floor, so this loop
  // is unreachable in practice; it guarantees the exact total regardless.
  while (assigned < n) {
    counts[0] += 1;
    assigned += 1;
  }
  return counts;
}

/* ------------------------------------------------------------------------- *
 * Batch plan
 * ------------------------------------------------------------------------- */

/** Fully code-assigned specification for one synthetic review. */
export interface SyntheticReviewSpec {
  index: number;
  rating: number;
  language: ShopLocale;
  /** Backdated review timestamp (ISO). */
  createdAt: string;
  verified: boolean;
  variantTitle: string | null;
  ageRange: string | null;
  skinConcerns: string[];
  timeUsing: string | null;
  resultsSeen: string[];
  helpfulCount: number;
  wantsReply: boolean;
  /** ISO timestamp (review date + 1–5 days, ≤ now) when wantsReply. */
  replyAt: string | null;
  personaKey: string;
  brief: string;
  tone: string;
  length: LengthBand;
  quirks: string | null;
  displayName: string;
  country: string | null;
  /** ≤ 15% of reviews get one small typo / casual punctuation. */
  writing: "clean" | "minor_slips" | "casual_sloppy";
}

/** Plausible reviewer countries per locale (adds realism to the widget). */
const LOCALE_COUNTRIES: Record<string, string[]> = {
  en: ["US", "GB", "CA", "AU"],
  fr: ["FR", "BE", "CH"],
  de: ["DE", "AT", "CH"],
  da: ["DK"],
  sv: ["SE"],
  fi: ["FI"],
  nl: ["NL", "BE"],
  it: ["IT"],
  es: ["ES"],
  ar: ["AE", "SA"],
  pl: ["PL"],
  "pt-PT": ["PT"],
  ja: ["JP"],
  nb: ["NO"],
  ro: ["RO"],
  hu: ["HU"],
  el: ["GR"],
};

const AGE_WEIGHTS = [4, 10, 22, 28, 22, 14]; // anti-aging brand skews 35+
const TIME_WEIGHTS_DEFAULT = [8, 24, 32, 22, 14];
const TIME_WEIGHTS_LOW_RATING = [18, 30, 28, 14, 10]; // disappointed users quit earlier
const POSITIVE_RESULTS = RESULTS_SEEN.filter((k) => k !== "too_early");

/**
 * Builds the complete, deterministic plan for a batch. Pure function of
 * (config, batchId): every chunk request rebuilds the identical plan and
 * slices out its own reviews.
 */
export function buildBatchPlan(config: SyntheticConfig, batchId: string): SyntheticReviewSpec[] {
  const n = config.count;
  const rng = mulberry32(hashSeed(`${batchId}|${config.productId}|${n}`));

  // 1. Ratings — derived distribution, then shuffled across positions.
  const distribution = deriveStarDistribution(n, config.targetAverage);
  const ratings: number[] = [];
  distribution.forEach((count, i) => {
    for (let k = 0; k < count; k += 1) ratings.push(i + 1);
  });
  while (ratings.length < n) ratings.push(5); // paranoid backstop
  ratings.length = n;
  shuffle(ratings, rng);

  // 2. Languages — SPEC-1.10 §2: explicit shares apportion by deterministic
  // largest remainder (no jitter — the editor's numbers are honored exactly);
  // absent shares keep the pre-1.10 even split + jitter BYTE-IDENTICALLY
  // (same statements, same RNG consumption), so plans for existing configs —
  // including jobs resumed across the upgrade — rebuild unchanged. Both
  // paths shuffle the per-review assignment across specs below.
  const langs = config.languages.length ? config.languages : (["en"] as ShopLocale[]);
  let perLang: number[];
  if (config.languageWeights) {
    const weights = config.languageWeights;
    perLang = largestRemainderCounts(
      langs.map((lang) => weights[lang] ?? 0),
      n,
    );
  } else {
    perLang = new Array<number>(langs.length).fill(Math.floor(n / langs.length));
    let remainder = n - perLang.reduce((a, b) => a + b, 0);
    const remainderOrder = shuffle(
      langs.map((_, i) => i),
      rng,
    );
    for (const i of remainderOrder) {
      if (remainder <= 0) break;
      perLang[i] += 1;
      remainder -= 1;
    }
    if (langs.length > 1) {
      const moves = Math.floor(n * 0.08);
      for (let m = 0; m < moves; m += 1) {
        const a = Math.floor(rng() * langs.length);
        const b = Math.floor(rng() * langs.length);
        if (a !== b && perLang[a] > 1) {
          perLang[a] -= 1;
          perLang[b] += 1;
        }
      }
    }
  }
  const languageByReview: ShopLocale[] = [];
  langs.forEach((lang, i) => {
    for (let k = 0; k < perLang[i]; k += 1) languageByReview.push(lang);
  });
  while (languageByReview.length < n) languageByReview.push(langs[0]);
  languageByReview.length = n;
  shuffle(languageByReview, rng);

  // 3. Dates — uniform in range with a mild recency bias.
  const startMs = new Date(`${config.dateStart}T00:00:00.000Z`).getTime();
  const endMs = new Date(`${config.dateEnd}T23:59:59.000Z`).getTime();
  const span = Math.max(0, endMs - startMs);
  const nowMs = Date.now();
  const createdAtMs: number[] = [];
  const ageFrac: number[] = []; // 1 = oldest in range, 0 = newest
  for (let i = 0; i < n; i += 1) {
    const frac = Math.pow(rng(), 0.75); // biased toward 1 → recent
    const ts = Math.min(nowMs, startMs + Math.round(span * frac));
    createdAtMs.push(ts);
    ageFrac.push(span > 0 ? 1 - (ts - startMs) / span : 0.5);
  }

  // 4. Verified flags — exact-ish proportion over a shuffled index set.
  const verifiedFlags = new Array<boolean>(n).fill(false);
  const verifiedTarget = Math.round((n * config.verifiedPercent) / 100);
  const verifiedOrder = shuffle(
    Array.from({ length: n }, (_, i) => i),
    rng,
  );
  for (let k = 0; k < verifiedTarget && k < n; k += 1) verifiedFlags[verifiedOrder[k]] = true;

  // 5. Reply flags — same technique.
  const replyFlags = new Array<boolean>(n).fill(false);
  const replyTarget = Math.round((n * config.repliesPercent) / 100);
  const replyOrder = shuffle(
    Array.from({ length: n }, (_, i) => i),
    rng,
  );
  for (let k = 0; k < replyTarget && k < n; k += 1) replyFlags[replyOrder[k]] = true;

  // 6. Variants — SPEC-1.10 §3: explicit shares (reserved "__none__" row =
  // no variant) apportion by the same deterministic largest remainder and
  // are then shuffled across specs; absent shares keep the pre-1.10
  // randomized weighting BYTE-IDENTICALLY (the legacy path always consumed
  // one rng() per variant for its weights plus the per-review rolls — that
  // exact consumption is preserved, weights or not being assigned).
  const variantByReview: Array<string | null> = [];
  const useVariantShares =
    config.variantWeights !== undefined &&
    config.assignVariants &&
    config.productVariants.length > 0;
  if (useVariantShares) {
    const shares = config.variantWeights as Record<string, number>;
    const options: Array<string | null> = [null, ...config.productVariants];
    const counts = largestRemainderCounts(
      options.map((option) => shares[option === null ? VARIANT_NONE_KEY : option] ?? 0),
      n,
    );
    options.forEach((option, i) => {
      for (let k = 0; k < counts[i]; k += 1) variantByReview.push(option);
    });
    while (variantByReview.length < n) variantByReview.push(null); // paranoid backstop
    variantByReview.length = n;
    shuffle(variantByReview, rng);
  } else {
    const legacyVariantWeights = config.productVariants.map(() => 1 + rng() * 2);
    for (let i = 0; i < n; i += 1) {
      if (!config.assignVariants || config.productVariants.length === 0 || rng() < 0.22) {
        variantByReview.push(null);
      } else {
        variantByReview.push(weightedPick(config.productVariants, legacyVariantWeights, rng));
      }
    }
  }

  // 7. Structured attributes — rating-coherent combinations.
  const attrs: Array<{
    ageRange: string | null;
    skinConcerns: string[];
    timeUsing: string | null;
    resultsSeen: string[];
  }> = [];
  for (let i = 0; i < n; i += 1) {
    if (!config.structuredAttrs) {
      attrs.push({ ageRange: null, skinConcerns: [], timeUsing: null, resultsSeen: [] });
      continue;
    }
    const rating = ratings[i];
    const ageRange = rng() < 0.75 ? weightedPick(AGE_RANGES, AGE_WEIGHTS, rng) : null;

    const concernRoll = rng();
    const concernCount = concernRoll < 0.12 ? 0 : concernRoll < 0.5 ? 1 : concernRoll < 0.84 ? 2 : 3;
    const skinConcerns = shuffle([...SKIN_CONCERNS], rng).slice(0, concernCount);

    const timeUsing = weightedPick(
      TIME_USING,
      rating <= 2 ? TIME_WEIGHTS_LOW_RATING : TIME_WEIGHTS_DEFAULT,
      rng,
    );
    const timeIndex = (TIME_USING as readonly string[]).indexOf(timeUsing);

    // Low ratings ↔ "too_early" / no results more likely; richness of
    // resultsSeen correlates with how long the product has been used.
    let resultsSeen: string[] = [];
    const roll = rng();
    if (rating <= 2) {
      if (roll < 0.45) resultsSeen = [];
      else if (roll < 0.85) resultsSeen = ["too_early"];
      else resultsSeen = [POSITIVE_RESULTS[Math.floor(rng() * POSITIVE_RESULTS.length)]];
    } else if (rating === 3) {
      if (roll < 0.3) resultsSeen = [];
      else if (roll < 0.6) resultsSeen = ["too_early"];
      else resultsSeen = [POSITIVE_RESULTS[Math.floor(rng() * POSITIVE_RESULTS.length)]];
    } else if (timeIndex <= 0 && roll < 0.55) {
      resultsSeen = ["too_early"];
    } else {
      const richness = 1 + Math.floor(rng() * (1 + Math.min(2, timeIndex)));
      resultsSeen = shuffle([...POSITIVE_RESULTS], rng).slice(0, richness);
    }
    // v1.29: hair products carry NO skin-concern chips and only hair-safe
    // results. Filtered AFTER sampling, never instead of it — the rng draw
    // sequence must be identical with the flag on or off (the batch plan's
    // RNG consumption is resume-stable by contract).
    if (config.hairProduct) {
      attrs.push({
        ageRange,
        skinConcerns: [],
        timeUsing,
        resultsSeen: resultsSeen.filter((k) => HAIR_SAFE_RESULTS.has(k)),
      });
    } else {
      attrs.push({ ageRange, skinConcerns, timeUsing, resultsSeen });
    }
  }

  // 8. Helpful votes — long tail: ≈60% get 0–1, a few approach the max;
  // older and higher-rated reviews skew higher.
  const votes: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const max = config.maxHelpfulVotes;
    const u = rng();
    if (max <= 0 || u < 0.38) {
      votes.push(0);
    } else if (u < 0.62 || max === 1) {
      votes.push(1);
    } else {
      const tail = (u - 0.62) / 0.38;
      const factor = 0.35 + 0.4 * ageFrac[i] + 0.25 * ((ratings[i] - 1) / 4);
      const value = 2 + Math.round(Math.pow(tail, 2.2) * (max - 2) * factor);
      votes.push(Math.min(max, Math.max(0, value)));
    }
  }

  // 9. Reply dates — review date + 1–5 days, never in the future.
  const replyAtMs: Array<number | null> = [];
  for (let i = 0; i < n; i += 1) {
    if (!replyFlags[i]) {
      replyAtMs.push(null);
      continue;
    }
    const days = 1 + Math.floor(rng() * 5);
    replyAtMs.push(Math.min(nowMs, createdAtMs[i] + days * 24 * 60 * 60 * 1000));
  }

  // 10. Personas — rotate through the shuffled bank honoring LENGTH_MIX.
  const bands = Object.keys(LENGTH_MIX) as LengthBand[];
  const quota: Record<LengthBand, number> = {
    one_liner: 0,
    short: 0,
    medium: 0,
    long: 0,
  };
  let quotaAssigned = 0;
  for (const band of bands) {
    quota[band] = Math.round(LENGTH_MIX[band] * n);
    quotaAssigned += quota[band];
  }
  // Fix rounding drift on the largest band.
  quota.short += n - quotaAssigned;
  if (quota.short < 0) {
    quota.medium += quota.short;
    quota.short = 0;
  }
  const personaOrder = shuffle([...PERSONA_BRIEFS], rng);
  const personaByReview: (typeof PERSONA_BRIEFS)[number][] = [];
  let cursor = 0;
  for (let i = 0; i < n; i += 1) {
    let chosen: (typeof PERSONA_BRIEFS)[number] | null = null;
    for (let step = 0; step < personaOrder.length; step += 1) {
      const candidate = personaOrder[(cursor + step) % personaOrder.length];
      if (quota[candidate.length] > 0) {
        chosen = candidate;
        cursor = (cursor + step + 1) % personaOrder.length;
        break;
      }
    }
    if (!chosen) {
      // All quotas exhausted (rounding edge) — rotate freely.
      chosen = personaOrder[cursor % personaOrder.length];
      cursor = (cursor + 1) % personaOrder.length;
    } else {
      quota[chosen.length] -= 1;
    }
    personaByReview.push(chosen);
  }

  // 11. Names — per-locale pools, rotated display formats, batch-unique via
  // suffix cycling as the last resort.
  const usedNames = new Set<string>();
  const displayNames: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const locale = languageByReview[i];
    const pool = poolFor(locale);
    let name: string | null = null;
    for (let attempt = 0; attempt < 10 && !name; attempt += 1) {
      const first = pool.first[Math.floor(rng() * pool.first.length)];
      const last = pool.last[Math.floor(rng() * pool.last.length)];
      const format = DISPLAY_FORMATS[(i + attempt) % DISPLAY_FORMATS.length];
      const candidate = formatDisplayName(locale, first, last, format);
      if (!usedNames.has(candidate)) name = candidate;
    }
    if (!name) {
      const first = pool.first[Math.floor(rng() * pool.first.length)];
      const last = pool.last[Math.floor(rng() * pool.last.length)];
      const base = formatDisplayName(locale, first, last, "full");
      let suffix = 2;
      while (usedNames.has(`${base} ${suffix}`)) suffix += 1;
      name = `${base} ${suffix}`;
    }
    usedNames.add(name);
    displayNames.push(name);
  }

  // 12. Assemble.
  const specs: SyntheticReviewSpec[] = [];
  for (let i = 0; i < n; i += 1) {
    const countries = LOCALE_COUNTRIES[languageByReview[i]] ?? null;
    const country =
      countries && rng() < 0.7 ? countries[Math.floor(rng() * countries.length)] : null;
    // v1.23: graded, and much more human than the old 12% single-typo flag.
    // Real review sections are messy; a batch that is 95% polished reads
    // generated. Roughly half stay clean so the mess never looks systematic.
    const writing = writingStyleFor(rng(), config.humanTouch ?? 50);
    const persona = personaByReview[i];
    specs.push({
      index: i,
      rating: ratings[i],
      language: languageByReview[i],
      createdAt: new Date(createdAtMs[i]).toISOString(),
      verified: verifiedFlags[i],
      variantTitle: variantByReview[i],
      ageRange: attrs[i].ageRange,
      skinConcerns: attrs[i].skinConcerns,
      timeUsing: attrs[i].timeUsing,
      resultsSeen: attrs[i].resultsSeen,
      helpfulCount: votes[i],
      wantsReply: replyFlags[i],
      replyAt: replyAtMs[i] !== null ? new Date(replyAtMs[i] as number).toISOString() : null,
      personaKey: persona.key,
      // v1.29: hair mode swaps in the persona's hair-variant brief; personas
      // without one keep the shared brief (the prompt's reinterpret rule
      // covers those). Deterministic from config — no rng involved.
      brief: config.hairProduct && persona.hairBrief ? persona.hairBrief : persona.brief,
      tone: persona.tone,
      length: persona.length,
      quirks: persona.quirks ?? null,
      displayName: displayNames[i],
      country,
      writing,
    });
  }
  return specs;
}

/* ------------------------------------------------------------------------- *
 * Plan cache (v1.7)
 *
 * generateChunk rebuilds the batch plan on every call so it can stay
 * stateless across requests/restarts. That was fine at 200 reviews; an
 * uncapped 10,000-review job would rebuild a 10,000-spec plan for each of its
 * 1,250 chunks. The plan is a pure function of (config, batchId) and both
 * driving flows (the pre-1.7 sequential-fetch page and the v1.7 job runner)
 * always pass the identical stored config for a given batchId, so a tiny
 * keyed cache is safe. Bounded to a handful of entries — at most 2 jobs run
 * per shop and the app is single-instance.
 * ------------------------------------------------------------------------- */

const PLAN_CACHE_LIMIT = 4;
const planCache = new Map<string, SyntheticReviewSpec[]>();

function planFor(config: SyntheticConfig, batchId: string): SyntheticReviewSpec[] {
  const key = `${batchId}|${config.productId}|${config.count}`;
  const hit = planCache.get(key);
  if (hit) return hit;
  const plan = buildBatchPlan(config, batchId);
  planCache.set(key, plan);
  while (planCache.size > PLAN_CACHE_LIMIT) {
    const oldest = planCache.keys().next().value;
    if (oldest === undefined) break;
    planCache.delete(oldest);
  }
  return plan;
}

/* ------------------------------------------------------------------------- *
 * AI text generation (title / body / reply only)
 * ------------------------------------------------------------------------- */

// Dash-free on purpose (SPEC-1.10 §4): prompt text must not exemplify the
// em/en dashes the model is told never to write.
/**
 * v1.26: the model used to receive the RANGE label ("1 to 3 months") and
 * parroted it into review text ("1 to 3 months in"). It now receives ONE
 * concrete duration inside the stored band, so the text reads like a person
 * ("about two months in") while the stored attribute keeps the band key.
 * Chosen by a hash of the spec's plan index — deterministic and rng-free,
 * because the batch plan's RNG consumption is resume-stable by contract.
 */
const TIME_USING_EXACT: Record<string, readonly string[]> = {
  lt_1w: ["2 days", "3 days", "4 days", "5 days", "about a week"],
  w1_4: ["1 week", "10 days", "2 weeks", "3 weeks", "almost a month"],
  m1_3: ["1 month", "6 weeks", "2 months", "10 weeks", "almost 3 months"],
  m3_6: ["3 months", "4 months", "5 months", "almost 6 months"],
  gt_6m: ["7 months", "8 months", "9 months", "almost a year", "over a year"],
};

export function exactTimeUsing(band: string, planIndex: number): string | null {
  const options = TIME_USING_EXACT[band];
  if (!options) return null;
  // Knuth multiplicative hash — spreads consecutive indices across options.
  const h = (planIndex * 2654435761) >>> 0;
  return options[h % options.length];
}

const RESULTS_PROMPT: Record<string, string> = {
  smoother: "smoother texture",
  fewer_lines: "reduced fine lines",
  firmer: "firmer skin",
  radiance: "more radiance",
  even_tone: "more even tone",
  hydration: "deep hydration",
  calmer: "calmer, less irritated skin",
  too_early: "too early to tell",
};

/**
 * v1.29 (SPEC-1.29): the results_seen keys a HAIR product may carry — the
 * stored keys stay inside RESULTS_SEEN (the widget's fixed filter taxonomy),
 * so only the category-neutral ones qualify; the skin-worded rest
 * (fewer_lines, firmer, calmer, even_tone, radiance) never appear on a hair
 * review. Prompt phrasing comes from RESULTS_PROMPT_HAIR.
 */
const HAIR_SAFE_RESULTS: ReadonlySet<string> = new Set(["smoother", "hydration", "too_early"]);

const RESULTS_PROMPT_HAIR: Record<string, string> = {
  smoother: "smoother, more manageable hair",
  hydration: "better hydrated, less dry hair",
  too_early: "too early to tell",
};

/**
 * The generator's system prompt. Exported (v1.7) so estimate.server.ts can
 * token-count ONE real chunk prompt with the exact builders the generator
 * uses (SPEC-1.7 §4 "counted baseline").
 */
/**
 * v1.25 (SPEC-1.24 addendum): the "Human touch" slider, as a distribution.
 * level 0 → 100% clean; level 100 → 0/60/40 clean/minor/sloppy; linear in
 * between (level 50 ≈ 50/30/20, the v1.23 feel; level 70 ≈ v1.24's 30/42/28).
 * Exactly ONE rng draw per review whatever the level — the batch plan's RNG
 * consumption is resume-stable by contract.
 */
export function writingStyleFor(
  roll: number,
  humanTouch: number,
): "clean" | "minor_slips" | "casual_sloppy" {
  const level = Math.min(100, Math.max(0, humanTouch)) / 100;
  const clean = 1 - level;
  const minor = 0.6 * level;
  if (roll < clean) return "clean";
  if (roll < clean + minor) return "minor_slips";
  return "casual_sloppy";
}

export function buildSystemPrompt(brandDisplayName: string, hairProduct = false): string {
  return `You write realistic customer product reviews used as internal QA/test data for a premium ${hairProduct ? "hair care" : "anti-aging skincare"} storefront. Each request supplies real product context and a list of review specifications. For every spec you write ONLY the free-text parts: a natural title, the review body, and (when reply_needed is true) the merchant's public reply. Every structured fact (rating, language, verified, variant, usage time, results) is already fixed. Your text must agree with it.

Respond with a single JSON array and NOTHING else: no markdown fences, no commentary before or after.
[{ "i": number, "title": string, "body": string, "reply": string | null }]

Hard rules:
- Output exactly one object per spec, with "i" matching the spec's "i".
- Write title, body and reply entirely in the spec's "language" (a locale code). Never mix languages inside one review.
- The star rating always outranks the persona: 1 or 2 stars read as disappointment, 3 as genuinely mixed, 4 or 5 as satisfaction, expressed through the persona's voice.
- Follow the persona brief, tone, quirks and length band: "one_liner" = a fragment or one sentence; "short" = 1 to 3 sentences; "medium" = 4 to 6 sentences; "long" = 7 to 12 sentences (short paragraphs allowed).
- Stay consistent with time_using and results_seen: someone using the product under a week cannot report long-term results; "too early to tell" means no visible results yet.
- "time_using" is the reviewer's actual usage duration. When the review mentions it, phrase it naturally in the review's language ("about two months in", "after three weeks", "j'utilise depuis 2 mois"). NEVER write it as a range like "1 to 3 months" — real shoppers know how long they have used something.
- Ground concrete product details in the provided context only; never invent ingredient percentages or medical claims; never name real competitor brands.
- Titles: natural and specific, at most 80 characters, no surrounding quotes.
- "writing" controls polish, and it applies to the TITLE as much as the body. "clean": normal careful writing. "minor_slips": one or two small human slips, e.g. a typo, a missing apostrophe, a lowercase sentence start, a doubled word; the title may start lowercase or drop its end punctuation. "casual_sloppy": clearly hurried real-shopper writing with several small grammar mistakes and imperfect capitalization (lowercase sentence starts, maybe the product name uncapitalized, perhaps ONE word in caps for emphasis), loose comma use, missing end punctuation, inconsistent spacing, sometimes doubled exclamation marks; the title reads like a dashed-off fragment (that kind of title: two to four plain words, maybe uncapitalized, maybe with doubled punctuation; invent your own in the review's language, never reuse an example verbatim). Always fully readable and native-feeling in that language, never gibberish, and never changing facts or the rating's sentiment.
- When "reply_needed" is true, "reply" is a warm, professional public response of 1 to 3 sentences from the brand "${brandDisplayName}", in the same language, thanking the reviewer and addressing their specific point (apologetic and constructive for low ratings). When false, "reply" must be null.
- These are fictional reviews by fictional customers. Do not mention AI, QA, testing, or that anything is synthetic.
- ${STYLE_RULES}`;
}

/**
 * The generator's per-chunk user message (product context + spec list).
 * Exported (v1.7) for the same token-counting purpose as buildSystemPrompt.
 */
export function buildUserContent(config: SyntheticConfig, specs: SyntheticReviewSpec[]): string {
  const lines: string[] = [];
  lines.push("PRODUCT CONTEXT");
  lines.push(`Title: ${config.productTitle}`);
  if (config.productType) lines.push(`Product type: ${config.productType}`);
  if (config.productTags.length) lines.push(`Tags: ${config.productTags.join(", ")}`);
  if (config.productVariants.length) {
    lines.push(`Variants: ${config.productVariants.join(", ")}`);
  }
  lines.push("Description:");
  lines.push(config.productDescription || "(no description provided)");
  // v1.29: merchant-written context, verbatim. Placed after the description
  // so it reads as part of PRODUCT CONTEXT, and marked authoritative so it
  // wins over a thin or outdated Shopify description.
  if (config.extraProductInfo) {
    lines.push("");
    lines.push(
      "Additional product info from the merchant (authoritative — prefer this over the description when they disagree):",
    );
    lines.push(config.extraProductInfo);
  }
  // v1.29: the category instruction that stops a skincare-trained persona
  // bank from writing about skin for a hair product.
  if (config.hairProduct) {
    lines.push("");
    lines.push(
      "CATEGORY: this is a HAIR product. Every review is about hair and scalp: texture, frizz, shine, softness, breakage, split ends, volume, manageability, scalp comfort. Never describe effects on facial skin, wrinkles, complexion or skincare routines. If a persona brief mentions skin or skincare, reinterpret it for hair care.",
    );
  }
  lines.push("");
  lines.push(
    `REVIEW SPECS: write exactly ${specs.length} review${specs.length === 1 ? "" : "s"}, one JSON object per spec:`,
  );
  specs.forEach((spec, i) => {
    lines.push(
      JSON.stringify({
        i: i + 1,
        language: spec.language,
        rating: spec.rating,
        persona: spec.brief,
        tone: spec.tone,
        length: spec.length,
        ...(spec.quirks ? { quirks: spec.quirks } : {}),
        verified_purchase: spec.verified,
        ...(spec.variantTitle ? { variant: spec.variantTitle } : {}),
        ...(spec.timeUsing
          ? { time_using: exactTimeUsing(spec.timeUsing, spec.index) ?? spec.timeUsing }
          : {}),
        ...(spec.resultsSeen.length
          ? {
              results_seen: spec.resultsSeen
                .map((k) => (config.hairProduct ? RESULTS_PROMPT_HAIR[k] : RESULTS_PROMPT[k]) ?? k)
                .join("; "),
            }
          : {}),
        reply_needed: spec.wantsReply,
        writing: spec.writing,
      }),
    );
  });
  return lines.join("\n");
}

/**
 * Robustly extracts a JSON array from model output: fenced blocks first, then
 * the widest `[...]` span, then a `{ "reviews": [...] }` wrapper. Returns null
 * when nothing parses (refusal prose, truncation, etc.).
 */
export function extractJsonArray(text: string): unknown[] | null {
  const candidates: string[] = [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) candidates.push(fence[1]);
  candidates.push(text);
  for (const candidate of candidates) {
    const start = candidate.indexOf("[");
    const end = candidate.lastIndexOf("]");
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(candidate.slice(start, end + 1));
        if (Array.isArray(parsed)) return parsed;
      } catch {
        // fall through
      }
    }
    const objStart = candidate.indexOf("{");
    const objEnd = candidate.lastIndexOf("}");
    if (objStart >= 0 && objEnd > objStart) {
      try {
        const parsed = JSON.parse(candidate.slice(objStart, objEnd + 1)) as {
          reviews?: unknown;
        };
        if (parsed && Array.isArray(parsed.reviews)) return parsed.reviews;
      } catch {
        // fall through
      }
    }
  }
  return null;
}

interface GeneratedText {
  title: string | null;
  body: string;
  reply: string | null;
}

/* ------------------------------------------------------------------------- *
 * Low-level Claude call WITH usage capture (v1.7)
 * ------------------------------------------------------------------------- */

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/** Outcome of one usage-aware Claude Messages call. */
interface ClaudeUsageOutcome {
  /** Concatenated text blocks; null on any failure or refusal. */
  text: string | null;
  /** Anthropic-reported usage summed over every billed HTTP attempt. */
  inputTokens: number;
  outputTokens: number;
  /** True when the API rejected the key itself (401/403) — fatal for a job. */
  authFailed: boolean;
}

/**
 * Mirror of ai.server.ts `callClaude` (same URL, headers, one retry on
 * 429/5xx/network, refusal → null) that ADDITIONALLY captures the `usage`
 * block of the response and flags key-rejection (401/403).
 *
 * WHY A LOCAL MIRROR INSTEAD OF THE SHARED HELPER: SPEC-1.7 §1 requires
 * GenerationJob.inputTokens / outputTokens (and the ModelThroughput
 * calibration of §4) to hold ACTUAL token usage, but `callClaude` returns
 * only the text and discards `usage`. ai.server.ts is owned by the estimates
 * workstream in this release (it gains `countTokens` there), so the raw-fetch
 * client is mirrored here rather than edited concurrently. Keep the request /
 * retry semantics of the two functions in sync.
 */
async function callClaudeWithUsage(
  apiKey: string,
  model: string,
  system: string,
  userContent: string,
  maxTokens = 6000,
): Promise<ClaudeUsageOutcome> {
  // Same rule as ai.server's clients: on default-thinking models the model
  // must answer directly, or generation chunks can think their max_tokens
  // away and truncate mid-JSON.
  const thinking = thinkingParamFor(model);
  const body = JSON.stringify({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: userContent }],
    ...(thinking ? { thinking } : {}),
  });
  const outcome: ClaudeUsageOutcome = {
    text: null,
    inputTokens: 0,
    outputTokens: 0,
    authFailed: false,
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(ANTHROPIC_MESSAGES_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body,
      });

      if (response.status === 429 || response.status >= 500) {
        // Transient — back off briefly and retry once.
        if (attempt === 0) {
          await sleepMs(1500);
          continue;
        }
        console.error(`[cellexia] Claude API transient error ${response.status}`);
        return outcome;
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        console.error(
          `[cellexia] Claude API error ${response.status}: ${detail.slice(0, 300)}`,
        );
        outcome.authFailed = response.status === 401 || response.status === 403;
        return outcome;
      }

      const data = (await response.json()) as {
        content?: Array<{ type?: string; text?: string }>;
        stop_reason?: string;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      // A 200 was billed — count its usage whatever happens next.
      outcome.inputTokens += toTokenCount(data.usage?.input_tokens);
      outcome.outputTokens += toTokenCount(data.usage?.output_tokens);
      if (data.stop_reason === "refusal") return outcome;
      const text = Array.isArray(data.content)
        ? data.content
            .filter((block) => block && block.type === "text" && typeof block.text === "string")
            .map((block) => block.text as string)
            // Fragments of one answer — a joined-in newline could land inside
            // a JSON token.
            .join("")
        : "";
      outcome.text = text.length > 0 ? text : null;
      return outcome;
    } catch (error) {
      if (attempt === 0) {
        await sleepMs(1000);
        continue;
      }
      console.error("[cellexia] Claude API request failed", error);
      return outcome;
    }
  }
  return outcome;
}

function toTokenCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Texts + usage produced for one chunk (usage covers ALL attempts made). */
interface ChunkTextsOutcome {
  /** Per-spec texts keyed by position in `specs`; null when every attempt failed. */
  texts: Map<number, GeneratedText> | null;
  inputTokens: number;
  outputTokens: number;
  authFailed: boolean;
}

/**
 * One Messages API call for ≤ 8 review specs (retried once on any failure —
 * network, refusal, unparseable output). Token usage is accumulated across
 * every billed attempt — a chunk whose first response could not be parsed
 * still cost real money and must show up in the job's actuals.
 */
async function generateChunkTexts(
  apiKey: string,
  model: string,
  brandDisplayName: string,
  config: SyntheticConfig,
  specs: SyntheticReviewSpec[],
): Promise<ChunkTextsOutcome> {
  const system = buildSystemPrompt(brandDisplayName, config.hairProduct);
  const userContent = buildUserContent(config, specs);
  let inputTokens = 0;
  let outputTokens = 0;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const call = await callClaudeWithUsage(apiKey, model, system, userContent, 6000);
    inputTokens += call.inputTokens;
    outputTokens += call.outputTokens;
    if (call.authFailed) {
      // Retrying a rejected key is pointless — bail out immediately.
      return { texts: null, inputTokens, outputTokens, authFailed: true };
    }
    const raw = call.text;
    if (!raw) continue; // network error / refusal / empty — retry once

    const items = extractJsonArray(raw);
    if (!items) {
      console.error(`[cellexia] synthetic: unparseable AI output (attempt ${attempt + 1})`);
      continue;
    }

    const byIndex = new Map<number, GeneratedText>();
    items.forEach((item, position) => {
      if (typeof item !== "object" || item === null) return;
      const record = item as Record<string, unknown>;
      const iRaw = Number(record.i);
      const index =
        Number.isInteger(iRaw) && iRaw >= 1 && iRaw <= specs.length ? iRaw - 1 : position;
      if (index < 0 || index >= specs.length || byIndex.has(index)) return;
      // scrubDashes (SPEC-1.10 §4): even a disobedient model output ships
      // without em/en dashes. Scrub BEFORE the length slice (the ", "
      // replacement can lengthen the text), and re-check emptiness after (a
      // dash-only string scrubs down to nothing). The spec's language picks
      // the locale-appropriate pause mark (、 for ja, ، for ar).
      const lang = specs[index].language;
      // v1.23: emoji scrub rides with the dash scrub — order does not matter
      // between them, both are idempotent and character-local.
      const body =
        typeof record.body === "string"
          ? scrubEmojis(scrubDashes(record.body.trim(), lang)).slice(0, 5000)
          : "";
      if (!body) return;
      const titleClean =
        typeof record.title === "string"
          ? scrubEmojis(scrubDashes(record.title.trim(), lang)).slice(0, 150)
          : "";
      const title = titleClean || null;
      const replyClean =
        specs[index].wantsReply && typeof record.reply === "string"
          ? scrubEmojis(scrubDashes(record.reply.trim(), lang)).slice(0, 5000)
          : "";
      const reply = replyClean || null;
      // v1.23: an absence-of-scent claim is a factual statement the merchant
      // never made. It cannot be text-edited out safely, so the review is
      // DROPPED (the batch runs a review short rather than shipping the
      // claim; the admin totals always reflect what was actually stored).
      if (hasFragranceFreeClaim(`${title ?? ""} ${body} ${reply ?? ""}`)) {
        console.error(`[cellexia] synthetic: dropped a review claiming fragrance-free (${lang})`);
        return;
      }
      byIndex.set(index, { title, body, reply });
    });

    if (byIndex.size > 0) return { texts: byIndex, inputTokens, outputTokens, authFailed: false };
    console.error("[cellexia] synthetic: AI output contained no usable reviews");
  }
  return { texts: null, inputTokens, outputTokens, authFailed: false };
}

/* ------------------------------------------------------------------------- *
 * Chunk + batch generation
 * ------------------------------------------------------------------------- */

export interface SyntheticChunkResult {
  batchId: string;
  /** 0-based index of the first review in this chunk. */
  start: number;
  /** Number of specs attempted in this chunk. */
  processed: number;
  created: number;
  failed: number;
  errors: string[];
  /** True when this chunk completed the batch. */
  done: boolean;
  total: number;
  /** Machine-readable fail-fast marker (missing AI key / provider off). */
  code?: "no_ai_key";
}

function pushError(errors: string[], message: string): void {
  if (errors.length < MAX_ERRORS) errors.push(message);
}

/** Accepts crypto.randomUUID output (and nothing wilder) as a batch id. */
export function isValidBatchId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/.test(value)
  );
}

/**
 * `SyntheticChunkResult` extended with what the v1.7 background job runner
 * needs for cost actuals, calibration and fatal-error detection (SPEC-1.7
 * §1/§3/§4).
 */
export interface GenerateChunkResult extends SyntheticChunkResult {
  /** ACTUAL Anthropic-reported token usage for this chunk (all attempts). */
  inputTokens: number;
  outputTokens: number;
  /** Wall-clock seconds spent on this chunk (AI calls + row persistence). */
  seconds: number;
  /** Settings.aiModel that served the chunk; null when settings failed. */
  model: string | null;
  /** True when the API rejected the key (401/403) — fatal for a job. */
  authFailed: boolean;
}

/**
 * The per-chunk unit of work (SPEC-1.7 §3) — extracted from the SPEC-1.4
 * chunk logic so the background job runner can drive it directly. Generates
 * one chunk of ≤ SYNTHETIC_CHUNK_SIZE reviews from the deterministic batch
 * plan and persists them immediately (rows are never accumulated in memory —
 * SPEC-1.7 §2). The first call may pass `batchId: null` (a fresh UUID is
 * minted); subsequent calls pass the returned batchId so the identical plan
 * is rebuilt and the next slice processed. All AI failure modes downgrade to
 * `failed` counts + `errors` entries — this function does not throw for them.
 *
 * `indices` (optional, v1.7.x): an explicit list of plan indices (≤ chunk
 * size) to process instead of the contiguous `[start, start+8)` slice. The
 * job runner uses it to resume by exclusion — regenerating exactly the specs
 * whose rows are missing after an out-of-order crash/cancel, which a
 * contiguous slice cannot express. Omitted by all pre-1.7 callers, whose
 * behavior is unchanged.
 */
export async function generateChunk(
  shop: string,
  config: SyntheticConfig,
  batchId: string | null,
  start: number,
  indices?: readonly number[],
): Promise<GenerateChunkResult> {
  const startedAtMs = Date.now();
  const result = await generateChunkInner(shop, config, batchId, start, indices);
  return { ...result, seconds: (Date.now() - startedAtMs) / 1000 };
}

/**
 * Pre-1.7 signature kept byte-compatible for existing callers (the
 * qa-generator route's sequential-fetch flow and generateSyntheticBatch):
 * same inputs, same result shape, same behavior — v1.7's extra usage/timing
 * fields are simply not exposed here.
 */
export async function generateSyntheticChunk(
  shop: string,
  config: SyntheticConfig,
  batchId: string | null,
  start: number,
): Promise<SyntheticChunkResult> {
  const result = await generateChunk(shop, config, batchId, start);
  return {
    batchId: result.batchId,
    start: result.start,
    processed: result.processed,
    created: result.created,
    failed: result.failed,
    errors: result.errors,
    done: result.done,
    total: result.total,
    ...(result.code ? { code: result.code } : {}),
  };
}

async function generateChunkInner(
  shop: string,
  config: SyntheticConfig,
  batchId: string | null,
  start: number,
  indices?: readonly number[],
): Promise<Omit<GenerateChunkResult, "seconds">> {
  const total = config.count;
  const id = batchId && isValidBatchId(batchId) ? batchId : crypto.randomUUID();
  const from = Math.min(Math.max(0, Math.floor(start)), Math.max(0, total - 1));
  const errors: string[] = [];
  // Specs this chunk is expected to process — used by the failure paths that
  // run before (or instead of) the plan slice being available.
  const expected = indices
    ? Math.min(indices.length, SYNTHETIC_CHUNK_SIZE)
    : Math.min(SYNTHETIC_CHUNK_SIZE, total - from);

  const base: Omit<GenerateChunkResult, "seconds"> = {
    batchId: id,
    start: from,
    processed: 0,
    created: 0,
    failed: 0,
    errors,
    done: false,
    total,
    inputTokens: 0,
    outputTokens: 0,
    model: null,
    authFailed: false,
  };

  let settings: Setting;
  try {
    settings = await getSettings(shop);
  } catch (error) {
    console.error("[cellexia] synthetic: settings lookup failed", error);
    pushError(errors, "Settings could not be loaded — please try again.");
    return { ...base, failed: expected, errors };
  }
  const model = settings.aiModel;
  const apiKey = settings.aiProvider === "anthropic" ? settings.anthropicApiKey : null;
  if (!apiKey) {
    pushError(errors, NO_AI_KEY_MESSAGE);
    return {
      ...base,
      model,
      failed: expected,
      errors,
      code: "no_ai_key",
    };
  }

  let specs: SyntheticReviewSpec[];
  try {
    const plan = planFor(config, id);
    // v1.7.x: an explicit index list resumes by exclusion (only the specs
    // whose rows are missing); otherwise the classic contiguous slice at
    // `start` is processed — byte-identical to pre-1.7 behavior.
    specs = indices
      ? indices
          .filter((i) => Number.isInteger(i) && i >= 0 && i < plan.length)
          .slice(0, SYNTHETIC_CHUNK_SIZE)
          .map((i) => plan[i])
      : plan.slice(from, from + SYNTHETIC_CHUNK_SIZE);
  } catch (error) {
    console.error("[cellexia] synthetic: batch plan failed", error);
    pushError(errors, "The batch plan could not be built — please try again.");
    return { ...base, model, failed: expected, errors };
  }
  if (specs.length === 0) {
    return { ...base, model, done: indices ? true : from + SYNTHETIC_CHUNK_SIZE >= total };
  }
  // Whether this chunk reaches the end of the plan. For a contiguous slice
  // this equals the old `from + specs.length >= total`; for an index list it
  // keys off the highest plan index processed (the runner ignores `done`).
  const chunkDone = specs[specs.length - 1].index + 1 >= total;

  const generatedAt = new Date();
  let outcome: ChunkTextsOutcome;
  try {
    outcome = await generateChunkTexts(
      apiKey,
      settings.aiModel,
      settings.brandDisplayName,
      config,
      specs,
    );
  } catch (error) {
    // The AI path never throws by design, but stay defensive around it.
    console.error("[cellexia] synthetic: text generation crashed", error);
    outcome = { texts: null, inputTokens: 0, outputTokens: 0, authFailed: false };
  }
  const usage = { inputTokens: outcome.inputTokens, outputTokens: outcome.outputTokens };

  if (outcome.authFailed) {
    pushError(
      errors,
      "The Anthropic API rejected the configured key — update it under Settings → AI Summary.",
    );
    return {
      ...base,
      ...usage,
      model,
      authFailed: true,
      processed: specs.length,
      failed: specs.length,
      errors,
      done: chunkDone,
    };
  }

  const texts = outcome.texts;
  if (!texts) {
    pushError(
      errors,
      `Reviews ${specs[0].index + 1}–${specs[specs.length - 1].index + 1}: the AI did not return usable review text (after one retry).`,
    );
    return {
      ...base,
      ...usage,
      model,
      processed: specs.length,
      failed: specs.length,
      errors,
      done: chunkDone,
    };
  }

  let created = 0;
  let failed = 0;
  for (let i = 0; i < specs.length; i += 1) {
    const spec = specs[i];
    const text = texts.get(i);
    if (!text) {
      failed += 1;
      // spec.index is the plan index — identical to `from + i` for the
      // contiguous slice, and the honest position for an index list.
      pushError(errors, `Review ${spec.index + 1}: missing from the AI response.`);
      continue;
    }
    try {
      await createReview(shop, {
        productId: config.productId,
        productTitle: config.productTitle,
        productHandle: config.productHandle,
        rating: spec.rating,
        title: text.title,
        body: text.body,
        language: spec.language,
        authorName: spec.displayName,
        authorEmail: null,
        country: spec.country,
        variantTitle: spec.variantTitle,
        verified: spec.verified,
        status: config.status,
        ageRange: spec.ageRange,
        skinConcerns: spec.skinConcerns,
        timeUsing: spec.timeUsing,
        resultsSeen: spec.resultsSeen,
        helpfulCount: spec.helpfulCount,
        reply: text.reply,
        replyAt: text.reply ? spec.replyAt : null,
        createdAt: spec.createdAt,
        ipHash: null,
        source: "synthetic",
        isSynthetic: true,
        syntheticBatchId: id,
        syntheticGeneratedAt: generatedAt,
      });
      created += 1;
    } catch (error) {
      failed += 1;
      console.error(`[cellexia] synthetic: review ${spec.index + 1} could not be saved`, error);
      pushError(errors, `Review ${spec.index + 1}: could not be saved to the database.`);
    }
  }

  return {
    ...base,
    ...usage,
    model,
    processed: specs.length,
    created,
    failed,
    errors,
    done: chunkDone,
  };
}

/**
 * Full-batch generation (SPEC-1.4 §C signature): derives the plan, runs the
 * 8-review AI chunks with parallelism 2, creates the rows, then re-syncs the
 * product's aggregates + metafields once. Partial failures are reported
 * honestly; the batch is never aborted by an AI failure.
 *
 * (The QA page drives the same chunks sequentially from the client for the
 * progress readout — this function is the one-call equivalent.)
 */
export async function generateSyntheticBatch(
  shop: string,
  admin: AdminClient,
  config: SyntheticConfig,
): Promise<{ batchId: string; created: number; failed: number; errors: string[] }> {
  const batchId = crypto.randomUUID();
  const errors: string[] = [];

  let settings: Setting;
  try {
    settings = await getSettings(shop);
  } catch (error) {
    console.error("[cellexia] synthetic: settings lookup failed", error);
    return {
      batchId,
      created: 0,
      failed: config.count,
      errors: ["Settings could not be loaded — please try again."],
    };
  }
  if (settings.aiProvider !== "anthropic" || !settings.anthropicApiKey) {
    // Fail fast — no template fallback (SPEC-1.4 §C).
    return { batchId, created: 0, failed: config.count, errors: [NO_AI_KEY_MESSAGE] };
  }

  const starts: number[] = [];
  for (let start = 0; start < config.count; start += SYNTHETIC_CHUNK_SIZE) starts.push(start);

  let created = 0;
  let failed = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      if (index >= starts.length) return;
      next += 1; // single-threaded event loop — no race between read and bump
      const result = await generateSyntheticChunk(shop, config, batchId, starts[index]);
      created += result.created;
      failed += result.failed;
      for (const message of result.errors) pushError(errors, message);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(AI_PARALLELISM, starts.length) }, () => worker()),
  );

  try {
    await recomputeProduct(shop, config.productId, admin);
  } catch (error) {
    console.error("[cellexia] synthetic: aggregate sync failed", error);
    pushError(
      errors,
      "Reviews were created, but the product rating sync failed — it will refresh on the next moderation action.",
    );
  }

  return { batchId, created, failed, errors };
}

/* ------------------------------------------------------------------------- *
 * Batch management
 * ------------------------------------------------------------------------- */

/** Delete chunk size — stays far below SQLite's bound-parameter limit. */
const DELETE_CHUNK = 200;

async function deleteReviewRows(shop: string, ids: string[]): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
    const chunk = ids.slice(i, i + DELETE_CHUNK);
    // TranslationCache has no relation to Review, so no cascade — clear it
    // explicitly (media + votes cascade via the schema).
    await prisma.translationCache.deleteMany({ where: { reviewId: { in: chunk } } });
    const result = await prisma.review.deleteMany({ where: { shop, id: { in: chunk } } });
    deleted += result.count;
  }
  if (deleted > 0) {
    // Cached Q&A answers (product + brand-page sentinels) can quote reviews
    // that no longer exist — same rule as every other deletion path.
    try {
      const { invalidateAskAnswers } = await import("./qna.server");
      await invalidateAskAnswers(shop);
    } catch (error) {
      console.error("[cellexia] ask-cache invalidation after batch delete failed", error);
    }
  }
  return deleted;
}

/**
 * v1.7 (SPEC-1.7 §7): deleting a batch must also delete/cancel its
 * GenerationJob rows. QUEUED jobs are cancelled outright, RUNNING jobs get a
 * cooperative cancel request (the runner stops after the in-flight chunk —
 * if that chunk lands a handful of rows after the deletion, they show up as
 * a small remnant batch the merchant can delete again), and terminal rows
 * (including the just-cancelled QUEUED ones) are removed so the jobs table
 * never points at a batch that no longer exists. Best-effort by design — a
 * job-table hiccup must never block the review deletion itself.
 */
async function cancelAndDeleteJobs(shop: string, batchId?: string): Promise<void> {
  const scope = batchId ? { shop, batchId } : { shop };
  try {
    await prisma.generationJob.updateMany({
      where: { ...scope, status: "QUEUED" },
      data: { status: "CANCELLED", cancelRequested: true, finishedAt: new Date() },
    });
    await prisma.generationJob.updateMany({
      where: { ...scope, status: "RUNNING" },
      data: { cancelRequested: true },
    });
    await prisma.generationJob.deleteMany({
      where: { ...scope, status: { in: ["COMPLETED", "FAILED", "CANCELLED"] } },
    });
  } catch (error) {
    console.error("[cellexia] synthetic: job cleanup for batch deletion failed", error);
  }
}

/**
 * Deletes every review of one synthetic batch (translations included; media
 * and votes cascade), and cancels/deletes the batch's GenerationJob rows
 * (SPEC-1.7 §7). Returns the number of deleted reviews. Aggregate re-sync is
 * the caller's job (the route holds the admin client) — use
 * `syntheticProductIds` BEFORE deleting to know which products to re-sync.
 */
/* ------------------------------------------------------------------------- *
 * Multi-product launch (SPEC-1.26)
 * ------------------------------------------------------------------------- */

export const MAX_MULTI_PRODUCTS = 20;

/**
 * The fields a launch may vary per product; everything else is shared.
 * v1.30: `publishAt` is deliberately NOT here — one publish time applies to
 * the whole launch (it rides in `shared` untouched), and rows cannot smuggle
 * their own (overrides copy only these keys).
 */
const PER_PRODUCT_KEYS = [
  "count",
  "targetAverage",
  "verifiedPercent",
  "repliesPercent",
  "assignVariants",
  "variantWeights",
  "dateStart",
  "dateEnd",
  // v1.29: category and merchant context are per-product by nature — a
  // launch mixing a hair serum with face creams needs them on the rows.
  "hairProduct",
  "extraProductInfo",
] as const;

export interface MultiProductRow {
  productId: string;
  overrides: Record<string, unknown>;
}

export interface MultiLaunchInput {
  shared: Record<string, unknown>;
  rows: MultiProductRow[];
}

/**
 * Validates and normalizes a multi-launch payload's SHAPE (SPEC-1.26 §1) —
 * before any Shopify fetch. Per-product configs are assembled later, with
 * each product's fetched context, through the EXISTING parseSyntheticConfig,
 * so multi introduces no second validation dialect.
 */
export function parseMultiLaunch(
  raw: unknown,
): { input: MultiLaunchInput; error: null } | { input: null; error: string } {
  if (typeof raw !== "object" || raw === null) {
    return { input: null, error: "The launch configuration is malformed" };
  }
  const v = raw as Record<string, unknown>;
  if (typeof v.shared !== "object" || v.shared === null) {
    return { input: null, error: "The launch configuration is missing its shared settings" };
  }
  if (!Array.isArray(v.products) || v.products.length === 0) {
    return { input: null, error: "Add at least one product to the launch" };
  }
  if (v.products.length > MAX_MULTI_PRODUCTS) {
    return { input: null, error: `A launch supports up to ${MAX_MULTI_PRODUCTS} products` };
  }
  const rows: MultiProductRow[] = [];
  const seen = new Set<string>();
  for (const [i, item] of v.products.entries()) {
    if (typeof item !== "object" || item === null) {
      return { input: null, error: `Product ${i + 1} is malformed` };
    }
    const row = item as Record<string, unknown>;
    const idSource = cleanString(row.productId, 128);
    const idMatch = idSource.match(/\d+/g);
    const productId = /^\d+$/.test(idSource)
      ? idSource
      : idMatch
        ? idMatch.reduce((a, b) => (b.length > a.length ? b : a), "")
        : "";
    if (!productId) {
      return { input: null, error: `Product ${i + 1} has no product selected` };
    }
    if (seen.has(productId)) {
      return { input: null, error: `The same product appears twice (row ${i + 1}) — merge the rows` };
    }
    seen.add(productId);
    // Server-side backstop mirroring the single path: a count above the hard
    // limit must be rejected, never silently clamped after approval.
    const count = Number(row.count);
    if (Number.isFinite(count) && count > MAX_SYNTHETIC_REVIEWS) {
      return {
        input: null,
        error: `Product ${i + 1}: the generator supports up to ${MAX_SYNTHETIC_REVIEWS} reviews per product`,
      };
    }
    const overrides: Record<string, unknown> = {};
    for (const key of PER_PRODUCT_KEYS) {
      if (key in row) overrides[key] = row[key];
    }
    rows.push({ productId, overrides });
  }
  // Shared settings must not smuggle per-product fields or a product context.
  const shared: Record<string, unknown> = { ...(v.shared as Record<string, unknown>) };
  for (const key of [...PER_PRODUCT_KEYS, "productId", "productTitle", "productHandle", "productDescription", "productType", "productTags", "productVariants"]) {
    delete shared[key];
  }
  return { input: { shared, rows }, error: null };
}

/**
 * Assembles one product's full SyntheticConfig from the launch's shared
 * settings, the row's overrides and the product's fetched context, through
 * parseSyntheticConfig. Returns the same shape parseSyntheticConfig does.
 */
export function assembleLaunchConfig(
  input: MultiLaunchInput,
  row: MultiProductRow,
  context: {
    id: string;
    title: string;
    handle: string | null;
    description: string;
    productType: string | null;
    tags: string[];
    variants: string[];
  },
): ReturnType<typeof parseSyntheticConfig> {
  // A row that could not learn its product's variants in the UI omits
  // assignVariants; the default is derived HERE from the freshly fetched
  // context, the same "on when the product has variants" the main form uses —
  // a hard client false for a multi-variant product would otherwise win.
  const overrides = { ...row.overrides };
  if (!("assignVariants" in overrides)) {
    overrides.assignVariants = context.variants.length > 1;
  }
  return parseSyntheticConfig({
    ...input.shared,
    ...overrides,
    productId: context.id,
    productTitle: context.title,
    productHandle: context.handle,
    productDescription: context.description,
    productType: context.productType,
    productTags: context.tags,
    productVariants: context.variants,
  });
}

/* ------------------------------------------------------------------------- *
 * Skeptical double-check (SPEC-1.24)
 * ------------------------------------------------------------------------- */

/** Server-side ceiling on how much of one group a paranoid answer may cut. */
const SKEPTIC_MAX_REMOVAL_SHARE = 0.4;

export function buildSkepticSystemPrompt(): string {
  return `You are a skeptical review auditor for an online store. You receive a numbered batch of product reviews and must identify the ones that READ machine-written, so they can be removed.

Signs to hunt: uniform sentence rhythm across different reviews; over-balanced pros-and-cons arcs; assistant vocabulary ("overall", "that said", "I appreciate"); suspicious polish in every single review; the same phrase, structure or arc repeating across the batch; generic praise with no lived detail; translated-sounding phrasing that no native shopper would type.

Genuinely human-looking texts stay, including messy ones: typos, lowercase starts, fragments, doubled words, sloppy punctuation are signs of a REAL shopper, never grounds for removal. Surface slips are NEVER a tell; convict on structure and substance (rhythm, arc, vocabulary, emptiness), not on spelling. Judge each review in its own language.

A typical healthy batch loses between none and roughly a third. Convict only what you would genuinely flag, worst first.

Respond with a single JSON object and NOTHING else:
{ "remove": [review numbers, worst first], "reason": "one short sentence naming the strongest overall tell" }
An empty "remove" array is a perfectly good answer.`;
}

export interface SkepticPassResult {
  checked: number;
  removed: number;
  /** Rows that passed through unjudged because a skeptic call failed. */
  unchecked: number;
  inputTokens: number;
  outputTokens: number;
  authFailed: boolean;
}

/**
 * Runs the skeptic over every not-yet-checked stored row of the batch, in
 * groups of `batchSize`. Convicted rows are DELETED (triple-guarded to this
 * shop's synthetic rows of this batch); survivors are marked qaChecked so a
 * resumed job never re-judges them. A failed or unparseable skeptic call
 * keeps the whole group (marked checked, counted as unchecked) — the checker
 * is a filter, never a gate. Caller recomputes aggregates when removed > 0.
 */
export async function runSkepticPass(
  shop: string,
  apiKey: string,
  model: string,
  batchId: string,
  batchSize: number,
  shouldStop?: () => Promise<boolean> | boolean,
  /** Fires after every group so the job can persist counters + heartbeat. */
  onGroup?: (delta: { checked: number; removed: number; unchecked: number }) => Promise<void>,
): Promise<SkepticPassResult> {
  const size = Math.min(60, Math.max(5, Math.floor(batchSize) || 20));
  const result: SkepticPassResult = {
    checked: 0, removed: 0, unchecked: 0, inputTokens: 0, outputTokens: 0, authFailed: false,
  };
  const system = buildSkepticSystemPrompt();

  for (;;) {
    if (shouldStop && (await shouldStop())) return result;
    const rows = await prisma.review.findMany({
      where: { shop, isSynthetic: true, syntheticBatchId: batchId, qaChecked: false },
      // Language first: cross-review tells (same arc, same phrase) only read
      // within a language, so groups should be as monolingual as possible.
      orderBy: [{ language: "asc" }, { createdAt: "asc" }],
      take: size,
      select: { id: true, language: true, rating: true, title: true, body: true },
    });
    if (rows.length === 0) return result;

    const numbered = rows.map((r, i) =>
      JSON.stringify({
        n: i + 1,
        language: r.language,
        rating: r.rating,
        title: r.title ?? "",
        body: r.body.slice(0, 1200),
      }),
    );
    const userContent = `REVIEWS (${rows.length}, one JSON object per line):\n${numbered.join("\n")}`;

    const call = await callClaudeWithUsage(apiKey, model, system, userContent, 1500);
    result.inputTokens += call.inputTokens;
    result.outputTokens += call.outputTokens;
    if (call.authFailed) {
      result.authFailed = true;
      result.unchecked += rows.length;
      await markChecked(shop, rows.map((r) => r.id));
      if (onGroup) await onGroup({ checked: 0, removed: 0, unchecked: rows.length });
      return result;
    }

    let removeIdx: number[] = [];
    let parsedOk = false;
    if (call.text) {
      const parsed = extractJson(call.text) as { remove?: unknown } | null;
      if (parsed && Array.isArray(parsed.remove)) {
        parsedOk = true;
        removeIdx = parsed.remove
          .map((n) => Number(n))
          .filter((n) => Number.isInteger(n) && n >= 1 && n <= rows.length);
      }
    }
    if (!parsedOk) {
      console.error("[cellexia] skeptic pass: unusable answer, group kept unchecked");
      result.unchecked += rows.length;
      await markChecked(shop, rows.map((r) => r.id));
      if (onGroup) await onGroup({ checked: 0, removed: 0, unchecked: rows.length });
      continue;
    }

    // Worst-first ordering is the model's contract; the cap keeps a paranoid
    // answer from gutting the batch. Never below 1 — a trailing group of two
    // must not make its reviews immune to an honest conviction.
    const cap = Math.max(1, Math.floor(rows.length * SKEPTIC_MAX_REMOVAL_SHARE));
    const convicted = [...new Set(removeIdx)].slice(0, cap).map((n) => rows[n - 1].id);
    const keptIds = rows.map((r) => r.id).filter((id) => !convicted.includes(id));

    // Order matters for crash-safety: survivors are marked FIRST, then the
    // convicted are deleted. A crash in between leaves every row present
    // (some already marked), so a resumed job re-checks the remainder and
    // never mistakes a deletion for a missing spec to regenerate.
    await markChecked(shop, keptIds);
    let removedInGroup = 0;
    if (convicted.length > 0) {
      const del = await prisma.review.deleteMany({
        where: { id: { in: convicted }, shop, isSynthetic: true, syntheticBatchId: batchId },
      });
      removedInGroup = del.count;
      result.removed += del.count;
      if (del.count > 0) {
        // The shared cleanup the batch-delete path performs: cached
        // translations of deleted rows are orphans, and cached Q&A answers
        // may quote them.
        await prisma.translationCache
          .deleteMany({ where: { reviewId: { in: convicted } } })
          .catch(() => undefined);
      }
    }
    result.checked += rows.length;
    if (onGroup) {
      await onGroup({ checked: rows.length, removed: removedInGroup, unchecked: 0 });
    }
  }
}

async function markChecked(shop: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await prisma.review.updateMany({
    where: { id: { in: ids }, shop, isSynthetic: true },
    data: { qaChecked: true },
  });
}

export async function deleteSyntheticBatch(shop: string, batchId: string): Promise<number> {
  const id = typeof batchId === "string" ? batchId.trim() : "";
  if (!id) return 0;
  // Before the early return: a QUEUED job may not have written any rows yet
  // and still must be cancelled when its batch is deleted.
  await cancelAndDeleteJobs(shop, id);
  const rows = await prisma.review.findMany({
    where: { shop, isSynthetic: true, syntheticBatchId: id },
    select: { id: true },
  });
  if (!rows.length) return 0;
  return deleteReviewRows(
    shop,
    rows.map((r) => r.id),
  );
}

/**
 * Deletes ALL synthetic reviews for the shop (and cancels/deletes every
 * generation job — SPEC-1.7 §7). Returns the deleted count.
 */
export async function deleteAllSynthetic(shop: string): Promise<number> {
  await cancelAndDeleteJobs(shop);
  const rows = await prisma.review.findMany({
    where: { shop, isSynthetic: true },
    select: { id: true },
  });
  if (!rows.length) return 0;
  return deleteReviewRows(
    shop,
    rows.map((r) => r.id),
  );
}

/**
 * Distinct product ids carrying synthetic reviews (optionally limited to one
 * batch). Call before a deletion to know which products need an aggregate
 * re-sync afterwards.
 */
export async function syntheticProductIds(
  shop: string,
  batchId?: string | null,
): Promise<string[]> {
  const where =
    batchId && batchId.trim()
      ? { shop, isSynthetic: true, syntheticBatchId: batchId.trim() }
      : { shop, isSynthetic: true };
  const groups = await prisma.review.groupBy({ by: ["productId"], where });
  return groups.map((g) => g.productId);
}

export interface SyntheticBatchInfo {
  batchId: string;
  productId: string;
  productTitle: string | null;
  count: number;
  /** ISO timestamp of the batch generation ("" if unknown). */
  generatedAt: string;
}

export interface SyntheticStats {
  total: number;
  published: number;
  batches: SyntheticBatchInfo[];
}

/**
 * Stats for the "Existing synthetic data" card. Never throws — the QA page
 * loader must render even when the query fails.
 */
export async function syntheticStats(shop: string): Promise<SyntheticStats> {
  try {
    const [total, published, groups] = await Promise.all([
      prisma.review.count({ where: { shop, isSynthetic: true } }),
      prisma.review.count({ where: { shop, isSynthetic: true, status: "PUBLISHED" } }),
      prisma.review.groupBy({
        by: ["syntheticBatchId", "productId", "productTitle"],
        where: { shop, isSynthetic: true, syntheticBatchId: { not: null } },
        _count: { _all: true },
        _max: { syntheticGeneratedAt: true },
      }),
    ]);

    const batches: SyntheticBatchInfo[] = groups
      .filter((g) => typeof g.syntheticBatchId === "string" && g.syntheticBatchId)
      .map((g) => {
        // Defensive access — aggregate result shapes vary across Prisma
        // versions and a stats hiccup must never break the QA page.
        const count =
          typeof g._count === "object" && g._count !== null ? g._count._all ?? 0 : 0;
        const generatedAtDate =
          typeof g._max === "object" && g._max !== null ? g._max.syntheticGeneratedAt : null;
        return {
          batchId: g.syntheticBatchId as string,
          productId: g.productId,
          productTitle: g.productTitle ?? null,
          count,
          generatedAt: generatedAtDate instanceof Date ? generatedAtDate.toISOString() : "",
        };
      })
      .sort((a, b) =>
        a.generatedAt < b.generatedAt ? 1 : a.generatedAt > b.generatedAt ? -1 : 0,
      );

    return { total, published, batches };
  } catch (error) {
    console.error("[cellexia] synthetic: stats query failed", error);
    return { total: 0, published: 0, batches: [] };
  }
}
