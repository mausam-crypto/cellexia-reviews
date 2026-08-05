/**
 * Cellexia Reviews — AI Curator engine (SPEC-1.17).
 *
 * curateProductLocale(shop, admin, productId, locale) runs ONE agent: it
 * assembles the locale's candidate set (each review in the text that
 * locale's shoppers actually see — native, cached translation, or original
 * marked with its language), fetches the product description + the
 * configured Accentuate "overview" metafield, calls the locale's
 * NATIVE-LANGUAGE prompt (curation-prompts.server.ts) and stores the
 * validated order + rationale in AiCuration.
 *
 * queueCuration(shop, admin, productIds?) fans out (product × qualifying
 * locale) tasks through an in-process queue: concurrency 2, per-(product,
 * locale) debounce 10 min, and (v1.20) the merchant's optional spend ceiling
 * instead of an invented per-day cap.
 * Admin-triggered ONLY (SPEC-1.17 §0.1) — nothing on any proxy path calls
 * into this module.
 *
 * Hard rules: helpfulCount is never part of the payload; returned ids are
 * validated against the candidate set (unknown dropped, < MIN_ORDER ⇒ the
 * attempt fails and nothing is stored).
 */
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

import prisma from "~/db.server";
import { SHOP_LOCALES } from "~/types/cellexia";
import { callClaudeWithUsage, extractJson } from "./ai.server";
import { curationPromptFor } from "./curation-prompts.server";
import { approxTokens, costUsd } from "./pricing.server";
import { getSettings } from "./settings.server";
import { checkBudget, recordSpend } from "./spend.server";
import { scrubDashes } from "./synthetic-prompts.server";
import { translateReviews } from "./translate.server";

/** v1.18 (SPEC-1.18 §1): what the agents read. */
export type CurationSource = "as_seen" | "all_translated";

export function asCurationSource(raw: unknown): CurationSource {
  return raw === "all_translated" ? "all_translated" : "as_seen";
}

type AdminClient = Pick<AdminApiContext, "graphql">;

/**
 * v1.20 (SPEC-1.20 §1): the 60-review cap is gone — the agent sees EVERY
 * published review. Volume is bounded by a token budget instead, a third of
 * the model's 1M context so there is ample room for output and prompt growth.
 */
export const MAX_PAYLOAD_TOKENS = 400_000;
/**
 * The review lines are not the whole request: the locale's system prompt, the
 * product description and overview (8000 chars each) and the merchant's
 * guidance also go on the wire. Reserve room for them so the budget bounds
 * the REQUEST rather than one part of it.
 */
const NON_REVIEW_TOKEN_RESERVE = 12_000;
const REVIEW_TOKEN_BUDGET = MAX_PAYLOAD_TOKENS - NON_REVIEW_TOKEN_RESERVE;
/** Body length ladder: full-ish, then tighter, before any review is dropped. */
const BODY_CHAR_LADDER = [2000, 1200, 800] as const;
const MAX_DESCRIPTION_CHARS = 8000;
const MIN_QUALIFYING_LOCAL_TEXTS = 5;
export const MIN_ORDER = 3;
const MAX_ORDER = 30;
const CURATION_CONCURRENCY = 2;
const DEBOUNCE_MS = 10 * 60 * 1000;

/* ------------------------------------------------------------------------- *
 * Product context (description + Accentuate overview)
 * ------------------------------------------------------------------------- */

export interface ProductContext {
  title: string;
  description: string;
  overview: string;
}

/**
 * Accentuate stores rich text as JSON (quill-ish delta or nested objects);
 * plain metafields are strings. Reduce anything to readable plain text.
 */
export function metafieldToText(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return metafieldToText(JSON.parse(trimmed));
      } catch {
        /* fall through: treat as plain text (maybe HTML) */
      }
    }
    // Strip tags defensively; Accentuate rich text may arrive as HTML.
    return trimmed.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
  if (Array.isArray(raw)) return raw.map(metafieldToText).filter(Boolean).join(" ");
  if (typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    // Common rich-text shapes: {value}, {text}, {children}, quill {ops:[{insert}]}
    const parts: string[] = [];
    for (const key of ["insert", "text", "value", "children", "ops", "content", "blocks"]) {
      if (key in record) parts.push(metafieldToText(record[key]));
    }
    return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  }
  return "";
}

export function parseOverviewField(field: string): { namespace: string; key: string } | null {
  const m = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(field.trim());
  return m ? { namespace: m[1], key: m[2] } : null;
}

