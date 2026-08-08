/**
 * Cellexia Reviews — pre-generation cost & time estimates (SPEC-1.7 §4).
 *
 * `estimateGeneration` prices a synthetic QA generation run BEFORE it is
 * enqueued. Token estimation uses three tiers, best first:
 *
 *   1. "measured"  — the shop's own rolling `ModelThroughput` calibration
 *                    (written by the job runner after every chunk), used once
 *                    at least 3 chunks were measured for this shop + model.
 *   2. "baseline"  — ONE real chunk prompt is built with the exact builders
 *                    the generator uses (`buildSystemPrompt` /
 *                    `buildUserContent` from synthetic.server.ts) and priced
 *                    via the Anthropic token-counting endpoint
 *                    (`POST /v1/messages/count_tokens`, same auth/headers as
 *                    the generation call). The counted per-review value is
 *                    cached in-memory for 15 minutes per
 *                    (shop, model, productId).
 *   3. "baseline"  — documented static fallback (190 input / 260 output
 *                    tokens per review) when the count endpoint is
 *                    unavailable (no API key, provider off, network failure);
 *                    the `detail` line says so.
 *
 * This module NEVER throws: every tier degrades to the next and, as the last
 * resort, a fully static estimate is computed synchronously. The returned DTO
 * carries the effective pricing (Sonnet 5 introductory rates applied by date
 * comparison and surfaced via `pricing.introUntil` so the UI can label them),
 * a human-readable `detail` line naming the estimation basis, and a fixed
 * `caveat` string — the UI never has to hardcode either.
 */
import prisma from "~/db.server";
import type { EstimateDTO } from "~/types/cellexia";
import { countTokens } from "./ai.server";
import { getSettings } from "./settings.server";
import {
  buildBatchPlan,
  buildSystemPrompt,
  buildUserContent,
  SYNTHETIC_CHUNK_SIZE,
} from "./synthetic.server";
import type { AdminClient, SyntheticConfig } from "./synthetic.server";
import { LENGTH_MIX } from "./synthetic-prompts.server";
import type { LengthBand } from "./synthetic-prompts.server";

/* ------------------------------------------------------------------------- *
 * Pricing
 * ------------------------------------------------------------------------- */

export interface ModelPricing {
  /** Standard input price, USD per million tokens. */
  inPerMTok: number;
  /** Standard output price, USD per million tokens. */
  outPerMTok: number;
  /** Introductory input price while `introUntil` has not passed. */
  introInPerMTok?: number;
  /** Introductory output price while `introUntil` has not passed. */
  introOutPerMTok?: number;
  /** Last day (inclusive, YYYY-MM-DD) the introductory rates apply. */
  introUntil?: string;
}

/**
 * Pricing (verified against the Anthropic pricing reference, 2026-07-25 —
 * keep this comment block in the source so it can be re-checked):
 *
 * | Model             | Input $/MTok | Output $/MTok | Note                                          |
 * | ----------------- | ------------ | ------------- | --------------------------------------------- |
 * | claude-sonnet-5   | 3.00         | 15.00         | Introductory 2.00 / 10.00 through 2026-08-31  |
 * | claude-haiku-4-5  | 1.00         | 5.00          |                                               |
 *
 * The introductory rate is used when `new Date() <= introUntil` (inclusive,
 * end of day UTC — "through 2026-08-31") and is surfaced to the UI via
 * `pricing.introUntil` on the DTO so it can be labeled. An unknown model
 * falls back to the claude-sonnet-5 row, and the `detail` line says so
 * (SPEC-1.7 §4).
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-sonnet-5": {
    inPerMTok: 3.0,
    outPerMTok: 15.0,
    introInPerMTok: 2.0,
    introOutPerMTok: 10.0,
    introUntil: "2026-08-31",
  },
  "claude-haiku-4-5": {
    inPerMTok: 1.0,
    outPerMTok: 5.0,
  },
};

/** Pricing row used when the configured model is not in MODEL_PRICING. */
const FALLBACK_PRICING_MODEL = "claude-sonnet-5";

/* ------------------------------------------------------------------------- *
 * Estimation constants (SPEC-1.7 §2 + §4)
 * ------------------------------------------------------------------------- */

/**
 * Chunk parallelism inside one job (SPEC-1.7 §2). Mirrors the runner's
 * constant in jobs.server.ts — both assume the single-instance deployment the
 * app already documents.
 */
