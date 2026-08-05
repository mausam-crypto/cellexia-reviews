/**
 * Cellexia Reviews — pre-run cost estimate for AI curation (SPEC-1.20 §2).
 *
 * Answers "what will this cost?" against the REAL payloads a run would send,
 * and spends nothing doing it:
 *   - payloads are assembled in dry-run mode (`translate: false`), so
 *     all_translated mode COUNTS the translations it would need instead of
 *     performing (and billing) them;
 *   - input tokens come from Anthropic's free `count_tokens` endpoint, so the
 *     figure is measured rather than guessed;
 *   - output tokens are the one estimate, and are labelled as such.
 *
 * Bounded work: at most MAX_COUNT_CALLS token counts and a 45 s wall clock.
 * Anything beyond that is extrapolated from the measured chars-per-token
 * ratio, and the result reports exactPairs/totalPairs so the admin can see
 * whether the number was measured or extrapolated.
 */
import {
  OUTPUT_TOKENS_PER_CALL,
  asCurationSource,
  buildCurationRequest,
  checkBudget,
  curatableProductIds,
  qualifyingLocales,
} from "./curation.server";
import type { ProductContextCache } from "./curation.server";
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import prisma from "~/db.server";
import { countTokens } from "./ai.server";
import {
  PRICES_AS_OF,
  approxTokens,
  approxTokensForChars,
  costUsd,
  ratesFor,
} from "./pricing.server";
import { getSettings } from "./settings.server";

type AdminClient = Pick<AdminApiContext, "graphql">;

const MAX_COUNT_CALLS = 250;
const COUNT_CONCURRENCY = 6;
const COUNT_TIME_BUDGET_MS = 45_000;
/**
 * Assembly is bounded too, not just the counting. A catalogue of hundreds of
 * products times 17 locales is thousands of payload builds inside one HTTP
 * request; without a clock the preview would simply time out and the merchant
 * would see nothing at all. Stopping early and SAYING so is far better than
 * failing.
 */
const ASSEMBLY_TIME_BUDGET_MS = 40_000;
/** Characters per translated review, averaged, for the translation estimate. */
const TRANSLATION_CHARS_PER_REVIEW = 600;

export interface EstimatePair {
  productId: string;
  productTitle: string | null;
  locale: string;
  reviewCount: number;
  /** Original count when the payload had to be trimmed to fit the budget. */
  trimmedFrom: number | null;
  inputTokens: number;
  /** true when inputTokens came from count_tokens, false when extrapolated. */
  measured: boolean;
}

export interface CurationEstimate {
  model: string;
  priced: boolean;
  pricesAsOf: string;
  introApplied: boolean;
  calls: number;
  products: number;
  inputTokens: number;
  outputTokens: number;
  exactPairs: number;
  totalPairs: number;
  trimmedProducts: number;
  missingTranslations: number;
  translationCostUsd: number | null;
  instantCostUsd: number | null;
  batchCostUsd: number | null;
  /**
   * The products this estimate actually covers. When assembly ran out of time
   * it is a subset, and the run must be scoped to it — otherwise the merchant
   * approves one figure and is billed for a larger job.
   */
  productIds: string[];
  /** true when assembly stopped early, so productIds is a subset of the ask. */
  truncated: boolean;
  budget: {
    ceiling: number | null;
    spent: number;
    /** Would a full-price "Run now" break the ceiling? */
    wouldExceed: boolean;
    /** Would the half-price background run break it? Judged separately. */
    batchWouldExceed: boolean;
  };
  pairs: EstimatePair[];
  /** Non-fatal notes for the admin (skipped products, degraded counting). */
  notes: string[];
}

/**
 * Estimates a run WITHOUT spending anything. `productIds` omitted ⇒ every
 * product with published reviews, exactly like "Curate all".
 */