async function fetchProductContext(
  admin: AdminClient,
  productId: string,
  overviewField: string,
): Promise<ProductContext> {
  const ref = parseOverviewField(overviewField);
  const query = `#graphql
    query CellexiaCurationProduct($id: ID!${ref ? ", $ns: String!, $key: String!" : ""}) {
      product(id: $id) {
        title
        description
        ${ref ? "metafield(namespace: $ns, key: $key) { value }" : ""}
      }
    }
  `;
  try {
    const response = await admin.graphql(query, {
      variables: {
        id: `gid://shopify/Product/${productId}`,
        ...(ref ? { ns: ref.namespace, key: ref.key } : {}),
      },
    });
    const json = (await response.json()) as {
      data?: { product?: { title?: string; description?: string; metafield?: { value?: string } | null } };
    };
    const product = json.data?.product;
    return {
      title: product?.title ?? "",
      description: (product?.description ?? "").slice(0, MAX_DESCRIPTION_CHARS),
      overview: metafieldToText(product?.metafield?.value).slice(0, MAX_DESCRIPTION_CHARS),
    };
  } catch (error) {
    console.error("[cellexia] curation product fetch failed", error);
    return { title: "", description: "", overview: "" };
  }
}

/* ------------------------------------------------------------------------- *
 * Candidate assembly (SPEC-1.17 §2)
 * ------------------------------------------------------------------------- */

export interface CurationCandidate {
  id: string;
  rating: number;
  title: string | null;
  body: string;
  verified: boolean;
  date: string;
  variant: string | null;
  hasMedia: boolean;
  /** "native" | "translated" | original language code */
  textNote: string;
}

/**
 * Builds the candidate list for (product, locale): each review carries the
 * text locale-L shoppers actually see. Returns the candidates plus how many
 * carry locale-L text (native or translated) — the qualification count.
 *
 * source "all_translated" (SPEC-1.18 §1): foreign candidates missing a
 * cached translation are translated NOW via translateReviews (cache-first,
 * results upserted to TranslationCache — billed at most once ever); any
 * still untranslated afterwards (provider off/error, dash-only body) fall
 * back to marked-original so the run proceeds.
 */
export async function buildCandidates(
  shop: string,
  productId: string,
  locale: string,
  source: CurationSource = "as_seen",
  options: { translate?: boolean } = {},
): Promise<{ candidates: CurationCandidate[]; localTexts: number; trimmedFrom?: number | null; missingTranslations?: number }> {
  // EVERY published review — no recency window (SPEC-1.20 §1).
  // The curator orders what the PRODUCT PAGE serves, so it must read exactly
  // the same set. reviews.server.ts's storefront query is
  // `{ shop, productId, status: "PUBLISHED" }` with no provenance filter, so a
  // published QA-generated review is shown to shoppers — and therefore has to
  // be ordered like any other. (v1.20.1: v1.20.0 added `isSynthetic: false`
  // here, which silently emptied the curator for stores populated from the QA
  // generator. The public brand page is the one place that DOES exclude them,
  // deliberately, and that is unaffected.)
  const rows = await prisma.review.findMany({
    where: { shop, productId: String(productId), status: "PUBLISHED" },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      rating: true,
      title: true,
      body: true,
      language: true,
      verified: true,
      createdAt: true,
      variantTitle: true,
      helpfulCount: true,
      media: { select: { id: true }, take: 1 },
    },
  });
  if (rows.length === 0) return { candidates: [], localTexts: 0 };

  const foreignIds = rows.filter((r) => r.language !== locale).map((r) => r.id);
  const translations = foreignIds.length
    ? await prisma.translationCache.findMany({
        where: { reviewId: { in: foreignIds }, target: locale },
        select: { reviewId: true, title: true, body: true },
      })
    : [];
  const byReview = new Map<string, { title: string | null; body: string | null }>(
    translations.map((t) => [t.reviewId, { title: t.title, body: t.body }]),
  );

  // Skip the translation block entirely when the run is guaranteed to fail
  // no_reviews (< MIN_ORDER candidates) — never bill translations for a run
  // that can't produce a curation.
  let missingTranslations = 0;
  if (source === "all_translated" && rows.length >= MIN_ORDER) {
    const missing = foreignIds.filter((id) => !byReview.get(id)?.body);
    missingTranslations = missing.length;
    // Dry run (the cost estimate, SPEC-1.20 §0): count what WOULD be
    // translated and translate NOTHING — a preview must never bill the
    // merchant. Those reviews then fall through as marked-original below,
    // which is exactly how a real run treats an untranslatable review.
    if (options.translate !== false) {
      // translateReviews caps at 20 ids per call — chunk. Full bodies are
      // translated (and cached); the payload slice happens below.
      for (let i = 0; i < missing.length; i += 20) {
        try {
          const got = await translateReviews(shop, missing.slice(i, i + 20), locale);
          for (const [id, tr] of Object.entries(got)) {
            if (tr?.body) byReview.set(id, { title: tr.title ?? null, body: tr.body });
          }
        } catch (error) {
          console.error("[cellexia] curation translate-all chunk failed", error);
        }
      }
    }
  }

  let localTexts = 0;
  const built = rows.map((r) => {
    let title = r.title;
    let body = r.body;
    let textNote: string;
    if (r.language === locale) {
      textNote = "native";
      localTexts += 1;
    } else {
      const tr = byReview.get(r.id);
      if (tr && tr.body) {
        title = tr.title ?? r.title;
        body = tr.body;
        textNote = "translated";
        localTexts += 1;
      } else {
        textNote = r.language;
      }
    }
    return {
      candidate: {
        id: r.id,
        rating: r.rating,
        title,
        body,
        verified: r.verified,
        date: r.createdAt.toISOString().slice(0, 10),
        variant: r.variantTitle,
        hasMedia: r.media.length > 0,
        textNote,
      } satisfies CurationCandidate,
      rating: r.rating,
      helpfulCount: r.helpfulCount,
    };
  });

  const { candidates, trimmedFrom } = fitToBudget(built);
  return { candidates, localTexts, trimmedFrom, missingTranslations };
}

