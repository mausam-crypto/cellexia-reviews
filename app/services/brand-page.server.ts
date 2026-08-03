/**
 * Cellexia Reviews — the "Cellexia Reviews" brand page engine (SPEC-1.19).
 *
 * Three jobs:
 *  1. computeBrandPageFacts(shop) — every number on the page, computed
 *     deterministically from the DB (the model NEVER invents a number).
 *     Synthetic QA reviews are excluded from EVERY query on this surface.
 *  2. generateBrandAnalysis(shop) — admin-triggered Claude prose around the
 *     facts, with verbatim-quote verification (≥ 40-char substring, same
 *     rule as Q&A); failed quotes are dropped, never invented.
 *  3. buildBrandPagePayload / publishBrandPage — assembles the
 *     `cellexia.brand_page` SHOP metafield (≤ 60,000 bytes enforced) that
 *     blocks/reviews-page.liquid SSRs, and writes it via metafieldsSet.
 *     scheduleBrandPagePublish debounces auto-refresh on moderation changes
 *     (same pattern as scheduleShopRatingSync).
 *
 * liquidSafe() lives here too: the archive proxy responds with
 * `application/liquid`, so user content must be HTML-escaped AND
 * Liquid-neutralized before interpolation ({{ or {% in a review body would
 * otherwise EXECUTE in the theme context).
 */
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

import prisma from "~/db.server";
import {
  AGE_RANGES,
  RESULTS_SEEN,
  SKIN_CONCERNS,
  TIME_USING,
} from "~/types/cellexia";
import { callClaude, extractJson } from "./ai.server";
import { BRAND_ANALYSIS_PROMPT, buildAnalysisUserContent } from "./brand-analysis-prompt.server";
import { getSettings } from "./settings.server";
import { scrubDashes } from "./synthetic-prompts.server";

type AdminClient = Pick<AdminApiContext, "graphql">;

export const BRAND_PAGE_METAFIELD_KEY = "brand_page";
const NAMESPACE = "cellexia";
export const MAX_PAGE_REVIEWS = 36;
const PER_PRODUCT_REVIEW_CAP = 6;
const MIN_CRITICAL_ON_PAGE = 4;
const BODY_EXCERPT_CHARS = 600;
const REPLY_EXCERPT_CHARS = 300;
export const MAX_METAFIELD_BYTES = 60_000;
const CONCERN_WINNER_MIN_REVIEWS = 3;
const MAX_PRODUCTS_ON_PAGE = 120;
const ANALYSIS_CORPUS_MAX = 60;
const ANALYSIS_CRITICAL_MIN = 10;

/* ------------------------------------------------------------------------- *
 * English label maps — the page's SEO language. The SSR section localizes
 * its LABELS via Liquid t:; these maps serve the archive pages and the
 * analysis prompt, which render server-side English.
 * ------------------------------------------------------------------------- */

export const CONCERN_LABELS: Record<string, string> = {
  fine_lines: "Fine lines & wrinkles",
  dark_spots: "Dark spots",
  dryness: "Dryness",
  dullness: "Dullness",
  firmness: "Loss of firmness",
  texture: "Uneven texture",
  sensitivity: "Sensitivity",
  redness: "Redness",
  pores: "Visible pores",
  dark_circles: "Dark circles",
};

export const RESULT_LABELS: Record<string, string> = {
  smoother: "Smoother texture",
  fewer_lines: "Fewer fine lines",
  firmer: "Firmer skin",
  radiance: "More radiance",
  even_tone: "More even tone",
  hydration: "Better hydration",
  calmer: "Calmer skin",
  too_early: "Too early to tell",
};

export const TIME_LABELS: Record<string, string> = {
  lt_1w: "Under 1 week",
  w1_4: "1–4 weeks",
  m1_3: "1–3 months",
  m3_6: "3–6 months",
  gt_6m: "Over 6 months",
};

/** Keys are the real AGE_RANGES values (app/types/cellexia.ts). */
export const AGE_LABELS: Record<string, string> = {
  under_25: "Under 25",
  "25_34": "25 to 34",
  "35_44": "35 to 44",
  "45_54": "45 to 54",
  "55_64": "55 to 64",
  "65_plus": "65 and over",
};