const JOB_CHUNK_PARALLELISM = 2;

/**
 * Max jobs RUNNING concurrently per shop (SPEC-1.7 §2). When this many jobs
 * already run, a new job queues behind them and the estimate adds the
 * queued-ahead time.
 */
const MAX_RUNNING_JOBS_PER_SHOP = 2;

/** Static fallback: input tokens per review (documented, SPEC-1.7 §4). */
const STATIC_INPUT_TOKENS_PER_REVIEW = 190;

/**
 * Static/default output tokens per review — title + body + optional reply,
 * JSON-encoded — at the standard LENGTH_MIX and the default 15% reply share
 * (documented, SPEC-1.7 §4).
 */
const STATIC_OUTPUT_TOKENS_PER_REVIEW = 260;

/**
 * Output tokens per review by length band (title + body, JSON-encoded).
 * Normalized so that the standard LENGTH_MIX (15% one-liner / 40% short /
 * 35% medium / 10% long) plus the default 15% merchant-reply share lands
 * exactly on STATIC_OUTPUT_TOKENS_PER_REVIEW:
 *   0.15·87 + 0.40·184 + 0.35·319 + 0.10·542 = 252.5, + 0.15·50 = 260.
 */
const OUTPUT_TOKENS_BY_LENGTH: Record<LengthBand, number> = {
  one_liner: 87,
  short: 184,
  medium: 319,
  long: 542,
};

/** Extra output tokens for one 1–3 sentence merchant reply, JSON-encoded. */
const OUTPUT_TOKENS_PER_REPLY = 50;

/** Reply share baked into STATIC_OUTPUT_TOKENS_PER_REVIEW. */
const DEFAULT_REPLIES_PERCENT = 15;

/**
 * Baseline seconds for one 8-review chunk at default effort, used when the
 * shop has no measured throughput yet (documented constant, SPEC-1.7 §4).
 */
const BASELINE_CHUNK_SECONDS = 18;

/** secondsHigh multiplier when the time basis is measured. */
const MEASURED_HIGH_MULTIPLIER = 1.6;

/** secondsHigh multiplier when the time basis is the 18 s baseline. */
const BASELINE_HIGH_MULTIPLIER = 2;

/** Minimum measured chunks before the calibration is trusted (SPEC-1.7 §4). */
const MIN_MEASURED_CHUNKS = 3;

/** In-memory token-count cache TTL (SPEC-1.7 §4). */
const COUNT_CACHE_TTL_MS = 15 * 60 * 1000;

/** Soft cap on cache entries — expired rows are pruned past this size. */
const COUNT_CACHE_MAX_ENTRIES = 200;

/**
 * Deterministic seed handed to buildBatchPlan for the sample chunk. It is
 * never persisted — it only keys the seeded PRNG so repeated estimates build
 * the identical sample prompt (which keeps the 15-minute cache coherent).
 */
const ESTIMATE_SAMPLE_SEED = "cellexia-estimate-sample";

/** Fixed caveat the UI shows verbatim next to every estimate (SPEC-1.7 §4). */
export const ESTIMATE_CAVEAT = "Estimate only — actual usage may differ.";

/* ------------------------------------------------------------------------- *
 * Public shape
 * ------------------------------------------------------------------------- */

/**
 * §4 requires the DTO to carry the basis detail line and the caveat so the UI
 * never hardcodes them; these fields extend the §1 EstimateDTO shape.
 */
export interface EstimateDetails {
  /**
   * Human-readable line naming the estimation basis, e.g. "Based on your
   * shop's last 27 generated chunks…" or "Based on a token count of one
   * sample batch." — includes the pricing-fallback note for unknown models.
   */
  detail: string;
  /** Always ESTIMATE_CAVEAT — shipped in the DTO per SPEC-1.7 §4. */
  caveat: string;
}

/** What `estimateGeneration` actually returns — a strict EstimateDTO subtype. */
export type GenerationEstimate = EstimateDTO & EstimateDetails;

/* ------------------------------------------------------------------------- *
 * In-memory count cache — keyed (shop, model, productId), 15-minute TTL
 * ------------------------------------------------------------------------- */

interface CountCacheEntry {
  perReviewInputTokens: number;
  at: number;
}

const countCache = new Map<string, CountCacheEntry>();