/**
 * Fits the candidate set inside MAX_PAYLOAD_TOKENS (SPEC-1.20 §1).
 *
 * Degrades in the spec's order: shorten bodies down the ladder first, and
 * only if that is still not enough drop reviews from the end of a COVERAGE
 * ordering — an interleave by rating band, so a trim keeps the full 1-5 star
 * spread instead of leaving the agent a wall of recent 5-star reviews. The
 * returned candidates stay in their natural (newest-first) order; coverage
 * ordering decides only what survives.
 */
function fitToBudget(
  built: Array<{ candidate: CurationCandidate; rating: number; helpfulCount: number }>,
): { candidates: CurationCandidate[]; trimmedFrom: number | null } {
  const sizeOf = (items: CurationCandidate[], bodyChars: number) =>
    items.reduce(
      (sum, c) => sum + approxTokens(JSON.stringify({ ...c, body: c.body.slice(0, bodyChars) })),
      0,
    );

  const all = built.map((b) => b.candidate);
  for (const bodyChars of BODY_CHAR_LADDER) {
    if (sizeOf(all, bodyChars) <= REVIEW_TOKEN_BUDGET) {
      return {
        candidates: all.map((c) => ({ ...c, body: c.body.slice(0, bodyChars) })),
        trimmedFrom: null,
      };
    }
  }

  // Still over budget at the tightest body length: drop by coverage order.
  const tightest = BODY_CHAR_LADDER[BODY_CHAR_LADDER.length - 1];
  const byBand = new Map<number, typeof built>();
  for (const item of built) {
    const band = byBand.get(item.rating) ?? [];
    band.push(item);
    byBand.set(item.rating, band);
  }
  for (const band of byBand.values()) {
    band.sort((a, b) => b.helpfulCount - a.helpfulCount);
  }
  // Round-robin across rating bands (5,4,3,2,1) so every band is represented.
  const bands = [5, 4, 3, 2, 1].map((r) => byBand.get(r) ?? []);
  const coverage: typeof built = [];
  for (let i = 0; coverage.length < built.length; i += 1) {
    let added = false;
    for (const band of bands) {
      if (i < band.length) {
        coverage.push(band[i]);
        added = true;
      }
    }
    if (!added) break;
  }

  const keptIds = new Set<string>();
  let used = 0;
  for (const item of coverage) {
    const trimmed = { ...item.candidate, body: item.candidate.body.slice(0, tightest) };
    const cost = approxTokens(JSON.stringify(trimmed));
    if (used + cost > REVIEW_TOKEN_BUDGET) break;
    used += cost;
    keptIds.add(item.candidate.id);
  }
  const candidates = all
    .filter((c) => keptIds.has(c.id))
    .map((c) => ({ ...c, body: c.body.slice(0, tightest) }));
  return { candidates, trimmedFrom: candidates.length < all.length ? all.length : null };
}