export const SOURCE_LABELS: Record<string, string> = {
  storefront: "Verified review collected on our store",
  "csv-import": "Imported from our previous review platform",
  "bulk-add": "Added by our team from direct customer feedback",
};

/* ------------------------------------------------------------------------- *
 * liquidSafe — HTML-escape + Liquid-neutralize user content (SPEC-1.19 §8)
 * ------------------------------------------------------------------------- */

export function liquidSafe(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // Liquid tokens: neutralize EVERY brace, not just matched pairs. A
    // pair-wise replacement whose output ends in "{" lets a third brace
    // re-form a live token ("{{{x}}}" → "&#123;{{x}}}"), which Shopify would
    // then EXECUTE (this response is served as application/liquid). Escaping
    // each brace individually has no such re-forming case; both render as
    // literal braces in the browser.
    .replace(/\{/g, "&#123;")
    .replace(/\}/g, "&#125;");
}

/**
 * Embeds a JSON blob inside a <script> tag in a Liquid-rendered response.
 * `</script>` inside any string value would end the element early (JSON
 * escaping does not cover `<`), and raw braces would be interpreted as
 * Liquid — both are neutralized with JSON string escapes, which parsers
 * decode back to the original characters.
 */
export function jsonLdSafe(value: unknown): string {
  // Braces are neutralized INSIDE string values only — the structural braces
  // of the JSON must survive. (JSON.stringify never emits "{{" or "{%"
  // structurally: an object brace is always followed by a quote or a closing
  // brace, so only string content can form a Liquid token.)
  // Braces inside strings become control sentinels, which JSON.stringify
  // emits as  /  escapes; those are rewritten below to { /
  // }. The SERIALIZED text therefore contains no literal brace from user
  // content (Liquid sees nothing to execute) while JSON.parse still returns
  // the original characters — lossless, unlike inserting a marker character.
  const scrub = (input: unknown): unknown => {
    if (typeof input === "string") {
      return input.replace(/\{/g, "\u0001").replace(/\}/g, "\u0002");
    }
    if (Array.isArray(input)) return input.map(scrub);
    if (input && typeof input === "object") {
      const out: Record<string, unknown> = {};
      // KEYS are scrubbed too: a key built from user data (a product handle,
      // a review id) would otherwise emit a live Liquid token.
      for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
        out[scrub(k) as string] = scrub(v);
      }
      return out;
    }
    return input;
  };
  // `<` and `>` only ever occur inside string values, so escaping them
  // globally is safe and stops `</script>` from ending the element early.
  return JSON.stringify(scrub(value))
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\\u0001/g, "\\u007b")
    .replace(/\\u0002/g, "\\u007d");
}

/* ------------------------------------------------------------------------- *
 * Facts (deterministic — SPEC-1.19 §4/§6)
 * ------------------------------------------------------------------------- */

interface FactRow {
  id: string;
  rating: number;
  verified: boolean;
  createdAt: Date;
  productId: string;
  productTitle: string | null;
  productHandle: string | null;
  skinConcerns: string;
  timeUsing: string | null;
  resultsSeen: string;
  source: string | null;
}

export interface BrandPageFacts {
  average: number;
  count: number;
  verifiedPercent: number;
  /** stars "5".."1" → { count, percent } — percents sum to 100 (largest remainder). */
  distribution: Record<string, { count: number; percent: number }>;
  dateFrom: string | null; // ISO date
  dateTo: string | null;
  sources: Array<{ key: string; label: string; count: number }>;
  criticalCount: number; // ≤ 3★
  criticalPercent: number;
  results: Array<{ key: string; label: string; count: number; percent: number }>;
  /** Among reviews reporting a concrete result: how long they had used the product. */
  timeToResults: Array<{ key: string; label: string; count: number; percent: number }>;
  products: Array<{
    productId: string;
    handle: string | null;
    title: string | null;
    average: number;
    count: number;
  }>;
  concernWinners: Array<{
    concern: string;
    label: string;
    mentions: number;
    productId: string;
    handle: string | null;
    title: string | null;
    average: number;
    count: number; // reviews mentioning the concern for that product
  }>;
}

