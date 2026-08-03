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
 * locale) tasks through an in-process queue: concurrency 2, per-shop daily
 * cap (CURATION_DAILY_CAP attempts), per-(product, locale) debounce 10 min.
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
import { callClaude, extractJson } from "./ai.server";
import { curationPromptFor } from "./curation-prompts.server";
import { getSettings } from "./settings.server";
import { scrubDashes } from "./synthetic-prompts.server";
import { translateReviews } from "./translate.server";

/** v1.18 (SPEC-1.18 §1): what the agents read. */
export type CurationSource = "as_seen" | "all_translated";

export function asCurationSource(raw: unknown): CurationSource {
  return raw === "all_translated" ? "all_translated" : "as_seen";
}

type AdminClient = Pick<AdminApiContext, "graphql">;

const MAX_CANDIDATES = 60;
const MAX_BODY_CHARS = 800;
const MAX_DESCRIPTION_CHARS = 4000;
const MIN_QUALIFYING_LOCAL_TEXTS = 5;
export const MIN_ORDER = 3;
const MAX_ORDER = 30;
export const CURATION_DAILY_CAP = 300;
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
): Promise<{ candidates: CurationCandidate[]; localTexts: number }> {
  const rows = await prisma.review.findMany({
    where: { shop, productId: String(productId), status: "PUBLISHED" },
    orderBy: { createdAt: "desc" },
    take: MAX_CANDIDATES,
    select: {
      id: true,
      rating: true,
      title: true,
      body: true,
      language: true,
      verified: true,
      createdAt: true,
      variantTitle: true,
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
  if (source === "all_translated" && rows.length >= MIN_ORDER) {
    const missing = foreignIds.filter((id) => !byReview.get(id)?.body);
    // translateReviews caps at 20 ids per call — chunk. Full bodies are
    // translated (and cached); the 800-char payload slice happens below.
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

  let localTexts = 0;
  const candidates: CurationCandidate[] = rows.map((r) => {
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
      id: r.id,
      rating: r.rating,
      title,
      body: body.slice(0, MAX_BODY_CHARS),
      verified: r.verified,
      date: r.createdAt.toISOString().slice(0, 10),
      variant: r.variantTitle,
      hasMedia: r.media.length > 0,
      textNote,
    };
  });
  return { candidates, localTexts };
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
    where: { shop, productId: String(productId), status: "PUBLISHED" },
    orderBy: { createdAt: "desc" },
    take: MAX_CANDIDATES,
    select: { id: true, language: true },
  });
  // Fewer than MIN_ORDER reviews can never produce a curation — qualifying
  // nothing here keeps guaranteed no_reviews failures out of the queue, the
  // daily cap, and the failures banner.
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
  | { status: "no_ai" | "no_reviews" | "no_product" | "failed" };

export async function curateProductLocale(
  shop: string,
  admin: AdminClient,
  productId: string,
  locale: string,
): Promise<CurationResult> {
  const targetLocale = (SHOP_LOCALES as readonly string[]).includes(locale) ? locale : "en";
  const settings = await getSettings(shop);
  if (settings.aiProvider !== "anthropic" || !settings.anthropicApiKey) return { status: "no_ai" };

  const { candidates } = await buildCandidates(
    shop,
    productId,
    targetLocale,
    asCurationSource(settings.curationSource),
  );
  if (candidates.length < MIN_ORDER) return { status: "no_reviews" };

  const context = await fetchProductContext(admin, productId, settings.curationOverviewField);
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

  const raw = await callClaude(
    settings.anthropicApiKey,
    settings.aiModel,
    curationPromptFor(targetLocale),
    userContent,
    2500,
  );
  if (!raw) return { status: "failed" };

  const parsed = extractJson(raw) as { order?: unknown; rationale?: unknown } | null;
  if (!parsed) return { status: "failed" };
  const validIds = new Set(candidates.map((c) => c.id));
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
    targetLocale,
  );

  await prisma.aiCuration.upsert({
    where: { shop_productId_locale: { shop, productId: String(productId), locale: targetLocale } },
    update: {
      orderedIds: JSON.stringify(order),
      rationale,
      model: settings.aiModel,
      reviewCount: candidates.length,
    },
    create: {
      shop,
      productId: String(productId),
      locale: targetLocale,
      orderedIds: JSON.stringify(order),
      rationale,
      model: settings.aiModel,
      reviewCount: candidates.length,
    },
  });
  return { status: "ok", ordered: order.length };
}

/* ------------------------------------------------------------------------- *
 * Queue (admin-triggered only)
 * ------------------------------------------------------------------------- */

const debounceMap = new Map<string, number>();
const dailyMap = new Map<string, { day: string; count: number }>();
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

/** Non-incrementing view of today's remaining cap — the sweep short-circuits
 * on 0 so a cap-starved backlog costs no qualification queries. */
export function remainingDailyCap(shop: string): number {
  const day = new Date().toISOString().slice(0, 10);
  const entry = dailyMap.get(shop);
  if (!entry || entry.day !== day) return CURATION_DAILY_CAP;
  return Math.max(0, CURATION_DAILY_CAP - entry.count);
}

function underDailyCap(shop: string): boolean {
  const day = new Date().toISOString().slice(0, 10);
  const entry = dailyMap.get(shop);
  if (!entry || entry.day !== day) {
    if (dailyMap.size > 200) {
      for (const [k, v] of dailyMap) if (v.day !== day) dailyMap.delete(k);
    }
    dailyMap.set(shop, { day, count: 1 });
    return true;
  }
  if (entry.count >= CURATION_DAILY_CAP) return false;
  entry.count += 1;
  return true;
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
  skippedCap: number;
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
  if (!ids || ids.length === 0) {
    const groups = await prisma.review.groupBy({
      by: ["productId"],
      where: { shop, status: "PUBLISHED" },
    });
    ids = groups.map((g) => g.productId);
  }
  const summary: QueueSummary = { queued: 0, skippedDebounce: 0, skippedCap: 0, products: ids.length, aiReady: true };
  const source = asCurationSource(settings.curationSource);
  const now = Date.now();
  for (const productId of ids) {
    const locales = await qualifyingLocales(shop, productId, source);
    enqueuePairs(shop, admin, locales.map((locale) => ({ productId, locale })), summary, now);
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
    if (!underDailyCap(shop)) {
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
  enqueuePairs(shop, admin, pairs, summary, Date.now());
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
    return {
      productId: row.productId,
      locale: row.locale,
      ordered,
      reviewCount: row.reviewCount,
      publishedNow,
      // Two staleness signals: the published count moved against the stored
      // count (compared under the MAX_CANDIDATES cap, so a product with more
      // than 60 reviews is not permanently stale), OR any review was
      // published after this curation ran (catches new arrivals past the
      // cap, where the count alone stays pinned at 60). Deletions past the
      // cap remain deliberately quiet.
      stale:
        Math.min(publishedNow, MAX_CANDIDATES) !== row.reviewCount ||
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