/**
 * Locales that get their OWN agent for this product (SPEC-1.17 §2).
 * Two queries total (reviews once, all cached translations once) — the
 * per-locale counts are derived in memory, never one query pair per locale.
 *
 * source "all_translated" (SPEC-1.18 §1): every storefront locale qualifies
 * (the whole point of the mode) — translation happens at curation time,
 * never here.
 */
export async function qualifyingLocales(
  shop: string,
  productId: string,
  source: CurationSource = "as_seen",
): Promise<string[]> {
  const rows = await prisma.review.findMany({
    // Same filter as buildCandidates: qualification must be decided on the
    // rows the agent will actually receive.
    where: { shop, productId: String(productId), status: "PUBLISHED" },
    orderBy: { createdAt: "desc" },
    select: { id: true, language: true },
  });
  // Fewer than MIN_ORDER reviews can never produce a curation — qualifying
  // nothing here keeps guaranteed no_reviews failures out of the queue, the
  // spend ceiling, and the failures banner.
  if (rows.length < MIN_ORDER) return [];
  if (source === "all_translated") return [...SHOP_LOCALES];
  const translations = await prisma.translationCache.findMany({
    where: { reviewId: { in: rows.map((r) => r.id) }, target: { in: [...SHOP_LOCALES] } },
    select: { reviewId: true, target: true, body: true },
  });
  const translated = new Set(
    translations.filter((t) => t.body).map((t) => `${t.reviewId}|${t.target}`),
  );
  const out: string[] = [];
  for (const locale of SHOP_LOCALES) {
    const localTexts = rows.filter(
      (r) => r.language === locale || translated.has(`${r.id}|${locale}`),
    ).length;
    if (locale === "en" || localTexts >= MIN_QUALIFYING_LOCAL_TEXTS) out.push(locale);
  }
  return out;
}

/* ------------------------------------------------------------------------- *
 * One agent run
 * ------------------------------------------------------------------------- */

export type CurationResult =
  | { status: "ok"; ordered: number }
  | { status: "no_ai" | "no_reviews" | "no_product" | "failed" | "over_budget" };

/**
 * v1.20 (SPEC-1.20 §4): the payload half of a curation run, shared by the
 * instant path and the Message Batches path so both send byte-identical
 * requests. Returns null with a status when the pair cannot be run at all.
 */
export interface CurationRequest {
  system: string;
  userContent: string;
  model: string;
  maxTokens: number;
  targetLocale: string;
  candidates: CurationCandidate[];
  trimmedFrom: number | null;
}

/**
 * Memo for one bulk operation. The product description and overview are the
 * SAME for all 17 locales, so without this a 40-product "Curate all" makes 680
 * identical Shopify Admin calls — slow enough to time the action out and
 * enough to hit Shopify's rate limit. Callers that loop over pairs create one
 * and pass it through; single runs pass nothing and fetch normally.
 */
export type ProductContextCache = Map<string, ProductContext>;

export async function buildCurationRequest(
  shop: string,
  admin: AdminClient,
  productId: string,
  locale: string,
  options: { translate?: boolean; contextCache?: ProductContextCache } = {},
): Promise<{ status: "ok"; request: CurationRequest } | { status: "no_ai" | "no_reviews" | "no_product" }> {
  const targetLocale = (SHOP_LOCALES as readonly string[]).includes(locale) ? locale : "en";
  const settings = await getSettings(shop);
  if (settings.aiProvider !== "anthropic" || !settings.anthropicApiKey) return { status: "no_ai" };

  const { candidates, trimmedFrom } = await buildCandidates(
    shop,
    productId,
    targetLocale,
    asCurationSource(settings.curationSource),
    { translate: options.translate !== false },
  );
  if (candidates.length < MIN_ORDER) return { status: "no_reviews" };

  const cached = options.contextCache?.get(productId);
  const context =
    cached ?? (await fetchProductContext(admin, productId, settings.curationOverviewField));
  if (!cached) options.contextCache?.set(productId, context);
  // A real product always has a title; a fully empty context means the Admin
  // API call failed (product deleted, transient error, or the app was
  // uninstalled while the task sat in the queue) — never call the model
  // blind on it. Distinct status so the admin banner explains it honestly.
  if (!context.title && !context.description) return { status: "no_product" };
  const guidance = (settings.curationInstructions ?? "").trim().slice(0, 1000);

  // NOTE: helpfulCount is deliberately absent from the payload (SPEC §0.3).
  const lines = candidates
    .map((c) =>
      JSON.stringify({
        id: c.id,
        rating: c.rating,
        title: c.title ?? undefined,
        body: c.body,
        verified: c.verified,
        date: c.date,
        variant: c.variant ?? undefined,
        hasMedia: c.hasMedia,
        textNote: c.textNote,
      }),
    )
    .join("\n");
  const userContent =
    `Product title: ${context.title}\n` +
    `Description:\n${context.description || "(none)"}\n\n` +
    `Overview:\n${context.overview || "(none)"}\n\n` +
    (guidance ? `Merchant guidance:\n${guidance}\n\n` : "") +
    `Reviews (${candidates.length}, one JSON object per line):\n${lines}`;

  return {
    status: "ok",
    request: {
      system: curationPromptFor(targetLocale),
      userContent,
      model: settings.aiModel,
      maxTokens: 2500,
      targetLocale,
      candidates,
      trimmedFrom: trimmedFrom ?? null,
    },
  };
}