function parseKeys(raw: string, allowed: readonly string[]): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((k): k is string => typeof k === "string" && allowed.includes(k));
  } catch {
    return [];
  }
}

/** Largest-remainder integer percents that always sum to 100 (or all-zero). */
function largestRemainderPercents(counts: number[]): number[] {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return counts.map(() => 0);
  const exact = counts.map((c) => (c * 100) / total);
  const floors = exact.map(Math.floor);
  let remainder = 100 - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  const out = [...floors];
  for (const { i } of order) {
    if (remainder <= 0) break;
    out[i] += 1;
    remainder -= 1;
  }
  return out;
}

const PUBLIC_WHERE = { status: "PUBLISHED", isSynthetic: false } as const;

export async function computeBrandPageFacts(shop: string): Promise<BrandPageFacts> {
  const rows: FactRow[] = await prisma.review.findMany({
    where: { shop, ...PUBLIC_WHERE },
    select: {
      id: true,
      rating: true,
      verified: true,
      createdAt: true,
      productId: true,
      productTitle: true,
      productHandle: true,
      skinConcerns: true,
      timeUsing: true,
      resultsSeen: true,
      source: true,
    },
  });

  const count = rows.length;
  const empty: BrandPageFacts = {
    average: 0,
    count: 0,
    verifiedPercent: 0,
    distribution: { "5": z(), "4": z(), "3": z(), "2": z(), "1": z() },
    dateFrom: null,
    dateTo: null,
    sources: [],
    criticalCount: 0,
    criticalPercent: 0,
    results: [],
    timeToResults: [],
    products: [],
    concernWinners: [],
  };
  function z() {
    return { count: 0, percent: 0 };
  }
  if (count === 0) return empty;

  const starCounts = [0, 0, 0, 0, 0]; // index 0 = 1★
  let ratingSum = 0;
  let verifiedCount = 0;
  let minDate = rows[0].createdAt;
  let maxDate = rows[0].createdAt;
  const sourceCounts = new Map<string, number>();
  const resultCounts = new Map<string, number>();
  const timeToResultCounts = new Map<string, number>();
  let reviewsWithResults = 0;
  let reviewsWithResultsAndTime = 0;
  const perProduct = new Map<
    string,
    { handle: string | null; title: string | null; sum: number; count: number }
  >();
  // concern → productId → {sumRating, count}
  const perConcernProduct = new Map<string, Map<string, { sum: number; count: number }>>();
  const concernMentions = new Map<string, number>();

  for (const r of rows) {
    starCounts[r.rating - 1] += 1;
    ratingSum += r.rating;
    if (r.verified) verifiedCount += 1;
    if (r.createdAt < minDate) minDate = r.createdAt;
    if (r.createdAt > maxDate) maxDate = r.createdAt;
    const src = r.source ?? "storefront";
    sourceCounts.set(src, (sourceCounts.get(src) ?? 0) + 1);

    const results = parseKeys(r.resultsSeen, RESULTS_SEEN);
    for (const key of results) resultCounts.set(key, (resultCounts.get(key) ?? 0) + 1);
    const concrete = results.filter((k) => k !== "too_early");
    if (concrete.length > 0) {
      reviewsWithResults += 1;
      if (r.timeUsing && (TIME_USING as readonly string[]).includes(r.timeUsing)) {
        reviewsWithResultsAndTime += 1;
        timeToResultCounts.set(r.timeUsing, (timeToResultCounts.get(r.timeUsing) ?? 0) + 1);
      }
    }

    const product = perProduct.get(r.productId) ?? {
      handle: r.productHandle,
      title: r.productTitle,
      sum: 0,
      count: 0,
    };
    product.sum += r.rating;
    product.count += 1;
    if (!product.handle && r.productHandle) product.handle = r.productHandle;
    if (!product.title && r.productTitle) product.title = r.productTitle;
    perProduct.set(r.productId, product);

    for (const concern of parseKeys(r.skinConcerns, SKIN_CONCERNS)) {
      concernMentions.set(concern, (concernMentions.get(concern) ?? 0) + 1);
      const productMap = perConcernProduct.get(concern) ?? new Map();
      const cp = productMap.get(r.productId) ?? { sum: 0, count: 0 };
      cp.sum += r.rating;
      cp.count += 1;
      productMap.set(r.productId, cp);
      perConcernProduct.set(concern, productMap);
    }
  }

  const starPercents = largestRemainderPercents([...starCounts].reverse()); // 5★ first
  const distribution: BrandPageFacts["distribution"] = {};
  for (let star = 5; star >= 1; star -= 1) {
    distribution[String(star)] = {
      count: starCounts[star - 1],
      percent: starPercents[5 - star],
    };
  }

  const criticalCount = starCounts[0] + starCounts[1] + starCounts[2];

  const products = [...perProduct.entries()]
    .map(([productId, p]) => ({
      productId,
      handle: p.handle,
      title: p.title,
      average: Math.round((p.sum / p.count) * 10) / 10,
      count: p.count,
    }))
    .sort((a, b) => b.count - a.count || a.productId.localeCompare(b.productId))
    // Most-reviewed first, capped: an unbounded catalog would otherwise fill
    // the metafield by itself and the size gate would strip every review card
    // (the archive stays browsable by product regardless).
    .slice(0, MAX_PRODUCTS_ON_PAGE);

  const concernWinners: BrandPageFacts["concernWinners"] = [];
  for (const concern of SKIN_CONCERNS) {
    const productMap = perConcernProduct.get(concern);
    if (!productMap) continue;
    let best: { productId: string; sum: number; count: number } | null = null;
    for (const [productId, cp] of productMap) {
      if (cp.count < CONCERN_WINNER_MIN_REVIEWS) continue;
      if (
        !best ||
        cp.sum / cp.count > best.sum / best.count ||
        (cp.sum / cp.count === best.sum / best.count && cp.count > best.count)
      ) {
        best = { productId, ...cp };
      }
    }
    if (!best) continue;
    const info = perProduct.get(best.productId);
    concernWinners.push({
      concern,
      label: CONCERN_LABELS[concern] ?? concern,
      mentions: concernMentions.get(concern) ?? 0,
      productId: best.productId,
      handle: info?.handle ?? null,
      title: info?.title ?? null,
      average: Math.round((best.sum / best.count) * 10) / 10,
      count: best.count,
    });
  }
  concernWinners.sort((a, b) => b.mentions - a.mentions);

  const resultsOut = RESULTS_SEEN.filter((k) => resultCounts.has(k)).map((key) => ({
    key,
    label: RESULT_LABELS[key] ?? key,
    count: resultCounts.get(key) ?? 0,
    percent: Math.round(((resultCounts.get(key) ?? 0) * 100) / count),
  }));
  const timeToResults = TIME_USING.filter((k) => timeToResultCounts.has(k)).map((key) => ({
    key,
    label: TIME_LABELS[key] ?? key,
    count: timeToResultCounts.get(key) ?? 0,
    percent:
      reviewsWithResultsAndTime > 0
        ? Math.round(((timeToResultCounts.get(key) ?? 0) * 100) / reviewsWithResultsAndTime)
        : 0,
  }));

  return {
    average: Math.round((ratingSum / count) * 10) / 10,
    count,
    verifiedPercent: Math.round((verifiedCount * 100) / count),
    distribution,
    dateFrom: minDate.toISOString().slice(0, 10),
    dateTo: maxDate.toISOString().slice(0, 10),
    sources: [...sourceCounts.entries()]
      .map(([key, n]) => ({ key, label: SOURCE_LABELS[key] ?? "Other", count: n }))
      .sort((a, b) => b.count - a.count),
    criticalCount,
    criticalPercent: Math.round((criticalCount * 100) / count),
    results: resultsOut,
    timeToResults,
    products,
    concernWinners,
  };
}