function countCacheKey(shop: string, model: string, config: SyntheticConfig): string {
  // v1.29: hairProduct and extraProductInfo change the counted prompt, so
  // they join the key (v1.26 lesson: estimates must invalidate over every
  // input) — a cheap djb2 hash keeps merchant text out of the key itself.
  let h = 5381;
  for (let i = 0; i < config.extraProductInfo.length; i += 1) {
    h = ((h * 33) ^ config.extraProductInfo.charCodeAt(i)) >>> 0;
  }
  return `${shop}|${model}|${config.productId}|${config.hairProduct ? "h" : "s"}|${h}`;
}

function pruneCountCache(now: number): void {
  if (countCache.size <= COUNT_CACHE_MAX_ENTRIES) return;
  for (const [key, entry] of countCache) {
    if (now - entry.at >= COUNT_CACHE_TTL_MS) countCache.delete(key);
  }
}

/* ------------------------------------------------------------------------- *
 * Internals
 * ------------------------------------------------------------------------- */

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

interface ResolvedPricing {
  /** Effective input rate (introductory when the window applies). */
  inPerMTok: number;
  /** Effective output rate (introductory when the window applies). */
  outPerMTok: number;
  /** Present ONLY while the introductory rates are being applied. */
  introUntil?: string;
  /** False when the model fell back to the sonnet-5 pricing row. */
  knownModel: boolean;
}

/**
 * Effective rates for a model at `now`. Introductory pricing applies through
 * the END of the `introUntil` day (UTC, inclusive) and, when applied, is
 * surfaced via `introUntil` so the UI can label it. Unknown models fall back
 * to the claude-sonnet-5 row (`knownModel: false` → noted in the detail line).
 */
function resolvePricing(model: string, now: Date): ResolvedPricing {
  const knownModel = Object.prototype.hasOwnProperty.call(MODEL_PRICING, model);
  const row = knownModel ? MODEL_PRICING[model] : MODEL_PRICING[FALLBACK_PRICING_MODEL];

  let inPerMTok = row.inPerMTok;
  let outPerMTok = row.outPerMTok;
  let introUntil: string | undefined;
  if (
    row.introUntil &&
    row.introInPerMTok !== undefined &&
    row.introOutPerMTok !== undefined
  ) {
    const windowEnd = Date.parse(`${row.introUntil}T23:59:59.999Z`);
    if (Number.isFinite(windowEnd) && now.getTime() <= windowEnd) {
      inPerMTok = row.introInPerMTok;
      outPerMTok = row.introOutPerMTok;
      introUntil = row.introUntil;
    }
  }
  return { inPerMTok, outPerMTok, introUntil, knownModel };
}

/**
 * Output tokens per review: the per-band table weighted by LENGTH_MIX (the
 * mix the plan builder actually enforces), plus the configured reply share.
 * At the default mix and 15% replies this is exactly the documented 260.
 */
function estimatedOutputTokensPerReview(config: SyntheticConfig): number {
  let weighted = 0;
  let mixTotal = 0;
  for (const band of Object.keys(LENGTH_MIX) as LengthBand[]) {
    const share = LENGTH_MIX[band];
    const tokens = OUTPUT_TOKENS_BY_LENGTH[band];
    if (!Number.isFinite(share) || share <= 0 || !Number.isFinite(tokens)) continue;
    weighted += share * tokens;
    mixTotal += share;
  }
  const base =
    mixTotal > 0
      ? weighted / mixTotal
      : STATIC_OUTPUT_TOKENS_PER_REVIEW -
        (DEFAULT_REPLIES_PERCENT / 100) * OUTPUT_TOKENS_PER_REPLY;
  // parseSyntheticConfig clamps repliesPercent, but the estimate must stay
  // finite for any input — a NaN here would poison every downstream number.
  const repliesPercent = Number.isFinite(config.repliesPercent)
    ? config.repliesPercent
    : DEFAULT_REPLIES_PERCENT;
  const replyShare = Math.min(100, Math.max(0, repliesPercent)) / 100;
  return base + replyShare * OUTPUT_TOKENS_PER_REPLY;
}

interface MeasuredThroughput {
  chunkCount: number;
  totalReviews: number;
  perReviewInputTokens: number;
  perReviewOutputTokens: number;
  /** null when the record carries no usable duration data. */
  avgChunkSeconds: number | null;
}