/**
 * The products a curation run covers when the merchant has not named one.
 *
 * ONE definition, exported, because three callers need it — the cost preview,
 * "Run now" and "Run in the background" — and when they each wrote their own
 * copy they drifted: 1.20.0 narrowed some and not others, so the preview
 * priced a run that the batch path then refused. If this query ever changes,
 * it must keep matching the storefront query in reviews.server.ts, which is
 * what decides the set the curated order applies to.
 */
export async function curatableProductIds(shop: string): Promise<string[]> {
  const groups = await prisma.review.groupBy({
    by: ["productId"],
    where: { shop, status: "PUBLISHED" },
  });
  return groups.map((g) => g.productId);
}

/**
 * v1.20: rebuilds ONLY what validating a response needs — the candidate id set
 * and the trim figure. Used by the batch apply path, which runs up to 24 hours
 * after submission: it must not depend on the Shopify Admin API (a transient
 * Admin failure there would throw away a result the merchant has already paid
 * for) and must not re-translate (that would bill again for text the run
 * already has).
 */
export async function rebuildCurationTarget(
  shop: string,
  productId: string,
  locale: string,
): Promise<{ status: "ok"; request: CurationRequest } | { status: "no_reviews" }> {
  const targetLocale = (SHOP_LOCALES as readonly string[]).includes(locale) ? locale : "en";
  const settings = await getSettings(shop);
  const { candidates, trimmedFrom } = await buildCandidates(
    shop,
    productId,
    targetLocale,
    asCurationSource(settings.curationSource),
    { translate: false },
  );
  if (candidates.length < MIN_ORDER) return { status: "no_reviews" };
  return {
    status: "ok",
    request: {
      // Prompt and product context are irrelevant once the response exists;
      // only candidates/targetLocale/model/trimmedFrom are read from here.
      system: "",
      userContent: "",
      model: settings.aiModel,
      maxTokens: 0,
      targetLocale,
      candidates,
      trimmedFrom: trimmedFrom ?? null,
    },
  };
}

/**
 * v1.20: the validate-and-store half, shared by instant and batch results —
 * so a batch-produced curation is subject to exactly the same id validation,
 * MIN_ORDER floor and dash scrub as an instant one.
 */
export async function applyCurationResponse(
  shop: string,
  productId: string,
  request: CurationRequest,
  rawText: string,
  /** Batch results override these with the figures from SUBMIT time. */
  options: { sourceCount?: number; reviewCount?: number } = {},
): Promise<CurationResult> {
  const parsed = extractJson(rawText) as { order?: unknown; rationale?: unknown } | null;
  if (!parsed) return { status: "failed" };
  const validIds = new Set(request.candidates.map((c) => c.id));
  const order: string[] = [];
  if (Array.isArray(parsed.order)) {
    for (const id of parsed.order) {
      if (typeof id === "string" && validIds.has(id) && !order.includes(id)) order.push(id);
      if (order.length >= MAX_ORDER) break;
    }
  }
  if (order.length < MIN_ORDER) return { status: "failed" };
  const rationale = scrubDashes(
    typeof parsed.rationale === "string" ? parsed.rationale.trim().slice(0, 2000) : "",
    request.targetLocale,
  );

  const row = {
    orderedIds: JSON.stringify(order),
    rationale,
    model: request.model,
    // Both numbers must come from the SAME moment, or a batch applied after a
    // review was deleted would show a trim ("read 7 of 8") that never
    // happened.
    reviewCount: options.reviewCount ?? request.candidates.length,
    // The staleness anchor is what was PUBLISHED, not what was read. Without
    // the distinction a trimmed run is stale the instant it completes, and
    // the auto-refresh sweep re-bills the biggest product every window.
    sourceCount:
      options.sourceCount ?? request.trimmedFrom ?? request.candidates.length,
  };
  await prisma.aiCuration.upsert({
    where: {
      shop_productId_locale: { shop, productId: String(productId), locale: request.targetLocale },
    },
    update: row,
    create: { shop, productId: String(productId), locale: request.targetLocale, ...row },
  });
  return { status: "ok", ordered: order.length };
}