/* ------------------------------------------------------------------------- *
 * Analysis (SPEC-1.19 §4)
 * ------------------------------------------------------------------------- */

export const ANALYSIS_SECTION_KEYS = [
  "positive",
  "results",
  "complaints",
  "byConcern",
  "timeline",
] as const;
export type AnalysisSectionKey = (typeof ANALYSIS_SECTION_KEYS)[number];

export interface AnalysisQuote {
  id: string;
  excerpt: string;
  author: string;
  rating: number;
  productTitle: string | null;
  productHandle: string | null;
  date: string;
}

export interface AnalysisSections {
  sections: Record<AnalysisSectionKey, { prose: string; quotes: AnalysisQuote[] }>;
}

export type AnalysisResult =
  | { status: "ok"; sections: AnalysisSections; reviewCount: number }
  | { status: "no_ai" | "no_reviews" | "failed" };

interface AnalysisCorpusRow {
  id: string;
  rating: number;
  title: string | null;
  body: string;
  authorName: string;
  verified: boolean;
  createdAt: Date;
  productTitle: string | null;
  productHandle: string | null;
  skinConcerns: string;
  timeUsing: string | null;
  resultsSeen: string;
}

async function loadAnalysisCorpus(shop: string): Promise<AnalysisCorpusRow[]> {
  const sel = {
    id: true,
    rating: true,
    title: true,
    body: true,
    authorName: true,
    verified: true,
    createdAt: true,
    productTitle: true,
    productHandle: true,
    skinConcerns: true,
    timeUsing: true,
    resultsSeen: true,
  };
  const top = await prisma.review.findMany({
    where: { shop, ...PUBLIC_WHERE },
    orderBy: [{ helpfulCount: "desc" }, { verified: "desc" }, { createdAt: "desc" }],
    take: ANALYSIS_CORPUS_MAX,
    select: sel,
  });
  // Ground the "Common complaints" section: guarantee critical reviews are
  // present even when the top slice is all-positive.
  const criticalIn = top.filter((r) => r.rating <= 3).length;
  if (criticalIn >= ANALYSIS_CRITICAL_MIN) return top;
  const extraCritical = await prisma.review.findMany({
    where: {
      shop,
      ...PUBLIC_WHERE,
      rating: { lte: 3 },
      id: { notIn: top.map((r) => r.id) },
    },
    orderBy: [{ helpfulCount: "desc" }, { createdAt: "desc" }],
    take: ANALYSIS_CRITICAL_MIN - criticalIn,
    select: sel,
  });
  if (extraCritical.length === 0) return top;
  // Swap the tail of the positive slice for the critical rows.
  const keep = top.slice(0, Math.max(0, ANALYSIS_CORPUS_MAX - extraCritical.length));
  return [...keep, ...extraCritical];
}