/**
 * The shop's rolling calibration for this model, or null when there is no
 * usable history yet (fewer than MIN_MEASURED_CHUNKS chunks, zero counters,
 * missing table). Never throws.
 */
async function readMeasuredThroughput(
  shop: string,
  model: string,
): Promise<MeasuredThroughput | null> {
  try {
    const row = await prisma.modelThroughput.findUnique({
      where: { shop_model: { shop, model } },
    });
    if (
      !row ||
      row.chunkCount < MIN_MEASURED_CHUNKS ||
      row.totalReviews <= 0 ||
      row.totalInTokens <= 0 ||
      row.totalOutTokens <= 0
    ) {
      return null;
    }
    const avgSeconds = row.totalSeconds > 0 ? row.totalSeconds / row.chunkCount : null;
    return {
      chunkCount: row.chunkCount,
      totalReviews: row.totalReviews,
      perReviewInputTokens: row.totalInTokens / row.totalReviews,
      perReviewOutputTokens: row.totalOutTokens / row.totalReviews,
      // Clamp to a sane band — a corrupted counter must not zero the ETA.
      avgChunkSeconds:
        avgSeconds !== null && Number.isFinite(avgSeconds)
          ? Math.min(600, Math.max(1, avgSeconds))
          : null,
    };
  } catch (error) {
    console.error("[cellexia] estimate: throughput lookup failed", error);
    return null;
  }
}

/**
 * Counted-baseline input tokens per review: builds ONE real chunk prompt for
 * this product with the same builders the generator uses (8 reviews' worth of
 * persona specs — fewer only when the whole batch is smaller) and asks the
 * token-counting endpoint for its exact input size. Cached per
 * (shop, model, productId) for 15 minutes. Returns null on any failure —
 * never throws.
 */
async function countedInputTokensPerReview(
  shop: string,
  model: string,
  apiKey: string | null,
  brandDisplayName: string,
  config: SyntheticConfig,
): Promise<number | null> {
  const key = countCacheKey(shop, model, config);
  const now = Date.now();
  const hit = countCache.get(key);
  if (hit && now - hit.at < COUNT_CACHE_TTL_MS) return hit.perReviewInputTokens;
  if (hit) countCache.delete(key);

  if (!apiKey) return null;

  try {
    // A bounded copy keeps the plan build cheap for huge requests: the sample
    // chunk only ever needs the first SYNTHETIC_CHUNK_SIZE specs. For counts
    // ≥ 8 the seeded plan is identical for every count, which keeps the
    // cached per-review value coherent with the (shop, model, productId) key.
    const sampleConfig: SyntheticConfig = {
      ...config,
      count: Math.max(1, Math.min(config.count, SYNTHETIC_CHUNK_SIZE)),
    };
    const specs = buildBatchPlan(sampleConfig, ESTIMATE_SAMPLE_SEED).slice(
      0,
      SYNTHETIC_CHUNK_SIZE,
    );
    if (specs.length === 0) return null;

    const tokens = await countTokens(
      apiKey,
      model,
      buildSystemPrompt(brandDisplayName, sampleConfig.hairProduct),
      buildUserContent(sampleConfig, specs),
    );
    if (tokens === null || tokens <= 0) return null;

    const perReview = tokens / specs.length;
    countCache.set(key, { perReviewInputTokens: perReview, at: now });
    pruneCountCache(now);
    return perReview;
  } catch (error) {
    console.error("[cellexia] estimate: sample token count failed", error);
    return null;
  }
}

/**
 * Seconds of queued-ahead work when the shop's two running slots are already
 * taken (SPEC-1.7 §4): the remaining chunks of every RUNNING/QUEUED job,
 * paced at the same avgChunkSeconds / parallelism as the job itself. Returns
 * 0 when a slot is free or the lookup fails — never throws.
 */
async function queuedAheadSeconds(shop: string, avgChunkSeconds: number): Promise<number> {
  try {
    const active = await prisma.generationJob.findMany({
      where: { shop, status: { in: ["RUNNING", "QUEUED"] } },
      select: { status: true, chunksTotal: true, chunksDone: true },
    });
    const running = active.filter((job) => job.status === "RUNNING").length;
    if (running < MAX_RUNNING_JOBS_PER_SHOP) return 0;
    const remainingChunks = active.reduce(
      (sum, job) => sum + Math.max(0, job.chunksTotal - job.chunksDone),
      0,
    );
    if (remainingChunks <= 0) return 0;
    return Math.ceil(remainingChunks / JOB_CHUNK_PARALLELISM) * avgChunkSeconds;
  } catch (error) {
    console.error("[cellexia] estimate: active-job lookup failed", error);
    return 0;
  }
}