export async function curateProductLocale(
  shop: string,
  admin: AdminClient,
  productId: string,
  locale: string,
): Promise<CurationResult> {
  // Check the ceiling BEFORE assembling. Assembly can translate, and
  // translation is billed to the same key — so a shop already at its limit
  // must be turned away here, not after it has paid for translations it will
  // not get to use. The precise check against this run's own cost follows.
  const preflight = await checkBudget(shop, 0);
  if (!preflight.ok) return { status: "over_budget" };

  const built = await buildCurationRequest(shop, admin, productId, locale);
  if (built.status !== "ok") return { status: built.status };
  const { request } = built;

  const settings = await getSettings(shop);
  const apiKey = settings.anthropicApiKey;
  if (!apiKey) return { status: "no_ai" };

  // v1.20 (SPEC-1.20 §3): refuse rather than overspend. The estimate uses the
  // measured payload; actual spend is recorded from billed usage below.
  const estimated = costUsd({
    model: request.model,
    inputTokens: approxTokens(request.system + request.userContent),
    outputTokens: OUTPUT_TOKENS_PER_CALL,
  });
  const budget = await checkBudget(shop, estimated ?? 0);
  if (!budget.ok) return { status: "over_budget" };

  const result = await callClaudeWithUsage(
    apiKey,
    request.model,
    request.system,
    request.userContent,
    request.maxTokens,
  );
  if (!result) return { status: "failed" };
  await recordSpend(shop, request.model, result.usage, false);
  if (!result.text) return { status: "failed" };

  return applyCurationResponse(shop, productId, request, result.text);
}


/* ------------------------------------------------------------------------- *
 * Spend ceiling (SPEC-1.20 §3) — replaces the old 300/day cap
 * ------------------------------------------------------------------------- */

/** Measured average output of a curation call (order + rationale). */
export const OUTPUT_TOKENS_PER_CALL = 900;

/**
 * The ledger itself lives in spend.server so translate.server can record its
 * own billed usage without a circular import. Re-exported here because every
 * curation caller already reaches for it through this module.
 */
export { checkBudget, recordSpend };

/* ------------------------------------------------------------------------- *
 * Queue (admin-triggered only)
 * ------------------------------------------------------------------------- */

const debounceMap = new Map<string, number>();
let inFlight = 0;
const queue: Array<{ shop: string; admin: AdminClient; productId: string; locale: string }> = [];
/** Keys currently queued or in flight — blocks double-queueing a pair that
 * has sat in the queue longer than the debounce window. */
const pendingKeys = new Set<string>();
/** Last time a run STARTED per key, success or not — the auto-refresh sweep
 * uses this so failing pairs are retried once per refresh window, never once
 * per hourly sweep (AiCuration.updatedAt only advances on success). */
const lastAttemptMap = new Map<string, number>();

export function lastCurationAttempt(shop: string, productId: string, locale: string): number {
  return lastAttemptMap.get(`${shop}|${productId}|${locale}`) ?? 0;
}



/** Recent non-ok runs per shop so the admin card can show them (in-process). */
const recentFailures = new Map<string, Array<{ productId: string; locale: string; status: string; at: number }>>();
const FAILURE_TTL_MS = 24 * 60 * 60 * 1000;

function recordFailure(shop: string, productId: string, locale: string, status: string): void {
  // One entry per (product, locale): a repeat failure replaces the old one.
  const list = (recentFailures.get(shop) ?? []).filter(
    (f) => !(f.productId === productId && f.locale === locale),
  );
  list.unshift({ productId, locale, status, at: Date.now() });
  recentFailures.set(shop, list.slice(0, 20));
}

/** A later successful run removes the stale warning for that (product, locale). */
function clearFailure(shop: string, productId: string, locale: string): void {
  const list = recentFailures.get(shop);
  if (!list) return;
  const next = list.filter((f) => !(f.productId === productId && f.locale === locale));
  if (next.length > 0) recentFailures.set(shop, next);
  else recentFailures.delete(shop);
}

/**
 * v1.20: lets the batch path record a failed (product, locale) into the same
 * recent-failures list instant runs use, and clear its debounce stamp so the
 * merchant can retry immediately — identical semantics to an instant failure.
 */