export async function generateBrandAnalysis(shop: string): Promise<AnalysisResult> {
  const settings = await getSettings(shop);
  if (settings.aiProvider !== "anthropic" || !settings.anthropicApiKey) return { status: "no_ai" };

  const facts = await computeBrandPageFacts(shop);
  if (facts.count === 0) return { status: "no_reviews" };
  const corpus = await loadAnalysisCorpus(shop);
  if (corpus.length === 0) return { status: "no_reviews" };

  const raw = await callClaude(
    settings.anthropicApiKey,
    settings.aiModel,
    BRAND_ANALYSIS_PROMPT,
    buildAnalysisUserContent(facts, corpus),
    4000,
  );
  if (!raw) return { status: "failed" };
  const parsed = extractJson(raw) as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== "object") return { status: "failed" };

  const byId = new Map(corpus.map((r) => [r.id, r]));
  const sections = {} as AnalysisSections["sections"];
  for (const key of ANALYSIS_SECTION_KEYS) {
    const rawSection = parsed[key] as { prose?: unknown; quotes?: unknown } | undefined;
    const prose = scrubDashes(
      typeof rawSection?.prose === "string" ? rawSection.prose.trim().slice(0, 1600) : "",
      "en",
    );
    if (!prose) return { status: "failed" }; // every section must exist
    const quotes: AnalysisQuote[] = [];
    if (Array.isArray(rawSection?.quotes)) {
      for (const entry of rawSection.quotes) {
        if (quotes.length >= 3) break;
        if (!entry || typeof entry !== "object") continue;
        const q = entry as Record<string, unknown>;
        if (typeof q.id !== "string" || typeof q.excerpt !== "string") continue;
        const review = byId.get(q.id);
        if (!review) continue;
        const excerpt = q.excerpt.trim().slice(0, 300);
        // Verbatim rule (SPEC-1.19 §4): ≥ 40 chars, exact substring of body
        // or title — fabricated/paraphrased quotes are dropped.
        if (excerpt.length < 40) continue;
        if (!review.body.includes(excerpt) && !(review.title ?? "").includes(excerpt)) continue;
        quotes.push({
          id: review.id,
          excerpt,
          author: review.authorName,
          rating: review.rating,
          productTitle: review.productTitle,
          productHandle: review.productHandle,
          date: review.createdAt.toISOString().slice(0, 10),
        });
      }
    }
    sections[key] = { prose, quotes };
  }

  const payload: AnalysisSections = { sections };
  await prisma.brandAnalysis.upsert({
    where: { shop },
    update: {
      sections: JSON.stringify(payload),
      reviewCount: facts.count,
      dateFrom: facts.dateFrom ? new Date(facts.dateFrom) : null,
      dateTo: facts.dateTo ? new Date(facts.dateTo) : null,
      model: settings.aiModel,
    },
    create: {
      shop,
      sections: JSON.stringify(payload),
      reviewCount: facts.count,
      dateFrom: facts.dateFrom ? new Date(facts.dateFrom) : null,
      dateTo: facts.dateTo ? new Date(facts.dateTo) : null,
      model: settings.aiModel,
    },
  });
  return { status: "ok", sections: payload, reviewCount: facts.count };
}