export async function estimateCuration(
  shop: string,
  admin: AdminClient,
  productIds?: string[],
): Promise<CurationEstimate> {
  const settings = await getSettings(shop);
  const model = settings.aiModel;
  const rates = ratesFor(model);
  const notes: string[] = [];

  let ids = productIds;
  if (!ids || ids.length === 0) ids = await curatableProductIds(shop);

  // A preview that finds nothing must say WHY. Before v1.20.1 the loop below
  // simply never ran when this list was empty, so the modal asserted reasons
  // ("needs 3 published reviews", "must exist in Shopify") that nothing had
  // actually checked. Report the shape of the catalogue first.
  if (ids.length === 0) {
    const anyReviews = await prisma.review.count({ where: { shop } });
    const anyPublished = await prisma.review.count({ where: { shop, status: "PUBLISHED" } });
    if (anyReviews === 0) {
      notes.push("There are no reviews in this app yet, so there is nothing to order.");
    } else if (anyPublished === 0) {
      notes.push(
        `All ${anyReviews} review(s) are still unpublished. Curation only orders published reviews — approve some on the Reviews page first.`,
      );
    } else {
      notes.push(
        `${anyPublished} published review(s) exist but none could be grouped by product, which usually means their product ids no longer match any product.`,
      );
    }
  }

  const source = asCurationSource(settings.curationSource);
  const pairs: EstimatePair[] = [];
  // Per-invocation, never module-level: two admins (or two shops) can estimate
  // at the same time, and a shared map would let one run's clear() blank the
  // other's payloads. Only the pairs we will actually count are held as text;
  // every pair keeps just its character count, which is all the extrapolation
  // needs. A 5000-review catalogue would otherwise sit in memory twice over.
  const payloads = new Map<number, { system: string; userContent: string }>();
  const charCounts: number[] = [];
  // One Shopify fetch per product, not per (product, locale) pair.
  const contextCache: ProductContextCache = new Map();
  const unreadableProducts = new Set<string>();
  const tooFewReviews = new Set<string>();
  /** Products with published reviews that no locale qualified for. */
  const noQualifyingLocale = new Set<string>();
  // A flag, not a note per pair: with no key EVERY pair reports no_ai, which
  // would push the same sentence hundreds of times into the modal.
  let noAiKey = false;
  let missingTranslations = 0;

  const assemblyStarted = Date.now();
  const measuredIds: string[] = [];
  let truncated = false;
  for (const productId of ids) {
    if (Date.now() - assemblyStarted > ASSEMBLY_TIME_BUDGET_MS) {
      truncated = true;
      const remaining = ids.length - measuredIds.length;
      notes.push(
        `Only ${measuredIds.length} of ${ids.length} products could be measured in the time available. This run will cover those ${measuredIds.length}, and the figures below are for exactly that — run the preview again afterwards for the remaining ${remaining}.`,
      );
      break;
    }
    measuredIds.push(productId);
    const locales = await qualifyingLocales(shop, productId, source);
    if (locales.length === 0) noQualifyingLocale.add(productId);
    for (const locale of locales) {
      // Dry run: never translates, never calls the Messages API.
      const built = await buildCurationRequest(shop, admin, productId, locale, {
        translate: false,
        contextCache,
      });
      if (built.status !== "ok") {
        // Every skip is disclosed. A product Shopify would not return costs
        // nothing to skip, but the merchant is approving a total — they must
        // not later find they were quoted for less work than actually ran.
        if (built.status === "no_product") unreadableProducts.add(productId);
        else if (built.status === "no_reviews") tooFewReviews.add(productId);
        else if (built.status === "no_ai") noAiKey = true;
        continue;
      }
      const { request } = built;
      const chars = request.system.length + request.userContent.length;
      const index = pairs.length;
      pairs.push({
        productId,
        productTitle: null,
        locale,
        reviewCount: request.candidates.length,
        trimmedFrom: request.trimmedFrom,
        // Provisional: replaced by the measured value below where possible.
        // Scanned from the real text (script-aware) while we still hold it.
        inputTokens: approxTokens(request.system + request.userContent),
        measured: false,
      });
      charCounts.push(chars);
      if (index < MAX_COUNT_CALLS) {
        payloads.set(index, { system: request.system, userContent: request.userContent });
      }
    }
    if (source === "all_translated") {
      missingTranslations += await countMissingTranslations(shop, productId, locales);
    }
  }

  if (noAiKey) {
    notes.push("No Claude API key is configured, so nothing could be prepared for this run.");
  }
  if (noQualifyingLocale.size > 0) {
    notes.push(
      `${noQualifyingLocale.size} product${noQualifyingLocale.size === 1 ? " has" : "s have"} fewer than 3 published reviews, which is the minimum an agent needs to put an order together.`,
    );
  }
  if (unreadableProducts.size > 0) {
    notes.push(
      `${unreadableProducts.size} product${unreadableProducts.size === 1 ? "" : "s"} could not be read from Shopify, so ${unreadableProducts.size === 1 ? "it is" : "they are"} not included. That usually means the product was deleted, but it can also be a temporary Shopify error — if these reviews belong to products that still exist, try again in a minute.`,
    );
  }
  if (tooFewReviews.size > 0) {
    notes.push(
      `${tooFewReviews.size} product${tooFewReviews.size === 1 ? "" : "s"} ${tooFewReviews.size === 1 ? "has" : "have"} too few published reviews to curate and ${tooFewReviews.size === 1 ? "is" : "are"} not included.`,
    );
  }

  // --- exact token counts, bounded ---------------------------------------
  let exactPairs = 0;
  if (settings.anthropicApiKey && pairs.length > 0) {
    const started = Date.now();
    const limit = Math.min(pairs.length, MAX_COUNT_CALLS);
    // Shared cursor across the workers. Safe without a lock: JS runs this
    // read-and-increment to completion before any await can yield.
    let cursor = 0;
    const worker = async () => {
      while (cursor < limit) {
        const index = cursor;
        cursor += 1;
        if (Date.now() - started > COUNT_TIME_BUDGET_MS) return;
        const payload = payloads.get(index);
        if (!payload) continue;
        const tokens = await countTokens(
          settings.anthropicApiKey!,
          model,
          payload.system,
          payload.userContent,
        );
        if (typeof tokens === "number") {
          pairs[index].inputTokens = tokens;
          pairs[index].measured = true;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(COUNT_CONCURRENCY, limit) }, worker));
    exactPairs = pairs.filter((p) => p.measured).length;
  } else if (!settings.anthropicApiKey) {
    notes.push("No Claude API key configured, so token counts are estimated rather than measured.");
  }

  // Extrapolate the unmeasured pairs from the measured chars-per-token ratio.
  if (exactPairs > 0 && exactPairs < pairs.length) {
    let chars = 0;
    let tokens = 0;
    pairs.forEach((p, i) => {
      if (!p.measured) return;
      chars += charCounts[i];
      tokens += p.inputTokens;
    });
    const perChar = chars > 0 ? tokens / chars : 0;
    if (perChar > 0) {
      pairs.forEach((p, i) => {
        if (p.measured) return;
        p.inputTokens = Math.round(charCounts[i] * perChar);
      });
      notes.push(
        `${pairs.length - exactPairs} of ${pairs.length} calls were estimated from the measured average rather than counted individually.`,
      );
    }
  }
  payloads.clear();

  const inputTokens = pairs.reduce((sum, p) => sum + p.inputTokens, 0);
  const outputTokens = pairs.length * OUTPUT_TOKENS_PER_CALL;
  const instantCostUsd = costUsd({ model, inputTokens, outputTokens });
  const batchCostUsd = costUsd({ model, inputTokens, outputTokens, batch: true });

  // Translation cost: characters in, roughly the same out, priced as tokens.
  // Only Claude translations are billed through this app's Anthropic key and
  // land on the same ledger — DeepL and Google are the merchant's separate
  // accounts, so quoting them at Claude's rates would be a made-up number.
  let translationCostUsd: number | null = null;
  if (missingTranslations > 0) {
    if (settings.translationProvider === "anthropic") {
      const translationTokens = approxTokensForChars(
        missingTranslations * TRANSLATION_CHARS_PER_REVIEW,
      );
      translationCostUsd = costUsd({
        model,
        inputTokens: translationTokens,
        outputTokens: translationTokens,
      });
    } else if (settings.translationProvider === "off") {
      notes.push(
        `${missingTranslations} review translations are missing, but translation is switched off — those reviews will be shown to the agents in their original language.`,
      );
      missingTranslations = 0;
    } else {
      notes.push(
        `${missingTranslations} review translations are still needed. They are billed by ${settings.translationProvider === "deepl" ? "DeepL" : "Google"}, not by Anthropic, so their cost is not part of the figures above.`,
      );
    }
  }

  // A batch run costs half, so it must be judged on its own price: quoting the
  // instant figure would refuse a background run the ceiling comfortably fits.
  const translation = translationCostUsd ?? 0;
  const instantBudget = await checkBudget(shop, (instantCostUsd ?? 0) + translation);
  const batchBudget = await checkBudget(shop, (batchCostUsd ?? 0) + translation);

  if (missingTranslations > 0 && settings.translationProvider === "anthropic") {
    // The preview must never translate (that would bill the merchant just for
    // looking), so it measured the payloads as they are today. Say so.
    notes.push(
      `${missingTranslations} reviews still need translating. The token counts above were measured on the untranslated text, so the real run will differ a little.`,
    );
  }
  if (exactPairs === 0 && pairs.length > 0) {
    notes.push(
      "Nothing could be counted exactly, so every figure here is an approximation rather than a measurement.",
    );
  }

  return {
    model,
    priced: rates !== null,
    pricesAsOf: PRICES_AS_OF,
    introApplied: rates?.introApplied ?? false,
    calls: pairs.length,
    products: new Set(pairs.map((p) => p.productId)).size,
    productIds: measuredIds,
    truncated,
    inputTokens,
    outputTokens,
    exactPairs,
    totalPairs: pairs.length,
    trimmedProducts: new Set(pairs.filter((p) => p.trimmedFrom != null).map((p) => p.productId))
      .size,
    missingTranslations,
    translationCostUsd,
    instantCostUsd,
    batchCostUsd,
    budget: {
      ceiling: instantBudget.ceiling,
      spent: instantBudget.spent,
      wouldExceed: !instantBudget.ok,
      batchWouldExceed: !batchBudget.ok,
    },
    pairs,
    notes,
  };
}

async function countMissingTranslations(
  shop: string,
  productId: string,
  locales: string[],
): Promise<number> {
  const rows = await prisma.review.findMany({
    where: { shop, productId: String(productId), status: "PUBLISHED" },
    select: { id: true, language: true },
  });
  if (rows.length === 0) return 0;
  const cached = await prisma.translationCache.findMany({
    where: { reviewId: { in: rows.map((r) => r.id) }, target: { in: locales } },
    select: { reviewId: true, target: true, body: true },
  });
  const have = new Set(cached.filter((c) => c.body).map((c) => `${c.reviewId}|${c.target}`));
  let missing = 0;
  for (const locale of locales) {
    for (const row of rows) {
      if (row.language === locale) continue;
      if (!have.has(`${row.id}|${locale}`)) missing += 1;
    }
  }
  return missing;
}