export function recordExternalFailure(
  shop: string,
  productId: string,
  locale: string,
  status: string,
): void {
  recordFailure(shop, productId, locale, status);
  debounceMap.delete(`${shop}|${productId}|${locale}`);
}

export function recentCurationFailures(shop: string) {
  const cutoff = Date.now() - FAILURE_TTL_MS;
  return (recentFailures.get(shop) ?? []).filter((f) => f.at > cutoff);
}

function pump(): void {
  while (inFlight < CURATION_CONCURRENCY && queue.length > 0) {
    const task = queue.shift();
    if (!task) return;
    const key = `${task.shop}|${task.productId}|${task.locale}`;
    inFlight += 1;
    void curateProductLocale(task.shop, task.admin, task.productId, task.locale)
      .then((result) => {
        if (result.status === "ok") {
          clearFailure(task.shop, task.productId, task.locale);
        } else {
          recordFailure(task.shop, task.productId, task.locale, result.status);
          // A failed run must be retryable right away — the debounce guards
          // against redundant re-runs of a SUCCESSFUL curation, not retries.
          debounceMap.delete(key);
        }
      })
      .catch((error) => {
        console.error("[cellexia] curation task failed", error);
        recordFailure(task.shop, task.productId, task.locale, "failed");
        debounceMap.delete(key);
      })
      .finally(() => {
        pendingKeys.delete(key);
        inFlight = Math.max(0, inFlight - 1);
        pump();
      });
  }
}

export interface QueueSummary {
  queued: number;
  skippedDebounce: number;
  /** Pairs not queued because the shop's spend ceiling is already reached. */
  skippedCap: number;
  /** Set when the ceiling blocked the run, so the admin can say so exactly. */
  budget?: { spent: number; ceiling: number };
  products: number;
  /** false ⇒ no Claude key configured; nothing was queued. */
  aiReady: boolean;
}

/**
 * Queues curation for the given products (or every product with published
 * reviews) across their qualifying locales. Returns what was queued vs
 * skipped so the admin can show honest numbers.
 */
export async function queueCuration(
  shop: string,
  admin: AdminClient,
  productIds?: string[],
): Promise<QueueSummary> {
  // Pre-check the key so a misconfigured shop gets an honest "not queued"
  // instead of runs that silently die as no_ai inside the pump.
  const settings = await getSettings(shop);
  if (settings.aiProvider !== "anthropic" || !settings.anthropicApiKey) {
    return { queued: 0, skippedDebounce: 0, skippedCap: 0, products: 0, aiReady: false };
  }
  let ids = productIds;
  if (!ids || ids.length === 0) ids = await curatableProductIds(shop);
  const summary: QueueSummary = { queued: 0, skippedDebounce: 0, skippedCap: 0, products: ids.length, aiReady: true };
  const budget = await checkBudget(shop, 0);
  if (!budget.ok && budget.ceiling != null) {
    summary.budget = { spent: budget.spent, ceiling: budget.ceiling };
  }
  const source = asCurationSource(settings.curationSource);
  const now = Date.now();
  for (const productId of ids) {
    const locales = await qualifyingLocales(shop, productId, source);
    enqueuePairs(shop, admin, locales.map((locale) => ({ productId, locale })), summary, now, !budget.ok);
  }
  pump();
  return summary;
}

/** Shared debounce/cap/push loop for queueCuration and queueCurationPairs. */
function enqueuePairs(
  shop: string,
  admin: AdminClient,
  pairs: Array<{ productId: string; locale: string }>,
  summary: QueueSummary,
  now: number,
  budgetExhausted = false,
): void {
  for (const { productId, locale } of pairs) {
    if (!(SHOP_LOCALES as readonly string[]).includes(locale)) continue;
    const key = `${shop}|${productId}|${locale}`;
    // Already queued or running (possibly longer than the debounce window,
    // e.g. a big bulk run draining slowly) — never double-queue.
    if (pendingKeys.has(key) || (debounceMap.get(key) ?? 0) > now - DEBOUNCE_MS) {
      summary.skippedDebounce += 1;
      continue;
    }
    if (budgetExhausted) {
      summary.skippedCap += 1;
      continue;
    }
    if (debounceMap.size > 5000) {
      for (const [k, v] of debounceMap) if (v <= now - DEBOUNCE_MS) debounceMap.delete(k);
    }
    debounceMap.set(key, now);
    pendingKeys.add(key);
    // Attempt stamped at ENQUEUE (not task start) so a sweep's due-filter can
    // never see a queued-but-unstarted (or just-fast-failed) pair as due —
    // for the 24h/7d windows the enqueue/start difference is irrelevant.
    lastAttemptMap.set(key, now);
    if (lastAttemptMap.size > 5000) {
      const cutoff = now - 8 * 24 * 60 * 60 * 1000; // > the longest window
      for (const [k, v] of lastAttemptMap) if (v < cutoff) lastAttemptMap.delete(k);
    }
    queue.push({ shop, admin, productId, locale });
    summary.queued += 1;
  }
}