/* ------------------------------------------------------------------------- *
 * Page payload + publish (SPEC-1.19 §6)
 * ------------------------------------------------------------------------- */

export interface BrandPageReviewEntry {
  id: string;
  rating: number;
  title: string | null;
  body: string;
  author: string;
  date: string;
  verified: boolean;
  language: string;
  productId: string;
  productTitle: string | null;
  productHandle: string | null;
  concerns: string[];
  ageRange: string | null;
  timeUsing: string | null;
  results: string[];
  source: string;
  reply: string | null;
}

export interface BrandPagePayload {
  publishedAt: string;
  facts: BrandPageFacts;
  analysis: {
    sections: AnalysisSections["sections"];
    generatedAt: string;
    reviewCount: number;
  } | null;
  reviews: BrandPageReviewEntry[];
  /** Feature toggles for the interactive layer (SPEC-1.19 §9). */
  config: BrandPageConfig;
}

function toEntry(r: {
  id: string;
  rating: number;
  title: string | null;
  body: string;
  authorName: string;
  createdAt: Date;
  verified: boolean;
  language: string;
  productId: string;
  productTitle: string | null;
  productHandle: string | null;
  skinConcerns: string;
  ageRange: string | null;
  timeUsing: string | null;
  resultsSeen: string;
  source: string | null;
  reply: string | null;
}): BrandPageReviewEntry {
  return {
    id: r.id,
    rating: r.rating,
    title: r.title,
    body: r.body.slice(0, BODY_EXCERPT_CHARS),
    author: r.authorName,
    date: r.createdAt.toISOString().slice(0, 10),
    verified: r.verified,
    language: r.language,
    productId: r.productId,
    productTitle: r.productTitle,
    productHandle: r.productHandle,
    concerns: parseKeys(r.skinConcerns, SKIN_CONCERNS),
    ageRange: r.ageRange && (AGE_RANGES as readonly string[]).includes(r.ageRange) ? r.ageRange : null,
    timeUsing:
      r.timeUsing && (TIME_USING as readonly string[]).includes(r.timeUsing) ? r.timeUsing : null,
    results: parseKeys(r.resultsSeen, RESULTS_SEEN),
    // Coerce to the known label keys — the Liquid t: lookup must never see
    // an unexpected value ("translation missing" renders as literal text).
    source: SOURCE_LABELS[r.source ?? "storefront"] ? (r.source ?? "storefront") : "storefront",
    reply: r.reply ? r.reply.slice(0, REPLY_EXCERPT_CHARS) : null,
  };
}

/** Top page reviews: helpful/verified/recent with per-product diversity and a
 * guaranteed critical presence (SPEC-1.19 §6). */