/** Cost per SPEC-1.7 §4: cents, with 4 decimals below $0.01. */
function computeCostUsd(
  inputTokens: number,
  outputTokens: number,
  pricing: ResolvedPricing,
): number {
  const raw =
    (inputTokens / 1e6) * pricing.inPerMTok + (outputTokens / 1e6) * pricing.outPerMTok;
  return raw < 0.01 ? roundTo(raw, 4) : roundTo(raw, 2);
}

function pricingFallbackNote(model: string): string {
  return ` Pricing uses the ${FALLBACK_PRICING_MODEL} rates because "${model}" is not in the pricing table.`;
}

/**
 * Pure, synchronous last-resort estimate — no settings, no database, no
 * network. Used when the normal path fails unexpectedly; provably cannot
 * throw for any SyntheticConfig.
 */
function staticFallbackEstimate(config: SyntheticConfig, model: string): GenerationEstimate {
  const reviews = Math.max(1, Math.floor(config.count) || 1);
  const chunks = Math.ceil(reviews / SYNTHETIC_CHUNK_SIZE);
  const pricing = resolvePricing(model, new Date());
  let inputTokens = Math.round(STATIC_INPUT_TOKENS_PER_REVIEW * reviews);
  let outputTokens = Math.round(estimatedOutputTokensPerReview(config) * reviews);
  let checkCalls = 0;
  if (config.skepticCheck !== false) {
    const perCheck = Math.min(60, Math.max(5, Math.floor(config.skepticBatchSize) || 20));
    checkCalls = Math.ceil(reviews / perCheck);
    inputTokens += reviews * 260 + checkCalls * 400;
    outputTokens += checkCalls * 120;
  }
  const seconds = Math.max(
    1,
    Math.ceil(Math.ceil(chunks / JOB_CHUNK_PARALLELISM) * BASELINE_CHUNK_SECONDS) +
      checkCalls * 6,
  );
  const secondsHigh = Math.max(seconds, Math.ceil(seconds * BASELINE_HIGH_MULTIPLIER));
  let detail =
    "Based on the built-in static estimate (190 input / 260 output tokens per review) — the live token count was unavailable.";
  if (!pricing.knownModel) detail += pricingFallbackNote(model);
  return {
    reviews,
    chunks,
    inputTokens,
    outputTokens,
    costUsd: computeCostUsd(inputTokens, outputTokens, pricing),
    seconds,
    secondsHigh,
    basis: "baseline",
    model,
    pricing: {
      inPerMTok: pricing.inPerMTok,
      outPerMTok: pricing.outPerMTok,
      ...(pricing.introUntil ? { introUntil: pricing.introUntil } : {}),
    },
    detail,
    caveat: ESTIMATE_CAVEAT,
  };
}