/**
 * v1.18 (SPEC-1.18 §2): pair-precise queueing for the auto-refresh sweep —
 * re-queues exactly the given (product, locale) pairs (the sweep's stale
 * set), never fresh sibling locales. Same queue, cap, debounce, failure
 * recording and pump as manual runs.
 */
export async function queueCurationPairs(
  shop: string,
  admin: AdminClient,
  pairs: Array<{ productId: string; locale: string }>,
): Promise<QueueSummary> {
  const settings = await getSettings(shop);
  if (settings.aiProvider !== "anthropic" || !settings.anthropicApiKey) {
    return { queued: 0, skippedDebounce: 0, skippedCap: 0, products: 0, aiReady: false };
  }
  const summary: QueueSummary = {
    queued: 0,
    skippedDebounce: 0,
    skippedCap: 0,
    products: new Set(pairs.map((p) => p.productId)).size,
    aiReady: true,
  };
  const budget = await checkBudget(shop, 0);
  if (!budget.ok && budget.ceiling != null) {
    summary.budget = { spent: budget.spent, ceiling: budget.ceiling };
  }
  enqueuePairs(shop, admin, pairs, summary, Date.now(), !budget.ok);
  pump();
  return summary;
}

/** Admin status rows: every stored curation for the shop (+staleness data). */
export async function curationStatus(shop: string) {
  const rows = await prisma.aiCuration.findMany({
    where: { shop },
    orderBy: [{ productId: "asc" }, { locale: "asc" }],
  });
  const counts = await prisma.review.groupBy({
    by: ["productId"],
    // Must match buildCandidates' filter exactly, or every product would read
    // as permanently stale.
    where: { shop, status: "PUBLISHED" },
    _count: { _all: true },
    _max: { createdAt: true },
  });
  const statsByProduct = new Map(
    counts.map((c) => [c.productId, { count: c._count._all, newest: c._max.createdAt }]),
  );
  return rows.map((row) => {
    let ordered = 0;
    try {
      const parsed = JSON.parse(row.orderedIds);
      ordered = Array.isArray(parsed) ? parsed.length : 0;
    } catch {
      ordered = 0;
    }
    const stats = statsByProduct.get(row.productId);
    const publishedNow = stats?.count ?? 0;
    const newest = stats?.newest ?? null;
    // Rows written before 1.20.0 have no sourceCount; for them the count the
    // agent read IS the count that was published, so it is the right anchor.
    const sourceCount = row.sourceCount || row.reviewCount;
    return {
      productId: row.productId,
      locale: row.locale,
      ordered,
      reviewCount: row.reviewCount,
      // How many were published when this ran — non-null only when the
      // payload had to be trimmed, i.e. when the agent read fewer than all.
      readOf: sourceCount > row.reviewCount ? sourceCount : null,
      publishedNow,
      // v1.20: no candidate cap any more, so the published count compares
      // directly — against what was PUBLISHED at run time, so a trimmed run
      // is not born stale. Either signal marks the row stale: the count
      // moved, or a review was published after this curation ran.
      stale:
        publishedNow !== sourceCount ||
        (newest !== null && newest.getTime() > row.updatedAt.getTime()),
      rationale: row.rationale,
      model: row.model,
      updatedAt: row.updatedAt,
    };
  });
}

/** Serve-time accessor: curated ids for (product, locale), en fallback. */
export async function curatedOrder(
  shop: string,
  productId: string,
  locale: string | undefined,
): Promise<string[] | null> {
  const tryLocales = [locale, "en"].filter(
    (l, i, arr): l is string => typeof l === "string" && arr.indexOf(l) === i,
  );
  for (const l of tryLocales) {
    const row = await prisma.aiCuration.findUnique({
      where: { shop_productId_locale: { shop, productId: String(productId), locale: l } },
    });
    if (!row) continue;
    try {
      const parsed = JSON.parse(row.orderedIds);
      if (Array.isArray(parsed) && parsed.length >= MIN_ORDER) {
        return parsed.filter((id): id is string => typeof id === "string");
      }
    } catch {
      /* fall through to next locale */
    }
  }
  return null;
}