export async function pickBrandPageReviews(shop: string): Promise<BrandPageReviewEntry[]> {
  const sel = {
    id: true,
    rating: true,
    title: true,
    body: true,
    authorName: true,
    createdAt: true,
    verified: true,
    language: true,
    productId: true,
    productTitle: true,
    productHandle: true,
    skinConcerns: true,
    ageRange: true,
    timeUsing: true,
    resultsSeen: true,
    source: true,
    reply: true,
  };
  const pool = await prisma.review.findMany({
    where: { shop, ...PUBLIC_WHERE },
    orderBy: [{ helpfulCount: "desc" }, { verified: "desc" }, { createdAt: "desc" }],
    take: 200,
    select: sel,
  });
  const perProduct = new Map<string, number>();
  const picked: typeof pool = [];
  for (const r of pool) {
    if (picked.length >= MAX_PAGE_REVIEWS) break;
    const used = perProduct.get(r.productId) ?? 0;
    if (used >= PER_PRODUCT_REVIEW_CAP) continue;
    perProduct.set(r.productId, used + 1);
    picked.push(r);
  }
  // Honesty rule: critical reviews must be visible on the page when they
  // exist — swap POSITIVE tail entries for the most helpful critical rows.
  // (Popping blindly would remove the critical row appended a moment ago.)
  const criticalPicked = picked.filter((r) => r.rating <= 3).length;
  if (criticalPicked < MIN_CRITICAL_ON_PAGE) {
    const extra = await prisma.review.findMany({
      where: { shop, ...PUBLIC_WHERE, rating: { lte: 3 }, id: { notIn: picked.map((r) => r.id) } },
      orderBy: [{ helpfulCount: "desc" }, { createdAt: "desc" }],
      take: MIN_CRITICAL_ON_PAGE - criticalPicked,
      select: sel,
    });
    for (const row of extra) {
      if (picked.length >= MAX_PAGE_REVIEWS) {
        // Drop the LAST positive entry, never a critical one.
        const victim = [...picked].reverse().find((r) => r.rating > 3);
        if (!victim) break;
        picked.splice(picked.indexOf(victim), 1);
      }
      picked.push(row);
    }
  }
  return picked.map(toEntry);
}

export async function buildBrandPagePayload(shop: string): Promise<BrandPagePayload> {
  const [facts, reviews, analysisRow, settings] = await Promise.all([
    computeBrandPageFacts(shop),
    pickBrandPageReviews(shop),
    prisma.brandAnalysis.findUnique({ where: { shop } }),
    getSettings(shop),
  ]);
  let analysis: BrandPagePayload["analysis"] = null;
  if (analysisRow) {
    try {
      const parsed = JSON.parse(analysisRow.sections) as AnalysisSections;
      if (parsed && parsed.sections) {
        // Quotes are re-validated against the CURRENT corpus at publish time:
        // a review that was since deleted, unpublished, redacted or edited
        // must never keep being republished (with its author's name) from a
        // stale analysis row.
        const quotedIds = [
          ...new Set(
            Object.values(parsed.sections).flatMap((s) =>
              Array.isArray(s?.quotes) ? s.quotes.map((q) => q.id) : [],
            ),
          ),
        ];
        const stillLive = new Map(
          (quotedIds.length
            ? await prisma.review.findMany({
                where: { shop, ...PUBLIC_WHERE, id: { in: quotedIds } },
                select: { id: true, body: true, title: true },
              })
            : []
          ).map((r) => [r.id, r]),
        );
        const sections = {} as AnalysisSections["sections"];
        for (const key of ANALYSIS_SECTION_KEYS) {
          const section = parsed.sections[key];
          if (!section) continue;
          sections[key] = {
            prose: section.prose,
            quotes: (section.quotes ?? []).filter((q) => {
              const live = stillLive.get(q.id);
              if (!live) return false;
              return live.body.includes(q.excerpt) || (live.title ?? "").includes(q.excerpt);
            }),
          };
        }
        analysis = {
          sections,
          generatedAt: analysisRow.generatedAt.toISOString().slice(0, 10),
          reviewCount: analysisRow.reviewCount,
        };
      }
    } catch {
      analysis = null;
    }
  }
  const payload: BrandPagePayload = {
    publishedAt: new Date().toISOString().slice(0, 10),
    facts,
    analysis,
    reviews,
    config: parseBrandPageConfig(settings.brandPageConfig),
  };
  // Size gate (SPEC-1.19 §6): trim bodies, then drop reviews — POSITIVE ones
  // first, so the guaranteed critical reviews (which sit at the tail) are
  // never what the trimmer removes. Byte length, not UTF-16 length: a
  // metafield limit counts bytes and multibyte text would otherwise slip past.
  const byteLength = (value: string) => Buffer.byteLength(value, "utf8");
  let json = JSON.stringify(payload);
  if (byteLength(json) > MAX_METAFIELD_BYTES) {
    payload.reviews = payload.reviews.map((r) => ({ ...r, body: r.body.slice(0, 400) }));
    json = JSON.stringify(payload);
  }
  while (byteLength(json) > MAX_METAFIELD_BYTES && payload.reviews.length > 0) {
    const victimIndex = payload.reviews.map((r) => r.rating > 3).lastIndexOf(true);
    payload.reviews.splice(victimIndex >= 0 ? victimIndex : payload.reviews.length - 1, 1);
    json = JSON.stringify(payload);
  }
  // Still oversized with no reviews left ⇒ the facts block itself is too big
  // (huge catalog). Shed the longest tail — products, then concern winners —
  // so the write succeeds instead of failing with an empty page.
  while (byteLength(json) > MAX_METAFIELD_BYTES && payload.facts.products.length > 10) {
    payload.facts.products.pop();
    json = JSON.stringify(payload);
  }
  while (byteLength(json) > MAX_METAFIELD_BYTES && payload.facts.concernWinners.length > 0) {
    payload.facts.concernWinners.pop();
    json = JSON.stringify(payload);
  }
  return payload;
}