async function computeEstimate(
  shop: string,
  config: SyntheticConfig,
): Promise<GenerationEstimate> {
  const reviews = Math.max(1, Math.floor(config.count) || 1);
  const chunks = Math.ceil(reviews / SYNTHETIC_CHUNK_SIZE);

  // Settings drive the model, the API key for the count endpoint and the
  // brand name the real system prompt embeds. A settings failure only costs
  // us the counted tier — the estimate still comes back.
  let model = FALLBACK_PRICING_MODEL;
  let apiKey: string | null = null;
  let brandDisplayName = "Cellexia";
  try {
    const settings = await getSettings(shop);
    if (settings.aiModel) model = settings.aiModel;
    apiKey = settings.aiProvider === "anthropic" ? settings.anthropicApiKey : null;
    if (settings.brandDisplayName) brandDisplayName = settings.brandDisplayName;
  } catch (error) {
    console.error("[cellexia] estimate: settings lookup failed", error);
  }

  const pricing = resolvePricing(model, new Date());

  // ── Tier 1: measured (shop's own rolling calibration) ────────────────────
  let basis: EstimateDTO["basis"] = "baseline";
  let detail = "";
  let inputPerReview: number | null = null;
  let outputPerReview = estimatedOutputTokensPerReview(config);
  let avgChunkSeconds = BASELINE_CHUNK_SECONDS;
  let highMultiplier: number = BASELINE_HIGH_MULTIPLIER;

  const measured = await readMeasuredThroughput(shop, model);
  if (measured) {
    basis = "measured";
    inputPerReview = measured.perReviewInputTokens;
    outputPerReview = measured.perReviewOutputTokens;
    detail = `Based on your shop's last ${measured.chunkCount} generated chunks (${measured.totalReviews} reviews) with this model.`;
    if (measured.avgChunkSeconds !== null) {
      avgChunkSeconds = measured.avgChunkSeconds;
      highMultiplier = MEASURED_HIGH_MULTIPLIER;
    }
  }

  // ── Tier 2: counted baseline (one real chunk through count_tokens) ───────
  if (inputPerReview === null) {
    const counted = await countedInputTokensPerReview(
      shop,
      model,
      apiKey,
      brandDisplayName,
      config,
    );
    if (counted !== null) {
      inputPerReview = counted;
      detail = "Based on a token count of one sample batch.";
    }
  }

  // ── Tier 3: documented static fallback ───────────────────────────────────
  if (inputPerReview === null) {
    inputPerReview = STATIC_INPUT_TOKENS_PER_REVIEW;
    detail =
      "Based on the built-in static estimate (190 input / 260 output tokens per review) — the live token count was unavailable.";
  }

  if (!pricing.knownModel) detail += pricingFallbackNote(model);

  // ── Totals, cost, time ────────────────────────────────────────────────────
  let inputTokens = Math.round(inputPerReview * reviews);
  let outputTokens = Math.round(outputPerReview * reviews);

  // v1.24 (SPEC-1.24 §4): the skeptical double-check reads every stored
  // review back (title + up to 1200 body chars + JSON scaffolding, ~260
  // input tokens per review, conservative) plus its own prompt per call, and
  // answers briefly. Priced with the same model as generation.
  if (config.skepticCheck !== false) {
    const perCheck = Math.min(60, Math.max(5, Math.floor(config.skepticBatchSize) || 20));
    const checkCalls = Math.ceil(reviews / perCheck);
    inputTokens += reviews * 260 + checkCalls * 400;
    outputTokens += checkCalls * 120;
  }
  const costUsd = computeCostUsd(inputTokens, outputTokens, pricing);

  const jobSeconds = Math.ceil(chunks / JOB_CHUNK_PARALLELISM) * avgChunkSeconds;
  const queueSeconds = await queuedAheadSeconds(shop, avgChunkSeconds);
  const seconds = Math.max(1, Math.ceil(jobSeconds + queueSeconds));
  // The high bound scales queued-ahead time too — the wait ahead is exactly
  // as uncertain as this job's own chunks.
  const secondsHigh = Math.max(seconds, Math.ceil(seconds * highMultiplier));

  return {
    reviews,
    chunks,
    inputTokens,
    outputTokens,
    costUsd,
    seconds,
    secondsHigh,
    basis,
    model,
    pricing: {
      inPerMTok: pricing.inPerMTok,
      outPerMTok: pricing.outPerMTok,
      ...(pricing.introUntil ? { introUntil: pricing.introUntil } : {}),
    },
    detail,
    caveat: ESTIMATE_CAVEAT,
  };
}

/* ------------------------------------------------------------------------- *
 * Public API
 * ------------------------------------------------------------------------- */

/**
 * Cost & time estimate for a prospective generation run (SPEC-1.7 §4).
 *
 * Never throws — every failure (settings, database, token-count endpoint)
 * degrades to the next estimation tier with an honest `detail` line, ending
 * at the documented static numbers.
 *
 * `_admin` is part of the §4 signature for parity with the generation path;
 * the estimate builds its sample prompt from the config's embedded product
 * context alone, so no Admin API call is needed today.
 */
export async function estimateGeneration(
  shop: string,
  _admin: AdminClient,
  config: SyntheticConfig,
): Promise<GenerationEstimate> {
  try {
    return await computeEstimate(shop, config);
  } catch (error) {
    console.error(
      "[cellexia] estimate: unexpected failure — falling back to static numbers",
      error,
    );
    return staticFallbackEstimate(config, FALLBACK_PRICING_MODEL);
  }
}