const SHOP_ID_QUERY = `#graphql
  query CellexiaBrandPageShopId { shop { id } }
`;
const METAFIELDS_SET = `#graphql
  mutation CellexiaBrandPageSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors { field message }
    }
  }
`;

export async function publishBrandPage(shop: string, admin: AdminClient): Promise<boolean> {
  try {
    const payload = await buildBrandPagePayload(shop);
    const idResponse = await admin.graphql(SHOP_ID_QUERY);
    const idJson = (await idResponse.json()) as { data?: { shop?: { id?: string } } };
    const ownerId = idJson.data?.shop?.id;
    if (!ownerId) return false;
    const response = await admin.graphql(METAFIELDS_SET, {
      variables: {
        metafields: [
          {
            ownerId,
            namespace: NAMESPACE,
            key: BRAND_PAGE_METAFIELD_KEY,
            type: "json",
            value: JSON.stringify(payload),
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
      console.error("[cellexia] publishBrandPage userErrors:", userErrors);
      return false;
    }
    return !json.errors;
  } catch (error) {
    console.error("[cellexia] publishBrandPage failed", error);
    return false;
  }
}

/* Debounced auto-refresh on review changes (same pattern + caveats as
 * scheduleShopRatingSync — per-process, idempotent write, last one wins). */
const BRAND_PAGE_SYNC_DEBOUNCE_MS = 60_000;
const pendingPublishes = new Map<string, { timer: ReturnType<typeof setTimeout>; admin: AdminClient }>();

export function scheduleBrandPagePublish(shop: string, admin: AdminClient): void {
  const pending = pendingPublishes.get(shop);
  if (pending) {
    pending.admin = admin;
    return;
  }
  const timer = setTimeout(() => {
    const entry = pendingPublishes.get(shop);
    pendingPublishes.delete(shop);
    if (entry) void publishBrandPage(shop, entry.admin);
  }, BRAND_PAGE_SYNC_DEBOUNCE_MS);
  const t = timer as unknown as { unref?: () => void };
  if (typeof t.unref === "function") t.unref();
  pendingPublishes.set(shop, { timer, admin });
}

/* ------------------------------------------------------------------------- *
 * Feature toggles (SPEC-1.19 §6)
 * ------------------------------------------------------------------------- */

export interface BrandPageConfig {
  ask: boolean;
  recommend: boolean;
}

export function parseBrandPageConfig(raw: string | null | undefined): BrandPageConfig {
  try {
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    return {
      ask: parsed.ask !== false,
      recommend: parsed.recommend !== false,
    };
  } catch {
    return { ask: true, recommend: true };
  }
}
